/**
 * Per-Connection Rate Limiter, Spacing & Concurrency Enforcement.
 *
 * Enforces rate limits (rpm, rpd, tpm, tpd, minTime, maxConcurrent, modelConcurrency)
 * configured in provider_connections.rate_limit_overrides_json.
 *
 * Operational Invariant:
 *  - Rate limiting infrastructure failures (e.g. Redis downtime, store exceptions)
 *    MUST FAIL OPEN with `{ allowed: true, degraded: true }`.
 *  - A quota outage must never take down inference routing.
 *  - Only an actual exceeded policy limit returns `{ allowed: false, reason, retryAfterMs }`.
 *  - Never throws on the request path.
 */

import { getQuotaStore } from "@/lib/quota/storeFactory.js";
import { isRedisConfigured } from "@/lib/redis/client.js";
import { globalRedisSemaphore } from "@/lib/resilience/redisSemaphore.js";
import { sanitizeConnectionLimitOverrides } from "./overrides.js";
import { globalConnectionSemaphore, globalModelSemaphore } from "./semaphore.js";

function getActiveSemaphore(type) {
  if (isRedisConfigured()) {
    return globalRedisSemaphore;
  }
  return type === "model" ? globalModelSemaphore : globalConnectionSemaphore;
}

// Tracks timestamp of last dispatched request per connection key for minTime spacing
const lastRequestTimeMap = new Map();

/**
 * Derive a consistent connection key string formatted `provider:account`.
 */
export function buildConnectionKey(connection) {
  if (!connection) return "unknown:default";
  if (typeof connection === "string") return connection;
  const provider = connection.provider || "default";
  const account = connection.account || connection.email || connection.name || connection.id || "default";
  return `${provider}:${account}`;
}

/**
 * Check connection limits across minTime, maxConcurrent, modelConcurrency, rpm, rpd, tpm, tpd.
 *
 * Returns structured verdict:
 *  - `{ allowed: true }`
 *  - `{ allowed: true, degraded: true }` (on infrastructure failure — fail-open)
 *  - `{ allowed: false, reason: string, retryAfterMs: number }` (when limit exceeded)
 *
 * NEVER throws on errors.
 */
export async function checkConnectionLimits(params = {}) {
  const {
    connection,
    overrides: rawOverrides,
    model,
    tokens = 1,
    store,
    now: rawNow,
    signal,
  } = params;

  const now = Number(rawNow) || Date.now();
  const connKey = buildConnectionKey(connection);
  const rawCandidate = rawOverrides
    ?? connection?.rate_limit_overrides_json
    ?? connection?.rateLimitOverrides
    ?? connection?.providerSpecificData?.rateLimitOverrides;
  const overrides = sanitizeConnectionLimitOverrides(rawCandidate);

  // If no overrides or empty config, all limits are unrestricted
  if (!overrides || Object.keys(overrides).length === 0) {
    return { allowed: true };
  }

  let connSlotAcquired = false;
  let modelSlotAcquired = false;
  let connLeaseId = null;
  let modelLeaseId = null;
  let degraded = false;

  const rollbackSlots = () => {
    if (connSlotAcquired) {
      const sem = getActiveSemaphore("conn");
      sem.release(connKey, connLeaseId);
      connSlotAcquired = false;
    }
    if (modelSlotAcquired && model) {
      const sem = getActiveSemaphore("model");
      sem.release(`${connKey}:${model}`, modelLeaseId);
      modelSlotAcquired = false;
    }
  };

  try {
    // 1. Enforce minTime inter-call spacing
    if (overrides.minTime && overrides.minTime > 0) {
      const lastAt = lastRequestTimeMap.get(connKey) || 0;
      const elapsed = now - lastAt;
      if (lastAt > 0 && elapsed < overrides.minTime) {
        const retryAfterMs = overrides.minTime - elapsed;
        return {
          allowed: false,
          reason: "min_time_not_met",
          retryAfterMs,
        };
      }
    }

    // 2. Enforce in-flight maxConcurrent semaphore
    if (overrides.maxConcurrent && overrides.maxConcurrent > 0) {
      const waitMs = overrides.maxWaitMs || 0;
      const sem = getActiveSemaphore("conn");
      const acqResult = await sem.acquire(connKey, overrides.maxConcurrent, {
        maxWaitMs: waitMs,
        signal,
      });

      if (!acqResult.acquired) {
        return {
          allowed: false,
          reason: "concurrency_limit_exceeded",
          retryAfterMs: Math.max(500, waitMs || 1000),
        };
      }
      connSlotAcquired = true;
      connLeaseId = acqResult.leaseId;
    }

    // 3. Enforce modelConcurrency if configured for this model
    if (
      overrides.modelConcurrency &&
      model &&
      typeof overrides.modelConcurrency[model] === "number" &&
      overrides.modelConcurrency[model] > 0
    ) {
      const modelKey = `${connKey}:${model}`;
      const modelMax = overrides.modelConcurrency[model];
      const waitMs = overrides.maxWaitMs || 0;
      const sem = getActiveSemaphore("model");
      const modelAcq = await sem.acquire(modelKey, modelMax, {
        maxWaitMs: waitMs,
        signal,
      });

      if (!modelAcq.acquired) {
        rollbackSlots();
        return {
          allowed: false,
          reason: "model_concurrency_limit_exceeded",
          retryAfterMs: Math.max(500, waitMs || 1000),
        };
      }
      modelSlotAcquired = true;
      modelLeaseId = modelAcq.leaseId;
    }

    // 4. Enforce quota store dimensions: rpm, rpd, tpm, tpd
    const quotaStore = store || getQuotaStore();
    const quotaDimensions = [
      { name: "rpm", limit: overrides.rpm, windowMs: 60_000, amount: 1 },
      { name: "rpd", limit: overrides.rpd, windowMs: 86_400_000, amount: 1 },
      { name: "tpm", limit: overrides.tpm, windowMs: 60_000, amount: Number(tokens) || 1 },
      { name: "tpd", limit: overrides.tpd, windowMs: 86_400_000, amount: Number(tokens) || 1 },
    ];

    for (const dim of quotaDimensions) {
      if (dim.limit && dim.limit > 0) {
        let res;
        try {
          res = await quotaStore.consume({
            key: `conn:${connKey}`,
            limit: dim.limit,
            windowMs: dim.windowMs,
            amount: dim.amount,
            counterType: `conn:${dim.name}`,
            now,
          });
        } catch (storeErr) {
          // Operational invariant: store failure fails open
          console.warn(
            `[connectionLimiter] QuotaStore error on dimension ${dim.name} for ${connKey} (failing open): ${storeErr?.message ?? storeErr}`
          );
          degraded = true;
          continue;
        }

        if (res?.degraded) {
          degraded = true;
        }

        if (res && res.allowed === false) {
          rollbackSlots();
          return {
            allowed: false,
            reason: `${dim.name}_limit_exceeded`,
            retryAfterMs: Math.max(1000, res.resetMs || 1000),
          };
        }
      }
    }

    // Update last successful request start time
    lastRequestTimeMap.set(connKey, now);

    return {
      allowed: true,
      ...(degraded ? { degraded: true } : {}),
      slotsHeld: {
        connection: connSlotAcquired,
        model: modelSlotAcquired,
        leaseId: connLeaseId,
        modelLeaseId,
      },
    };
  } catch (err) {
    // Unexpected error in limiter logic — fail open so inference never halts
    console.warn(`[connectionLimiter] Unexpected error (failing open): ${err?.message ?? err}`);
    rollbackSlots();
    return {
      allowed: true,
      degraded: true,
    };
  }
}

/**
 * Release connection and model concurrency slots upon request completion or abort.
 */
export function releaseConnectionSlot(params = {}) {
  const { connection, overrides: rawOverrides, model, leaseId, modelLeaseId } = params;
  const connKey = buildConnectionKey(connection);
  const rawCandidate = rawOverrides
    ?? connection?.rate_limit_overrides_json
    ?? connection?.rateLimitOverrides
    ?? connection?.providerSpecificData?.rateLimitOverrides;
  const overrides = sanitizeConnectionLimitOverrides(rawCandidate);

  if (overrides?.maxConcurrent && overrides.maxConcurrent > 0) {
    const sem = getActiveSemaphore("conn");
    sem.release(connKey, leaseId);
  }

  if (
    overrides?.modelConcurrency &&
    model &&
    typeof overrides.modelConcurrency[model] === "number" &&
    overrides.modelConcurrency[model] > 0
  ) {
    const sem = getActiveSemaphore("model");
    sem.release(`${connKey}:${model}`, modelLeaseId);
  }
}

/**
 * Reset all in-memory state. Used for unit tests.
 */
export function resetConnectionLimiter() {
  lastRequestTimeMap.clear();
  globalConnectionSemaphore.reset();
  globalModelSemaphore.reset();
  try {
    globalRedisSemaphore.reset();
  } catch {}
}

/**
 * Single-use OAuth token refresh deduplication across in-process calls and cluster instances.
 *
 * Layer 1: In-process Promise and TTL cache.
 * Layer 2: Distributed Redis lock (`khatam:lock:refresh:<provider>:<tokenHash>`, `SET NX EX 30`)
 *          and result cache (`khatam:cache:refresh:<provider>:<tokenHash>`) across replicas.
 *
 * Operational invariants:
 * - Fail-open: Redis failures or network partitions fall back to Layer 1 without throwing.
 * - Secret hygiene: Tokens are always SHA-256 hashed; never stored cleartext in Redis keys.
 */

import { createHash } from "node:crypto";
import { getRedisClient, isRedisConfigured, withRedisKey } from "@/lib/redis/client.js";

const REFRESH_RESULT_TTL_MS = 10_000;
const REFRESH_LOCK_TTL_SEC = 30;
const refreshDedupCache = new Map();

const INSTANCE_ID = typeof process !== "undefined"
  ? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  : "inst-refresh";

export function hashRefreshToken(token) {
  if (!token) return "empty";
  const trimmed = String(token).trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return createHash("sha256").update(trimmed).digest("hex");
}

export function resetRefreshDedupCache() {
  refreshDedupCache.clear();
}

export async function dedupRefresh(provider, oldToken, fn, log) {
  if (!oldToken) return fn();
  const tokenHash = hashRefreshToken(oldToken);
  const localKey = `${provider}:${oldToken}`;

  // Layer 1: In-process memory check
  const hit = refreshDedupCache.get(localKey);
  if (hit) {
    if (hit.promise) {
      log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
      return hit.promise;
    }
    if (hit.expiresAt > Date.now()) {
      log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
      return hit.result;
    }
    refreshDedupCache.delete(localKey);
  }

  // Promise wrapper for in-process callers while refresh is in flight
  const inFlightPromise = (async () => {
    let client = null;
    let lockKey = null;
    let cacheKey = null;
    let lockAcquired = false;

    // Layer 2: Distributed Redis mutex
    try {
      if (isRedisConfigured()) {
        client = getRedisClient();
        if (client) {
          // Explicit pattern: khatam:lock:refresh:<provider>:<tokenHash>
          lockKey = withRedisKey(`lock:refresh:${provider}:${tokenHash}`);
          cacheKey = withRedisKey(`cache:refresh:${provider}:${tokenHash}`);

          // Check if another instance already finished this refresh
          const cachedVal = await client.get(cacheKey);
          if (cachedVal) {
            try {
              const parsed = JSON.parse(cachedVal);
              log?.info?.("TOKEN_REFRESH", `Reusing cluster-cached refresh result for ${provider}`);
              refreshDedupCache.set(localKey, { result: parsed, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });
              return parsed;
            } catch {}
          }

          // Attempt distributed lock: SET key instanceId EX 30 NX
          const setRes = await client.set(lockKey, INSTANCE_ID, "EX", REFRESH_LOCK_TTL_SEC, "NX");
          if (setRes === "OK") {
            lockAcquired = true;
          } else {
            // Another instance holds the lock — wait/poll for their result
            log?.info?.("TOKEN_REFRESH", `Waiting for distributed refresh lock on ${provider}`);
            const startWait = Date.now();
            const maxWaitMs = 15_000;
            while (Date.now() - startWait < maxWaitMs) {
              await new Promise((r) => setTimeout(r, 150));
              const clusterResult = await client.get(cacheKey);
              if (clusterResult) {
                try {
                  const parsed = JSON.parse(clusterResult);
                  log?.info?.("TOKEN_REFRESH", `Obtained cluster refresh result for ${provider}`);
                  refreshDedupCache.set(localKey, { result: parsed, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });
                  return parsed;
                } catch {}
              }
              // If lock expired or was released, break and attempt execution
              const lockHolder = await client.get(lockKey);
              if (!lockHolder) break;
            }
          }
        }
      }
    } catch (redisErr) {
      // Fail-open: Redis failure falls back to direct execution
      log?.warn?.("TOKEN_REFRESH", `Redis refresh lock failed: ${redisErr?.message ?? redisErr}`);
    }

    try {
      const result = await fn();
      refreshDedupCache.set(localKey, { result, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });

      // Share result across cluster if Redis is available
      if (client && cacheKey) {
        try {
          await client.set(cacheKey, JSON.stringify(result), "EX", 15);
        } catch {}
      }
      return result;
    } catch (err) {
      refreshDedupCache.delete(localKey);
      throw err;
    } finally {
      if (lockAcquired && client && lockKey) {
        try {
          await client.del(lockKey);
        } catch {}
      }
    }
  })();

  refreshDedupCache.set(localKey, { promise: inFlightPromise });
  return inFlightPromise;
}

/**
 * Durable circuit-breaker state (Wave 4).
 *
 * SQLite is authoritative; Redis is an optional, best-effort cache mirror.
 *
 * Operational invariants:
 *   - Every function here swallows its own errors. A missing table (built
 *     before migration 003), a locked database, an unreachable Redis — none of
 *     them may break routing. "No state" is always a valid answer.
 *   - Redis is never awaited on the request path and never constructed unless
 *     the process configured `REDIS_URL` or a caller injected a client.
 *   - Keys are namespaced `khatam:cb:<domain>` and contain provider/connection
 *     identifiers only — never credentials, emails, or key material (FR-019).
 */

import { getAdapter } from "@/lib/db/driver.js";
import { isRedisConfigured, withRedisKey } from "@/lib/redis/client.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "@/lib/redis/events.js";
import { getCircuitBreaker, resetAllCircuitBreakers } from "@/shared/utils/circuitBreaker.js";
import {
  BREAKER_TABLE,
  REDIS_BREAKER_PREFIX,
  REDIS_BREAKER_TTL_SECONDS,
} from "open-sse/config/resilienceConfig.js";

/** True when the breaker table exists in the open database. */
export function breakerTableExists(db) {
  try {
    return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [BREAKER_TABLE]));
  } catch {
    return false;
  }
}

/** True when the additive Wave 4 columns are present. */
export function breakerDiagnosticsColumnsPresent(db) {
  try {
    const names = new Set((db.all(`PRAGMA table_info(${BREAKER_TABLE})`) || []).map((row) => row.name));
    return names.has("last_failure_kind") && names.has("open_cycle_count");
  } catch {
    return false;
  }
}

function safeJsonParse(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return null;
  }
}

/**
 * Load one breaker row.
 * @returns {Promise<object|null>} snapshot-shaped object, or null
 */
export async function loadBreakerRow(domain, db = null) {
  if (!domain) return null;
  try {
    const adapter = db || (await getAdapter());
    if (!breakerTableExists(adapter)) return null;
    const row = adapter.get(`SELECT * FROM ${BREAKER_TABLE} WHERE domain = ?`, [String(domain)]);
    if (!row) return null;

    const hasDiagnostics = breakerDiagnosticsColumnsPresent(adapter);
    return {
      name: String(domain),
      state: row.state,
      failureCount: Number(row.failure_count) || 0,
      successCount: Number(row.success_count) || 0,
      lastFailureTime: row.last_failure_at ? Date.parse(row.last_failure_at) || null : null,
      lastFailureKind: hasDiagnostics ? row.last_failure_kind || null : null,
      openCycleCount: hasDiagnostics ? Number(row.open_cycle_count) || 0 : 0,
      kindFailureCounts: hasDiagnostics ? safeJsonParse(row.kind_failure_counts_json, {}) : {},
      transitionHistory: hasDiagnostics ? safeJsonParse(row.transition_history_json, []) : [],
      lastFailureReason: row.last_failure_reason || null,
      cooldownUntil: row.cooldown_until || null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist one breaker snapshot.
 * @returns {Promise<boolean>} true when the row was written
 */
export async function saveBreakerRow(domain, snapshot, db = null) {
  if (!domain || !snapshot || typeof snapshot !== "object") return false;
  try {
    const adapter = db || (await getAdapter());
    if (!breakerTableExists(adapter)) return false;

    const hasDiagnostics = breakerDiagnosticsColumnsPresent(adapter);
    const nowIso = new Date().toISOString();
    const lastFailureIso = Number.isFinite(Number(snapshot.lastFailureTime))
      ? new Date(Number(snapshot.lastFailureTime)).toISOString()
      : null;
    // cooldown_until mirrors the breaker's own arithmetic so an external reader
    // (dashboard, CLI) sees the same expiry the breaker enforces.
    const retryAfterMs = Number.isFinite(Number(snapshot.retryAfterMs)) ? Number(snapshot.retryAfterMs) : null;
    const cooldownUntil = retryAfterMs && retryAfterMs > 0
      ? new Date(Date.now() + retryAfterMs).toISOString()
      : null;

    if (hasDiagnostics) {
      adapter.run(
        `INSERT INTO ${BREAKER_TABLE}
           (domain, state, failure_count, success_count, last_failure_reason, last_failure_at,
            cooldown_until, degraded_until, updated_at,
            last_failure_kind, open_cycle_count, kind_failure_counts_json, transition_history_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           state = excluded.state,
           failure_count = excluded.failure_count,
           success_count = excluded.success_count,
           last_failure_reason = excluded.last_failure_reason,
           last_failure_at = excluded.last_failure_at,
           cooldown_until = excluded.cooldown_until,
           degraded_until = excluded.degraded_until,
           updated_at = excluded.updated_at,
           last_failure_kind = excluded.last_failure_kind,
           open_cycle_count = excluded.open_cycle_count,
           kind_failure_counts_json = excluded.kind_failure_counts_json,
           transition_history_json = excluded.transition_history_json`,
        [
          String(domain),
          String(snapshot.state || "CLOSED"),
          Number(snapshot.failureCount) || 0,
          Number(snapshot.successCount) || 0,
          snapshot.lastFailureKind || null,
          lastFailureIso,
          cooldownUntil,
          snapshot.state === "DEGRADED" ? cooldownUntil : null,
          nowIso,
          snapshot.lastFailureKind || null,
          Number(snapshot.openCycleCount) || 0,
          safeJsonStringify(snapshot.kindFailureCounts || {}),
          safeJsonStringify((snapshot.transitionHistory || []).slice(-25)),
        ]
      );
    } else {
      // Pre-003 database (should not happen after boot, but be safe).
      adapter.run(
        `INSERT INTO ${BREAKER_TABLE}
           (domain, state, failure_count, success_count, last_failure_reason, last_failure_at,
            cooldown_until, degraded_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           state = excluded.state,
           failure_count = excluded.failure_count,
           success_count = excluded.success_count,
           last_failure_reason = excluded.last_failure_reason,
           last_failure_at = excluded.last_failure_at,
           cooldown_until = excluded.cooldown_until,
           degraded_until = excluded.degraded_until,
           updated_at = excluded.updated_at`,
        [
          String(domain),
          String(snapshot.state || "CLOSED"),
          Number(snapshot.failureCount) || 0,
          Number(snapshot.successCount) || 0,
          snapshot.lastFailureKind || null,
          lastFailureIso,
          cooldownUntil,
          snapshot.state === "DEGRADED" ? cooldownUntil : null,
          nowIso,
        ]
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** Every persisted breaker row, for dashboards and diagnostics. */
export async function listBreakerRows(db = null) {
  try {
    const adapter = db || (await getAdapter());
    if (!breakerTableExists(adapter)) return [];
    return adapter.all(`SELECT * FROM ${BREAKER_TABLE} ORDER BY updated_at DESC`);
  } catch {
    return [];
  }
}

/** Delete one breaker row. */
export async function deleteBreakerRow(domain, db = null) {
  try {
    const adapter = db || (await getAdapter());
    if (!breakerTableExists(adapter)) return false;
    adapter.run(`DELETE FROM ${BREAKER_TABLE} WHERE domain = ?`, [String(domain)]);
    return true;
  } catch {
    return false;
  }
}

/** Delete every breaker row. */
export async function deleteAllBreakerRows(db = null) {
  try {
    const adapter = db || (await getAdapter());
    if (!breakerTableExists(adapter)) return false;
    adapter.run(`DELETE FROM ${BREAKER_TABLE}`);
    return true;
  } catch {
    return false;
  }
}

// ─── Optional Redis cache mirror ────────────────────────────────────────────

/** Full Redis key for a domain: `khatam:cb:<domain>`. */
export function redisBreakerKey(domain) {
  return withRedisKey(`${REDIS_BREAKER_PREFIX}${String(domain)}`);
}

let cachedClientProvider = null;

/**
 * Resolve a Redis client, or null.
 * A caller-injected provider wins (tests); otherwise a client exists only when
 * `REDIS_URL` is configured, and it is imported dynamically so a process that
 * never touches Redis never loads ioredis.
 */
async function resolveCacheClient(clientProvider) {
  // A caller-injected provider wins — tests install one without configuring
  // REDIS_URL, and an injected client is an explicit request to use it.
  if (typeof clientProvider === "function") {
    try { return await clientProvider(); } catch { return null; }
  }
  if (cachedClientProvider) {
    try { return await cachedClientProvider(); } catch { return null; }
  }
  // No injection: only a configured process ever loads ioredis at all.
  if (!isRedisConfigured()) return null;
  try {
    const { getRedisClient } = await import("@/lib/redis/client.js");
    return getRedisClient();
  } catch {
    return null;
  }
}

/** Test seam: install a client provider (or null to clear). */
export function setBreakerCacheClientProvider(provider) {
  cachedClientProvider = typeof provider === "function" ? provider : null;
}

/** Read a cached snapshot, or null. Never throws. */
export async function readRedisSnapshot(domain, options = {}) {
  if (!domain) return null;
  try {
    const client = await resolveCacheClient(options.clientProvider);
    if (!client || typeof client.get !== "function") return null;
    const raw = await client.get(redisBreakerKey(domain));
    if (!raw) return null;
    return safeJsonParse(typeof raw === "string" ? raw : String(raw), null);
  } catch {
    return null;
  }
}

/** Write a cached snapshot. Never throws; returns whether it landed. */
export async function writeRedisSnapshot(domain, snapshot, options = {}) {
  if (!domain || !snapshot) return false;
  try {
    const client = await resolveCacheClient(options.clientProvider);
    if (!client || typeof client.set !== "function") return false;
    const payload = safeJsonStringify(snapshot);
    if (!payload) return false;
    if (typeof client.set === "function" && client.set.length >= 3) {
      await client.set(redisBreakerKey(domain), payload, "EX", REDIS_BREAKER_TTL_SECONDS);
    } else {
      await client.set(redisBreakerKey(domain), payload);
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a cached snapshot. Never throws. */
export async function clearRedisSnapshot(domain, options = {}) {
  if (!domain) return false;
  try {
    const client = await resolveCacheClient(options.clientProvider);
    if (!client || typeof client.del !== "function") return false;
    await client.del(redisBreakerKey(domain));
    return true;
  } catch {
    return false;
  }
}

// Flag to avoid self-echoing remote circuit trip events
let isApplyingRemoteTrip = false;

// Re-export resetAllCircuitBreakers for test isolation & breaker lifecycle management
export { resetAllCircuitBreakers };

// Set of in-flight persistence and restore promises (tracked for clean test teardown)
const inFlightOperations = new Set();

function trackOperation(promise) {
  if (!promise || typeof promise.then !== "function") return promise;
  inFlightOperations.add(promise);
  promise.finally(() => inFlightOperations.delete(promise)).catch(() => {});
  return promise;
}

/**
 * Returns count of currently in-flight breaker persistence / restore operations.
 */
export function getInFlightBreakerPersistenceCount() {
  return inFlightOperations.size;
}

/**
 * Test seam: await all in-flight persistence and restore operations.
 * Allows test suites to drain background DB/Redis writes before closing clients or tearing down temp dirs.
 * Minimal additive production seam: behaviour-neutral on the hot path (caller continues fire-and-forget),
 * fail-open, and non-blocking for routing requests.
 *
 * Deterministic queue flush: flushes the microtask queue (via setImmediate) so deferred restore()
 * hooks scheduled via Promise.resolve().then(...) are invoked and tracked, then loops until the
 * in-flight set is empty and stays empty after one more flush.
 */
export async function drainBreakerPersistence() {
  const flush = () => new Promise((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });

  while (true) {
    await flush();
    if (inFlightOperations.size === 0) {
      break;
    }
    await Promise.allSettled([...inFlightOperations]);
  }
}

// Subscribe to cluster circuit trips to sync state across router replicas
try {
  subscribeKhatamEvent(KHATAM_EVENTS.CIRCUIT_TRIP, (payload) => {
    if (!payload || !payload.domain) return;
    const { domain, state, reason, lastFailureKind } = payload;
    const breaker = getCircuitBreaker(domain);
    if (!breaker) return;

    if (state === "OPEN" && breaker.state !== "OPEN") {
      isApplyingRemoteTrip = true;
      try {
        breaker.openCircuit(lastFailureKind || null, reason || "circuit_trip_sync");
      } finally {
        isApplyingRemoteTrip = false;
      }
    } else if (state === "DEGRADED" && breaker.state === "CLOSED") {
      isApplyingRemoteTrip = true;
      try {
        breaker.transition("DEGRADED", reason || "circuit_trip_sync");
      } finally {
        isApplyingRemoteTrip = false;
      }
    }
  });
} catch {
  // Fail-open if pub/sub bus cannot be initialized
}

// ─── Wired Domain Factory ──────────────────────────────────────────────────

/**
 * Get (or create) a CircuitBreaker wired to SQLite persistence and the optional
 * Redis cache mirror.
 *
 * The breaker is usable immediately (synchronous): restore runs in the
 * background and merges once ready; persistence runs fire-and-forget.
 */
export function getCircuitBreakerForDomain(domain, options = {}) {
  const persistence = {
    save(name, snapshot) {
      // Fire-and-forget to both sinks; neither failure may reject
      const pSql = saveBreakerRow(name, snapshot).catch(() => false);
      const pRedis = writeRedisSnapshot(name, snapshot).catch(() => false);
      const pAll = Promise.all([pSql, pRedis]);
      trackOperation(pAll);
      return pAll;
    },
  };

  const restore = () => {
    const p = (async () => {
      // Redis cache mirror first (sub-millisecond), falling back to SQLite
      const cached = await readRedisSnapshot(domain);
      if (cached) return cached;
      return await loadBreakerRow(domain);
    })();
    trackOperation(p);
    return p;
  };

  const onStateChange = (name, oldState, newState) => {
    if (typeof options.onStateChange === "function") {
      try { options.onStateChange(name, oldState, newState); } catch {}
    }
    // Publish cluster circuit_trip event when circuit transitions to OPEN or DEGRADED
    if (!isApplyingRemoteTrip && (newState === "OPEN" || newState === "DEGRADED")) {
      try {
        const breaker = getCircuitBreaker(name);
        publishKhatamEvent(KHATAM_EVENTS.CIRCUIT_TRIP, {
          domain: name,
          state: newState,
          reason: breaker?.lastFailureReason || "circuit_trip",
          cooldownMs: typeof breaker?.effectiveCooldownMs === "function" ? breaker.effectiveCooldownMs() : 60000,
          lastFailureKind: breaker?.lastFailureKind || null,
        });
      } catch {}
    }
  };

  return getCircuitBreaker(domain, {
    ...options,
    persistence,
    restore,
    onStateChange,
  });
}

/**
 * Reset every domain breaker: memory registry cleared, rows wiped, Redis keys deleted.
 */
export async function resetDomainCircuitBreakers(domains = []) {
  resetAllCircuitBreakers();

  if (Array.isArray(domains) && domains.length > 0) {
    for (const d of domains) {
      await deleteBreakerRow(d);
      await clearRedisSnapshot(d);
    }
  } else {
    await deleteAllBreakerRows();
  }
}


/**
 * Advisory API Key Authentication Cache (Redis Accelerator)
 *
 * Design Invariants (contracts/redis-conventions.md & FR-020, FR-022):
 * 1. Zero raw secrets in Redis keys: keys are hashed via SHA-256.
 *    Redis key format: <prefix>:cache:auth:key:<apiKeyHash>
 * 2. Bounded TTL: 60 seconds (AUTH_CACHE_TTL_SEC = 60).
 * 3. Advisory Only / SQLite Status Check: Cache hits NEVER bypass the SQLite status check.
 *    Negative control: a revoked, banned, or deleted key must still be rejected.
 * 4. Invalidation: Key operations (revoke, ban, delete, regenerate) evict entries immediately.
 * 5. Individually switchable: Disabled via REDIS_AUTH_CACHE_DISABLED="true" or AUTH_CACHE_DISABLED="true".
 * 6. Non-blocking / Fail-open: Never throws out of request path when Redis is unavailable or fails.
 */

import crypto from "node:crypto";
import { getRedisClient, isRedisConfigured, withRedisKey } from "@/lib/redis/client.js";
import { getAdapter } from "@/lib/db/driver.js";

export const AUTH_CACHE_TTL_SEC = 60;

/**
 * Hash raw API key using SHA-256 to ensure zero raw secrets in Redis keys.
 * @param {string} rawKey
 * @returns {string} SHA-256 hex digest
 */
export function hashApiKey(rawKey) {
  if (typeof rawKey !== "string" || !rawKey) return "";
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Format the namespaced Redis key for auth cache.
 * @param {string} rawKey
 * @returns {string|null}
 */
export function getAuthCacheKey(rawKey) {
  const hashed = hashApiKey(rawKey);
  return hashed ? withRedisKey(`cache:auth:key:${hashed}`) : null;
}

/**
 * Check whether the advisory auth cache is enabled.
 * Returns false if explicitly disabled by environment variable or if Redis is unconfigured.
 */
export function isAuthCacheEnabled() {
  if (
    process.env.REDIS_AUTH_CACHE_DISABLED === "true" ||
    process.env.AUTH_CACHE_DISABLED === "true"
  ) {
    return false;
  }
  return isRedisConfigured();
}

/**
 * Store API key metadata in Redis with a 60s bounded TTL.
 *
 * @param {string} rawKey - Raw API key
 * @param {Object} data - Metadata object (e.g. id, name, access rules, limits)
 * @param {number} [ttlSeconds=AUTH_CACHE_TTL_SEC] - TTL in seconds
 * @returns {Promise<boolean>} True if cached, false otherwise
 */
export async function setCachedApiKey(rawKey, data, ttlSeconds = AUTH_CACHE_TTL_SEC) {
  if (!isAuthCacheEnabled() || !rawKey || !data) return false;

  try {
    const client = getRedisClient();
    if (!client) return false;

    const cacheKey = getAuthCacheKey(rawKey);
    if (!cacheKey) return false;

    const payload = {
      ...data,
      _cachedAt: Date.now(),
      _expiresAt: Date.now() + ttlSeconds * 1000,
    };

    await client.set(cacheKey, JSON.stringify(payload), "EX", ttlSeconds);
    return true;
  } catch (err) {
    // Fail-open: logging optional, never throw out of request path
    return false;
  }
}

/**
 * Evict cached API key metadata from Redis by raw key.
 *
 * @param {string} rawKey - Raw API key
 * @returns {Promise<boolean>}
 */
export async function evictCachedApiKey(rawKey) {
  if (!isRedisConfigured() || !rawKey) return false;

  try {
    const client = getRedisClient();
    if (!client) return false;

    const cacheKey = getAuthCacheKey(rawKey);
    if (!cacheKey) return false;

    await client.del(cacheKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Evict cached API key metadata by SHA-256 hash.
 *
 * @param {string} apiKeyHash - SHA-256 hex string
 * @returns {Promise<boolean>}
 */
export async function evictCachedApiKeyByHash(apiKeyHash) {
  if (!isRedisConfigured() || !apiKeyHash) return false;

  try {
    const client = getRedisClient();
    if (!client) return false;

    const cacheKey = withRedisKey(`cache:auth:key:${apiKeyHash}`);
    await client.del(cacheKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve cached API key metadata from Redis with mandatory SQLite status verification.
 *
 * NEGATIVE CONTROL INVARIANT:
 * Cache hits NEVER bypass the SQLite status check.
 * If SQLite indicates the key has been revoked, banned, or deleted,
 * the cache entry is immediately evicted and null is returned.
 *
 * @param {string} rawKey - Raw API key
 * @param {Object} [options]
 * @param {boolean} [options.bypassStatusCheck=false] - NEVER use in production; strictly for negative-control test probes
 * @returns {Promise<Object|null>} Cached key metadata if valid & active, null otherwise
 */
export async function getCachedApiKey(rawKey, options = {}) {
  if (!isAuthCacheEnabled() || !rawKey) return null;

  try {
    const client = getRedisClient();
    if (!client) return null;

    const cacheKey = getAuthCacheKey(rawKey);
    if (!cacheKey) return null;

    const raw = await client.get(cacheKey);
    if (!raw) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await client.del(cacheKey);
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      await client.del(cacheKey);
      return null;
    }

    // SQLite Status Check (Authoritative Verification)
    if (!options.bypassStatusCheck) {
      try {
        const db = await getAdapter();
        const row = db.get("SELECT isActive FROM apiKeys WHERE key = ?", [rawKey]);
        const isActive = Boolean(row && (row.isActive === 1 || row.isActive === true));

        if (!isActive) {
          // Negative control triggered: Key revoked, banned, or deleted in SQLite!
          // Evict stale cached metadata immediately and reject authorization.
          await client.del(cacheKey);
          return null;
        }
      } catch (dbErr) {
        // If SQLite is unavailable or errors, fail-closed on authorization
        return null;
      }
    }

    return parsed;
  } catch {
    // Fail-open: Redis error must not crash the request path
    return null;
  }
}

/**
 * Authenticate an API key using advisory cache + SQLite fallback.
 * Checks Redis cache first (with SQLite status verification). On miss, queries SQLite
 * and populates the Redis cache.
 *
 * @param {string} rawKey - Raw API key
 * @returns {Promise<Object|null>} Full active API key record, or null if invalid/inactive
 */
export async function authenticateApiKey(rawKey) {
  if (!rawKey) return null;

  // 1. Try advisory cache
  const cached = await getCachedApiKey(rawKey);
  if (cached) return cached;

  // 2. Query SQLite authoritative record
  try {
    const db = await getAdapter();
    const row = db.get("SELECT * FROM apiKeys WHERE key = ?", [rawKey]);
    if (!row) return null;

    const isActive = row.isActive === 1 || row.isActive === true;
    if (!isActive) return null;

    // Dynamically import rowToKey to avoid circular dependency
    const { getApiKeyByKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const fullKey = await getApiKeyByKey(rawKey);

    if (fullKey && fullKey.isActive) {
      // Advisory population of Redis cache
      await setCachedApiKey(rawKey, fullKey);
    }

    return fullKey;
  } catch {
    return null;
  }
}

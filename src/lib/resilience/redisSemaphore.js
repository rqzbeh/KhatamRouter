/**
 * Lease-based distributed concurrency semaphore using Redis Sorted Sets (ZSET)
 * and Lua scripts, with automatic holder-death pruning and in-process fallback.
 *
 * Design rules (Constitution Principle III & VI, Contract Section 2):
 * - Key pattern: `khatam:semaphore:...` (namespaced via withRedisKey).
 * - Member: `<instanceId>:<requestId>:<timestamp>`
 * - Score: Expiration timestamp in epoch ms (`now + leaseTtlMs`).
 * - Holder death: Stale leases are purged atomically via ZREMRANGEBYSCORE on every acquire.
 * - Fail-open: If Redis is unconfigured, unreachable, or errors out, degrades seamlessly
 *   to InProcessSemaphore without throwing on the request path.
 */

import { randomUUID } from "node:crypto";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";
import { InProcessSemaphore } from "open-sse/services/rateLimitManager/semaphore.js";

export const DEFAULT_LEASE_TTL_MS = 120_000; // 2 minutes

const INSTANCE_ID = typeof process !== "undefined"
  ? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  : "inst-default";

export const SEMAPHORE_TRY_ACQUIRE = `
-- KEYS[1]: Semaphore key
-- ARGV[1]: Current timestamp (epoch ms)
-- ARGV[2]: Lease expiration timestamp (now + leaseTtlMs)
-- ARGV[3]: Max allowed concurrency
-- ARGV[4]: Unique lease ID (<instanceId>:<requestId>:<timestamp>)
-- ARGV[5]: Key TTL in seconds

-- 1. Remove expired leases whose holders have died or completed without release
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])

-- 2. Count active leases
local count = redis.call("ZCARD", KEYS[1])

-- 3. Check limit
if count < tonumber(ARGV[3]) then
  redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
  return { 1, count + 1 }
else
  return { 0, count }
end
`;

export const SEMAPHORE_RELEASE = `
-- KEYS[1]: Semaphore key
-- ARGV[1]: Unique lease ID

redis.call("ZREM", KEYS[1], ARGV[1])
return 1
`;

export class RedisSemaphore {
  constructor(options = {}) {
    this.customClient = options.client !== undefined ? options.client : undefined;
    this.leaseTtlMs = Number(options.leaseTtlMs) || DEFAULT_LEASE_TTL_MS;
    this.instanceId = options.instanceId || INSTANCE_ID;
    this.fallback = options.fallback || new InProcessSemaphore();
    this.warned = false;
  }

  getClient() {
    if (this.customClient !== undefined) return this.customClient;
    if (!isRedisConfigured()) return null;
    return getRedisClient();
  }

  _warnError(err, context = "") {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[redisSemaphore] Redis error${context ? ` in ${context}` : ""}: ${err?.message ?? err} (failing over to in-process semaphore)`);
  }

  _formatKey(key) {
    if (!key) return withRedisKey("semaphore:default");
    const str = String(key);
    return str.startsWith("khatam:") ? str : withRedisKey(str.startsWith("semaphore:") ? str : `semaphore:${str}`);
  }

  _generateLeaseId(requestId) {
    const reqPart = requestId ? String(requestId).replace(/[^a-zA-Z0-9_-]/g, "") : randomUUID().slice(0, 8);
    return `${this.instanceId}:${reqPart}:${Date.now()}`;
  }

  /**
   * Get current in-flight count for a key.
   */
  async getInFlight(key) {
    const client = this.getClient();
    if (!client) {
      return this.fallback.getInFlight(key);
    }
    const redisKey = this._formatKey(key);
    try {
      const now = Date.now();
      if (typeof client.zremrangebyscore === "function") {
        await client.zremrangebyscore(redisKey, "-inf", now);
      }
      if (typeof client.zcard === "function") {
        return Number(await client.zcard(redisKey)) || 0;
      }
      return 0;
    } catch (err) {
      this._warnError(err, "getInFlight");
      return this.fallback.getInFlight(key);
    }
  }

  /**
   * Non-blocking attempt to acquire a lease.
   * Returns `{ acquired: boolean, current: number, limit: number, leaseId?: string, degraded?: boolean }`.
   */
  async tryAcquire(key, maxConcurrent, options = {}) {
    const limit = Number(maxConcurrent) || 0;
    if (limit <= 0) {
      return { acquired: true, current: 0, limit: 0 };
    }

    const client = this.getClient();
    if (!client) {
      const fb = this.fallback.tryAcquire(key, limit);
      return { ...fb, degraded: true };
    }

    const redisKey = this._formatKey(key);
    const now = Number(options.now) || Date.now();
    const ttlMs = Number(options.leaseTtlMs) || this.leaseTtlMs;
    const leaseExpiresAt = now + ttlMs;
    const leaseId = options.leaseId || this._generateLeaseId(options.requestId);
    const keyTtlSec = Math.max(60, Math.ceil((ttlMs * 2) / 1000));

    try {
      if (typeof client.eval === "function") {
        const res = await client.eval(
          SEMAPHORE_TRY_ACQUIRE,
          1,
          redisKey,
          String(now),
          String(leaseExpiresAt),
          String(limit),
          leaseId,
          String(keyTtlSec)
        );

        if (Array.isArray(res)) {
          const acquired = Number(res[0]) === 1;
          const current = Number(res[1]) || 0;
          return {
            acquired,
            current,
            limit,
            ...(acquired ? { leaseId } : {}),
          };
        }
      }

      // Command-based fallback if eval is unavailable
      if (typeof client.zremrangebyscore === "function") {
        await client.zremrangebyscore(redisKey, "-inf", now);
      }
      const count = typeof client.zcard === "function" ? Number(await client.zcard(redisKey)) || 0 : 0;
      if (count < limit) {
        if (typeof client.zadd === "function") {
          await client.zadd(redisKey, leaseExpiresAt, leaseId);
        }
        if (typeof client.expire === "function") {
          await client.expire(redisKey, keyTtlSec).catch(() => {});
        }
        return {
          acquired: true,
          current: count + 1,
          limit,
          leaseId,
        };
      }
      return {
        acquired: false,
        current: count,
        limit,
      };
    } catch (err) {
      this._warnError(err, "tryAcquire");
      const fb = this.fallback.tryAcquire(key, limit);
      return { ...fb, degraded: true };
    }
  }

  /**
   * Acquire a lease, waiting up to maxWaitMs if busy.
   */
  async acquire(key, maxConcurrent, options = {}) {
    const { maxWaitMs = 0, signal } = options;
    const limit = Number(maxConcurrent) || 0;

    const initial = await this.tryAcquire(key, limit, options);
    if (initial.acquired) {
      return initial;
    }

    if (maxWaitMs <= 0 || (signal && signal.aborted)) {
      return {
        acquired: false,
        reason: "concurrency_limit_exceeded",
        current: initial.current,
        limit,
      };
    }

    const start = Date.now();
    const intervalMs = Math.min(100, Math.max(20, Math.floor(maxWaitMs / 10)));

    while (Date.now() - start < maxWaitMs) {
      if (signal && signal.aborted) {
        return {
          acquired: false,
          reason: "aborted",
          current: initial.current,
          limit,
        };
      }

      await new Promise((r) => setTimeout(r, intervalMs));

      const next = await this.tryAcquire(key, limit, options);
      if (next.acquired) {
        return next;
      }
    }

    return {
      acquired: false,
      reason: "concurrency_timeout",
      current: initial.current,
      limit,
    };
  }

  /**
   * Release a lease by unique lease ID.
   */
  async release(key, leaseId) {
    if (!leaseId) {
      // If no leaseId provided, release in-process fallback
      this.fallback.release(key);
      return true;
    }

    const client = this.getClient();
    if (!client) {
      this.fallback.release(key);
      return true;
    }

    const redisKey = this._formatKey(key);
    try {
      if (typeof client.eval === "function") {
        await client.eval(SEMAPHORE_RELEASE, 1, redisKey, String(leaseId));
        return true;
      }
      if (typeof client.zrem === "function") {
        await client.zrem(redisKey, String(leaseId));
        return true;
      }
      return true;
    } catch (err) {
      this._warnError(err, "release");
      this.fallback.release(key);
      return false;
    }
  }

  /**
   * Purge expired leases explicitly (holder-death cleanup).
   */
  async pruneExpired(key, now = Date.now()) {
    const client = this.getClient();
    if (!client) return 0;
    const redisKey = this._formatKey(key);
    try {
      if (typeof client.zremrangebyscore === "function") {
        return await client.zremrangebyscore(redisKey, "-inf", now);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Reset state for testing.
   */
  async reset(key) {
    this.fallback.reset();
    const client = this.getClient();
    if (client && key) {
      const redisKey = this._formatKey(key);
      try {
        if (typeof client.del === "function") await client.del(redisKey);
      } catch {}
    }
  }
}

export const globalRedisSemaphore = new RedisSemaphore();
export default RedisSemaphore;

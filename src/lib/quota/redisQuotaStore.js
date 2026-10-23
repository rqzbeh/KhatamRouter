/**
 * Redis-backed sliding-window quota store using two-bucket weighted interpolation.
 *
 * Algorithm (two-bucket sliding window):
 *  - Given window duration W in ms, bucket index B = floor(T / W).
 *  - Current bucket: B, previous bucket: B - 1.
 *  - Elapsed in current bucket: elapsed = T - (B * W).
 *  - Weight of previous bucket: weightPrev = (W - elapsed) / W.
 *  - Estimated usage = (previousCount * weightPrev) + currentCount.
 *  - If (estimatedUsage + amount) <= limit:
 *      atomically increment current bucket by amount via INCRBYFLOAT,
 *      set key TTL to 2 * window + safety margin,
 *      return allowed: true.
 *    Otherwise:
 *      do not increment, return allowed: false.
 *
 * Fail-open contract (Constitution Principle III & VI):
 *  - When REDIS_URL is unset, or when Redis commands throw, methods catch the error,
 *    emit a single non-fatal warning, and return:
 *    { allowed: true, degraded: true, current: 0, limit, remaining: limit, resetAtMs, resetMs }
 *  - Runs on the request path: MUST NEVER throw.
 *
 * Security:
 *  - Quota keys NEVER store raw API keys in cleartext — keys are SHA-256 hashed.
 *  - No raw secret is ever emitted in logs.
 *  - All Redis keys are strictly namespaced under khatam:quota: (or configured REDIS_KEY_PREFIX).
 */

import { createHash } from "node:crypto";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";
import { SqliteQuotaStore } from "./sqliteQuotaStore.js";

/**
 * Hash a raw API key or token to a SHA-256 hex string so cleartext secrets
 * are never stored in Redis keys, SQLite rows, or logs.
 */
export function hashQuotaKey(key) {
  if (!key || typeof key !== "string") return "anonymous";
  const trimmed = key.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return createHash("sha256").update(trimmed).digest("hex");
}

export function normalizeQuotaKey(key) {
  return hashQuotaKey(key);
}

let redisWarned = false;

function warnRedisError(error, context = "") {
  if (redisWarned) return;
  redisWarned = true;
  console.warn(
    `[quota:redis] Redis operation failed${context ? ` (${context})` : ""}: ${error?.message ?? error} (failing open — non-blocking)`
  );
}

/** Reset warning state (primarily for tests) */
export function resetRedisQuotaWarning() {
  redisWarned = false;
}

const CONSUME_LUA = `
local curr = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local weightPrev = tonumber(ARGV[3])
local ttlSec = tonumber(ARGV[4])
local existing = (prev * weightPrev) + curr
local newUsage = existing + amount
if newUsage <= limit then
  local newCurr = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ttlSec)
  return {1, tostring(newCurr), tostring(prev), tostring(newUsage)}
else
  return {0, tostring(curr), tostring(prev), tostring(existing)}
end
`;

export class RedisQuotaStore {
  constructor(options = {}) {
    this.driver = "redis";
    this.customClient = options.client !== undefined ? options.client : undefined;
    this.fallbackStore = options.fallbackStore || options.fallback || new SqliteQuotaStore(options.sqliteOptions);
  }

  getClient() {
    if (this.customClient !== undefined) return this.customClient;
    if (!isRedisConfigured()) return null;
    return getRedisClient();
  }

  /**
   * Consume `amount` against the sliding window quota for `key`.
   * Returns `{ allowed, remaining, resetAtMs, resetMs, current, limit, degraded? }`.
   * Fails open if Redis is not configured or errors out. Never throws.
   */
  async consume(params = {}) {
    const {
      key,
      limit: rawLimit,
      windowMs: rawWindowMs,
      window: rawWindow,
      amount: rawAmount,
      counterType = "default",
      now: rawNow,
    } = params;

    const limit = Number(rawLimit) || 0;
    const winMs = Number(rawWindowMs) || (Number(rawWindow) ? Number(rawWindow) * 1000 : 60000);
    const amount = rawAmount !== undefined ? Number(rawAmount) : 1;
    const now = Number(rawNow) || Date.now();

    const bucket = Math.floor(now / winMs);
    const prevBucket = bucket - 1;
    const elapsedInCurrent = Math.max(0, now - (bucket * winMs));
    const weightPrev = Math.max(0, Math.min(1, 1 - (elapsedInCurrent / winMs)));
    const resetAtMs = (bucket + 1) * winMs;
    const resetMs = Math.max(0, resetAtMs - now);
    const ttlSec = Math.max(60, Math.ceil((winMs * 2) / 1000) + 10);

    const client = this.getClient();
    if (!client) {
      if (this.fallbackStore) {
        try {
          const fallbackRes = await this.fallbackStore.consume(params);
          return {
            ...fallbackRes,
            degraded: true,
          };
        } catch {
          // Fall through to fail-open
        }
      }
      return {
        allowed: true,
        degraded: true,
        current: 0,
        limit,
        remaining: limit,
        resetAtMs,
        resetMs,
      };
    }

    const normKey = normalizeQuotaKey(key);
    const currKey = withRedisKey(`quota:${normKey}:${counterType}:${bucket}`);
    const prevKey = withRedisKey(`quota:${normKey}:${counterType}:${prevBucket}`);

    try {
      // Try Lua script for atomic multi-replica evaluation
      if (typeof client.eval === "function") {
        try {
          const res = await client.eval(
            CONSUME_LUA,
            2,
            currKey,
            prevKey,
            String(amount),
            String(limit),
            String(weightPrev),
            String(ttlSec)
          );
          if (Array.isArray(res)) {
            const allowed = Number(res[0]) === 1;
            const current = parseFloat(res[3] || "0") || 0;
            return {
              allowed,
              current,
              limit,
              remaining: Math.max(0, limit - current),
              resetAtMs,
              resetMs,
            };
          }
        } catch (evalErr) {
          // If eval is unsupported by mock or cluster, continue to command fallback
        }
      }

      // Command-based two-bucket INCRBYFLOAT fallback
      const [currRaw, prevRaw] = await Promise.all([
        client.get(currKey),
        client.get(prevKey),
      ]);
      const curr = parseFloat(currRaw || "0") || 0;
      const prev = parseFloat(prevRaw || "0") || 0;
      const existing = (prev * weightPrev) + curr;
      const newUsage = existing + amount;

      if (newUsage <= limit) {
        await client.incrbyfloat(currKey, amount);
        if (typeof client.expire === "function") {
          const expiring = client.expire(currKey, ttlSec);
          if (expiring && typeof expiring.catch === "function") await expiring.catch(() => {});
        }
        return {
          allowed: true,
          current: newUsage,
          limit,
          remaining: Math.max(0, limit - newUsage),
          resetAtMs,
          resetMs,
        };
      } else {
        return {
          allowed: false,
          current: existing,
          limit,
          remaining: Math.max(0, limit - existing),
          resetAtMs,
          resetMs,
        };
      }
    } catch (error) {
      warnRedisError(error, "consume");
      if (this.fallbackStore) {
        try {
          const fallbackRes = await this.fallbackStore.consume(params);
          return {
            ...fallbackRes,
            degraded: true,
          };
        } catch {
          // Fall through to fail-open
        }
      }
      return {
        allowed: true,
        degraded: true,
        current: 0,
        limit,
        remaining: limit,
        resetAtMs,
        resetMs,
      };
    }
  }

  /**
   * Inspect current usage without incrementing counters.
   * Returns `{ allowed, remaining, resetAtMs, resetMs, current, limit, degraded? }`.
   * Fails open if Redis is not configured or errors out. Never throws.
   */
  async peek(params = {}) {
    const {
      key,
      limit: rawLimit,
      windowMs: rawWindowMs,
      window: rawWindow,
      amount: rawAmount,
      counterType = "default",
      now: rawNow,
    } = params;

    const limit = Number(rawLimit) || 0;
    const winMs = Number(rawWindowMs) || (Number(rawWindow) ? Number(rawWindow) * 1000 : 60000);
    const amount = rawAmount !== undefined ? Number(rawAmount) : 1;
    const now = Number(rawNow) || Date.now();

    const bucket = Math.floor(now / winMs);
    const prevBucket = bucket - 1;
    const elapsedInCurrent = Math.max(0, now - (bucket * winMs));
    const weightPrev = Math.max(0, Math.min(1, 1 - (elapsedInCurrent / winMs)));
    const resetAtMs = (bucket + 1) * winMs;
    const resetMs = Math.max(0, resetAtMs - now);

    const client = this.getClient();
    if (!client) {
      if (this.fallbackStore) {
        try {
          const fallbackRes = await this.fallbackStore.peek(params);
          return {
            ...fallbackRes,
            degraded: true,
          };
        } catch {}
      }
      return {
        allowed: true,
        degraded: true,
        current: 0,
        limit,
        remaining: limit,
        resetAtMs,
        resetMs,
      };
    }

    const normKey = normalizeQuotaKey(key);
    const currKey = withRedisKey(`quota:${normKey}:${counterType}:${bucket}`);
    const prevKey = withRedisKey(`quota:${normKey}:${counterType}:${prevBucket}`);

    try {
      const [currRaw, prevRaw] = await Promise.all([
        client.get(currKey),
        client.get(prevKey),
      ]);
      const curr = parseFloat(currRaw || "0") || 0;
      const prev = parseFloat(prevRaw || "0") || 0;
      const existing = (prev * weightPrev) + curr;
      const allowed = (existing + amount) <= limit;

      return {
        allowed,
        current: existing,
        limit,
        remaining: Math.max(0, limit - existing),
        resetAtMs,
        resetMs,
      };
    } catch (error) {
      warnRedisError(error, "peek");
      if (this.fallbackStore) {
        try {
          const fallbackRes = await this.fallbackStore.peek(params);
          return {
            ...fallbackRes,
            degraded: true,
          };
        } catch {}
      }
      return {
        allowed: true,
        degraded: true,
        current: 0,
        limit,
        remaining: limit,
        resetAtMs,
        resetMs,
      };
    }
  }
}

export async function consumeRedisQuota(params, store) {
  const s = store || new RedisQuotaStore();
  return s.consume(params);
}

export async function peekRedisQuota(params, store) {
  const s = store || new RedisQuotaStore();
  return s.peek(params);
}

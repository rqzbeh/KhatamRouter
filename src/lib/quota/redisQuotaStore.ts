/**
 * Redis-backed sliding-window quota store using two-bucket weighted interpolation.
 *
 * TypeScript twin of `redisQuotaStore.js`.
 */

import { createHash } from "node:crypto";
import type { Redis as RedisClientType } from "ioredis";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";

export interface QuotaParams {
  key: string;
  limit: number;
  windowMs?: number;
  window?: number;
  amount?: number;
  counterType?: string;
  now?: number;
}

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  resetMs: number;
  current: number;
  limit: number;
  degraded?: boolean;
}

export interface RedisQuotaStoreOptions {
  client?: RedisClientType | null;
}

export function hashQuotaKey(key: string): string {
  if (!key || typeof key !== "string") return "anonymous";
  const trimmed = key.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return createHash("sha256").update(trimmed).digest("hex");
}

export function normalizeQuotaKey(key: string): string {
  return hashQuotaKey(key);
}

let redisWarned = false;

function warnRedisError(error: unknown, context = ""): void {
  if (redisWarned) return;
  redisWarned = true;
  const msg = error instanceof Error ? error.message : String(error);
  console.warn(
    `[quota:redis] Redis operation failed${context ? ` (${context})` : ""}: ${msg} (failing open — non-blocking)`
  );
}

export function resetRedisQuotaWarning(): void {
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
  readonly driver: string = "redis";
  private customClient: RedisClientType | null;

  constructor(options: RedisQuotaStoreOptions = {}) {
    this.customClient = options.client || null;
  }

  getClient(): RedisClientType | null {
    if (this.customClient) return this.customClient;
    if (!isRedisConfigured()) return null;
    return getRedisClient();
  }

  async consume(params: QuotaParams): Promise<QuotaResult> {
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
      if (typeof client.eval === "function") {
        try {
          const res = (await client.eval(
            CONSUME_LUA,
            2,
            currKey,
            prevKey,
            String(amount),
            String(limit),
            String(weightPrev),
            String(ttlSec)
          )) as unknown[];
          if (Array.isArray(res)) {
            const allowed = Number(res[0]) === 1;
            const current = parseFloat(String(res[3] || "0")) || 0;
            return {
              allowed,
              current,
              limit,
              remaining: Math.max(0, limit - current),
              resetAtMs,
              resetMs,
            };
          }
        } catch {
          // Fall through to command fallback
        }
      }

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
          await client.expire(currKey, ttlSec).catch(() => {});
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

  async peek(params: QuotaParams): Promise<QuotaResult> {
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

export async function consumeRedisQuota(
  params: QuotaParams,
  store?: RedisQuotaStore
): Promise<QuotaResult> {
  const s = store || new RedisQuotaStore();
  return s.consume(params);
}

export async function peekRedisQuota(
  params: QuotaParams,
  store?: RedisQuotaStore
): Promise<QuotaResult> {
  const s = store || new RedisQuotaStore();
  return s.peek(params);
}

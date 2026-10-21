/**
 * SQLite-backed sliding-window quota store over `api_key_quota_counters`.
 *
 * Algorithm (two-bucket sliding window):
 *  - Matches RedisQuotaStore sliding-window math identically.
 *  - Backed by SQLite table `api_key_quota_counters(key, window_bucket, counter_type, value, updated_at)`.
 *  - Atomic read-then-UPSERT inside database transaction.
 *
 * Fail-open guard:
 *  - If `api_key_quota_counters` table does not exist (e.g. before Leaf A migrations run),
 *    or on SQLite error, methods catch the error, emit a non-fatal warning once, and fail open:
 *    { allowed: true, degraded: true, current: 0, limit, remaining: limit, resetAtMs, resetMs }
 *  - Never throws on the request path.
 *
 * Security:
 *  - Quota keys are hashed with SHA-256 (normalizeQuotaKey). Cleartext secrets are never stored.
 */

import { getAdapter } from "../db/driver.js";
import { normalizeQuotaKey, hashQuotaKey } from "./redisQuotaStore.js";

// Re-exported so SQLite callers can hash keys the same way without importing the Redis store.
export { normalizeQuotaKey, hashQuotaKey };

let sqliteWarned = false;

function warnSqliteError(error, context = "") {
  if (sqliteWarned) return;
  sqliteWarned = true;
  console.warn(
    `[quota:sqlite] SQLite quota operation failed${context ? ` (${context})` : ""}: ${error?.message ?? error} (failing open — continuing without blocking)`
  );
}

/** Reset warning state (primarily for tests) */
export function resetSqliteQuotaWarning() {
  sqliteWarned = false;
}

export class SqliteQuotaStore {
  constructor(options = {}) {
    this.driver = "sqlite";
    this.tableName = options.tableName || "api_key_quota_counters";
    this.customAdapter = options.adapter || null;
  }

  async getDb() {
    if (this.customAdapter) return this.customAdapter;
    return getAdapter();
  }

  /**
   * Consume `amount` against the sliding window quota in SQLite.
   * Fails open if table does not exist or database throws. Never throws.
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

    const normKey = normalizeQuotaKey(key);

    try {
      const db = await this.getDb();
      let result;

      db.transaction(() => {
        const rows = db.all(
          `SELECT window_bucket, value FROM ${this.tableName} WHERE key = ? AND counter_type = ? AND window_bucket IN (?, ?)`,
          [normKey, counterType, bucket, prevBucket]
        );

        let curr = 0;
        let prev = 0;
        for (const row of rows || []) {
          if (row.window_bucket === bucket) curr = Number(row.value) || 0;
          else if (row.window_bucket === prevBucket) prev = Number(row.value) || 0;
        }

        const existing = (prev * weightPrev) + curr;
        const newUsage = existing + amount;

        if (newUsage <= limit) {
          db.run(
            `INSERT INTO ${this.tableName} (key, window_bucket, counter_type, value, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (key, window_bucket, counter_type)
             DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
            [normKey, bucket, counterType, amount, now]
          );

          result = {
            allowed: true,
            current: newUsage,
            limit,
            remaining: Math.max(0, limit - newUsage),
            resetAtMs,
            resetMs,
          };
        } else {
          result = {
            allowed: false,
            current: existing,
            limit,
            remaining: Math.max(0, limit - existing),
            resetAtMs,
            resetMs,
          };
        }
      });

      return result;
    } catch (error) {
      warnSqliteError(error, "consume");
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
   * Fails open if table does not exist or database throws. Never throws.
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

    const normKey = normalizeQuotaKey(key);

    try {
      const db = await this.getDb();
      const rows = db.all(
        `SELECT window_bucket, value FROM ${this.tableName} WHERE key = ? AND counter_type = ? AND window_bucket IN (?, ?)`,
        [normKey, counterType, bucket, prevBucket]
      );

      let curr = 0;
      let prev = 0;
      for (const row of rows || []) {
        if (row.window_bucket === bucket) curr = Number(row.value) || 0;
        else if (row.window_bucket === prevBucket) prev = Number(row.value) || 0;
      }

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
      warnSqliteError(error, "peek");
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

export async function consumeSqliteQuota(params, store) {
  const s = store || new SqliteQuotaStore();
  return s.consume(params);
}

export async function peekSqliteQuota(params, store) {
  const s = store || new SqliteQuotaStore();
  return s.peek(params);
}

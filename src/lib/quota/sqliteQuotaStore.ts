/**
 * SQLite-backed sliding-window quota store over `api_key_quota_counters`.
 *
 * TypeScript twin of `sqliteQuotaStore.js`.
 */

import { getAdapter } from "../db/driver.js";
import { normalizeQuotaKey, hashQuotaKey } from "./redisQuotaStore.js";
import type { QuotaParams, QuotaResult } from "./redisQuotaStore.js";

export { normalizeQuotaKey, hashQuotaKey };

export interface SqliteQuotaStoreOptions {
  tableName?: string;
  adapter?: any;
}

let sqliteWarned = false;

function warnSqliteError(error: unknown, context = ""): void {
  if (sqliteWarned) return;
  sqliteWarned = true;
  const msg = error instanceof Error ? error.message : String(error);
  console.warn(
    `[quota:sqlite] SQLite quota operation failed${context ? ` (${context})` : ""}: ${msg} (failing open — continuing without blocking)`
  );
}

export function resetSqliteQuotaWarning(): void {
  sqliteWarned = false;
}

export class SqliteQuotaStore {
  readonly driver: string = "sqlite";
  readonly tableName: string;
  private customAdapter: any;

  constructor(options: SqliteQuotaStoreOptions = {}) {
    this.tableName = options.tableName || "api_key_quota_counters";
    this.customAdapter = options.adapter || null;
  }

  async getDb(): Promise<any> {
    if (this.customAdapter) return this.customAdapter;
    return getAdapter();
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

    const normKey = normalizeQuotaKey(key);

    try {
      const db = await this.getDb();
      let result: QuotaResult | undefined;

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

      return result!;
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

export async function consumeSqliteQuota(
  params: QuotaParams,
  store?: SqliteQuotaStore
): Promise<QuotaResult> {
  const s = store || new SqliteQuotaStore();
  return s.consume(params);
}

export async function peekSqliteQuota(
  params: QuotaParams,
  store?: SqliteQuotaStore
): Promise<QuotaResult> {
  const s = store || new SqliteQuotaStore();
  return s.peek(params);
}

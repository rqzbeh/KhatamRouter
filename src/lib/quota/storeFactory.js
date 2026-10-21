/**
 * Quota Store Factory.
 *
 * Instantiates and returns the appropriate quota store:
 *  - RedisQuotaStore when REDIS_URL is configured (cluster-wide distributed rate limits).
 *  - SqliteQuotaStore backed by `api_key_quota_counters` when REDIS_URL is unset.
 */

import { isRedisConfigured } from "../redis/client.js";
import { RedisQuotaStore } from "./redisQuotaStore.js";
import { SqliteQuotaStore } from "./sqliteQuotaStore.js";

let defaultStore = null;

export function storeFactory(options = {}) {
  const { forceStore, ...rest } = options;

  if (forceStore === "redis") {
    return new RedisQuotaStore(rest);
  }
  if (forceStore === "sqlite") {
    return new SqliteQuotaStore(rest);
  }

  if (isRedisConfigured()) {
    return new RedisQuotaStore(rest);
  }

  return new SqliteQuotaStore(rest);
}

/** Alias matching spec naming */
export const quotaStoreFactory = storeFactory;

/**
 * Memoised default store for the current process. REDIS_URL is read at call
 * time, so tests that flip it should call resetDefaultQuotaStore() first.
 */
export function getQuotaStore() {
  if (!defaultStore) defaultStore = storeFactory();
  return defaultStore;
}

export function resetDefaultQuotaStore() {
  defaultStore = null;
}

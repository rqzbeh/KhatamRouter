/**
 * Quota Store Factory.
 *
 * TypeScript twin of `storeFactory.js`.
 */

import { isRedisConfigured } from "../redis/client.js";
import { RedisQuotaStore, type RedisQuotaStoreOptions } from "./redisQuotaStore.js";
import { SqliteQuotaStore, type SqliteQuotaStoreOptions } from "./sqliteQuotaStore.js";

export type QuotaStore = RedisQuotaStore | SqliteQuotaStore;

export interface StoreFactoryOptions extends RedisQuotaStoreOptions, SqliteQuotaStoreOptions {
  forceStore?: "redis" | "sqlite";
}

let defaultStore: QuotaStore | null = null;

export function storeFactory(options: StoreFactoryOptions = {}): QuotaStore {
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

export const quotaStoreFactory = storeFactory;

export function getQuotaStore(): QuotaStore {
  if (!defaultStore) defaultStore = storeFactory();
  return defaultStore;
}

export function resetDefaultQuotaStore(): void {
  defaultStore = null;
}

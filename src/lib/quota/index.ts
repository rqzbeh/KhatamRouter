/**
 * Quota subsystem barrel — TypeScript twin of index.js.
 */

export {
  storeFactory,
  quotaStoreFactory,
  getQuotaStore,
  resetDefaultQuotaStore,
  type QuotaStore,
  type StoreFactoryOptions,
} from "./storeFactory.js";

export {
  RedisQuotaStore,
  consumeRedisQuota,
  peekRedisQuota,
  hashQuotaKey,
  normalizeQuotaKey,
  resetRedisQuotaWarning,
  type QuotaParams,
  type QuotaResult,
  type RedisQuotaStoreOptions,
} from "./redisQuotaStore.js";

export {
  SqliteQuotaStore,
  consumeSqliteQuota,
  peekSqliteQuota,
  resetSqliteQuotaWarning,
  type SqliteQuotaStoreOptions,
} from "./sqliteQuotaStore.js";

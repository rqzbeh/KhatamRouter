/**
 * Quota subsystem barrel — T009's `quotaStoreFactory()` lives on storeFactory.
 */

export {
  storeFactory,
  quotaStoreFactory,
  getQuotaStore,
  resetDefaultQuotaStore,
} from "./storeFactory.js";

export {
  RedisQuotaStore,
  consumeRedisQuota,
  peekRedisQuota,
  hashQuotaKey,
  normalizeQuotaKey,
  resetRedisQuotaWarning,
} from "./redisQuotaStore.js";

export {
  SqliteQuotaStore,
  consumeSqliteQuota,
  peekSqliteQuota,
  resetSqliteQuotaWarning,
} from "./sqliteQuotaStore.js";

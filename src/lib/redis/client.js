/**
 * Shared Redis client for KhatamRouter cluster state (rate limits, quotas,
 * circuit breakers, pub/sub).
 *
 * Design rules (Constitution Principle III):
 * - Every key is namespaced under REDIS_KEY_PREFIX (default `khatam:`).
 * - Redis is always optional: when REDIS_URL is unset the module returns null
 *   / false instead of throwing, and callers keep working on SQLite.
 * - When REDIS_URL is set but unreachable, connections retry with exponential
 *   backoff while every API here stays non-blocking and fail-open.
 */

import Redis from "ioredis";

/** Fallback prefix when process.env.REDIS_KEY_PREFIX is unset/empty. */
export const REDIS_KEY_PREFIX_DEFAULT = "khatam:";

/**
 * Import-time snapshot of the configured prefix. Prefer `withRedisKey()` /
 * `getRedisKeyPrefix()` inside code paths that may run after env overrides.
 */
export const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || REDIS_KEY_PREFIX_DEFAULT;

/** Current prefix, re-read from env so runtime overrides apply. */
export function getRedisKeyPrefix() {
  return process.env.REDIS_KEY_PREFIX || REDIS_KEY_PREFIX_DEFAULT;
}

/**
 * Namespace a key suffix under the configured prefix.
 * `withRedisKey("quota:user:1")` → `khatam:quota:user:1`
 * The prefix is normalised to end with `:` so `custom` → `custom:` too.
 */
export function withRedisKey(suffix = "") {
  const prefix = getRedisKeyPrefix();
  const normalized = prefix.endsWith(":") ? prefix : `${prefix}:`;
  return `${normalized}${String(suffix ?? "")}`;
}

/** True when an explicit Redis endpoint was configured for this process. */
export function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Connection options shared by the command client and the pub/sub subscriber.
 * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` keep callers from
 * blocking on a dead Redis; `retryStrategy` keeps the socket reconnecting in
 * the background instead.
 */
export function createRedisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    // Exponential backoff (100ms → 30s cap), never stops retrying.
    retryStrategy(times) {
      return Math.min(100 * 2 ** Math.min(times, 8), 30000);
    },
  };
}

let client = null;
let subscriber = null;
let offlineWarned = false;

function warnOffline(message) {
  if (offlineWarned) return;
  offlineWarned = true;
  console.warn(`[redis] ${message} (continuing without Redis — non-blocking fail-open)`);
}

function startConnection(instance, label) {
  // An 'error' listener must exist before connect(): ioredis emits (never
  // throws) on connection failure, and an unhandled 'error' event would crash
  // the process.
  instance.on("error", (error) => {
    warnOffline(`${label} connection error: ${error?.message ?? error}`);
  });
  const started = instance.connect();
  if (started && typeof started.catch === "function") started.catch(() => {});
  return instance;
}

/**
 * Lazily create the command client.
 * Returns `null` when REDIS_URL is unset (no Redis, no error), or the ioredis
 * instance otherwise. The instance may still be connecting — check
 * `isRedisAvailable()` before issuing commands.
 */
export function getRedisClient() {
  if (!isRedisConfigured()) {
    warnOffline("REDIS_URL is not set — running without Redis");
    return null;
  }
  if (client) return client;
  client = startConnection(new Redis(process.env.REDIS_URL, createRedisOptions()), "redis");
  return client;
}

/**
 * Lazily create a dedicated pub/sub connection (ioredis switches a connection
 * into subscriber mode, so it cannot share the command client).
 */
export function getRedisSubscriber() {
  if (!isRedisConfigured()) return null;
  if (subscriber) return subscriber;
  subscriber = startConnection(new Redis(process.env.REDIS_URL, createRedisOptions()), "redis subscriber");
  return subscriber;
}

/** True only when a Redis connection exists and is ready. Never throws. */
export function isRedisAvailable() {
  try {
    if (!isRedisConfigured()) return false;
    if (!client && !subscriber) return false;
    if (client && client.status === "ready") return true;
    if (subscriber && subscriber.status === "ready") return true;
    return false;
  } catch {
    return false;
  }
}

async function closeInstance(instance) {
  if (!instance) return;
  try {
    if (instance.status === "ready") await instance.quit();
  } catch {
    try { instance.disconnect(); } catch {}
  }
  try { instance.disconnect(); } catch {}
  try { instance.removeAllListeners(); } catch {}
}

/** Close both connections and reset module state. Safe to call when unused. */
export async function closeRedisClient() {
  const activeSubscriber = subscriber;
  const activeClient = client;
  subscriber = null;
  client = null;
  offlineWarned = false;
  await closeInstance(activeSubscriber);
  await closeInstance(activeClient);
}

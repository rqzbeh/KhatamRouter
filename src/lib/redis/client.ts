/**
 * Shared Redis client for KhatamRouter cluster state (rate limits, quotas,
 * circuit breakers, pub/sub).
 *
 * TypeScript twin of `client.js`.
 */

import Redis, { type Redis as RedisClientType, type RedisOptions } from "ioredis";

export const REDIS_KEY_PREFIX_DEFAULT = "khatam:";

export const REDIS_KEY_PREFIX: string = process.env.REDIS_KEY_PREFIX || REDIS_KEY_PREFIX_DEFAULT;

export function getRedisKeyPrefix(): string {
  return process.env.REDIS_KEY_PREFIX || REDIS_KEY_PREFIX_DEFAULT;
}

export function withRedisKey(suffix = ""): string {
  const prefix = getRedisKeyPrefix();
  const normalized = prefix.endsWith(":") ? prefix : `${prefix}:`;
  return `${normalized}${String(suffix ?? "")}`;
}

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export function createRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    retryStrategy(times: number): number {
      return Math.min(100 * 2 ** Math.min(times, 8), 30000);
    },
  };
}

let client: RedisClientType | null = null;
let subscriber: RedisClientType | null = null;
let offlineWarned = false;

function warnOffline(message: string): void {
  if (offlineWarned) return;
  offlineWarned = true;
  console.warn(`[redis] ${message} (continuing without Redis — non-blocking fail-open)`);
}

function startConnection(instance: RedisClientType, label: string): RedisClientType {
  instance.on("error", (error: Error) => {
    warnOffline(`${label} connection error: ${error?.message ?? error}`);
  });
  const started = instance.connect();
  if (started && typeof started.catch === "function") started.catch(() => {});
  return instance;
}

export function getRedisClient(): RedisClientType | null {
  if (!isRedisConfigured()) {
    warnOffline("REDIS_URL is not set — running without Redis");
    return null;
  }
  if (client) return client;
  client = startConnection(new Redis(process.env.REDIS_URL as string, createRedisOptions()), "redis");
  return client;
}

export function getRedisSubscriber(): RedisClientType | null {
  if (!isRedisConfigured()) return null;
  if (subscriber) return subscriber;
  subscriber = startConnection(new Redis(process.env.REDIS_URL as string, createRedisOptions()), "redis subscriber");
  return subscriber;
}

export function isRedisAvailable(): boolean {
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

async function closeInstance(instance: RedisClientType | null): Promise<void> {
  if (!instance) return;
  try {
    if (instance.status === "ready") await instance.quit();
  } catch {
    try { instance.disconnect(); } catch {}
  }
  try { instance.disconnect(); } catch {}
  try { instance.removeAllListeners(); } catch {}
}

export function setRedisClient(newClient: RedisClientType | null): void {
  client = newClient;
}

export function setRedisSubscriber(newSubscriber: RedisClientType | null): void {
  subscriber = newSubscriber;
}

export async function closeRedisClient(): Promise<void> {
  const activeSubscriber = subscriber;
  const activeClient = client;
  subscriber = null;
  client = null;
  offlineWarned = false;
  await closeInstance(activeSubscriber);
  await closeInstance(activeClient);
}

/**
 * KhatamRouter cluster event bus — TypeScript twin of `events.js`.
 */

import { EventEmitter } from "node:events";
import type { Redis as RedisClientType } from "ioredis";
import { getRedisSubscriber, isRedisConfigured, isRedisAvailable } from "./client.js";

export const KHATAM_EVENTS = Object.freeze({
  CONFIG_RELOAD: "khatam:events:config_reload",
  CIRCUIT_TRIP: "khatam:events:circuit_trip",
  QUOTA_EXCEEDED: "khatam:events:quota_exceeded",
} as const);

export type KhatamEventChannel = (typeof KHATAM_EVENTS)[keyof typeof KHATAM_EVENTS];
export type KhatamEventHandler<T = unknown> = (payload: T) => void;

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const localBus = new EventEmitter();
localBus.setMaxListeners(200);

const redisSubscriptions = new Map<string, { status: "pending" | "ready" }>();
const messageHooked = new WeakSet<object>();
let publishWarned = false;

function warnPublish(message: string): void {
  if (publishWarned) return;
  publishWarned = true;
  console.warn(`[redis] ${message} (events still delivered locally)`);
}

function parseEnvelope(raw: unknown): { source: unknown; payload: unknown } {
  if (typeof raw !== "string") return { source: null, payload: raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "source" in parsed) {
      return { source: parsed.source, payload: parsed.payload ?? null };
    }
    return { source: null, payload: parsed };
  } catch {
    return { source: null, payload: raw };
  }
}

function ensureMessageHook(sub: RedisClientType): void {
  if (messageHooked.has(sub)) return;
  messageHooked.add(sub);
  sub.on("message", (channel: string, raw: string) => {
    const { source, payload } = parseEnvelope(raw);
    if (source === INSTANCE_ID) return;
    localBus.emit(channel, payload);
  });
}

function subscribeOnRedis(channel: string): void {
  if (!isRedisConfigured()) return;
  if (redisSubscriptions.has(channel)) return;
  const sub = getRedisSubscriber();
  if (!sub) return;

  redisSubscriptions.set(channel, { status: "pending" });
  ensureMessageHook(sub);

  const doSubscribe = () => {
    sub.subscribe(channel)
      .then(() => { redisSubscriptions.set(channel, { status: "ready" }); })
      .catch(() => { redisSubscriptions.delete(channel); });
  };

  if (sub.status === "ready") doSubscribe();
  else sub.once("ready", doSubscribe);
}

function unsubscribeOnRedis(channel: string): void {
  const sub = getRedisSubscriber();
  if (!sub) {
    redisSubscriptions.delete(channel);
    return;
  }
  redisSubscriptions.delete(channel);
  if (sub.status !== "ready") return;
  sub.unsubscribe(channel).catch(() => {});
}

export function publishKhatamEvent<T = unknown>(channel: KhatamEventChannel | string, payload?: T): boolean {
  if (typeof channel !== "string" || !channel) {
    throw new TypeError("[redis] publishKhatamEvent(channel, payload) requires a non-empty channel string");
  }

  localBus.emit(channel, payload);

  if (!isRedisConfigured()) return false;
  const sub = getRedisSubscriber();
  if (!sub || !isRedisAvailable()) return false;

  try {
    const raw = JSON.stringify({ source: INSTANCE_ID, payload: payload ?? null });
    const published = sub.publish(channel, raw);
    if (published && typeof published.catch === "function") {
      published.catch((error: Error) => {
        warnPublish(`publish to ${channel} failed: ${error?.message ?? error}`);
      });
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnPublish(`publish to ${channel} failed: ${message}`);
    return false;
  }
}

export function subscribeKhatamEvent<T = unknown>(
  channel: KhatamEventChannel | string,
  handler: KhatamEventHandler<T>
): () => void {
  if (typeof channel !== "string" || !channel) {
    throw new TypeError("[redis] subscribeKhatamEvent(channel, handler) requires a non-empty channel string");
  }
  if (typeof handler !== "function") {
    throw new TypeError("[redis] subscribeKhatamEvent(channel, handler) requires a handler function");
  }

  localBus.on(channel, handler as (payload: unknown) => void);
  subscribeOnRedis(channel);

  return function unsubscribe(): void {
    localBus.off(channel, handler as (payload: unknown) => void);
    if (localBus.listenerCount(channel) === 0) unsubscribeOnRedis(channel);
  };
}

export function localKhatamEventListenerCount(channel: string): number {
  return localBus.listenerCount(channel);
}

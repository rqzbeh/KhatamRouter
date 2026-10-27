/**
 * KhatamRouter cluster event bus.
 *
 * Every event is delivered twice by design:
 *  1. on the in-process EventEmitter bus — local listeners and tests always
 *     receive the payload synchronously, Redis or not;
 *  2. over Redis Pub/Sub when REDIS_URL is configured — so other replicas see it.
 *
 * A message this process published is tagged with its source id and skipped on
 * the Redis fan-out, so a single process never handles its own event twice.
 */

import { EventEmitter } from "node:events";
import {
  getRedisClient,
  getRedisSubscriber,
  isRedisConfigured,
  isRedisAvailable,
} from "./client.js";

/** Canonical channel names — already fully qualified under the khatam: namespace. */
export const KHATAM_EVENTS = Object.freeze({
  CONFIG_RELOAD: "khatam:events:config_reload",
  CIRCUIT_TRIP: "khatam:events:circuit_trip",
  QUOTA_EXCEEDED: "khatam:events:quota_exceeded",
  USAGE: "khatam:events:usage",
  CONSOLE_LOG: "khatam:events:console_log",
});

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const localBus = new EventEmitter();
localBus.setMaxListeners(200);

/** channel → subscription state on the Redis subscriber connection. */
const redisSubscriptions = new Map();
const messageHooked = new WeakSet();
let publishWarned = false;

function warnPublish(message) {
  if (publishWarned) return;
  publishWarned = true;
  console.warn(`[redis] ${message} (events still delivered locally)`);
}

// Cross-worker IPC fallback (REDIS_URL unset, cluster worker only). Internal, no exports.
const IPC_RELOAD_SCOPES = Object.freeze(["aliases", "combos", "nodes", "settings", "all"]);
const IPC_LISTENER_KEY = Symbol.for("khatam.events.ipcListener");
let applyingPrimaryMessage = false;

/** The supervisor sets KHATAM_WORKER_ROLE on every worker and provides an IPC channel. */
function isIpcWorker() {
  return typeof process.send === "function" && Boolean(process.env.KHATAM_WORKER_ROLE) && !isRedisConfigured();
}

function relayToPrimary(channel, payload) {
  if (channel !== KHATAM_EVENTS.CONFIG_RELOAD || applyingPrimaryMessage) return;
  if (!isIpcWorker()) return;
  const scope = payload?.scope;
  if (!IPC_RELOAD_SCOPES.includes(scope)) return;
  try {
    process.send({ type: "config_reload", scope });
  } catch (error) {
    warnPublish(`IPC relay to primary failed: ${error?.message ?? error}`);
  }
}

// Primary broadcast arrives here. Emit locally only; applyingPrimaryMessage stops a re-send (no echo loop).
function onPrimaryMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.type !== "config_reload") return;
  if (!IPC_RELOAD_SCOPES.includes(msg.scope)) return;
  applyingPrimaryMessage = true;
  try {
    localBus.emit(KHATAM_EVENTS.CONFIG_RELOAD, { scope: msg.scope });
  } finally {
    applyingPrimaryMessage = false;
  }
}

if (isIpcWorker()) {
  // Replace the listener from any previously loaded copy of this module.
  const previous = globalThis[IPC_LISTENER_KEY];
  if (previous) process.off("message", previous);
  globalThis[IPC_LISTENER_KEY] = onPrimaryMessage;
  process.on("message", onPrimaryMessage);
}

function parseEnvelope(raw) {
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

function ensureMessageHook(sub) {
  if (messageHooked.has(sub)) return;
  messageHooked.add(sub);
  sub.on("message", (channel, raw) => {
    const { source, payload } = parseEnvelope(raw);
    // Already delivered by the local bus when we published it ourselves.
    if (source === INSTANCE_ID) return;
    localBus.emit(channel, payload);
  });
}

function subscribeOnRedis(channel) {
  if (!isRedisConfigured()) return;
  const state = redisSubscriptions.get(channel);
  if (state) return;
  const sub = getRedisSubscriber();
  if (!sub) return;

  redisSubscriptions.set(channel, { status: "pending" });
  ensureMessageHook(sub);

  const doSubscribe = () => {
    sub.subscribe(channel)
      .then(() => { redisSubscriptions.set(channel, { status: "ready" }); })
      .catch(() => {
        // Fail open: drop the pending attempt so a later subscribe can retry;
        // local delivery is unaffected.
        redisSubscriptions.delete(channel);
      });
  };

  if (sub.status === "ready") doSubscribe();
  else sub.once("ready", doSubscribe);
}

function unsubscribeOnRedis(channel) {
  const sub = getRedisSubscriber();
  if (!sub) {
    redisSubscriptions.delete(channel);
    return;
  }
  redisSubscriptions.delete(channel);
  if (sub.status !== "ready") return;
  sub.unsubscribe(channel).catch(() => {});
}

/**
 * Publish an event locally and (when configured) to Redis.
 *
 * Returns `true` when the event was handed to Redis, `false` when only local
 * delivery happened (Redis unset/unreachable — fail-open, never throws).
 * Redis errors are swallowed after a single warning.
 */
export function publishKhatamEvent(channel, payload) {
  if (typeof channel !== "string" || !channel) {
    throw new TypeError("[redis] publishKhatamEvent(channel, payload) requires a non-empty channel string");
  }

  // Local bus first: local listeners and tests always receive it immediately.
  localBus.emit(channel, payload);

  if (!isRedisConfigured()) {
    relayToPrimary(channel, payload);
    return false;
  }
  const client = getRedisClient();
  if (!client || !isRedisAvailable()) return false;

  try {
    const raw = JSON.stringify({ source: INSTANCE_ID, payload: payload ?? null });
    const published = client.publish(channel, raw);
    if (published && typeof published.catch === "function") {
      published.catch((error) => {
        warnPublish(`publish to ${channel} failed: ${error?.message ?? error}`);
      });
    }
    return true;
  } catch (error) {
    warnPublish(`publish to ${channel} failed: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Subscribe to an event.
 *
 * The handler fires on the local bus synchronously for every publish from this
 * process, and on Redis messages from other replicas once the subscription is
 * up. Returns an unsubscribe function.
 */
export function subscribeKhatamEvent(channel, handler) {
  if (typeof channel !== "string" || !channel) {
    throw new TypeError("[redis] subscribeKhatamEvent(channel, handler) requires a non-empty channel string");
  }
  if (typeof handler !== "function") {
    throw new TypeError("[redis] subscribeKhatamEvent(channel, handler) requires a handler function");
  }

  localBus.on(channel, handler);
  subscribeOnRedis(channel);

  return function unsubscribe() {
    localBus.off(channel, handler);
    if (localBus.listenerCount(channel) === 0) unsubscribeOnRedis(channel);
  };
}

/** Number of local listeners for a channel (diagnostics / tests). */
export function localKhatamEventListenerCount(channel) {
  return localBus.listenerCount(channel);
}

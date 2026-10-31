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
import * as redisClient from "./client.js";

const getRedisClient = () => redisClient.getRedisClient?.();
const getRedisSubscriber = () => redisClient.getRedisSubscriber?.();
const isRedisConfigured = () => redisClient.isRedisConfigured?.() ?? false;
const isRedisAvailable = () => redisClient.isRedisAvailable?.() ?? false;
const isRedisPublisherReady = () => {
  try {
    if (typeof redisClient.isRedisPublisherReady === "function") {
      return redisClient.isRedisPublisherReady();
    }
  } catch {
    // Fall back to isRedisAvailable when mocked without isRedisPublisherReady
  }
  return isRedisAvailable();
};

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

// Bounded startup and reconnect coalescing for CONFIG_RELOAD invalidations.
const pendingReloads = new Map();
const MAX_PENDING_RELOADS = 20;

function queueConfigReload(payload) {
  const scope = (payload && typeof payload === "object" && typeof payload.scope === "string")
    ? payload.scope
    : null;

  if (scope === "all" || pendingReloads.has("all")) {
    pendingReloads.clear();
    pendingReloads.set("all", payload || { scope: "all", timestamp: Date.now() });
    return;
  }

  const key = scope || "__default__";
  pendingReloads.set(key, payload ?? null);

  if (pendingReloads.size >= MAX_PENDING_RELOADS) {
    pendingReloads.clear();
    pendingReloads.set("all", { scope: "all", timestamp: Date.now() });
  }
}

const clientHooked = new WeakSet();

async function publishCoalescedWithRetry(client, payload, maxRetries = 4) {
  const channel = KHATAM_EVENTS.CONFIG_RELOAD;
  const raw = JSON.stringify({
    source: INSTANCE_ID,
    payload: payload ?? null,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!client || client.status !== "ready") {
      queueConfigReload(payload);
      return;
    }
    try {
      const subscribers = await client.publish(channel, raw);
      if (subscribers > 0 || attempt === maxRetries) {
        return;
      }
      // If 0 subscribers reached, remote replicas might still be reconnecting.
      // Wait briefly (100ms, 250ms, 500ms, 750ms) and retry.
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * (attempt + 1) ** 1.5, 750)));
    } catch (err) {
      warnPublish(`publish coalesced config_reload failed: ${err?.message ?? err}`);
      queueConfigReload(payload);
      return;
    }
  }
}

function flushPendingReloads(client) {
  if (pendingReloads.size === 0) return;
  if (!client || client.status !== "ready") return;

  const entries = Array.from(pendingReloads.entries());
  pendingReloads.clear();

  for (const [, payload] of entries) {
    publishCoalescedWithRetry(client, payload).catch((err) => {
      warnPublish(`publish coalesced config_reload unhandled: ${err?.message ?? err}`);
    });
  }
}

function ensurePublisherReadyHook(client) {
  if (!client || typeof client.on !== "function" || clientHooked.has(client)) return;
  clientHooked.add(client);
  client.on("ready", () => {
    flushPendingReloads(client);
  });
}

/** Clear pending coalesced events (diagnostics / tests). */
export function clearPendingKhatamEvents() {
  pendingReloads.clear();
}

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

  ensureMessageHook(sub);

  const doSubscribe = () => {
    if (sub.status !== "ready") return;
    sub.subscribe(channel)
      .then(() => {
        const current = redisSubscriptions.get(channel);
        if (current) current.status = "ready";
      })
      .catch(() => {
        // Fail open: drop the pending attempt so a later subscribe can retry;
        // local delivery is unaffected.
        redisSubscriptions.delete(channel);
      });
  };

  redisSubscriptions.set(channel, { status: "pending", onReady: doSubscribe });

  if (sub.status === "ready") {
    doSubscribe();
  }
  if (typeof sub.on === "function") {
    sub.on("ready", doSubscribe);
  }
}

function unsubscribeOnRedis(channel) {
  const sub = getRedisSubscriber();
  const state = redisSubscriptions.get(channel);
  redisSubscriptions.delete(channel);
  if (!sub) return;
  if (state?.onReady && typeof sub.off === "function") {
    sub.off("ready", state.onReady);
  }
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
  if (client) {
    ensurePublisherReadyHook(client);
  }

  // Publishing readiness must depend strictly on publisher client.status === "ready"
  // rather than either publisher/subscriber, preventing "Stream isn't writeable"
  // errors when enableOfflineQueue is false.
  const isReady = typeof isRedisPublisherReady === "function"
    ? isRedisPublisherReady()
    : Boolean(client && client.status === "ready");

  if (!isReady) {
    if (channel === KHATAM_EVENTS.CONFIG_RELOAD) {
      queueConfigReload(payload);
    }
    return false;
  }

  // Flush any previously coalesced invalidations first
  flushPendingReloads(client);

  try {
    const raw = JSON.stringify({ source: INSTANCE_ID, payload: payload ?? null });
    const published = client.publish(channel, raw);
    if (published && typeof published.catch === "function") {
      published.catch((error) => {
        warnPublish(`publish to ${channel} failed: ${error?.message ?? error}`);
        if (channel === KHATAM_EVENTS.CONFIG_RELOAD) {
          queueConfigReload(payload);
        }
      });
    }
    return true;
  } catch (error) {
    warnPublish(`publish to ${channel} failed: ${error?.message ?? error}`);
    if (channel === KHATAM_EVENTS.CONFIG_RELOAD) {
      queueConfigReload(payload);
    }
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

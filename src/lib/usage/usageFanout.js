/**
 * Distributed Usage Event Fan-Out (Redis Pub/Sub Accelerator)
 *
 * Design Invariants (contracts/redis-conventions.md & FR-021, FR-022):
 * 1. Channel: "khatam:events:usage"
 * 2. Envelope Schema: { source, channel, timestamp, payload }
 * 3. Client Separation Invariant:
 *    - getRedisClient() for publishing
 *    - getRedisSubscriber() for subscribing
 * 4. Zero Double-Echo: An instance skips events published with its own instanceId.
 * 5. Fail-Open: Always delivers locally first; Redis publish/subscribe errors never throw.
 */

import { EventEmitter } from "node:events";
import {
  getRedisClient,
  getRedisSubscriber,
  isRedisConfigured,
  isRedisAvailable,
} from "@/lib/redis/client.js";

export const USAGE_CHANNEL = "khatam:events:usage";

let instanceId = `usage-inst-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Get current instance ID.
 */
export function getInstanceId() {
  return instanceId;
}

/**
 * Test seam to set instance ID.
 */
export function setInstanceId(newId) {
  instanceId = newId;
}

const localUsageBus = new EventEmitter();
localUsageBus.setMaxListeners(200);

let isSubscribed = false;
let messageListener = null;

function parseEnvelope(raw) {
  if (typeof raw !== "string") return { source: null, payload: raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "source" in parsed) {
      return {
        source: parsed.source,
        channel: parsed.channel,
        timestamp: parsed.timestamp,
        payload: parsed.payload ?? null,
      };
    }
    return { source: null, payload: parsed };
  } catch {
    return { source: null, payload: raw };
  }
}

/**
 * Ensure Redis subscriber is hooked up to the usage channel.
 */
export function initUsageFanout() {
  if (!isRedisConfigured() || isSubscribed) return;

  const sub = getRedisSubscriber();
  if (!sub) return;

  messageListener = (channel, raw) => {
    if (channel !== USAGE_CHANNEL) return;

    const envelope = parseEnvelope(raw);

    // INVARIANT: Prevent duplicate local echo
    if (envelope.source === instanceId) {
      return;
    }

    // Deliver to remote listeners on this instance
    localUsageBus.emit("usage", envelope.payload);
  };

  sub.on("message", messageListener);

  const subscribeIfReady = () => {
    sub.subscribe(USAGE_CHANNEL).catch(() => {});
  };

  if (sub.status === "ready") {
    subscribeIfReady();
  } else {
    sub.once("ready", subscribeIfReady);
  }

  isSubscribed = true;
}

/**
 * Subscribe a listener function to live usage events.
 * Receives both local usage events and fanned-out usage events from cluster replicas.
 *
 * @param {Function} listener
 * @returns {Function} unsubscribe function
 */
export function subscribeUsageEvents(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("listener must be a function");
  }

  initUsageFanout();
  localUsageBus.on("usage", listener);

  return function unsubscribe() {
    localUsageBus.off("usage", listener);
  };
}

/**
 * Publish a usage event to local listeners and fan it out over Redis Pub/Sub.
 *
 * @param {Object} eventData - Usage record payload
 * @returns {Promise<boolean>} True if published to Redis or local bus
 */
export async function fanoutUsageEvent(eventData) {
  // 1. Deliver to local listeners immediately
  localUsageBus.emit("usage", eventData);

  // 2. If Redis is configured, publish across cluster instances
  if (!isRedisConfigured()) {
    return true;
  }

  try {
    const client = getRedisClient();
    if (!client) return true;

    const envelope = {
      source: instanceId,
      channel: USAGE_CHANNEL,
      timestamp: Date.now(),
      payload: eventData ?? null,
    };

    const published = client.publish(USAGE_CHANNEL, JSON.stringify(envelope));
    if (published && typeof published.catch === "function") {
      published.catch(() => {});
    }
    return true;
  } catch {
    // Fail-open: Never throw out of request path
    return true;
  }
}

/**
 * Return the internal EventEmitter for testing or advanced diagnostics.
 */
export function getUsageFanoutEmitter() {
  return localUsageBus;
}

/**
 * Close and reset usage fanout subscriptions (useful in test teardown).
 */
export function closeUsageFanout() {
  if (isSubscribed) {
    const sub = getRedisSubscriber();
    if (sub && messageListener) {
      try {
        sub.off("message", messageListener);
        if (sub.status === "ready") {
          sub.unsubscribe(USAGE_CHANNEL).catch(() => {});
        }
      } catch {}
    }
    messageListener = null;
    isSubscribed = false;
  }
  localUsageBus.removeAllListeners();
}

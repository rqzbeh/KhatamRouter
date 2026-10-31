/**
 * Independent subscriber child process for Redis events reliability integration test.
 */

import { subscribeKhatamEvent, KHATAM_EVENTS } from "../../../../src/lib/redis/events.js";
import { getRedisSubscriber } from "../../../../src/lib/redis/client.js";

const warnings = [];

// Track warnings
const origWarn = console.warn;
console.warn = (...args) => {
  const msg = args.join(" ");
  warnings.push(msg);
  if (process.send) {
    process.send({ type: "warn", message: msg });
  }
  origWarn(...args);
};

process.on("warning", (warning) => {
  const msg = warning?.message || String(warning);
  warnings.push(msg);
  if (process.send) {
    process.send({ type: "node_warning", message: msg });
  }
});

const receivedEvents = [];

const unsub = subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
  receivedEvents.push(payload);
  if (process.send) {
    process.send({ type: "event", channel: KHATAM_EVENTS.CONFIG_RELOAD, payload });
  }
});

// Wait until the underlying subscriber connection is ready
const sub = getRedisSubscriber();
if (sub) {
  sub.on("connect", () => console.log("[sub] connect"));
  sub.on("ready", () => console.log("[sub] ready"));
  sub.on("close", () => console.log("[sub] close"));
  sub.on("reconnecting", (ms) => console.log("[sub] reconnecting in", ms));
  if (sub.status === "ready") {
    if (process.send) process.send({ type: "subscriber_ready" });
  } else {
    sub.once("ready", () => {
      if (process.send) process.send({ type: "subscriber_ready" });
    });
  }
} else {
  // If Redis is not configured
  if (process.send) process.send({ type: "subscriber_ready" });
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.action === "get_status") {
    if (process.send) {
      process.send({
        type: "status",
        eventCount: receivedEvents.length,
        events: receivedEvents,
        warnings,
      });
    }
  } else if (msg.action === "exit") {
    try {
      unsub();
    } catch {}
    process.exit(0);
  }
});

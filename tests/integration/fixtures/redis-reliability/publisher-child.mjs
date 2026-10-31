/**
 * Independent publisher child process for Redis events reliability integration test.
 */

import { publishKhatamEvent, KHATAM_EVENTS } from "../../../../src/lib/redis/events.js";
import { getRedisClient } from "../../../../src/lib/redis/client.js";

const client = getRedisClient();
if (client) {
  client.on("connect", () => console.log("[pub] connect"));
  client.on("ready", () => console.log("[pub] ready"));
  client.on("close", () => console.log("[pub] close"));
  client.on("reconnecting", (ms) => console.log("[pub] reconnecting in", ms));
}

const warnings = [];

// Intercept warnings
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

// Emit immediately at startup BEFORE publisher client is ready
if (process.env.STARTUP_EMIT === "1") {
  const payload = {
    scope: process.env.STARTUP_SCOPE || "aliases",
    startup: true,
    timestamp: Date.now(),
  };
  const result = publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, payload);
  if (process.send) {
    process.send({ type: "startup_published", result, payload });
  }
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.action === "publish") {
    const channel = msg.channel || KHATAM_EVENTS.CONFIG_RELOAD;
    const result = publishKhatamEvent(channel, msg.payload);
    if (process.send) {
      process.send({
        type: "published",
        channel,
        payload: msg.payload,
        result,
      });
    }
  } else if (msg.action === "get_status") {
    if (process.send) {
      process.send({
        type: "status",
        warnings,
      });
    }
  } else if (msg.action === "exit") {
    process.exit(0);
  }
});

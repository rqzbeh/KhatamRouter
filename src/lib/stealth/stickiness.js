/**
 * First-Message Session Stickiness (Wave 5)
 *
 * Pins a conversation to the same upstream connection so provider prompt caches
 * stay warm. The key is the SHA-256 hash of the conversation's FIRST user
 * message (namespaced by combo/provider identity when provided), truncated to
 * 16 hex characters. Using only the first message keeps the key stable as the
 * conversation grows.
 *
 * Properties:
 *   - In-memory Map, 15 minute TTL, hard cap of 500 entries (oldest evicted).
 *   - Fail-OPEN: any malformed input, hashing failure or missing body returns
 *     null / no-ops and never throws. Callers fall back to normal ordering.
 *   - Default-OFF behind STEALTH_STICKINESS=1 / STEALTH_ALL=1.
 */

import { createHash } from "node:crypto";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";

/** TTL for a sticky binding (aligned with the 15-minute session TTL used elsewhere). */
export const STICKINESS_TTL_MS = 15 * 60 * 1000;

/** Maximum pinned entries before the oldest is evicted. */
export const STICKINESS_MAX_ENTRIES = 500;

/** Key length of the truncated SHA-256 hex digest. */
export const STICKINESS_KEY_LENGTH = 16;

/** @type {Map<string, { connectionId: string, createdAt: number, lastUsedAt: number }>} */
const pins = new Map();

/**
 * Check if session stickiness is enabled.
 * Default is FALSE (default-off).
 *
 * @returns {boolean}
 */
export function isStickinessEnabled() {
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.STEALTH_ALL === "1" || process.env.STEALTH_STICKINESS === "1";
}

/**
 * Test-only: clear all pins.
 */
export function clearStickyConnections() {
  pins.clear();
}

/**
 * Test-only: current number of pins.
 * @returns {number}
 */
export function stickyConnectionCount() {
  return pins.size;
}

/**
 * Flatten a message `content` value (string, or Claude/OpenAI content-block array)
 * into a deterministic text representation.
 *
 * @param {unknown} content
 * @returns {string}
 */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const type = block.type;
      if (typeof block.text === "string" && (type === undefined || type === "text")) {
        parts.push(block.text);
      } else if (type === "input_text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (type === "input" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (typeof block.content === "string") {
        parts.push(block.content);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

/**
 * Extract the first user message from a request body.
 * Supports OpenAI chat (`messages[]`), Claude (`messages[]` with blocks) and
 * OpenAI Responses (`input[]`).
 *
 * @param {unknown} body
 * @returns {string} Flattened first user message text ("" when absent)
 */
export function extractFirstUserMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";

  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : null;

  if (!messages) {
    // Single-turn Claude `system`-less prompt shape is not a conversation; ignore.
    return "";
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user") continue;
    const text = flattenContent(message.content ?? message.text);
    if (text.trim().length > 0) return text;
  }

  return "";
}

/**
 * Compute a stable session key from the first user message.
 *
 * @param {unknown} bodyOrMessages - Request body, or an array of messages
 * @param {string} [namespace] - Combo/provider identity to namespace the key
 * @returns {string | null} 16-char hex key, or null when no key can be derived
 */
export function computeSessionKey(bodyOrMessages, namespace = "") {
  try {
    if (!bodyOrMessages) return null;

    let firstText = "";
    if (Array.isArray(bodyOrMessages)) {
      firstText = extractFirstUserMessage({ messages: bodyOrMessages });
    } else {
      firstText = extractFirstUserMessage(bodyOrMessages);
    }

    if (!firstText) return null;

    const payload = `${namespace ? `${namespace}\u0000` : ""}${firstText}`;
    return createHash("sha256")
      .update(payload, "utf8")
      .digest("hex")
      .slice(0, STICKINESS_KEY_LENGTH);
  } catch {
    // Fail-open: never throw out of the routing path.
    return null;
  }
}

/**
 * Drop expired entries. Called on every read/write so idle maps do not grow.
 *
 * @param {number} now
 */
function pruneExpired(now) {
  for (const [key, entry] of pins) {
    if (now - entry.lastUsedAt > STICKINESS_TTL_MS) {
      pins.delete(key);
    }
  }
}

/**
 * Evict the least-recently-used entries until the map is within the cap.
 */
function evictOverflow() {
  while (pins.size > STICKINESS_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of pins) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    pins.delete(oldestKey);
  }
}

function getRedisSessionKey(key) {
  return withRedisKey ? withRedisKey(`session:stealth:${key}`) : `khatam:session:stealth:${key}`;
}

/**
 * Record a conversation → connection pin.
 *
 * @param {string | null} key - Session key from `computeSessionKey`
 * @param {string} connectionId
 * @param {{ force?: boolean }} [options]
 * @returns {boolean} true when a pin was stored
 */
export function setStickyConnection(key, connectionId, options = {}) {
  try {
    const enabled = options.force || isStickinessEnabled();
    if (!enabled) return false;
    if (!key || typeof key !== "string" || !connectionId || typeof connectionId !== "string") {
      return false;
    }
    const now = Date.now();
    pruneExpired(now);
    const existing = pins.get(key);
    pins.set(key, {
      connectionId,
      createdAt: existing ? existing.createdAt : now,
      lastUsedAt: now,
    });
    evictOverflow();

    // Mirror to Redis cluster session pins under khatam:session:stealth:<promptHash> (15-min TTL)
    if (isRedisConfigured()) {
      const client = getRedisClient();
      if (client && typeof client.set === "function") {
        client.set(getRedisSessionKey(key), connectionId, "EX", 900).catch(() => {});
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Record a conversation → connection pin asynchronously, awaiting Redis persistence.
 */
export async function setStickyConnectionAsync(key, connectionId, options = {}) {
  const localOk = setStickyConnection(key, connectionId, options);
  if (!localOk) return false;

  if (isRedisConfigured()) {
    const client = getRedisClient();
    if (client && typeof client.set === "function") {
      try {
        await client.set(getRedisSessionKey(key), connectionId, "EX", 900);
      } catch {}
    }
  }
  return true;
}

/**
 * Look up a pinned connection for a conversation.
 * Synchronous read against local in-process cache, with background Redis prefetch if absent.
 *
 * @param {string | null} key - Session key from `computeSessionKey`
 * @param {{ force?: boolean }} [options]
 * @returns {string | null} connectionId, or null when absent/expired/disabled
 */
export function getStickyConnection(key, options = {}) {
  try {
    const enabled = options.force || isStickinessEnabled();
    if (!enabled) return null;
    if (!key || typeof key !== "string") return null;

    const now = Date.now();
    const entry = pins.get(key);
    if (entry) {
      if (now - entry.lastUsedAt > STICKINESS_TTL_MS) {
        pins.delete(key);
        return null;
      }
      entry.lastUsedAt = now;
      return entry.connectionId;
    }

    // If absent locally but Redis is configured, trigger asynchronous prefetch for subsequent calls
    if (isRedisConfigured()) {
      const client = getRedisClient();
      if (client && typeof client.get === "function") {
        client.get(getRedisSessionKey(key)).then((remoteConn) => {
          if (remoteConn && !pins.has(key)) {
            pins.set(key, { connectionId: remoteConn, createdAt: Date.now(), lastUsedAt: Date.now() });
          }
        }).catch(() => {});
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Look up a pinned connection for a conversation, checking Redis cluster state if absent locally.
 */
export async function getStickyConnectionAsync(key, options = {}) {
  const local = getStickyConnection(key, options);
  if (local) return local;

  const enabled = options.force || isStickinessEnabled();
  if (!enabled || !key || typeof key !== "string") return null;

  if (isRedisConfigured()) {
    const client = getRedisClient();
    if (client && typeof client.get === "function") {
      try {
        const remoteConn = await client.get(getRedisSessionKey(key));
        if (remoteConn) {
          pins.set(key, { connectionId: remoteConn, createdAt: Date.now(), lastUsedAt: Date.now() });
          return remoteConn;
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Remove a pin (e.g. after the connection starts failing).
 *
 * @param {string} key
 * @returns {boolean}
 */
export function clearStickyConnection(key) {
  try {
    if (!key || typeof key !== "string") return false;
    const deleted = pins.delete(key);

    if (isRedisConfigured()) {
      const client = getRedisClient();
      if (client && typeof client.del === "function") {
        client.del(getRedisSessionKey(key)).catch(() => {});
      }
    }

    return deleted;
  } catch {
    return false;
  }
}

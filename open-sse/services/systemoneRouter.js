/**
 * Pure System One router utilities for intelligent combo model selection.
 * Used by the "smart" combo strategy to pick the best model for a request
 * before generation begins, with Redis-backed session stickiness for prompt-cache retention.
 *
 * NOTE: Stickiness is strictly backed by the Redis cluster layer (withRedisKey, khatam: prefix).
 * In-process Map storage is forbidden to prevent desync across server replicas.
 */

import { getRedisClient, withRedisKey } from "@/lib/redis/client.js";

export const DEFAULT_SYSTEMONE_ROUTER_MODEL = "oc/jev-1.13-free";
export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 8000;
export const MAX_STATE_CHARS = 2000;
export const MAX_STICKY_SESSIONS = 5000;
export const STICKY_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const STICKY_SESSION_TTL_SEC = 2 * 60 * 60; // 7200 seconds

/**
 * Extract prompt text from the request body for System One classification.
 * Takes the last user turn (or prompt) and truncates to avoid token waste.
 *
 * @param {object} body - Request body
 * @param {number} [maxChars=MAX_STATE_CHARS] - Max character cap
 * @returns {string} Clean prompt state
 */
export function extractPromptState(body, maxChars = MAX_STATE_CHARS) {
  if (!body || typeof body !== "object") return "";

  // Messages array (OpenAI / Claude / etc.) or input array (Codex)
  const messages = Array.isArray(body.messages)
    ? body.messages
    : (Array.isArray(body.input) ? body.input : null);

  if (messages && messages.length > 0) {
    // Find the latest user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "user" || msg?.type === "message" || (!msg?.role && msg?.content)) {
        const text = extractTextFromContent(msg.content ?? msg.text);
        if (text && text.trim().length > 0) {
          return text.trim().slice(0, maxChars);
        }
      }
    }
    // Fallback: latest message of any role
    const lastMsg = messages[messages.length - 1];
    const text = extractTextFromContent(lastMsg?.content ?? lastMsg?.text);
    if (text) return text.trim().slice(0, maxChars);
  }

  // String prompt / input
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt.trim().slice(0, maxChars);
  }
  if (typeof body.input === "string" && body.input.trim()) {
    return body.input.trim().slice(0, maxChars);
  }

  return "";
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Build choice criteria dictionary for System One from an array of models.
 * Criteria keys are the model names; values are null so System One uses its
 * native knowledge of models without manual descriptions.
 *
 * @param {string[]} models - Array of model IDs in the combo
 * @returns {Record<string, null>} Criteria map
 */
export function buildChoiceCriteria(models) {
  const criteria = {};
  if (!Array.isArray(models)) return criteria;
  for (const m of models) {
    if (typeof m === "string" && m.trim().length > 0) {
      criteria[m.trim()] = null;
    }
  }
  return criteria;
}

/**
 * Parse a System One route response JSON.
 *
 * @param {object} json - Upstream response payload
 * @returns {{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null}
 */
export function parseSystemOneRouteAnswer(json) {
  if (!json || typeof json !== "object") return null;

  const route = json.answers?.route;
  if (!route || typeof route !== "object") return null;

  const rawChoice = typeof route.choice === "string" ? route.choice.trim() : "";
  if (!rawChoice) return null;

  const confidence = typeof route.confidence === "number" && Number.isFinite(route.confidence)
    ? route.confidence
    : null;

  let probabilities = null;
  if (route.probabilities && typeof route.probabilities === "object" && !Array.isArray(route.probabilities)) {
    probabilities = {};
    for (const [k, v] of Object.entries(route.probabilities)) {
      const num = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(num)) {
        probabilities[k] = num;
      }
    }
  }

  return {
    choice: rawChoice,
    confidence,
    probabilities,
  };
}

/**
 * Order combo models based on System One choice result:
 * 1. The selected choice is placed at index 0.
 * 2. Remaining models are ordered by probabilities descending.
 * 3. Models without probabilities retain their relative order at the end.
 *
 * @param {string[]} models - Original models array
 * @param {object} choiceResult - Parsed System One choice
 * @returns {string[]} Reordered models array
 */
export function orderModelsByChoice(models, choiceResult) {
  if (!Array.isArray(models) || models.length <= 1) return models || [];
  if (!choiceResult?.choice || !models.includes(choiceResult.choice)) return [...models];

  const { choice, probabilities } = choiceResult;
  const others = models.filter((m) => m !== choice);

  if (probabilities && typeof probabilities === "object") {
    others.sort((a, b) => {
      const pA = probabilities[a] ?? 0;
      const pB = probabilities[b] ?? 0;
      return pB - pA;
    });
  }

  return [choice, ...others];
}

/**
 * Check if a session already has a sticky model assigned for this combo in Redis cluster.
 *
 * @param {string} comboName - Combo name
 * @param {string|null} sessionId - Client session identifier
 * @param {string[]} models - Currently available combo models
 * @returns {Promise<string|null>} Model to use, or null if no sticky model
 */
export async function getStickyComboModel(comboName, sessionId, models) {
  if (!sessionId || !comboName || !Array.isArray(models)) return null;

  try {
    const client = getRedisClient();
    if (!client || typeof client.get !== "function") return null;

    const key = withRedisKey(`combo:sticky:${comboName}:${sessionId}`);
    const storedModel = await client.get(key);
    if (!storedModel) return null;

    // Ensure stored model still belongs to combo
    if (!models.includes(storedModel)) {
      await client.del(key);
      const indexKey = withRedisKey(`combo:sticky_index:${comboName}`);
      if (typeof client.zrem === "function") {
        await client.zrem(indexKey, sessionId);
      }
      return null;
    }

    // Refresh TTL on use
    if (typeof client.expire === "function") {
      client.expire(key, STICKY_SESSION_TTL_SEC).catch(() => {});
      const indexKey = withRedisKey(`combo:sticky_index:${comboName}`);
      client.expire(indexKey, STICKY_SESSION_TTL_SEC).catch(() => {});
    }

    return storedModel;
  } catch {
    return null;
  }
}

/**
 * Record sticky model for this session in Redis cluster so subsequent turns keep prompt-cache warm.
 *
 * @param {string} comboName - Combo name
 * @param {string|null} sessionId - Client session identifier
 * @param {string} model - Selected model
 * @returns {Promise<void>}
 */
export async function setStickyComboModel(comboName, sessionId, model) {
  if (!sessionId || !comboName || !model) return;

  try {
    const client = getRedisClient();
    if (!client || typeof client.set !== "function") return;

    const key = withRedisKey(`combo:sticky:${comboName}:${sessionId}`);
    const indexKey = withRedisKey(`combo:sticky_index:${comboName}`);
    const combosKey = withRedisKey("combo:sticky_combos");

    const now = Date.now();
    await client.set(key, model, "EX", STICKY_SESSION_TTL_SEC);
    if (typeof client.zadd === "function") {
      await client.zadd(indexKey, now + STICKY_SESSION_TTL_MS, sessionId);
      if (typeof client.expire === "function") {
        client.expire(indexKey, STICKY_SESSION_TTL_SEC).catch(() => {});
      }
      await client.zadd(combosKey, now, comboName);
    }
  } catch {
    // Fail-open
  }
}

/**
 * Clear a sticky session mapping in Redis cluster (e.g. after a model fails or resets).
 *
 * @param {string} [comboName] - Combo name; omit to clear all
 * @param {string|null} [sessionId] - Specific session ID; omit to clear all for combo
 * @returns {Promise<void>}
 */
export async function clearStickyComboSession(comboName, sessionId = null) {
  try {
    const client = getRedisClient();
    if (!client) return;

    if (!comboName) {
      await resetStickyComboStore();
      return;
    }

    const indexKey = withRedisKey(`combo:sticky_index:${comboName}`);
    if (sessionId) {
      const key = withRedisKey(`combo:sticky:${comboName}:${sessionId}`);
      await client.del(key);
      if (typeof client.zrem === "function") {
        await client.zrem(indexKey, sessionId);
      }
      return;
    }

    // Clear all for comboName
    if (typeof client.zrangebyscore === "function") {
      const sessions = await client.zrangebyscore(indexKey, "-inf", "+inf");
      if (Array.isArray(sessions) && sessions.length > 0) {
        const keys = sessions.map((s) => withRedisKey(`combo:sticky:${comboName}:${s}`));
        await Promise.all(keys.map((k) => client.del(k)));
      }
    }
    await client.del(indexKey);
    const combosKey = withRedisKey("combo:sticky_combos");
    if (typeof client.zrem === "function") {
      await client.zrem(combosKey, comboName);
    }
  } catch {
    // Fail-open
  }
}

/**
 * Prune old or excess sticky sessions to prevent unbounded growth in Redis index sets.
 *
 * @returns {Promise<void>}
 */
export async function pruneStickyComboSessions() {
  try {
    const client = getRedisClient();
    if (!client || typeof client.zremrangebyscore !== "function") return;
    const combosKey = withRedisKey("combo:sticky_combos");
    if (typeof client.zrangebyscore === "function") {
      const combos = await client.zrangebyscore(combosKey, "-inf", "+inf");
      const now = Date.now();
      if (Array.isArray(combos)) {
        for (const c of combos) {
          await client.zremrangebyscore(withRedisKey(`combo:sticky_index:${c}`), "-inf", now);
        }
      }
    }
  } catch {
    // Fail-open
  }
}

/**
 * Reset sticky store in Redis cluster (for testing).
 *
 * @returns {Promise<void>}
 */
export async function resetStickyComboStore() {
  try {
    const client = getRedisClient();
    if (!client) return;

    const combosKey = withRedisKey("combo:sticky_combos");
    if (typeof client.zrangebyscore === "function") {
      const combos = await client.zrangebyscore(combosKey, "-inf", "+inf");
      if (Array.isArray(combos) && combos.length > 0) {
        for (const c of combos) {
          const indexKey = withRedisKey(`combo:sticky_index:${c}`);
          const sessions = await client.zrangebyscore(indexKey, "-inf", "+inf");
          if (Array.isArray(sessions) && sessions.length > 0) {
            const keys = sessions.map((s) => withRedisKey(`combo:sticky:${c}:${s}`));
            await Promise.all(keys.map((k) => client.del(k)));
          }
          await client.del(indexKey);
        }
      }
    }
    await client.del(combosKey);
  } catch {
    // Fail-open
  }
}

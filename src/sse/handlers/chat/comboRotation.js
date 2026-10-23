/**
 * Atomic Round-Robin Combo Rotation using Shared Redis Counter
 *
 * Design Invariants (contracts/redis-conventions.md & FR-018, FR-022):
 * 1. Redis Key: <prefix>:counter:combo:<comboName>:index
 * 2. Atomic Increment: Uses Redis INCR to coordinate round-robin rotation across instances
 *    without writing to SQLite per request.
 * 3. Modulo Distribution: target models array is rotated using modulo arithmetic.
 * 4. Sticky Limit Support: Groups consecutive requests per model when stickyLimit > 1.
 * 5. Persistent Counter: No TTL (persistent counter).
 * 6. Fail-Open: Gracefully degrades to in-memory rotation if Redis is unavailable.
 */

import {
  getRedisClient,
  isRedisConfigured,
  isRedisAvailable,
  withRedisKey,
} from "@/lib/redis/client.js";
import { getRotatedModels } from "open-sse/services/combo.js";

/**
 * Format the namespaced Redis key for combo rotation.
 * Pattern: khatam:counter:combo:<comboName>:index
 *
 * @param {string} comboName
 * @returns {string}
 */
export function getComboCounterKey(comboName) {
  const safeName = (comboName || "__default__").trim();
  return withRedisKey(`counter:combo:${safeName}:index`);
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotated = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotated.shift();
    rotated.push(moved);
  }
  return rotated;
}

/**
 * Perform atomic round-robin rotation of combo models using Redis INCR.
 *
 * @param {string[]} models - Array of model names in the combo
 * @param {string} comboName - Name of the combo
 * @param {number|string} [stickyLimit=1] - Consecutive requests per model before switching
 * @returns {Promise<string[]>} Rotated models array
 */
export async function rotateComboModels(models, comboName, stickyLimit = 1) {
  if (!Array.isArray(models) || models.length <= 1) {
    return models;
  }

  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);

  if (isRedisConfigured()) {
    try {
      const client = getRedisClient();
      if (client) {
        const key = getComboCounterKey(comboName);
        // Atomic INCR coordination across all control-plane instances
        const count = await client.incr(key);

        // Modulo arithmetic with sticky group support
        // E.g., count = 1, stickyLimit = 2 -> Math.floor(0 / 2) % N = 0
        // E.g., count = 2, stickyLimit = 2 -> Math.floor(1 / 2) % N = 0
        // E.g., count = 3, stickyLimit = 2 -> Math.floor(2 / 2) % N = 1
        const currentIndex = Math.floor((count - 1) / normalizedStickyLimit) % models.length;
        return rotateModelsFromIndex(models, currentIndex);
      }
    } catch {
      // Fail-open: Fall back to in-memory rotation
    }
  }

  // In-memory fallback
  return getRotatedModels(models, comboName, "round-robin", stickyLimit);
}

/**
 * Reset Redis counter for a given combo.
 *
 * @param {string} comboName
 * @returns {Promise<boolean>}
 */
export async function resetComboCounter(comboName) {
  if (!isRedisConfigured()) return false;
  try {
    const client = getRedisClient();
    if (!client) return false;
    const key = getComboCounterKey(comboName);
    await client.del(key);
    return true;
  } catch {
    return false;
  }
}

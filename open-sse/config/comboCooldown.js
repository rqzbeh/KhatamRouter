/**
 * Combo member cooldown configuration and pure normalization functions.
 * Stored in settings.comboStrategies[comboName].memberCooldownMs.
 * Pure constants and functions — safe for both engine (open-sse) and client dashboard.
 */

export const MEMBER_COOLDOWN_PRESETS_MS = Object.freeze({
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
});

export const MIN_MEMBER_COOLDOWN_MS = 10_000;
export const MAX_MEMBER_COOLDOWN_MS = 24 * 3_600_000; // 86_400_000 (24h)

export const COOLDOWN_PRESET_OPTIONS = Object.freeze([
  { value: "default", label: "Default (429: 90s, 5xx: 45s)" },
  { value: "1m", label: "1 minute (1m)" },
  { value: "5m", label: "5 minutes (5m)" },
  { value: "1h", label: "1 hour (1h)" },
  { value: "custom", label: "Custom seconds (10s – 24h)" },
]);

/**
 * Validate and normalize a member cooldown setting.
 * Returns integer milliseconds in range [10_000, 86_400_000], or null meaning "default".
 * Uses Object.hasOwn so prototype keys ("toString", "constructor") safely evaluate to null.
 */
export function normalizeMemberCooldownMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (Object.hasOwn(MEMBER_COOLDOWN_PRESETS_MS, trimmed)) {
      return MEMBER_COOLDOWN_PRESETS_MS[trimmed];
    }
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (Number.isSafeInteger(num) && num >= MIN_MEMBER_COOLDOWN_MS && num <= MAX_MEMBER_COOLDOWN_MS) {
        return num;
      }
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_MEMBER_COOLDOWN_MS || value > MAX_MEMBER_COOLDOWN_MS) return null;
  return value;
}

/**
 * Check if a candidate value is a valid member cooldown (either null/empty or valid duration).
 */
export function isValidMemberCooldown(value) {
  if (value === null || value === undefined || value === "") return true;
  return normalizeMemberCooldownMs(value) !== null;
}

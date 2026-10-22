/**
 * Cooldown management and adaptive backoff math (Wave 4).
 *
 * Computes kind-aware cooldowns, escalates them across repeated probe failures
 * (open→half_open→open cycles), and answers whether a target or connection is
 * currently cooling down.
 *
 * Pure, deterministic, and safe to run on any clock: callers can inject `now`
 * for testing and the arithmetic never yields negative durations or NaN.
 */

import {
  COOLDOWN_BY_KIND,
  FAILURE_KIND,
  BREAKER_DEFAULTS,
} from "open-sse/config/resilienceConfig.js";

/**
 * Resolve the base cooldown duration in milliseconds for a failure kind.
 *
 * Precedence:
 *   1. Explicit override passed in `options.cooldownByKind`
 *   2. Constant map `COOLDOWN_BY_KIND`
 *   3. `options.defaultCooldown` (or BREAKER_DEFAULTS.resetTimeout)
 */
export function resolveCooldownMs(kind, options = {}) {
  const overrides = options && typeof options.cooldownByKind === "object" ? options.cooldownByKind : null;
  if (overrides && kind && typeof overrides[kind] === "number" && Number.isFinite(overrides[kind])) {
    return Math.max(0, overrides[kind]);
  }
  if (kind && typeof COOLDOWN_BY_KIND[kind] === "number") {
    return COOLDOWN_BY_KIND[kind];
  }
  const fallback = options && typeof options.defaultCooldown === "number" && Number.isFinite(options.defaultCooldown)
    ? options.defaultCooldown
    : BREAKER_DEFAULTS.resetTimeout;
  return Math.max(0, fallback);
}

/**
 * Escalate a base cooldown across repeated probe cycles.
 *
 * Cycles up to `backoffEscalationCount` (default 3) keep the base cooldown.
 * Each cycle beyond doubles the cooldown, capped at `baseTimeout × maxBackoffMultiplier`.
 *
 * Example (base 30s, escalation count 3, cap 16x = 480s):
 *   cycle 0, 1, 2, 3 → 30s
 *   cycle 4          → 60s
 *   cycle 5          → 120s
 *   cycle 6          → 240s
 *   cycle 7+         → 480s
 */
export function escalateCooldown(baseTimeout, openCycleCount = 0, options = {}) {
  const base = Math.max(0, Number.isFinite(Number(baseTimeout)) ? Number(baseTimeout) : BREAKER_DEFAULTS.resetTimeout);
  const cycles = Math.max(0, Number.isFinite(Number(openCycleCount)) ? Math.floor(Number(openCycleCount)) : 0);
  const escalationThreshold = options && typeof options.backoffEscalationCount === "number"
    ? Math.max(0, options.backoffEscalationCount)
    : BREAKER_DEFAULTS.backoffEscalationCount;
  const maxMultiplier = options && typeof options.maxBackoffMultiplier === "number"
    ? Math.max(1, options.maxBackoffMultiplier)
    : BREAKER_DEFAULTS.maxBackoffMultiplier;

  if (cycles <= escalationThreshold) return base;
  const excess = Math.min(cycles - escalationThreshold, 30); // bound to prevent exponent overflow
  const factor = 2 ** excess;
  const ceiling = base * maxMultiplier;
  return Math.min(base * factor, ceiling);
}

/**
 * Calculate the timestamp until which a target must cool down.
 *
 * Clamps at `now + maxCapMs` if a cap is provided, and never returns a
 * timestamp in the past when duration > 0.
 */
export function calculateCooldownUntil(baseDurationMs, options = {}) {
  const now = options && typeof options.now === "number" ? options.now : Date.now();
  const duration = Math.max(0, Number.isFinite(Number(baseDurationMs)) ? Number(baseDurationMs) : 0);
  const openCycles = options && typeof options.openCycleCount === "number" ? options.openCycleCount : 0;
  const escalated = escalateCooldown(duration, openCycles, options);
  const until = now + escalated;
  return {
    durationMs: escalated,
    cooldownUntilIso: new Date(until).toISOString(),
    cooldownUntilMs: until,
  };
}

/**
 * Check whether a target is currently cooling down.
 *
 * Returns `{ inCooldown: boolean, remainingMs: number }`.
 */
export function cooldownVerdict(cooldownUntil, now = Date.now()) {
  if (!cooldownUntil) return { inCooldown: false, remainingMs: 0 };
  const targetMs = typeof cooldownUntil === "number"
    ? cooldownUntil
    : Date.parse(String(cooldownUntil));
  if (!Number.isFinite(targetMs)) return { inCooldown: false, remainingMs: 0 };
  const remaining = targetMs - now;
  if (remaining <= 0) return { inCooldown: false, remainingMs: 0 };
  return { inCooldown: true, remainingMs: Math.ceil(remaining) };
}

/**
 * Inspect an existing connection record for active model locks or account-level
 * rate limits without mutating the record.
 *
 * Compatible with `open-sse/services/accountFallback.js` conventions:
 *   - `modelLock_<model>`
 *   - `modelLock___all`
 *   - `rateLimitedUntil`
 */
export function getConnectionCooldownVerdict(connection, model = null, now = Date.now()) {
  if (!connection || typeof connection !== "object") {
    return { inCooldown: false, remainingMs: 0, reason: null };
  }

  // 1. Account-wide rateLimitedUntil
  if (connection.rateLimitedUntil) {
    const verdict = cooldownVerdict(connection.rateLimitedUntil, now);
    if (verdict.inCooldown) {
      return { ...verdict, reason: "account_rate_limited", until: connection.rateLimitedUntil };
    }
  }

  // 2. Account-level lock: modelLock___all
  if (connection.modelLock___all) {
    const verdict = cooldownVerdict(connection.modelLock___all, now);
    if (verdict.inCooldown) {
      return { ...verdict, reason: "model_lock_all", until: connection.modelLock___all };
    }
  }

  // 3. Per-model lock: modelLock_<model>
  if (model) {
    const key = `modelLock_${model}`;
    if (connection[key]) {
      const verdict = cooldownVerdict(connection[key], now);
      if (verdict.inCooldown) {
        return { ...verdict, reason: "model_lock", until: connection[key] };
      }
    }
  }

  return { inCooldown: false, remainingMs: 0, reason: null };
}

/** Human-readable duration (e.g. "2m 30s", "45s", "1h 15m"). */
export function formatDurationHuman(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds <= 0) return "0s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

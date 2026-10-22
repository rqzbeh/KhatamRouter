/**
 * Resilience configuration contracts (Wave 4).
 *
 * Every constant the circuit breaker, the failure classifier, the cooldown
 * resolver and the pre-dispatch gates depend on lives here — no magic numbers
 * or status literals in the implementations (open-sse/AGENTS.md convention).
 *
 * Everything in this module is static data. The one runtime knob, the feature
 * flag, is exposed as a function so it is read at call time instead of frozen
 * at import: tests and operators flip it without reloading the module.
 */

/** The four breaker states, in the order a healthy→failing target travels. */
export const BREAKER_STATE = {
  CLOSED: "CLOSED",
  DEGRADED: "DEGRADED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

/** All states, for validation and diagnostics. */
export const BREAKER_STATES = Object.freeze(Object.values(BREAKER_STATE));

/**
 * Failure taxonomy produced by `classify429`.
 * - rate_limit:      short transient window; retry after the cooldown.
 * - quota_exhausted: long-period cap; do not hammer, fail over.
 * - transient:       not a 429 (or unclassifiable), leave policy to the caller.
 */
export const FAILURE_KIND = {
  RATE_LIMIT: "rate_limit",
  QUOTA_EXHAUSTED: "quota_exhausted",
  TRANSIENT: "transient",
};

export const FAILURE_KINDS = Object.freeze(Object.values(FAILURE_KIND));

/**
 * Breaker defaults. `resetTimeout` is the CLOSED→OPEN cooldown before the first
 * HALF_OPEN probe; `degradationThreshold` (as a fraction) decides where the
 * warning state begins.
 */
export const BREAKER_DEFAULTS = {
  failureThreshold: 5,
  resetTimeout: 30 * 1000,
  halfOpenRequests: 1,
  /** Fraction of failureThreshold at which CLOSED escalates to DEGRADED. */
  degradationRatio: 0.6,
  /** Upper bound on the escalated cooldown, as a multiple of resetTimeout. */
  maxBackoffMultiplier: 16,
  /** Open cycles tolerated before the cooldown starts doubling. */
  backoffEscalationCount: 3,
  /** Bounded transition history kept per breaker for diagnostics. */
  maxTransitionHistory: 25,
  /** Named-registry ceiling before cold breakers are evicted. */
  maxRegistrySize: 500,
};

/**
 * Per-kind breaker thresholds and cooldowns.
 *
 * `threshold` overrides `failureThreshold` for that kind; `immediateOpen`
 * skips DEGRADED (a credential the upstream says is exhausted has no useful
 * "warning" phase). `cooldown` replaces `resetTimeout` as the base for that
 * kind and is still escalated by open-cycle count.
 */
export const KIND_THRESHOLDS = Object.freeze({
  [FAILURE_KIND.QUOTA_EXHAUSTED]: Object.freeze({
    threshold: 1,
    immediateOpen: true,
    cooldown: 60 * 60 * 1000,
  }),
  [FAILURE_KIND.RATE_LIMIT]: Object.freeze({
    threshold: 3,
    immediateOpen: false,
    cooldown: 30 * 1000,
  }),
  [FAILURE_KIND.TRANSIENT]: Object.freeze({
    threshold: 5,
    immediateOpen: false,
    cooldown: 30 * 1000,
  }),
});

/** Cooldown bucket per failure kind, in milliseconds. */
export const COOLDOWN_BY_KIND = Object.freeze({
  [FAILURE_KIND.QUOTA_EXHAUSTED]: 60 * 60 * 1000,
  [FAILURE_KIND.RATE_LIMIT]: 30 * 1000,
  [FAILURE_KIND.TRANSIENT]: 30 * 1000,
});

/**
 * Client-error statuses that say nothing about the credential or the provider:
 * the request itself was wrong. They must never count toward breaker state.
 *
 * 400 malformed / 406 unacceptable / 408 client timeout / 409 conflict /
 * 410 gone / 422 unprocessable.
 */
export const NON_TRIPPING_STATUSES = Object.freeze([400, 406, 408, 409, 410, 422]);

/** Set form for O(1) membership checks in the hot path. */
export const NON_TRIPPING_STATUS_SET = new Set(NON_TRIPPING_STATUSES);

/**
 * Content-policy refusal wording. A moderation refusal is a property of the
 * request, not of the provider's health, so it is exempt exactly like the
 * client-error statuses above.
 */
// No trailing `\b`: these markers are routinely followed by another word
// character (`content_policy_violation`), where `\b` would fail to match.
export const POLICY_FAILURE_PATTERN = /\b(?:content[_\s-]?policy|policy[_\s-]?violation|moderation[_\s-]?blocked|safety[_\s-]?system|blocked\s+by\s+(?:safety|policy))/i;

/** Truncation bound for any failure reason persisted or logged. */
export const FAILURE_REASON_MAX_LEN = 160;

/**
 * Feature flag. Wave 4 is inert unless this is exactly "1"; any other value
 * (including unset) preserves the pre-Wave-4 fallback path byte for byte.
 */
export const RESILIENCE_FLAG_ENV = "KHATAM_RESILIENCE_CIRCUIT_BREAKER";

/** Redis namespace suffix for breaker snapshots (full key: `khatam:cb:<domain>`). */
export const REDIS_BREAKER_PREFIX = "cb:";

/** TTL applied to a Redis breaker snapshot; refreshed on every write. */
export const REDIS_BREAKER_TTL_SECONDS = 24 * 60 * 60;

/** SQLite table holding durable breaker state. */
export const BREAKER_TABLE = "domain_circuit_breakers";

/**
 * Upstream retry hints below this many seconds describe a short throttle that
 * clears on its own; above it, a generic quota phrase is taken at its word.
 */
export const QUOTA_SCALE_RETRY_SECONDS = 3600;

/** Gate identifiers, in the fixed evaluation order. */
export const GATE = Object.freeze({
  CIRCUIT: "circuit_open",
  COOLDOWN: "cooldown",
  CREDENTIAL: "credential",
});

/** Verdict kinds returned by `evaluateTargetGates`. */
export const VERDICT = Object.freeze({
  PROCEED: "proceed",
  SKIP: "skip",
});

/** True when the Wave 4 fallback integration is enabled for this process. */
export function isResilienceEnabled() {
  return process.env[RESILIENCE_FLAG_ENV] === "1";
}

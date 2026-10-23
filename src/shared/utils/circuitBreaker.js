/**
 * Circuit Breaker — 4-state provider-health machine (Wave 4).
 *
 * States:
 *   CLOSED    — healthy, traffic passes
 *   DEGRADED  — elevated failure count, traffic still passes, diagnostics warn
 *   OPEN      — short-circuited until the effective cooldown elapses
 *   HALF_OPEN — cooling complete, a bounded number of probe requests may pass
 *
 * Design rules:
 *   - Pure and synchronous. Persistence is an injected `{ load, save }` seam
 *     and is fire-and-forget: nothing on the request path can throw or block
 *     because SQLite (or Redis) is unhappy.
 *   - Client-error statuses, content-policy refusals and our own local
 *     lifecycle/host errors never count — they say nothing about provider
 *     health. See `shouldRecordFailure` in failureClassification.js.
 *   - Cooldowns are kind-aware and escalate with repeated probe cycles, capped
 *     at `base × maxBackoffMultiplier`.
 *
 * No I/O, no imports outside config/classification, so this stays usable from
 * `open-sse/` (standalone engine) and `src/` (app) alike.
 */

import {
  BREAKER_STATE,
  BREAKER_DEFAULTS,
  COOLDOWN_BY_KIND,
  KIND_THRESHOLDS,
} from "open-sse/config/resilienceConfig.js";
import { shouldRecordFailure } from "@/lib/resilience/failureClassification.js";
import { escalateCooldown, resolveCooldownMs } from "@/lib/resilience/cooldownManager.js";

/** Convenience alias so callers can `import { STATE }`. */
export const STATE = BREAKER_STATE;

/** Thrown by `execute()` when the circuit is OPEN. */
export class CircuitBreakerOpenError extends Error {
  constructor(message, circuitName, retryAfterMs) {
    super(message);
    this.name = "CircuitBreakerOpenError";
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A recorded state change. Bounded by `maxTransitionHistory`.
 * @typedef {{from: string, to: string, timestamp: number, failureCount: number, reason?: string}} TransitionRecord
 */

/**
 * @typedef {Object} CircuitBreakerStatus
 * @property {string} name
 * @property {string} state
 * @property {number} failureCount
 * @property {number|null} lastFailureTime
 * @property {number} retryAfterMs
 * @property {string|null} lastFailureKind
 * @property {number} openCycleCount
 * @property {Record<string, number>} kindFailureCounts
 * @property {number} degradationThreshold
 * @property {number} effectiveResetTimeout
 * @property {TransitionRecord[]} transitionHistory
 */

/**
 * @typedef {Object} CircuitBreakerOptions
 * @property {number} [failureThreshold]
 * @property {number} [resetTimeout]
 * @property {number} [halfOpenRequests]
 * @property {number} [degradationThreshold]
 * @property {number} [maxBackoffMultiplier]
 * @property {number} [backoffEscalationCount]
 * @property {number} [maxTransitionHistory]
 * @property {Record<string, number>} [cooldownByKind]
 * @property {Partial<Record<string, {threshold?: number, immediateOpen?: boolean, cooldown?: number}>>} [kindThresholds]
 * @property {(name: string, oldState: string, newState: string) => void} [onStateChange]
 * @property {(name: string, snapshot: object) => Promise<void>|void} [persistence] async save hook, failures swallowed
 * @property {() => Promise<object|null>|object|null} [restore] async load hook, failures swallowed
 */

export class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = String(name || "anonymous");

    this.failureThreshold = clampInt(options.failureThreshold, BREAKER_DEFAULTS.failureThreshold, 1);
    this.resetTimeout = clampInt(options.resetTimeout, BREAKER_DEFAULTS.resetTimeout, 0);
    this.halfOpenRequests = clampInt(options.halfOpenRequests, BREAKER_DEFAULTS.halfOpenRequests, 1);
    this.maxBackoffMultiplier = clampInt(options.maxBackoffMultiplier, BREAKER_DEFAULTS.maxBackoffMultiplier, 1);
    this.backoffEscalationCount = clampInt(options.backoffEscalationCount, BREAKER_DEFAULTS.backoffEscalationCount, 0);
    this.maxTransitionHistory = clampInt(options.maxTransitionHistory, BREAKER_DEFAULTS.maxTransitionHistory, 1);

    this.degradationThreshold = clampInt(
      options.degradationThreshold,
      Math.max(1, Math.ceil(this.failureThreshold * BREAKER_DEFAULTS.degradationRatio)),
      1
    );

    this.kindThresholds = options.kindThresholds || KIND_THRESHOLDS;
    this.cooldownByKind = options.cooldownByKind || COOLDOWN_BY_KIND;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.persistence = options.persistence && typeof options.persistence.save === "function" ? options.persistence : null;
    this.restore = typeof options.restore === "function" ? options.restore : null;

    this.state = BREAKER_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastFailureKind = null;
    this.kindFailureCounts = {};
    this.openCycleCount = 0;
    this.halfOpenAllowed = this.halfOpenRequests;
    this.halfOpenProbeStartedAt = null;
    this.transitionHistory = [];
    this.loaded = false;

    if (this.restore) {
      // Fire-and-forget restore: the breaker is usable immediately with CLOSED
      // defaults; state merges in whenever the async load lands.
      Promise.resolve()
        .then(() => this.restore())
        .then((snapshot) => this.applySnapshot(snapshot))
        .catch(() => {});
    }
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  /** Transition an expired OPEN (or DEGRADED) breaker into its next state. */
  refreshOpenState() {
    if (this.state === BREAKER_STATE.OPEN) {
      if (this.timeUntilResetMs() <= 0) {
        this.transition(BREAKER_STATE.HALF_OPEN, "cooldown-expired");
        this.halfOpenAllowed = this.halfOpenRequests;
        this.halfOpenProbeStartedAt = Date.now();
        this.persist();
      }
    } else if (this.state === BREAKER_STATE.DEGRADED) {
      // A DEGRADED target that is receiving no traffic at all should not stay
      // degraded forever: once the last failure's cooldown window elapses with
      // no further failure, forget the counts.
      if (this.lastFailureTime != null && Date.now() - this.lastFailureTime >= this.effectiveCooldownMs()) {
        this.transition(BREAKER_STATE.CLOSED, "degraded-timeout");
        this.failureCount = 0;
        this.lastFailureKind = null;
        this.kindFailureCounts = {};
        this.persist();
      }
    }
  }

  /**
   * True when a request may be dispatched.
   * Admits HALF_OPEN probes while budget remains.
   */
  canExecute() {
    this.refreshOpenState();
    switch (this.state) {
      case BREAKER_STATE.CLOSED:
      case BREAKER_STATE.DEGRADED:
        return true;
      case BREAKER_STATE.HALF_OPEN:
        if (this.halfOpenAllowed > 0) {
          this.halfOpenAllowed -= 1;
          if (this.halfOpenAllowed === 0 && this.halfOpenProbeStartedAt == null) {
            this.halfOpenProbeStartedAt = Date.now();
          }
          return true;
        }
        return false;
      case BREAKER_STATE.OPEN:
      default:
        return false;
    }
  }

  /** Milliseconds until the next probe is allowed; 0 when dispatch is allowed. */
  getRetryAfterMs() {
    this.refreshOpenState();
    if (this.state === BREAKER_STATE.CLOSED || this.state === BREAKER_STATE.DEGRADED) return 0;
    return this.timeUntilResetMs();
  }

  getStatus() {
    this.refreshOpenState();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      retryAfterMs: this.getRetryAfterMs(),
      lastFailureKind: this.lastFailureKind,
      openCycleCount: this.openCycleCount,
      kindFailureCounts: { ...this.kindFailureCounts },
      degradationThreshold: this.degradationThreshold,
      effectiveResetTimeout: this.effectiveCooldownMs(),
      transitionHistory: [...this.transitionHistory],
    };
  }

  /**
   * Run `fn` under the breaker.
   * Throws `CircuitBreakerOpenError` when OPEN; records failure/success around
   * `fn`. `options.isFailure` and `options.classify` let callers describe
   * outcomes the default classifier cannot see.
   */
  async execute(fn, options = {}) {
    this.refreshOpenState();
    if (this.state === BREAKER_STATE.OPEN) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker "${this.name}" is OPEN. Try again later.`,
        this.name,
        this.getRetryAfterMs()
      );
    }
    if (typeof options.onProbeAcquired === "function" && this.state === BREAKER_STATE.HALF_OPEN) {
      try { options.onProbeAcquired(); } catch { /* never fail the request */ }
    }
    try {
      const result = await fn();
      if (this.state === BREAKER_STATE.HALF_OPEN) this.recordSuccess("half-open-probe-succeeded");
      else this.recordSuccess("ok");
      return result;
    } catch (error) {
      const classify = typeof options.classify === "function" ? options.classify : null;
      const isFailure = typeof options.isFailure === "function" ? options.isFailure : () => true;
      const kind = classify ? safeCall(() => classify(error), undefined) : undefined;
      const shouldCount = shouldRecordFailure({ error, kind }) && safeCall(() => isFailure(error), true);
      if (shouldCount) this.recordFailure(kind);
      throw error;
    }
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  /**
   * Record a successful request.
   * - HALF_OPEN: close the circuit and reset counters (recovery confirmed).
   * - CLOSED/DEGRADED: decouple the failure count gradually (recovery trust).
   * - OPEN: ignore; only an acquired probe may settle an OPEN breaker.
   */
  recordSuccess(reason = "success") {
    this.refreshOpenState();
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      this.transition(BREAKER_STATE.CLOSED, reason);
      this.resetCounters();
      this.persist();
      return;
    }
    if (this.state === BREAKER_STATE.OPEN) return;
    if (this.failureCount > 0) this.failureCount -= 1;
    if (this.state === BREAKER_STATE.DEGRADED && this.failureCount <= this.degradationThreshold) {
      this.transition(BREAKER_STATE.CLOSED, "recovery");
    }
    this.successCount += 1;
    this.persist();
  }

  /**
   * Record a failed request. Callers must have decided the failure counts (see
   * `shouldRecordFailure`) — this method still re-checks defensively so a
   * caller that forgets cannot poison provider health with a client 4xx.
   *
   * @param {string|null} [kind] a `FailureKind`
   * @param {{status?: number, error?: unknown}} [context] for the non-tripping filter
   */
  recordFailure(kind = null, context = {}) {
    if (context && (context.status != null || context.error != null)) {
      if (!shouldRecordFailure({ status: context.status, error: context.error, kind })) return;
    }
    this.decayStaleDegradation();
    const failureKind = typeof kind === "string" && kind ? kind : null;

    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    this.lastFailureKind = failureKind;
    if (failureKind) {
      this.kindFailureCounts[failureKind] = (this.kindFailureCounts[failureKind] || 0) + 1;
    }

    // A failed probe is the escalation signal: it must count BEFORE any
    // kind-specific "immediate open" shortcut, or a quota_exhausted probe
    // failure would return early and never increment openCycleCount.
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      this.openCycleCount += 1;
      this.openCircuit(failureKind, `probe-failed-cycle-${this.openCycleCount}`);
      return;
    }

    // Kind-specific thresholds, checked before the generic total.
    if (failureKind) {
      const config = this.kindThresholds[failureKind];
      if (config) {
        const kindCount = this.kindFailureCounts[failureKind];
        const threshold = typeof config.threshold === "number" ? config.threshold : this.failureThreshold;
        if (config.immediateOpen && kindCount >= Math.max(1, threshold)) {
          this.openCircuit(failureKind);
          return;
        }
        if (kindCount >= threshold) {
          this.openCircuit(failureKind);
          return;
        }
      }
    }

    if (this.state === BREAKER_STATE.OPEN) {
      // Already open: counts updated, cooldown untouched by extra failures.
      this.persist();
      return;
    }

    if (this.state === BREAKER_STATE.DEGRADED) {
      if (this.failureCount >= this.failureThreshold) this.openCircuit(failureKind);
      else this.persist();
      return;
    }

    // CLOSED
    if (this.failureCount >= this.failureThreshold) {
      this.openCircuit(failureKind);
    } else if (this.failureCount >= this.degradationThreshold) {
      this.transition(BREAKER_STATE.DEGRADED, "failure-threshold-warn");
      this.persist();
    } else {
      this.persist();
    }
  }

  /** Force the circuit OPEN and arm its cooldown. */
  openCircuit(kind = null, reason = null) {
    if (kind) this.lastFailureKind = kind;
    this.transition(BREAKER_STATE.OPEN, reason || `open-${kind || "failure"}`);
    if (this.lastFailureTime == null) this.lastFailureTime = Date.now();
    this.halfOpenProbeStartedAt = null;
    this.halfOpenAllowed = 0;
    this.persist();
  }

  /** Close a DEGRADED breaker without touching a CLOSED/OPEN/HALF_OPEN one. */
  closeDegraded(reason = "manual-close") {
    if (this.state !== BREAKER_STATE.DEGRADED) return false;
    this.transition(BREAKER_STATE.CLOSED, reason);
    this.resetCounters();
    this.persist();
    return true;
  }

  /** Reset to a pristine CLOSED breaker. */
  reset(reason = "manual-reset") {
    this.transition(BREAKER_STATE.CLOSED, reason);
    this.resetCounters();
    this.lastFailureTime = null;
    this.halfOpenProbeStartedAt = null;
    this.halfOpenAllowed = this.halfOpenRequests;
    this.persist();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  resetCounters() {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureKind = null;
    this.kindFailureCounts = {};
    this.openCycleCount = 0;
  }

  /**
   * Escalated base cooldown for the current kind and cycle count.
   * Kind overrides replace `resetTimeout` as the base but still escalate.
   */
  effectiveCooldownMs() {
    const kindBase = resolveCooldownMs(this.lastFailureKind, {
      cooldownByKind: this.cooldownByKind,
      defaultCooldown: this.resetTimeout,
    });
    const base = Number.isFinite(kindBase) && kindBase > 0 ? kindBase : this.resetTimeout;
    return escalateCooldown(base, this.openCycleCount, {
      backoffEscalationCount: this.backoffEscalationCount,
      maxBackoffMultiplier: this.maxBackoffMultiplier,
    });
  }

  /** Milliseconds until the current cooldown expires (≥ 0). */
  timeUntilResetMs() {
    if (this.state === BREAKER_STATE.HALF_OPEN && this.halfOpenProbeStartedAt != null) {
      return Math.max(0, this.resetTimeout - (Date.now() - this.halfOpenProbeStartedAt));
    }
    if (this.lastFailureTime == null) return 0;
    return Math.max(0, this.effectiveCooldownMs() - (Date.now() - this.lastFailureTime));
  }

  /**
   * A DEGRADED breaker that stops receiving traffic ages out instead of
   * lingering; also lets a long-past failure stop double-counting.
   */
  decayStaleDegradation() {
    if (this.state !== BREAKER_STATE.DEGRADED) return;
    if (this.lastFailureTime == null) return;
    if (Date.now() - this.lastFailureTime < this.effectiveCooldownMs()) return;
    this.failureCount = 0;
    this.lastFailureKind = null;
    this.kindFailureCounts = {};
  }

  transition(newState, reason = undefined) {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;

    if (newState === BREAKER_STATE.HALF_OPEN) {
      this.halfOpenAllowed = this.halfOpenRequests;
      this.halfOpenProbeStartedAt = null;
    }

    this.transitionHistory.push({
      from: oldState,
      to: newState,
      timestamp: Date.now(),
      failureCount: this.failureCount,
      reason: typeof reason === "string" ? reason : undefined,
    });
    if (this.transitionHistory.length > this.maxTransitionHistory) {
      this.transitionHistory.splice(0, this.transitionHistory.length - this.maxTransitionHistory);
    }

    if (this.onStateChange) {
      try { this.onStateChange(this.name, oldState, newState); } catch { /* never fail the request */ }
    }
  }

  /**
   * Persist asynchronously. Every failure — including a throwing persistence
   * hook — is swallowed: availability beats durability on the hot path.
   */
  persist() {
    if (!this.persistence) return;
    const snapshot = this.toSnapshot();
    try {
      const maybe = this.persistence.save(this.name, snapshot);
      if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
    } catch { /* never fail the request */ }
  }

  /** Merge a previously persisted snapshot into this breaker. */
  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    try {
      if (isKnownState(snapshot.state)) this.state = snapshot.state;
      if (Number.isFinite(Number(snapshot.failureCount))) this.failureCount = Math.max(0, Number(snapshot.failureCount));
      if (Number.isFinite(Number(snapshot.successCount))) this.successCount = Math.max(0, Number(snapshot.successCount));
      if (snapshot.lastFailureTime == null) this.lastFailureTime = null;
      else if (Number.isFinite(Number(snapshot.lastFailureTime))) this.lastFailureTime = Number(snapshot.lastFailureTime);
      this.lastFailureKind = typeof snapshot.lastFailureKind === "string" ? snapshot.lastFailureKind : null;
      if (snapshot.kindFailureCounts && typeof snapshot.kindFailureCounts === "object") {
        this.kindFailureCounts = { ...snapshot.kindFailureCounts };
      }
      if (Number.isFinite(Number(snapshot.openCycleCount))) this.openCycleCount = Math.max(0, Number(snapshot.openCycleCount));
      if (Number.isFinite(Number(snapshot.degradationThreshold))) this.degradationThreshold = Math.max(1, Number(snapshot.degradationThreshold));
      if (Array.isArray(snapshot.transitionHistory)) {
        this.transitionHistory = snapshot.transitionHistory.slice(-this.maxTransitionHistory);
      }
      if (this.state === BREAKER_STATE.HALF_OPEN) this.halfOpenAllowed = this.halfOpenRequests;
      this.loaded = true;
    } catch { /* malformed snapshot: keep in-memory defaults */ }
  }

  toSnapshot() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastFailureKind: this.lastFailureKind,
      kindFailureCounts: { ...this.kindFailureCounts },
      openCycleCount: this.openCycleCount,
      degradationThreshold: this.degradationThreshold,
      transitionHistory: [...this.transitionHistory],
      // Pure read (no refresh), so persisting can never re-enter this method.
      cooldownMs: this.effectiveCooldownMs(),
      updatedAt: new Date().toISOString(),
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampInt(value, fallback, min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.floor(num));
}

function isKnownState(value) {
  return value === BREAKER_STATE.CLOSED
    || value === BREAKER_STATE.DEGRADED
    || value === BREAKER_STATE.OPEN
    || value === BREAKER_STATE.HALF_OPEN;
}

function safeCall(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// ─── Registry ───────────────────────────────────────────────────────────────

const registry = new Map();

/**
 * Number of breakers currently registered (test seam).
 */
export function getCircuitRegistrySize() {
  return registry.size;
}

/**
 * Drop every registered breaker. Test seam; also used by `resetAllCircuitBreakers`.
 */
export function __resetCircuitRegistryForTests() {
  registry.clear();
}

/**
 * Evict cold breakers when the registry is full.
 * Only CLOSED breakers with zero failures are eligible — they are
 * behaviourally identical to a freshly constructed breaker, so removing them
 * changes nothing. OPEN/HALF_OPEN breakers carry live state and stay.
 */
function evictColdBreakersIfNeeded() {
  if (registry.size < BREAKER_DEFAULTS.maxRegistrySize) return;
  const candidates = [];
  for (const [name, breaker] of registry) {
    if (breaker.state === BREAKER_STATE.CLOSED && breaker.failureCount === 0) {
      candidates.push({ name, lastFailureTime: breaker.lastFailureTime || 0 });
    }
  }
  candidates.sort((a, b) => a.lastFailureTime - b.lastFailureTime);
  const target = registry.size - BREAKER_DEFAULTS.maxRegistrySize + 1;
  for (let i = 0; i < candidates.length && i < target; i++) {
    registry.delete(candidates[i].name);
  }
}

/**
 * Get (or create) the breaker registered under `name`.
 * Passing `options` on a subsequent call updates mutable tuning in place.
 */
export function getCircuitBreaker(name, options = {}) {
  let breaker = registry.get(name);
  if (!breaker) {
    evictColdBreakersIfNeeded();
    breaker = new CircuitBreaker(name, options);
    registry.set(name, breaker);
  } else if (options && typeof options === "object") {
    if (typeof options.failureThreshold === "number") breaker.failureThreshold = clampInt(options.failureThreshold, breaker.failureThreshold, 1);
    if (typeof options.resetTimeout === "number") breaker.resetTimeout = clampInt(options.resetTimeout, breaker.resetTimeout, 0);
    if (typeof options.halfOpenRequests === "number") breaker.halfOpenRequests = clampInt(options.halfOpenRequests, breaker.halfOpenRequests, 1);
    if (typeof options.degradationThreshold === "number") breaker.degradationThreshold = clampInt(options.degradationThreshold, breaker.degradationThreshold, 1);
    if (typeof options.maxBackoffMultiplier === "number") breaker.maxBackoffMultiplier = clampInt(options.maxBackoffMultiplier, breaker.maxBackoffMultiplier, 1);
    if (typeof options.backoffEscalationCount === "number") breaker.backoffEscalationCount = clampInt(options.backoffEscalationCount, breaker.backoffEscalationCount, 0);
    if (options.cooldownByKind) breaker.cooldownByKind = options.cooldownByKind;
    if (options.kindThresholds) breaker.kindThresholds = options.kindThresholds;
  }
  return breaker;
}

/** Status of every registered breaker. */
export function getAllCircuitBreakerStatuses() {
  return [...registry.values()].map((breaker) => breaker.getStatus());
}

/** Reset every registered breaker to CLOSED and empty the registry. */
export function resetAllCircuitBreakers() {
  for (const breaker of registry.values()) {
    try { breaker.reset("reset-all"); } catch { /* best effort */ }
  }
  registry.clear();
}

/** Status lookup by name without forcing construction. */
export function peekCircuitBreakerStatus(name) {
  const breaker = registry.get(name);
  return breaker ? breaker.getStatus() : null;
}

/** Convenience: is `name` currently OPEN (after refreshing expiry)? */
export function isCircuitOpen(name) {
  const breaker = registry.get(name);
  if (!breaker) return false;
  breaker.refreshOpenState();
  return breaker.state === BREAKER_STATE.OPEN;
}

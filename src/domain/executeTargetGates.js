/**
 * Ordered pre-dispatch gates (Wave 4).
 *
 * Before routing dispatches a request to a combo/model target, it asks this
 * module whether the target is usable at all. The answer is a verdict, never an
 * exception: a gate chain that can throw is a gate chain that can take the
 * router down, and every gate here reads state that may be missing, stale, or
 * temporarily unreachable.
 *
 * Locked gate order (spec US5, FR-014):
 *   1. circuit  — the target's breaker is OPEN
 *   2. cooldown — a model lock or rate limit is still armed
 *   3. credential — no credential/lock state lets this target run
 *
 * The first gate to skip wins. Reordering is a behaviour change: the breaker
 * owns long-lived provider health, the cooldown owns short-lived per-account
 * locks, and the credential gate is the cheapest last look.
 */

import {
  GATE,
  VERDICT,
  BREAKER_STATE,
} from "open-sse/config/resilienceConfig.js";
import { sanitizeFailureReason } from "@/lib/resilience/failureClassification.js";
import { cooldownVerdict, formatDurationHuman, getConnectionCooldownVerdict } from "@/lib/resilience/cooldownManager.js";

/** A passing verdict. `target` is echoed unchanged for the caller. */
export function proceedVerdict(target = null) {
  return { kind: VERDICT.PROCEED, target, reason: null, retryAfterMs: 0 };
}

/**
 * A skipping verdict.
 * @param {string} reason one of GATE values
 * @param {{retryAfterMs?: number, message?: string}} [extra]
 */
export function skipVerdict(reason, extra = {}) {
  const retryAfterMs = Number.isFinite(Number(extra.retryAfterMs)) && Number(extra.retryAfterMs) > 0
    ? Math.ceil(Number(extra.retryAfterMs))
    : 0;
  return {
    kind: VERDICT.SKIP,
    reason,
    retryAfterMs,
    retryAfterHuman: retryAfterMs > 0 ? formatDurationHuman(retryAfterMs) : null,
    message: extra.message || defaultSkipMessage(reason),
  };
}

function defaultSkipMessage(reason) {
  switch (reason) {
    case GATE.CIRCUIT: return "Target circuit breaker is open";
    case GATE.COOLDOWN: return "Target is cooling down";
    case GATE.CREDENTIAL: return "Target has no usable credential";
    default: return "Target skipped";
  }
}

/**
 * Resolve a breaker for a target.
 * Accepts a pre-resolved breaker (tests, callers that own the registry), a
 * resolver function, or nothing.
 */
function resolveBreaker(target, deps) {
  if (target && target.breaker && typeof target.breaker.getStatus === "function") return target.breaker;
  if (typeof deps.getBreaker === "function") {
    const domain = breakerDomainFor(target);
    if (!domain) return null;
    return deps.getBreaker(domain) || null;
  }
  return null;
}

/**
 * Breaker domain for a target: provider-scoped when a provider exists, else the
 * connection-scoped name. Kept here so gates and callers agree on the naming.
 */
export function breakerDomainFor(target) {
  if (!target || typeof target !== "object") return null;
  if (target.domain) return String(target.domain);
  const provider = target.provider ? String(target.provider) : "";
  const connectionId = target.connectionId ? String(target.connectionId) : "";
  if (provider) return connectionId ? `${provider}:${connectionId}` : provider;
  return connectionId || null;
}

/**
 * Gate 1 — circuit breaker.
 * A breaker in OPEN rejects. HALF_OPEN probes are *admitted* here and the probe
 * budget is consumed by `canExecute()`; a probe-carrying target proceeds.
 */
function circuitGate(target, deps) {
  const breaker = resolveBreaker(target, deps);
  if (!breaker) return null;

  const status = typeof breaker.getStatus === "function" ? breaker.getStatus() : null;
  if (!status) return null;

  if (status.state === BREAKER_STATE.OPEN) {
    return skipVerdict(GATE.CIRCUIT, {
      retryAfterMs: status.retryAfterMs,
      message: sanitizeFailureReason(
        `Circuit open for ${breaker.name || breakerDomainFor(target) || "target"}${status.lastFailureKind ? ` (${status.lastFailureKind})` : ""}`
      ),
    });
  }

  if (status.state === BREAKER_STATE.HALF_OPEN) {
    const allowed = typeof breaker.canExecute === "function" ? breaker.canExecute() : true;
    if (!allowed) {
      return skipVerdict(GATE.CIRCUIT, {
        retryAfterMs: status.retryAfterMs || 1000,
        message: sanitizeFailureReason(
          `Half-open probe budget exhausted for ${breaker.name || breakerDomainFor(target) || "target"}`
        ),
      });
    }
  }

  return null;
}

/** Gate 2 — armed cooldown (connection-level model lock / rate limit). */
function cooldownGate(target, deps) {
  const connection = target && target.connection ? target.connection : null;
  const model = target && target.model ? String(target.model) : null;
  const now = Number.isFinite(Number(deps.now)) ? Number(deps.now) : Date.now();

  if (connection) {
    const verdict = getConnectionCooldownVerdict(connection, model, now);
    if (verdict.inCooldown) {
      return skipVerdict(GATE.COOLDOWN, {
        retryAfterMs: verdict.remainingMs,
        message: sanitizeFailureReason(`Cooldown active (${verdict.reason}) for ${model || "account"}`),
      });
    }
  }

  // Explicit per-target cooldown timestamp (e.g. persisted rate_limited_until).
  if (target && target.cooldownUntil) {
    const verdict = cooldownVerdict(target.cooldownUntil, now);
    if (verdict.inCooldown) {
      return skipVerdict(GATE.COOLDOWN, {
        retryAfterMs: verdict.remainingMs,
        message: sanitizeFailureReason("Target rate-limited by upstream"),
      });
    }
  }

  return null;
}

/**
 * Gate 3 — credential availability.
 * `deps.hasCredential(target)` (sync or async) may answer false; a throw or a
 * missing function means "unknown", which proceeds.
 */
async function credentialGate(target, deps) {
  if (typeof deps.hasCredential !== "function") return null;
  const hasCredential = await deps.hasCredential(target);
  if (hasCredential === false) {
    return skipVerdict(GATE.CREDENTIAL, { message: "No credential available for target" });
  }
  return null;
}

/** The ordered gate chain. Order is the contract (FR-014). */
const GATES = [
  { reason: GATE.CIRCUIT, evaluate: circuitGate },
  { reason: GATE.COOLDOWN, evaluate: cooldownGate },
  { reason: GATE.CREDENTIAL, evaluate: credentialGate },
];

/** Gate reasons in evaluation order (for tests and diagnostics). */
export function gateOrder() {
  return GATES.map((gate) => gate.reason);
}

/**
 * Evaluate the gate chain for one target.
 *
 * Always resolves to a verdict. Any gate throwing is treated as "this gate has
 * nothing to say" and the chain continues; an outer catch fails open to
 * `proceed` so a broken dependency can never deny routing.
 *
 * @param {object} target `{ provider, connectionId, model, connection, breaker, cooldownUntil }`
 * @param {object} deps `{ getBreaker?, hasCredential?, now? }`
 * @returns {Promise<{kind: "proceed"|"skip", reason: string|null, retryAfterMs: number}>}
 */
export async function evaluateTargetGates(target, deps = {}) {
  try {
    for (const gate of GATES) {
      let outcome = null;
      try {
        outcome = await gate.evaluate(target, deps || {});
      } catch {
        outcome = null; // a gate that cannot answer does not block
      }
      if (outcome && outcome.kind === VERDICT.SKIP) return outcome;
    }
    return proceedVerdict(target);
  } catch {
    // Fail open: availability beats a perfect verdict.
    return proceedVerdict(target);
  }
}

/**
 * Describe every target whose breaker is OPEN, for terminal diagnostics.
 * Returns null when the pool is not uniformly blocked (mixed pools keep the
 * generic response).
 */
export function collectOpenBreakerExclusions(targets, deps = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const exclusions = [];
  for (const target of targets) {
    const breaker = resolveBreaker(target, deps);
    if (!breaker || typeof breaker.getStatus !== "function") return null;
    const status = breaker.getStatus();
    if (!status || status.state !== BREAKER_STATE.OPEN) return null;
    exclusions.push({
      domain: breaker.name || breakerDomainFor(target),
      provider: target.provider || null,
      model: target.model || null,
      reason: GATE.CIRCUIT,
      retryAfterMs: status.retryAfterMs > 0 ? status.retryAfterMs : null,
    });
  }
  return exclusions;
}

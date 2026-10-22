/**
 * Fallback-path resilience facade (Wave 4).
 *
 * The fallback loops (`src/sse/handlers/chat.js` and friends) call this facade
 * instead of touching breakers or gates directly. That keeps the opt-in
 * boundary in one place and makes the "disabled" path trivially auditable: when
 * `KHATAM_RESILIENCE_CIRCUIT_BREAKER` is not `"1"`, `gateTarget` returns a
 * proceed verdict before any module that could read SQLite or Redis is
 * consulted, and `observeFailure`/`observeSuccess` return without doing work.
 *
 * Fail semantics: fail-open. A gate or breaker that cannot answer lets traffic
 * through. Authorization stays fail-closed elsewhere (Wave 3, unchanged).
 */

import {
  GATE,
  RESILIENCE_FLAG_ENV,
  isResilienceEnabled,
} from "open-sse/config/resilienceConfig.js";
import {
  classify429,
  sanitizeFailureReason,
  shouldRecordFailure,
} from "@/lib/resilience/failureClassification.js";
import { proceedVerdict, evaluateTargetGates, breakerDomainFor } from "@/domain/executeTargetGates.js";

export { isResilienceEnabled, RESILIENCE_FLAG_ENV };

/** Lazily resolved so the disabled path never loads the store or its driver. */
async function loadStore() {
  return import("@/lib/resilience/circuitBreakerStore.js");
}

/** True when the breaker registry already holds a breaker for `domain`. */
async function resolveBreaker(domain) {
  if (!domain) return null;
  try {
    const { getCircuitBreakerForDomain } = await loadStore();
    return getCircuitBreakerForDomain(domain);
  } catch {
    return null;
  }
}

/**
 * Build the target descriptor the gate chain understands from the pieces the
 * fallback loop already has.
 */
export function buildTarget({ provider, connectionId, model, connection, cooldownUntil } = {}) {
  return {
    provider: provider || null,
    connectionId: connectionId || null,
    model: model || null,
    connection: connection || null,
    cooldownUntil: cooldownUntil || null,
  };
}

/**
 * Pre-dispatch gate for one target.
 *
 * Disabled → an immediate proceed verdict (no I/O at all).
 * Enabled  → the ordered gate chain, with a breaker resolved for the target.
 */
export async function gateTarget(target, options = {}) {
  if (!isResilienceEnabled()) return proceedVerdict(target);

  const descriptor = target && typeof target === "object" ? target : buildTarget(target || {});
  const domain = breakerDomainFor(descriptor);

  try {
    // A caller-supplied resolver wins (tests, batch callers that pre-resolve);
    // otherwise the durable store is consulted lazily, only on this path.
    const getBreaker = typeof options.getBreaker === "function"
      ? options.getBreaker
      : () => resolveBreaker(domain);

    const verdict = await evaluateTargetGates(descriptor, {
      getBreaker,
      hasCredential: options.hasCredential,
      now: options.now,
    });

    // The gate chain is synchronous by contract; the default resolver is async,
    // so when it produced a promise the chain saw an unresolved breaker and
    // proceeded. Re-check the breaker here rather than silently skipping it.
    if (verdict.kind !== "skip" && typeof options.getBreaker !== "function") {
      const breaker = await resolveBreaker(domain);
      if (breaker) {
        const recheck = await evaluateTargetGates(
          { ...descriptor, breaker },
          { hasCredential: options.hasCredential, now: options.now }
        );
        if (recheck.kind === "skip") return recheck;
      }
    }

    return verdict;
  } catch {
    return proceedVerdict(descriptor);
  }
}

/**
 * Record a failed attempt against the target's breaker.
 *
 * @param {object} params
 * @param {string} [params.provider]
 * @param {string} [params.connectionId]
 * @param {number} [params.status]
 * @param {unknown} [params.error]  upstream error text/object
 * @param {object} [params.headers] upstream headers (body classification)
 * @param {object} [params.body]    parsed upstream error body
 */
export async function observeFailure({ provider, connectionId, model, status, error, headers, body } = {}) {
  if (!isResilienceEnabled()) return { recorded: false, reason: "disabled" };

  if (!shouldRecordFailure({ status, error })) {
    return { recorded: false, reason: "exempt" };
  }

  const domain = breakerDomainFor({ provider, connectionId });
  if (!domain) return { recorded: false, reason: "no-domain" };

  try {
    const breaker = await resolveBreaker(domain);
    if (!breaker) return { recorded: false, reason: "no-breaker" };

    const kind = classify429({ status, headers, body: body !== undefined ? body : error });
    breaker.recordFailure(kind, { status, error });
    return {
      recorded: true,
      domain,
      kind,
      state: breaker.state,
      retryAfterMs: breaker.getRetryAfterMs(),
      reason: sanitizeFailureReason(error, 160),
    };
  } catch {
    return { recorded: false, reason: "error" };
  }
}

/**
 * Record a successful attempt: closes a HALF_OPEN probe and decays CLOSED counts.
 */
export async function observeSuccess({ provider, connectionId } = {}) {
  if (!isResilienceEnabled()) return { recorded: false, reason: "disabled" };
  const domain = breakerDomainFor({ provider, connectionId });
  if (!domain) return { recorded: false, reason: "no-domain" };
  try {
    const breaker = await resolveBreaker(domain);
    if (!breaker) return { recorded: false, reason: "no-breaker" };
    breaker.recordSuccess("request-succeeded");
    return { recorded: true, domain, state: breaker.state };
  } catch {
    return { recorded: false, reason: "error" };
  }
}

/**
 * Terminal diagnostic: every target blocked purely by an OPEN breaker.
 * Null when the pool is mixed or resilience is disabled.
 */
export async function describeCircuitExclusions(targets, options = {}) {
  if (!isResilienceEnabled()) return null;
  try {
    const { collectOpenBreakerExclusions } = await import("@/domain/executeTargetGates.js");
    return collectOpenBreakerExclusions(targets, {
      getBreaker: options.getBreaker,
    });
  } catch {
    return null;
  }
}

/** Re-export the gate identifiers used by call sites for logging. */
export { GATE };

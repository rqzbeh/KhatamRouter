// Wave 4 — 4-state circuit breaker, 429 classification, cooldowns, pre-dispatch gates.
//
// Covers (spec.md US1..US6 / FR-001..FR-020):
// 1. State machine: CLOSED → DEGRADED → OPEN → HALF_OPEN → CLOSED, escalation
// 2. 429 Classification: rate_limit vs quota_exhausted vs transient
// 3. Local-lifecycle / non-tripping status exemptions (never poison health)
// 4. Cooldowns: kind buckets + open-cycle escalation
// 5. Persistence: domain_circuit_breakers round-trip through the real driver
// 6. Redis Fail-Open: absent and throwing caches degrade to SQLite silently
// 7. Pre-Dispatch Gates: locked order, retry hints, never throws
// 8. Flag isolation: zero behaviour change when unconfigured
// 9. Negative Control: an OPEN breaker must reject a gated target

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate/verdict constants are pure data — import them directly.
const {
  BREAKER_STATE,
  FAILURE_KIND,
  GATE,
  VERDICT,
  NON_TRIPPING_STATUSES,
  RESILIENCE_FLAG_ENV,
} = await import("open-sse/config/resilienceConfig.js");

const classification = await import("@/lib/resilience/failureClassification.js");
const cooldowns = await import("@/lib/resilience/cooldownManager.js");
const breakerModule = await import("@/shared/utils/circuitBreaker.js");
const gates = await import("@/domain/executeTargetGates.js");
const fallback = await import("@/domain/fallbackResilience.js");

const { CircuitBreaker, CircuitBreakerOpenError, STATE, getCircuitBreaker, __resetCircuitRegistryForTests } = breakerModule;

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Deterministic clock. `Date.now` is the only time source the breaker uses,
 * which makes every transition and cooldown assertion exact.
 */
let fakeNow = 1_700_000_000_000;
function advance(ms) { fakeNow += ms; }
function resetClock() { fakeNow = 1_700_000_000_000; }

const originalNow = Date.now;

beforeEach(() => {
  resetClock();
  vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
  delete process.env[RESILIENCE_FLAG_ENV];
  __resetCircuitRegistryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  Date.now = originalNow;
  delete process.env[RESILIENCE_FLAG_ENV];
  __resetCircuitRegistryForTests();
});

/** Build a breaker with a small, predictable threshold. */
function makeBreaker(name = "provider-x", overrides = {}) {
  return new CircuitBreaker(name, {
    failureThreshold: 4,
    degradationThreshold: 2,
    resetTimeout: 30_000,
    halfOpenRequests: 1,
    ...overrides,
  });
}

/** Drive a breaker straight to OPEN. */
function driveToOpen(breaker, kind = FAILURE_KIND.TRANSIENT) {
  while (breaker.state !== BREAKER_STATE.OPEN) breaker.recordFailure(kind);
  return breaker;
}

// ─── 1. State Machine ───────────────────────────────────────────────────────

describe("1. State Machine — CLOSED → DEGRADED → OPEN → HALF_OPEN → CLOSED", () => {
  it("exposes exactly the four contractual states", () => {
    expect(Object.keys(STATE).sort()).toEqual(["CLOSED", "DEGRADED", "HALF_OPEN", "OPEN"]);
    expect(STATE).toBe(BREAKER_STATE);
  });

  it("starts CLOSED and admits dispatch", () => {
    const breaker = makeBreaker();
    expect(breaker.state).toBe(BREAKER_STATE.CLOSED);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getRetryAfterMs()).toBe(0);
  });

  it("escalates CLOSED → DEGRADED at the degradation threshold", () => {
    const breaker = makeBreaker();
    breaker.recordFailure(FAILURE_KIND.TRANSIENT);
    expect(breaker.state).toBe(BREAKER_STATE.CLOSED);

    breaker.recordFailure(FAILURE_KIND.TRANSIENT);
    expect(breaker.state).toBe(BREAKER_STATE.DEGRADED);
    expect(breaker.failureCount).toBe(2);
    // DEGRADED still serves traffic — that is the whole point of the state.
    expect(breaker.canExecute()).toBe(true);
  });

  it("escalates DEGRADED → OPEN at the failure threshold", () => {
    const breaker = makeBreaker();
    for (let i = 0; i < 4; i++) breaker.recordFailure(FAILURE_KIND.TRANSIENT);
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
    expect(breaker.canExecute()).toBe(false);
  });

  it("OPEN rejects dispatch until the cooldown elapses, then admits a probe as HALF_OPEN", () => {
    const breaker = driveToOpen(makeBreaker());
    expect(breaker.canExecute()).toBe(false);
    expect(breaker.getRetryAfterMs()).toBe(30_000);

    advance(30_001);
    // The first call after expiry transitions and consumes the single probe slot.
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.state).toBe(BREAKER_STATE.HALF_OPEN);
    // Probe budget is exhausted: a second concurrent request waits.
    expect(breaker.canExecute()).toBe(false);
  });

  it("a failed HALF_OPEN probe returns to OPEN and increments openCycleCount", () => {
    const breaker = driveToOpen(makeBreaker());
    advance(30_001);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.state).toBe(BREAKER_STATE.HALF_OPEN);

    breaker.recordFailure(FAILURE_KIND.TRANSIENT);
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
    expect(breaker.openCycleCount).toBe(1);
  });

  it("a successful HALF_OPEN probe closes the circuit and resets counters", () => {
    const breaker = driveToOpen(makeBreaker());
    advance(30_001);
    breaker.canExecute();
    expect(breaker.state).toBe(BREAKER_STATE.HALF_OPEN);

    breaker.recordSuccess("probe");
    expect(breaker.state).toBe(BREAKER_STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.kindFailureCounts).toEqual({});
    expect(breaker.openCycleCount).toBe(0);
  });

  it("resets and reports a bounded transition history", () => {
    const breaker = makeBreaker({ maxTransitionHistory: 3 });
    for (let i = 0; i < 4; i++) breaker.recordFailure(FAILURE_KIND.TRANSIENT);
    expect(breaker.transitionHistory.length).toBeLessThanOrEqual(3);
    const last = breaker.transitionHistory.at(-1);
    expect(last.to).toBe(BREAKER_STATE.OPEN);

    breaker.reset();
    expect(breaker.state).toBe(BREAKER_STATE.CLOSED);
    expect(breaker.getStatus().failureCount).toBe(0);
  });

  it("execute() throws CircuitBreakerOpenError carrying the retry hint when OPEN", async () => {
    const breaker = driveToOpen(makeBreaker());
    await expect(breaker.execute(async () => "never")).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    await breaker.execute(async () => "never").catch((error) => {
      expect(error.circuitName).toBe("provider-x");
      expect(error.retryAfterMs).toBeGreaterThan(0);
    });
  });

  it("execute() records a genuine upstream failure but ignores a client-error failure", async () => {
    const breaker = makeBreaker();
    await breaker
      .execute(async () => { throw new Error("upstream exploded"); }, {
        classify: () => FAILURE_KIND.TRANSIENT,
      })
      .catch(() => {});
    expect(breaker.failureCount).toBe(1);

    await breaker
      .execute(async () => {
        const err = new Error("bad request");
        err.status = 400;
        throw err;
      })
      .catch(() => {});
    // 400 is exempt: the count must not move.
    expect(breaker.failureCount).toBe(1);
  });
});

// ─── 2. 429 Classification ─────────────────────────────────────────────────

describe("2. 429 Classification — rate_limit vs quota_exhausted vs transient", () => {
  it("classifies any non-429 status as transient", () => {
    expect(classification.classify429({ status: 500, body: {} })).toBe(FAILURE_KIND.TRANSIENT);
    expect(classification.classify429({ status: 200 })).toBe(FAILURE_KIND.TRANSIENT);
    expect(classification.classify429({})).toBe(FAILURE_KIND.TRANSIENT);
  });

  it("classifies a plain burst 429 as rate_limit", () => {
    const body = { error: { message: "Rate limit exceeded, please slow down" } };
    expect(classification.classify429({ status: 429, body })).toBe(FAILURE_KIND.RATE_LIMIT);
  });

  it("classifies terminal credit exhaustion as quota_exhausted even with a short retry hint", () => {
    const body = {
      error: {
        message: "You have exhausted all your credits. Please retry in 5s.",
      },
    };
    expect(classification.classify429({ status: 429, body })).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
  });

  it("classifies a daily-quota 429 as quota_exhausted", () => {
    const bodies = [
      { error: { message: "You have reached your daily limit" } },
      { error: { message: "Monthly quota exceeded" } },
      { error: { message: "request reached organization TPD rate limit, current: 10, limit: 5" } },
      { error: "usage limit reached" },
    ];
    for (const body of bodies) {
      expect(classification.classify429({ status: 429, body }), JSON.stringify(body)).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
    }
  });

  it("honours an upstream-declared sub-hour retry window over a generic quota phrase", () => {
    const body = {
      error: {
        code: 429,
        message: "You exceeded your current quota",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "38.9s" }],
      },
    };
    expect(classification.upstreamRetryDelaySeconds(body)).toBeCloseTo(38.9, 1);
    expect(classification.classify429({ status: 429, body })).toBe(FAILURE_KIND.RATE_LIMIT);
  });

  it("treats a quota phrase with an hour-plus declared window as exhaustion", () => {
    const body = {
      error: {
        message: "Daily quota exceeded. Please retry in 7200s.",
      },
    };
    expect(classification.classify429({ status: 429, body })).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
  });

  it("recognises CJK quota exhaustion bodies", () => {
    expect(classification.classify429({ status: 429, body: { error: { message: "当前额度已用完" } } }))
      .toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
    expect(classification.classify429({ status: 429, body: { error: { message: "할당량을 초과했습니다" } } }))
      .toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
  });

  it("distinguishes concurrency wording from an exhausted budget", () => {
    const concurrency = { error: { message: "Too many concurrent requests for this account" } };
    expect(classification.looksLikeConcurrencyLimit(concurrency)).toBe(true);
    expect(classification.classify429({ status: 429, body: concurrency })).toBe(FAILURE_KIND.RATE_LIMIT);

    // An explicit quota phrase outranks the concurrency reading.
    const both = { error: { message: "Too many concurrent requests; daily quota exceeded" } };
    expect(classification.looksLikeConcurrencyLimit(both)).toBe(false);
  });

  it("parses Retry-After in seconds, relative units, and HTTP dates", () => {
    expect(classification.parseRetryAfter("60")).toBe(60);
    // Relative units must be checked before plain integer parsing: "5m" is 300s, not 5s.
    expect(classification.parseRetryAfter("5m")).toBe(300);
    expect(classification.parseRetryAfter("2h")).toBe(7200);
    expect(classification.parseRetryAfter("1500ms")).toBe(1.5);
    expect(classification.parseRetryAfter("")).toBeNull();
    expect(classification.parseRetryAfter(undefined)).toBeNull();
    const futureDate = new Date(Date.now() + 90_000).toUTCString();
    expect(classification.parseRetryAfter(futureDate)).toBeGreaterThan(80);
  });

  it("classifies from axios-style and fetch-style error shapes", () => {
    expect(classification.classify429FromError({
      response: { status: 429, data: { error: { message: "daily limit reached" } } },
    })).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);

    expect(classification.classify429FromError({
      status: 429,
      body: { error: { message: "too many requests" } },
    })).toBe(FAILURE_KIND.RATE_LIMIT);

    // No status anywhere → undefined, so the caller decides instead of guessing.
    expect(classification.classify429FromError(new Error("boom"))).toBeUndefined();
    expect(classification.classify429FromError(null)).toBeUndefined();
  });

  it("bounds every quota regex so an adversarial body cannot hang classification", () => {
    // A long body of near-miss text must return quickly and be transient-safe.
    const hostile = { error: { message: `${"daily ".repeat(5000)}x` } };
    const started = performance.now();
    classification.classify429({ status: 429, body: hostile });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// ─── 3. Local-Lifecycle And Non-Tripping Exemptions ────────────────────────

describe("3. Failure Exemptions — client 4xx, POLICY, local lifecycle", () => {
  it("declares exactly the non-tripping client statuses", () => {
    expect([...NON_TRIPPING_STATUSES].sort((a, b) => a - b)).toEqual([400, 406, 408, 409, 410, 422]);
  });

  it("never records a non-tripping client status", () => {
    for (const status of NON_TRIPPING_STATUSES) {
      expect(classification.shouldRecordFailure({ status }), String(status)).toBe(false);
    }
    // Account-scoped and server statuses still count.
    for (const status of [401, 402, 403, 404, 429, 500, 502, 503, 504]) {
      expect(classification.shouldRecordFailure({ status }), String(status)).toBe(true);
    }
  });

  it("exempts content-policy and moderation refusals", () => {
    expect(classification.shouldRecordFailure({ status: 400, error: "blocked by safety system" })).toBe(false);
    expect(classification.shouldRecordFailure({ status: 403, error: "content_policy_violation" })).toBe(false);
    expect(classification.shouldRecordFailure({ status: 403, error: new Error("blocked by policy") })).toBe(false);
    expect(classification.shouldRecordFailure({ status: "POLICY" })).toBe(true); // not a client status → ordinary handling
    expect(classification.shouldRecordFailure({ kind: "POLICY" })).toBe(false);
  });

  it("exempts our own stream-lifecycle errors", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classification.isLocalStreamLifecycleError(abort)).toBe(true);
    expect(classification.isLocalStreamLifecycleError("Invalid state: Controller is already closed")).toBe(true);
    expect(classification.isLocalStreamLifecycleError("Client disconnected mid-stream")).toBe(true);
    expect(classification.isLocalStreamLifecycleError("request_signal_aborted")).toBe(true);

    expect(classification.shouldRecordFailure({ error: abort })).toBe(false);
    expect(classification.shouldRecordFailure({ error: "Controller is already closed" })).toBe(false);
  });

  it("exempts local host-execution errors but not upstream ones", () => {
    expect(classification.isLocalExecutionError({ code: "ENOENT" })).toBe(true);
    expect(classification.isLocalExecutionError("spawn claude ENOENT")).toBe(true);
    expect(classification.shouldRecordFailure({ error: "spawn x EACCES" })).toBe(false);

    const upstream = { status: 502, message: "bad gateway from upstream provider" };
    expect(classification.isLocalExecutionError(upstream)).toBe(false);
    expect(classification.shouldRecordFailure(upstream)).toBe(true);
  });

  it("a breaker never moves on an exempt failure, in any state", () => {
    const breaker = makeBreaker();
    for (const status of NON_TRIPPING_STATUSES) {
      breaker.recordFailure(FAILURE_KIND.TRANSIENT, { status });
    }
    expect(breaker.state).toBe(BREAKER_STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);

    // Even directly OPEN, an exempt failure must not extend the cooldown.
    driveToOpen(breaker);
    const before = breaker.getRetryAfterMs();
    breaker.recordFailure(FAILURE_KIND.TRANSIENT, { status: 400 });
    expect(breaker.getRetryAfterMs()).toBe(before);
  });

  it("sanitizes secrets out of a persisted failure reason", () => {
    const reason = classification.sanitizeFailureReason(
      "upstream rejected Authorization: Bearer sk-abcdef0123456789 and api_key=supersecretvalue123",
      200
    );
    expect(reason).not.toContain("sk-abcdef0123456789");
    expect(reason).not.toContain("supersecretvalue123");
    expect(reason).toContain("[redacted]");
    expect(reason.length).toBeLessThanOrEqual(200);
  });
});

// ─── 4. Cooldowns ─────────────────────────────────────────────────────────

describe("4. Cooldowns — kind buckets and adaptive escalation", () => {
  it("resolves a kind-specific base cooldown", () => {
    expect(cooldowns.resolveCooldownMs(FAILURE_KIND.QUOTA_EXHAUSTED)).toBe(60 * 60 * 1000);
    expect(cooldowns.resolveCooldownMs(FAILURE_KIND.RATE_LIMIT)).toBe(30 * 1000);
    // Explicit overrides win over the constant map.
    expect(cooldowns.resolveCooldownMs(FAILURE_KIND.RATE_LIMIT, {
      cooldownByKind: { [FAILURE_KIND.RATE_LIMIT]: 1000 },
    })).toBe(1000);
    // Unknown kind falls back to the caller default.
    expect(cooldowns.resolveCooldownMs("nonsense", { defaultCooldown: 777 })).toBe(777);
  });

  it("holds the base cooldown up to the escalation count, then doubles", () => {
    const base = 30_000;
    const opts = { backoffEscalationCount: 3, maxBackoffMultiplier: 16 };
    expect(cooldowns.escalateCooldown(base, 0, opts)).toBe(30_000);
    expect(cooldowns.escalateCooldown(base, 3, opts)).toBe(30_000);
    expect(cooldowns.escalateCooldown(base, 4, opts)).toBe(60_000);
    expect(cooldowns.escalateCooldown(base, 5, opts)).toBe(120_000);
    expect(cooldowns.escalateCooldown(base, 6, opts)).toBe(240_000);
    // Capped at base × maxBackoffMultiplier.
    expect(cooldowns.escalateCooldown(base, 20, opts)).toBe(30_000 * 16);
  });

  it("escalates a kind-cooldown the same way instead of pinning a fixed interval", () => {
    // quota_exhausted has a 1h base; each probe cycle beyond 3 doubles it.
    const breaker = makeBreaker("quota-provider", { backoffEscalationCount: 3, maxBackoffMultiplier: 4 });
    breaker.recordFailure(FAILURE_KIND.QUOTA_EXHAUSTED);
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
    expect(breaker.getRetryAfterMs()).toBe(60 * 60 * 1000);

    // Burn four probe cycles without advancing the clock past the base window.
    for (let cycle = 0; cycle < 4; cycle++) {
      advance(60 * 60 * 1000 + 1);
      expect(breaker.canExecute()).toBe(true);
      breaker.recordFailure(FAILURE_KIND.QUOTA_EXHAUSTED);
      expect(breaker.openCycleCount).toBe(cycle + 1);
    }
    expect(breaker.getRetryAfterMs()).toBe(2 * 60 * 60 * 1000);
  });

  it("opens immediately for an exhausted quota (no useless DEGRADED phase)", () => {
    const breaker = makeBreaker("immediate", {
      kindThresholds: {
        [FAILURE_KIND.QUOTA_EXHAUSTED]: { threshold: 1, immediateOpen: true, cooldown: 60 * 60 * 1000 },
      },
    });
    breaker.recordFailure(FAILURE_KIND.QUOTA_EXHAUSTED);
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
  });

  it("computes cooldown timestamps and clamps expired ones to zero", () => {
    const { cooldownUntilMs, durationMs } = cooldowns.calculateCooldownUntil(30_000, { now: fakeNow });
    expect(durationMs).toBe(30_000);
    expect(cooldownUntilMs).toBe(fakeNow + 30_000);

    expect(cooldowns.cooldownVerdict(cooldownUntilMs, fakeNow)).toEqual({ inCooldown: true, remainingMs: 30_000 });
    expect(cooldowns.cooldownVerdict(cooldownUntilMs, fakeNow + 30_001)).toEqual({ inCooldown: false, remainingMs: 0 });
    // Never negative, never NaN.
    expect(cooldowns.cooldownVerdict("not-a-date", fakeNow)).toEqual({ inCooldown: false, remainingMs: 0 });
  });

  it("reads connection model locks and account rate limits without mutating them", () => {
    const until = new Date(fakeNow + 45_000).toISOString();
    const connection = { id: "c1", modelLock_gpt: until, rateLimitedUntil: null };
    const frozen = JSON.stringify(connection);

    const verdict = cooldowns.getConnectionCooldownVerdict(connection, "gpt", fakeNow);
    expect(verdict.inCooldown).toBe(true);
    expect(verdict.reason).toBe("model_lock");
    expect(verdict.remainingMs).toBe(45_000);
    expect(JSON.stringify(connection)).toBe(frozen);

    // A different model is not locked by a per-model lock.
    expect(cooldowns.getConnectionCooldownVerdict(connection, "other", fakeNow).inCooldown).toBe(false);

    // Account-wide lock wins for every model.
    const accountWide = { modelLock___all: until };
    expect(cooldowns.getConnectionCooldownVerdict(accountWide, "anything", fakeNow).reason).toBe("model_lock_all");

    // Expired locks are inert.
    expect(cooldowns.getConnectionCooldownVerdict(connection, "gpt", fakeNow + 60_000).inCooldown).toBe(false);
  });

  it("formats a human retry window", () => {
    expect(cooldowns.formatDurationHuman(0)).toBe("0s");
    expect(cooldowns.formatDurationHuman(45_000)).toBe("45s");
    expect(cooldowns.formatDurationHuman(150_000)).toBe("2m 30s");
    expect(cooldowns.formatDurationHuman(3_600_000)).toBe("1h");
  });
});

// ─── 5. Persistence ───────────────────────────────────────────────────────

describe("5. Persistence — domain_circuit_breakers round-trip", () => {
  let tempDir;
  let originalDataDir;
  let store;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-wave4-persist-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    process.env.DATA_DIR_ALLOW_TEMP = "1";
    delete global._dbAdapter;

    vi.resetModules();
    store = await import("@/lib/resilience/circuitBreakerStore.js");
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    delete process.env.DATA_DIR_ALLOW_TEMP;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("creates the table with Wave 4 diagnostics columns after migration", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    expect(tables.has("domain_circuit_breakers")).toBe(true);

    const columns = new Set(db.all("PRAGMA table_info(domain_circuit_breakers)").map((r) => r.name));
    for (const col of ["domain", "state", "failure_count", "cooldown_until", "last_failure_kind", "open_cycle_count", "kind_failure_counts_json", "transition_history_json"]) {
      expect(columns.has(col), `missing column ${col}`).toBe(true);
    }

    // Migration 3 is recorded; Wave 2's two rows are still there (>= 3 now).
    const versions = db.all("SELECT version FROM _khatam_migrations").map((r) => String(r.version));
    expect(versions).toContain("1");
    expect(versions).toContain("2");
    expect(versions).toContain("3");
    expect(versions.length).toBeGreaterThanOrEqual(3);
  });

  it("round-trips a breaker snapshot through SQLite", async () => {
    const snapshot = {
      state: BREAKER_STATE.OPEN,
      failureCount: 7,
      successCount: 2,
      lastFailureTime: fakeNow,
      lastFailureKind: FAILURE_KIND.QUOTA_EXHAUSTED,
      openCycleCount: 2,
      kindFailureCounts: { [FAILURE_KIND.QUOTA_EXHAUSTED]: 5, [FAILURE_KIND.TRANSIENT]: 2 },
      transitionHistory: [{ from: BREAKER_STATE.CLOSED, to: BREAKER_STATE.OPEN, timestamp: fakeNow, failureCount: 7 }],
      retryAfterMs: 3_600_000,
    };

    expect(await store.saveBreakerRow("provider-x", snapshot)).toBe(true);
    const loaded = await store.loadBreakerRow("provider-x");

    expect(loaded).not.toBeNull();
    expect(loaded.state).toBe(BREAKER_STATE.OPEN);
    expect(loaded.failureCount).toBe(7);
    expect(loaded.lastFailureKind).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
    expect(loaded.openCycleCount).toBe(2);
    expect(loaded.kindFailureCounts[FAILURE_KIND.QUOTA_EXHAUSTED]).toBe(5);
    expect(loaded.transitionHistory).toHaveLength(1);
    expect(loaded.cooldownUntil).toBeTruthy();
  });

  it("upserts rather than duplicating a domain row", async () => {
    await store.saveBreakerRow("provider-y", { state: BREAKER_STATE.CLOSED, failureCount: 1 });
    await store.saveBreakerRow("provider-y", { state: BREAKER_STATE.OPEN, failureCount: 9 });

    const rows = (await store.listBreakerRows()).filter((r) => r.domain === "provider-y");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(BREAKER_STATE.OPEN);
    expect(Number(rows[0].failure_count)).toBe(9);
  });

  it("restores a wired breaker's state in a fresh instance", async () => {
    const first = store.getCircuitBreakerForDomain("restore-me", { failureThreshold: 2, resetTimeout: 5_000 });
    expect(first).toBeDefined();
    first.recordFailure(FAILURE_KIND.QUOTA_EXHAUSTED);
    expect(first.state).toBe(BREAKER_STATE.OPEN);

    // Let the fire-and-forget persistence settle.
    await new Promise((resolve) => setTimeout(resolve, 60));

    __resetCircuitRegistryForTests();
    const second = store.getCircuitBreakerForDomain("restore-me");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(second.state).toBe(BREAKER_STATE.OPEN);
    expect(second.lastFailureKind).toBe(FAILURE_KIND.QUOTA_EXHAUSTED);
  });

  it("returns null/false instead of throwing when the table is missing", async () => {
    // A raw in-memory database with no schema at all.
    const emptyDb = {
      all: () => [],
      get: () => undefined,
      run: () => ({ changes: 0 }),
      exec: () => {},
    };
    expect(await store.loadBreakerRow("nope", emptyDb)).toBeNull();
    expect(await store.saveBreakerRow("nope", { state: BREAKER_STATE.OPEN }, emptyDb)).toBe(false);
    expect(await store.listBreakerRows(emptyDb)).toEqual([]);
  });
});

// ─── 6. Redis Fail-Open ───────────────────────────────────────────────────

describe("6. Redis Fail-Open — cache mirror degrades to SQLite", () => {
  let store;
  let originalRedisUrl;

  beforeEach(async () => {
    originalRedisUrl = process.env.REDIS_URL;
    store = await import("@/lib/resilience/circuitBreakerStore.js");
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    store.setBreakerCacheClientProvider(null);
  });

  it("namespaces cache keys under khatam:cb:", () => {
    delete process.env.REDIS_URL;
    expect(store.redisBreakerKey("openai")).toBe("khatam:cb:openai");
    process.env.REDIS_KEY_PREFIX = "custom";
    expect(store.redisBreakerKey("openai")).toBe("custom:cb:openai");
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("is a silent no-op when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    store.setBreakerCacheClientProvider(null);

    expect(await store.readRedisSnapshot("p")).toBeNull();
    expect(await store.writeRedisSnapshot("p", { state: "OPEN" })).toBe(false);
    expect(await store.clearRedisSnapshot("p")).toBe(false);
  });

  it("swallows a throwing Redis client on read, write, and clear", async () => {
    store.setBreakerCacheClientProvider(() => ({
      get: async () => { throw new Error("ECONNREFUSED"); },
      set: async () => { throw new Error("ECONNREFUSED"); },
      del: async () => { throw new Error("ECONNREFUSED"); },
    }));

    await expect(store.readRedisSnapshot("p")).resolves.toBeNull();
    await expect(store.writeRedisSnapshot("p", { state: "OPEN" })).resolves.toBe(false);
    await expect(store.clearRedisSnapshot("p")).resolves.toBe(false);
  });

  it("swallows a client provider that itself throws", async () => {
    store.setBreakerCacheClientProvider(() => { throw new Error("no client"); });
    await expect(store.readRedisSnapshot("p")).resolves.toBeNull();
  });

  it("reads and writes through a healthy client", async () => {
    const memory = new Map();
    store.setBreakerCacheClientProvider(() => ({
      get: async (key) => memory.get(key) ?? null,
      set: async (key, value) => { memory.set(key, value); return "OK"; },
      del: async (key) => { memory.delete(key); return 1; },
    }));

    expect(await store.writeRedisSnapshot("svc", { state: "OPEN", failureCount: 3 })).toBe(true);
    expect([...memory.keys()]).toEqual(["khatam:cb:svc"]);
    const cached = await store.readRedisSnapshot("svc");
    expect(cached.state).toBe("OPEN");
    expect(cached.failureCount).toBe(3);

    expect(await store.clearRedisSnapshot("svc")).toBe(true);
    expect(memory.size).toBe(0);
  });

  it("never writes credential material into a cache key", async () => {
    delete process.env.REDIS_URL;
    const key = store.redisBreakerKey("openai");
    expect(key).not.toMatch(/sk-|bearer|api[_-]?key|@/i);
  });
});

// ─── 7. Pre-Dispatch Gates ────────────────────────────────────────────────

describe("7. Pre-Dispatch Gates — locked order and never-throwing verdicts", () => {
  it("declares the fixed evaluation order circuit → cooldown → credential", () => {
    expect(gates.gateOrder()).toEqual([GATE.CIRCUIT, GATE.COOLDOWN, GATE.CREDENTIAL]);
  });

  it("proceeds when no gate objects", async () => {
    const verdict = await gates.evaluateTargetGates({ provider: "openai", model: "gpt" }, {});
    expect(verdict.kind).toBe(VERDICT.PROCEED);
    expect(verdict.reason).toBeNull();
  });

  it("skips with circuit_open and a retry hint when the breaker is OPEN", async () => {
    const breaker = driveToOpen(makeBreaker("openai"));
    const verdict = await gates.evaluateTargetGates(
      { provider: "openai", model: "gpt", breaker },
      {}
    );
    expect(verdict.kind).toBe(VERDICT.SKIP);
    expect(verdict.reason).toBe(GATE.CIRCUIT);
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
    expect(verdict.retryAfterHuman).toBeTruthy();
  });

  it("skips with cooldown when a model lock is still armed", async () => {
    const connection = { modelLock_gpt: new Date(fakeNow + 20_000).toISOString() };
    const verdict = await gates.evaluateTargetGates(
      { provider: "openai", model: "gpt", connection },
      {}
    );
    expect(verdict.kind).toBe(VERDICT.SKIP);
    expect(verdict.reason).toBe(GATE.COOLDOWN);
    expect(verdict.retryAfterMs).toBe(20_000);
  });

  it("the breaker gate wins when both the breaker and a cooldown are active", async () => {
    const breaker = driveToOpen(makeBreaker("openai"));
    const connection = { modelLock_gpt: new Date(fakeNow + 20_000).toISOString() };
    const verdict = await gates.evaluateTargetGates(
      { provider: "openai", model: "gpt", breaker, connection },
      {}
    );
    expect(verdict.reason).toBe(GATE.CIRCUIT);
  });

  it("skips with credential when the credential gate answers false", async () => {
    const verdict = await gates.evaluateTargetGates(
      { provider: "openai", model: "gpt" },
      { hasCredential: () => false }
    );
    expect(verdict.kind).toBe(VERDICT.SKIP);
    expect(verdict.reason).toBe(GATE.CREDENTIAL);
  });

  it("fails open when a gate dependency throws", async () => {
    const verdict = await gates.evaluateTargetGates(
      { provider: "openai", model: "gpt", breaker: { getStatus() { throw new Error("boom"); } } },
      { hasCredential: () => { throw new Error("db down"); } }
    );
    expect(verdict.kind).toBe(VERDICT.PROCEED);
  });

  it("fails open when the target itself is malformed", async () => {
    await expect(gates.evaluateTargetGates(null, {})).resolves.toMatchObject({ kind: VERDICT.PROCEED });
    await expect(gates.evaluateTargetGates("not-a-target", null)).resolves.toMatchObject({ kind: VERDICT.PROCEED });
  });

  it("collects circuit-open exclusions only for a uniformly blocked pool", async () => {
    const openA = driveToOpen(makeBreaker("a"));
    const openB = driveToOpen(makeBreaker("b"));
    const exclusions = gates.collectOpenBreakerExclusions([
      { provider: "a", model: "m1", breaker: openA },
      { provider: "b", model: "m2", breaker: openB },
    ]);
    expect(exclusions).toHaveLength(2);
    expect(exclusions.every((e) => e.reason === GATE.CIRCUIT)).toBe(true);
    expect(exclusions[0].retryAfterMs).toBeGreaterThan(0);

    // One healthy target → not a uniformly blocked pool.
    const healthy = makeBreaker("c");
    expect(gates.collectOpenBreakerExclusions([
      { provider: "a", model: "m1", breaker: openA },
      { provider: "c", model: "m2", breaker: healthy },
    ])).toBeNull();
  });

  it("derives a stable breaker domain from provider and connection", () => {
    expect(gates.breakerDomainFor({ provider: "openai" })).toBe("openai");
    expect(gates.breakerDomainFor({ provider: "openai", connectionId: "c1" })).toBe("openai:c1");
    expect(gates.breakerDomainFor({ connectionId: "c1" })).toBe("c1");
    expect(gates.breakerDomainFor({})).toBeNull();
    expect(gates.breakerDomainFor(null)).toBeNull();
  });
});

// ─── 8. Flag Isolation ────────────────────────────────────────────────────

describe("8. Flag Isolation — no behaviour change when unconfigured", () => {
  it("gateTarget proceeds without consulting any state while the flag is off", async () => {
    delete process.env[RESILIENCE_FLAG_ENV];
    // A resolver that would explode if it were ever called.
    const getBreaker = vi.fn(() => { throw new Error("should not be consulted"); });
    const verdict = await fallback.gateTarget({ provider: "p", model: "m" }, { getBreaker });
    expect(verdict.kind).toBe(VERDICT.PROCEED);
    expect(getBreaker).not.toHaveBeenCalled();
  });

  it("observeFailure and observeSuccess are inert while the flag is off", async () => {
    delete process.env[RESILIENCE_FLAG_ENV];
    await expect(fallback.observeFailure({ provider: "p", status: 500, error: "boom" }))
      .resolves.toMatchObject({ recorded: false, reason: "disabled" });
    await expect(fallback.observeSuccess({ provider: "p" }))
      .resolves.toMatchObject({ recorded: false, reason: "disabled" });
  });

  it("reads the flag at call time, not import time", async () => {
    delete process.env[RESILIENCE_FLAG_ENV];
    expect(fallback.isResilienceEnabled()).toBe(false);
    process.env[RESILIENCE_FLAG_ENV] = "1";
    expect(fallback.isResilienceEnabled()).toBe(true);
    process.env[RESILIENCE_FLAG_ENV] = "true";
    expect(fallback.isResilienceEnabled()).toBe(false);
    delete process.env[RESILIENCE_FLAG_ENV];
    expect(fallback.isResilienceEnabled()).toBe(false);
  });

  it("describeCircuitExclusions is null while the flag is off", async () => {
    delete process.env[RESILIENCE_FLAG_ENV];
    expect(await fallback.describeCircuitExclusions([{ provider: "p" }])).toBeNull();
  });
});

// ─── 9. Negative Control ──────────────────────────────────────────────────

describe("9. Negative Control — an OPEN breaker must reject", () => {
  it("rejects a gated target whose breaker is OPEN (positive control: CLOSED proceeds)", async () => {
    // Positive control first: the same wiring, healthy breaker → proceeds.
    const healthy = makeBreaker("negative-control");
    const allowed = await gates.evaluateTargetGates(
      { provider: "negative-control", model: "m", breaker: healthy },
      {}
    );
    expect(allowed.kind).toBe(VERDICT.PROCEED);

    // Now the same target, breaker OPEN.
    const open = driveToOpen(makeBreaker("negative-control"));
    const rejected = await gates.evaluateTargetGates(
      { provider: "negative-control", model: "m", breaker: open },
      {}
    );
    expect(rejected.kind).toBe(VERDICT.SKIP);
    expect(rejected.reason).toBe(GATE.CIRCUIT);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);

    // And the breaker itself refuses to execute the work at all.
    const work = vi.fn(async () => "upstream-called");
    await expect(open.execute(work)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(work).not.toHaveBeenCalled();
  });

  it("an exempt failure cannot rescue an OPEN breaker", async () => {
    const breaker = driveToOpen(makeBreaker("sticky"));
    const retry = breaker.getRetryAfterMs();
    breaker.recordFailure(FAILURE_KIND.TRANSIENT, { status: 400 });
    breaker.recordFailure(FAILURE_KIND.TRANSIENT, { error: "Controller is already closed" });
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
    expect(breaker.getRetryAfterMs()).toBe(retry);
  });
});

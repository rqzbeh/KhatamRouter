**Feature Branch**: `004-resilience-circuit-breaker`
**Created**: 2026-10-22
**Status**: Draft
**Input**: User description: "Wave 4: 4-state circuit breaker, 429 classification, cooldowns and pre-dispatch gates. A `CLOSED → DEGRADED → OPEN → HALF_OPEN` breaker with adaptive escalation and kind-aware cooldowns; 429 body classification separating rate-limit from quota exhaustion; local-lifecycle filtering so client aborts never poison provider health; SQLite `domain_circuit_breakers` persistence with an optional Redis `khatam:cb:` cache that degrades when Redis is absent; an ordered, never-throwing pre-dispatch gate chain; and wiring into the existing account-fallback path with zero behaviour change when unconfigured."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 4-State Circuit Breaker with Kind-Aware Cooldowns (Priority: P1)

An upstream provider starts failing. The breaker must record failures, degrade before it opens, open only for failures that say something about *provider* health, and escalate its cooldown when repeated probes fail — so one flapping provider cannot pin the whole combo.

**Why this priority**: This is the core state machine. Every other deliverable (persistence, gates, wiring) composes around it.

**Independent Test**: Drive a `CircuitBreaker` instance through CLOSED → DEGRADED → OPEN → HALF_OPEN → CLOSED with a fake clock and assert state, `retryAfterMs`, and cooldown values at each step.

**Acceptance Scenarios**:

1. **Given** a CLOSED breaker with `failureThreshold: 3`, **When** three non-exempt failures are recorded, **Then** the breaker transitions to DEGRADED and still allows dispatch.
2. **Given** a DEGRADED breaker, **When** the failure count reaches `failureThreshold`, **Then** it transitions to OPEN and `canExecute()` returns false.
3. **Given** an OPEN breaker whose cooldown expired, **When** `canExecute()` is called, **Then** it transitions to HALF_OPEN and admits at most `halfOpenRequests` probes.
4. **Given** a HALF_OPEN breaker whose probe fails, **When** the failure is recorded, **Then** it returns to OPEN and `openCycleCount` increments.
5. **Given** a HALF_OPEN breaker whose probe succeeds, **When** the success is recorded, **Then** it transitions to CLOSED with all counts reset.
6. **Given** any state, **When** a failure carries a non-tripping 4xx status (400, 406, 408, 409, 410, 422) or a POLICY refusal, **Then** `failureCount` does not change and no transition occurs.
7. **Given** repeated OPEN → HALF_OPEN → OPEN cycles, **When** the breaker opens again, **Then** the effective cooldown escalates (doubling), capped at `maxBackoffMultiplier × resetTimeout`.
8. **Given** a breaker whose `lastFailureKind` is `quota_exhausted`, **When** it opens, **Then** the `cooldownByKind.quota_exhausted` override applies and still escalates with `openCycleCount`.

---

### User Story 2 - 429 Classification (Priority: P1)

Providers return HTTP 429 for two different reasons: a short rate-limit window, or a long quota-exhaustion period. Treating the second as the first produces a retry loop that burns calls for hours.

**Independent Test**: Feed representative 429 bodies (OpenAI burst, Google `RetryInfo` with `retryDelay`, Anthropic credit exhaustion, CJK quota text, plain JSON) to `classify429()` and assert the returned kind.

**Acceptance Scenarios**:

1. **Given** a non-429 status, **When** classified, **Then** the kind is `transient`.
2. **Given** a 429 whose body states the account is out of credits or over a billing cap, **When** classified, **Then** the kind is `quota_exhausted` even if a short retry hint is present.
3. **Given** a 429 whose body declares a sub-hour retry window (Google `RetryInfo` / "please retry in Ns"), **When** classified, **Then** the kind is `rate_limit`.
4. **Given** a 429 body matching a daily/monthly/per-month quota phrase, **When** classified, **Then** the kind is `quota_exhausted`.
5. **Given** a 429 body with concurrency wording ("too many concurrent requests"), **When** checked with `looksLikeConcurrencyLimit()`, **Then** it reports true and never overrides an explicit quota signal.

---

### User Story 3 - Local-Lifecycle Filtering (Priority: P2)

Our own stream controller can throw after close, and callers abort routinely. Those errors must never enter the breaker or count toward a cooldown.

**Independent Test**: Pass `AbortError`, "Controller is already closed", "Client disconnected", ENOENT spawn errors, and a genuine upstream 502 to the classifier/predicate functions and assert only the 502 counts.

**Acceptance Scenarios**:

1. **Given** an error whose name is `AbortError`, **When** classified as a failure, **Then** it is filtered as local lifecycle.
2. **Given** a message matching "controller is already closed", **When** classified, **Then** it is filtered.
3. **Given** a genuine upstream 502 with a provider body, **When** classified, **Then** it is *not* filtered and counts as a failure.

---

### User Story 4 - Persistence: SQLite with Optional Redis Cache (Priority: P2)

Breaker state must survive a restart on a single node and be shareable across nodes when Redis exists — but Redis is optional and its absence must never break routing.

**Independent Test**: Open a temp `DATA_DIR`, persist a breaker, re-instantiate it, and assert the state round-trips. Then point the cache at a Redis double that throws and assert reads/writes degrade to SQLite without throwing.

**Acceptance Scenarios**:

1. **Given** a fresh database, **When** migrations run, **Then** `domain_circuit_breakers` exists with the Wave 2 columns plus the additive Wave 4 diagnostics columns.
2. **Given** an OPEN breaker, **When** it is persisted and reloaded in a new process, **Then** the state, failure count, kind counts, and open cycle count are restored.
3. **Given** `REDIS_URL` unset, **When** the cache is used, **Then** every read/write is a no-op returning null/false, never a throw.
4. **Given** `REDIS_URL` set but the client throws, **When** the cache is read or written, **Then** the error is swallowed and SQLite remains authoritative.
5. **Given** Redis is used, **When** keys are written, **Then** they are namespaced `khatam:cb:`.

---

### User Story 5 - Ordered Pre-Dispatch Gates (Priority: P1)

Before dispatching to a target, the router must check, in a fixed order, whether the target is usable at all. The gate chain must always return a verdict and never throw.

**Independent Test**: Call `evaluateTargetGates()` with permutations of breaker state, cooldown, credential availability, and quota headroom, asserting the verdict reason and that gate order is stable.

**Acceptance Scenarios**:

1. **Given** an OPEN breaker for the target, **When** gates are evaluated, **Then** the verdict is `skip` with reason `circuit_open` and a retry hint.
2. **Given** an active cooldown, **When** gates are evaluated, **Then** the verdict is `skip` with reason `cooldown`.
3. **Given** no breaker and no cooldown, **When** gates are evaluated, **Then** the verdict is `proceed`.
4. **Given** any gate dependency that throws, **When** gates are evaluated, **Then** the chain returns a `proceed` verdict (fail-open) rather than throwing.
5. **Given** a breaker OPEN *and* a cooldown active, **When** gates are evaluated, **Then** the breaker gate wins (order is fixed).

---

### User Story 6 - Fallback Wiring With No Behaviour Change (Priority: P1)

The new machinery must be inert until an operator opts in.

**Independent Test**: With the flag off, run the account-fallback loop and assert the pre-existing code path executes unchanged; with the flag on, assert an OPEN breaker is rejected before dispatch.

**Acceptance Scenarios**:

1. **Given** the feature flag is unset, **When** the fallback loop runs, **Then** no breaker reads/writes occur and pre-existing behaviour is preserved.
2. **Given** the feature flag is enabled, **When** a target's breaker is OPEN, **Then** the attempt is rejected without an upstream call.
3. **Given** the feature flag is enabled and a legitimate failure occurs, **When** the loop records it, **Then** the breaker records it and existing cooldown handling still runs.

---

### Edge Cases

- Clock moving backwards: cooldown arithmetic must clamp at 0, never return a negative `retryAfterMs`.
- `failureThreshold: 1` with `degradationThreshold: 0`: OPEN must happen without an impossible DEGRADED step.
- A non-tripping status arriving while already OPEN: it must not reset or extend the cooldown.
- Registry growth from high-cardinality names: evict only cold, CLOSED, zero-failure breakers.
- Redis present but the module is never imported: no connection attempt should be made at import time.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The breaker MUST expose exactly four states: `CLOSED`, `DEGRADED`, `OPEN`, `HALF_OPEN`.
- **FR-002**: CLOSED MUST transition to DEGRADED at `degradationThreshold` failures and to OPEN at `failureThreshold` failures.
- **FR-003**: OPEN MUST reject dispatch via `canExecute()` until its effective cooldown elapses, then admit exactly `halfOpenRequests` probes as HALF_OPEN.
- **FR-004**: A failed HALF_OPEN probe MUST return the breaker to OPEN and increment `openCycleCount`; a successful probe MUST close it and reset counters.
- **FR-005**: Client-error statuses 400, 406, 408, 409, 410, 422 and POLICY refusals MUST NOT count as failures in any state.
- **FR-006**: Cooldowns MUST be kind-aware via `cooldownByKind` (`rate_limit`, `quota_exhausted`, `transient`), defaulting to `resetTimeout`.
- **FR-007**: Effective cooldown MUST escalate with `openCycleCount` beyond `backoffEscalationCount`, capped by `maxBackoffMultiplier`.
- **FR-008**: `classify429()` MUST distinguish `rate_limit` from `quota_exhausted` using body text and upstream retry hints, per the documented decision order.
- **FR-009**: Terminal credit/billing signals MUST classify as `quota_exhausted` regardless of any retry hint.
- **FR-010**: Local stream-lifecycle and local host-execution errors MUST be excluded from failure accounting.
- **FR-011**: State MUST persist to the SQLite `domain_circuit_breakers` table and restore on construction.
- **FR-012**: An optional Redis cache MUST namespace under `khatam:cb:` and MUST degrade silently to SQLite when Redis is absent or erroring.
- **FR-013**: `evaluateTargetGates()` MUST return one of `{kind:"proceed"}` / `{kind:"skip", reason, retryAfterMs}` and MUST NOT throw.
- **FR-014**: Gate evaluation order MUST be fixed: circuit breaker → cooldown → credential/model-lock.
- **FR-015**: Fallback-path integration MUST be behind a default-off flag and introduce zero behaviour change when disabled.
- **FR-016**: All new persistence MUST be additive; no existing column may be dropped or renamed.

### Security & Fail-Semantics Requirements

- **FR-017**: Breaker and gate failures MUST be fail-open for availability (a broken breaker must not deny traffic) while authorization remains fail-closed (unchanged from Wave 3).
- **FR-018**: No secret, token, API key, or credential value may be written to `domain_circuit_breakers`, Redis, or any failure log. Failure reasons MUST be truncated and derived from status/kinds, not from raw credential material.
- **FR-019**: Redis keys MUST NOT contain API keys, tokens, or emails; breaker names are provider/connection identifiers only.
- **FR-020**: Regexes applied to upstream bodies MUST be bounded (no unbounded `.*` over attacker-controlled input) to avoid ReDoS.

### Key Entities

- **CircuitBreaker**: named state machine with counters, kind counts, cycle count, cooldown config, transition history, and injectable persistence/cache.
- **FailureKind**: `rate_limit` | `quota_exhausted` | `transient`.
- **GateVerdict**: `{ kind: "proceed", ... }` or `{ kind: "skip", reason, retryAfterMs }`.
- **domain_circuit_breakers row**: `domain`, `state`, counters, `last_failure_reason`, timestamps, plus additive Wave 4 diagnostics.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `tests/unit/wave4-resilience.test.js` passes with at least 40 assertions covering all six user stories.
- **SC-002**: The negative control passes: an OPEN breaker rejects a gated target and the verdict reason is `circuit_open`.
- **SC-003**: With the integration flag off, Wave 1–3 test suites and all three baseline snapshots are byte-identical to their pre-change output.
- **SC-004**: `domain_circuit_breakers` exists after a fresh migration run, and a persisted breaker restores state across instances.
- **SC-005**: With `REDIS_URL` unset, every cache operation returns without throwing, and with a throwing Redis double the same holds.
- **SC-006**: Container smoke: the built image boots, `/dashboard` answers 200/302/307, and `_khatam_migrations` holds at least two rows.
- **SC-007**: Lint (`npx eslint .`) and both Typecheck projects stay green.

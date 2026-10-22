---
description: "Dependency-ordered checklist of tasks for Wave 4 Resilience, Circuit Breaker, and Pre-Dispatch Gates"
---

# Tasks: Wave 4 — Resilience, Circuit Breaker, and Pre-Dispatch Gates

**Input**: Design documents from `/specs/004-resilience-circuit-breaker/` (`spec.md`, `plan.md`)

**Prerequisites**: `spec.md`, `plan.md`

**Tests**: `tests/unit/wave4-resilience.test.js` plus the Wave 1–3 regression suites and the three baseline snapshots.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 breaker, US2 classification, US3 local-lifecycle, US4 persistence, US5 gates, US6 wiring

---

## Phase 1: Configuration Contracts

- [x] T001 [P] [US1] Create `open-sse/config/resilienceConfig.js` with `BREAKER_STATE`, `FAILURE_KIND`, default thresholds/reset timeout/backoff caps, `NON_TRIPPING_STATUSES` (400/406/408/409/410/422), `POLICY_FAILURE_TEXT`, `COOLDOWN_BY_KIND`, `RESILIENCE_FLAG_ENV`, and the `khatam:cb:` namespace suffix.
- [x] T002 [P] [US4] Extend `src/lib/db/schema.js` `TABLES.domain_circuit_breakers` with additive diagnostics columns and bump `SCHEMA_VERSION` to 4.

---

## Phase 2: Failure Taxonomy (US2, US3)

- [x] T003 [US2] Implement `classify429({status, headers, body})` in `src/lib/resilience/failureClassification.js` with the documented decision order (terminal credit wording → declared sub-hour retry → quota phrase → default rate_limit).
- [x] T004 [P] [US2] Add `looksLikeQuotaExhausted`, `looksLikeConcurrencyLimit`, `upstreamRetryDelaySeconds`, and `parseRetryAfter` (integer seconds, HTTP date, Groq-style `5m`).
- [x] T005 [US3] Add `isLocalStreamLifecycleError` and `isLocalExecutionError`, and a `shouldRecordFailure({status, error, kind})` predicate combining the non-tripping status policy, `POLICY` refusals, and the local-error filters.
- [x] T006 [US2] Ensure every body regex is bounded (no unbounded `.*` across attacker-controlled input) per FR-020.

---

## Phase 3: Cooldowns (US1)

- [x] T007 [US1] Implement `src/lib/resilience/cooldownManager.js`: `resolveCooldownMs(kind, ctx)`, `escalateCooldown(base, openCycleCount, {backoffEscalationCount, maxBackoffMultiplier})`, and `cooldownVerdict(untilMs, now)`.
- [x] T008 [US1] Add connection-level helpers `getConnectionCooldownVerdict(connection, model, now)` that read existing `modelLock_*` / `rateLimitedUntil` fields without mutating them.

---

## Phase 4: State Machine (US1)

- [x] T009 [US1] Implement `CircuitBreaker` in `src/shared/utils/circuitBreaker.js`: four states, `canExecute()`, `getStatus()`, `getRetryAfterMs()`, `onSuccess()`, `onFailure(kind)`, `reset()`, transition history bounded to `maxTransitionHistory`.
- [x] T010 [US1] Implement kind-specific thresholds (`immediateOpen`, per-kind `threshold`) and `cooldownByKind` overrides with open-cycle escalation capped by `maxBackoffMultiplier`.
- [x] T011 [US1] Implement the named registry `getCircuitBreaker(name, options)` with cold CLOSED/zero-failure eviction at 500 entries, plus `getAllCircuitBreakerStatuses`, `resetAllCircuitBreakers`, and `__resetCircuitRegistryForTests`.
- [x] T012 [US1] Implement `CircuitBreakerOpenError` carrying `circuitName` and `retryAfterMs`.

---

## Phase 5: Persistence (US4)

- [x] T013 [US4] Add migration `src/lib/db/migrations/003-wave4-circuit-breaker.js` (version 3): additive `ADD COLUMN` guarded by `PRAGMA table_info`, `CREATE INDEX IF NOT EXISTS` on `cooldown_until`; register it in `migrations/index.js`.
- [x] T014 [US4] Implement `src/lib/resilience/circuitBreakerStore.js`: `loadBreakerRow(domain)`, `saveBreakerRow(domain, snapshot)`, `listBreakerRows()`, resilient to a missing table (returns null, never throws).
- [x] T015 [P] [US4] Implement the `khatam:cb:` Redis mirror: `readRedisSnapshot(domain)`, `writeRedisSnapshot(domain, snapshot)`, `clearRedisSnapshot(domain)`, each swallowing errors and never constructing a client unless a caller injects one or `REDIS_URL` is set.
- [x] T016 [US4] Implement `getCircuitBreakerForDomain(domain, options)` wiring SQLite persistence plus the optional Redis cache into the pure machine, and `resetDomainCircuitBreakers()`.

---

## Phase 6: Pre-Dispatch Gates (US5)

- [x] T017 [US5] Implement `src/domain/executeTargetGates.js` with ordered descriptors `[circuit, cooldown, credential]`, `evaluateTargetGates(target, deps)`, `proceedVerdict`, `skipVerdict`, and a single outer `try/catch` returning `proceed` on any failure.
- [x] T018 [US5] Return `retryAfterMs` on skips and expose `collectOpenBreakerExclusions(targets)` for terminal diagnostics.

---

## Phase 7: Fallback Wiring (US6)

- [x] T019 [US6] Implement `src/domain/fallbackResilience.js`: `isResilienceEnabled()` (flag read at call time), `gateTarget(...)` returning `proceed` immediately when disabled, `observeFailure(...)`, `observeSuccess(...)`.
- [x] T020 [US6] Wire `src/sse/handlers/chat.js`: gate before dispatch, observe failure after a failed attempt, observe success in `onRequestSuccess` — each behind `isResilienceEnabled()`.

---

## Phase 8: Verification

- [x] T021 [US1..US6] Write `tests/unit/wave4-resilience.test.js` covering all six stories, the migration, the Redis degrade path, gate ordering, flag isolation, and the negative control (OPEN breaker rejects).
- [x] T022 Run the Wave 1–3 regression suites and the three baseline snapshots; assert unchanged output.
- [x] T023 Run `npx eslint .` and both `tsc --noEmit` projects.
- [x] T024 Container smoke on `Dockerfile.bun`: boot, `/dashboard` 200/302/307, at least two `_khatam_migrations` rows.
- [x] T025 Update `README.md` and `ROADMAP.md` in a second PR; run `node scripts/verify-docs-claims.mjs` to exit 0.

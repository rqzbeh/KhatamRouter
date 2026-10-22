# Implementation Plan: Wave 4 — Resilience, Circuit Breaking, and Pre-Dispatch Gates

**Branch**: `feat/wave4-resilience` | **Date**: 2026-10-22 | **Spec**: [Feature Spec](./spec.md)

**Input**: Feature specification from `/specs/004-resilience-circuit-breaker/spec.md`

---

## Summary

Wave 4 adds provider-health protection to the routing path in four composable layers, all inert until an operator flips one flag:

1. **Pure 4-state breaker** (`src/shared/utils/circuitBreaker.js`) — `CLOSED → DEGRADED → OPEN → HALF_OPEN` with failure-kind thresholds, kind-aware cooldowns, adaptive escalation on repeated probe failures, bounded transition history, and an injectable persistence/cache seam. No I/O on the hot path; persistence is fire-and-forget.
2. **Failure taxonomy** (`src/lib/resilience/failureClassification.js`) — `classify429()` separating a short rate-limit window from long-period quota exhaustion, plus local-lifecycle/local-execution filters and the non-tripping client-status policy (400, 406, 408, 409, 410, 422, `POLICY`).
3. **Cooldown resolution + persistence** (`src/lib/resilience/cooldownManager.js`, `src/lib/resilience/circuitBreakerStore.js`) — kind → cooldown buckets, and SQLite-backed `domain_circuit_breakers` state with an optional `khatam:cb:` Redis mirror that degrades silently to SQLite.
4. **Ordered pre-dispatch gates** (`src/domain/executeTargetGates.js`) — breaker → cooldown → credential, returning a verdict and never throwing.

The fallback loops call these through `src/domain/fallbackResilience.js`, which short-circuits to a no-op when `KHATAM_RESILIENCE_CIRCUIT_BREAKER` is not `"1"`. That keeps Wave 1–3 behaviour byte-identical by construction rather than by careful patching.

## Technical Context

**Language/Version**: JavaScript ES2022 (repo convention: plain ESM JS, no TypeScript in this wave). Bun 1.4.3 runtime; Node 22 fallback.

**Primary Dependencies**: native `bun:sqlite` (with `better-sqlite3` / `node:sqlite` / `sql.js` fallbacks via the existing driver chain), `ioredis` (optional, loaded lazily).

**Storage**:
- SQLite `domain_circuit_breakers` at `$DATA_DIR/db/data.sqlite` — Wave 2 table, extended additively by migration `003` with `last_failure_kind`, `open_cycle_count`, `kind_failure_counts_json`, `transition_history_json`, `half_open_probe_at`.
- Redis `khatam:cb:<domain>` JSON snapshot, TTL'd, best-effort.

**Testing**:
- `tests/unit/wave4-resilience.test.js` (Vitest) — state machine, classification, persistence, gates, flag isolation, negative control.
- Regression: the Wave 1–3 unit suites plus `verify-providers` / `verify-alias` / `verify-oauth-urls` baselines.

**Target Platform**: Linux x86_64 / arm64, `oven/bun:1.4.3-slim` container.

## Design Decisions

### D1. Pure machine, injected persistence (chosen over a DB-coupled breaker)

The breaker owns no I/O. `CircuitBreaker` accepts `{ persistence: { load, save }, cache }`; `_persist()` schedules `save()` and swallows every rejection. This keeps the state machine synchronous and deterministic under a fake clock, keeps `src/shared/**` free of a database import (it is also typechecked by the core project), and lets the test suite drive transitions without a database.

*Alternative rejected*: a breaker that reads SQLite lazily in `canExecute()`. It would place an async dependency inside a hot, must-not-throw path and make gate ordering non-deterministic in tests.

### D2. Additive migration 003, never an edit to 002

`002-wave2-storage-quota.js` is already recorded as applied on existing installations. Wave 4's diagnostics columns therefore land in `003-wave4-circuit-breaker.js`, each guarded by `PRAGMA table_info`, and `schema.js`'s `TABLES.domain_circuit_breakers` grows the same columns so `syncSchemaFromTables()` can repair legacy rows. `SCHEMA_VERSION` moves `3 → 4` per the file's own instruction; the two "additive schema v3" doc strings are corrected to v4 in the docs PR.

### D3. Redis is a cache mirror, never the authority

SQLite is authoritative. A Redis read failure returns `null` (callers then use SQLite) and a write failure is logged once and dropped. Nothing awaits Redis on the request path; the mirror is updated from the same fire-and-forget persist hook. Redis is loaded with a dynamic `import()` so a process that never enables the flag never constructs an ioredis client.

*Alternative rejected*: Redis-authoritative distributed state. It would require a correctness dependency on an optional service that the constitution explicitly forbids (`REDIS_URL` unset must work).

### D4. One flag, read at call time: `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1`

Unset/other values mean "Wave 3 behaviour". The call sites test the flag *before* invoking any new module, so the disabled path executes exactly the old statements — no extra awaits, no extra DB reads. Settings-driven toggles were rejected for this wave: settings are read from SQLite inside the loop already at several points, and an environment flag is the smallest thing that can be verified in a container smoke test.

### D5. Gate order is data, not control flow

`src/domain/executeTargetGates.js` holds an ordered array of gate descriptors. Each gate returns `null` (pass) or a skip reason; the evaluator stops at the first skip and wraps the whole run in one `try/catch` that fails open to `proceed`. Order is asserted by tests rather than implied by nesting, so a future gate cannot silently jump the breaker.

### D6. Failure classification is bounded and body-driven

`classify429` scans a body stringified from the response and matches a fixed list of literal-ish patterns (no unbounded `.*` over attacker-controlled input). Decision order: non-429 → `transient`; terminal credit/billing wording → `quota_exhausted`; declared sub-hour retry window → `rate_limit`; quota phrase → `quota_exhausted`; default → `rate_limit`.

## Files

| Path | Purpose |
| :--- | :--- |
| `open-sse/config/resilienceConfig.js` | States, failure kinds, thresholds, cooldown buckets, non-tripping statuses, flag + Redis prefix constants |
| `src/shared/utils/circuitBreaker.js` | 4-state machine, registry with cold eviction, `CircuitBreakerOpenError` |
| `src/lib/resilience/failureClassification.js` | `classify429`, quota/concurrency predicates, local-lifecycle filters, `shouldRecordFailure` |
| `src/lib/resilience/cooldownManager.js` | Kind → cooldown resolution, escalation math, connection cooldown helpers |
| `src/lib/resilience/circuitBreakerStore.js` | SQLite `domain_circuit_breakers` persistence + `khatam:cb:` Redis mirror + `getCircuitBreakerForDomain` |
| `src/domain/executeTargetGates.js` | Ordered, never-throwing pre-dispatch verdicts |
| `src/domain/fallbackResilience.js` | Flag gate + thin facade used by the fallback loops |
| `src/sse/handlers/chat.js` | Opt-in gate/failure/success wiring inside the account loop |
| `src/lib/db/migrations/003-wave4-circuit-breaker.js` | Additive diagnostics columns |
| `src/lib/db/migrations/index.js`, `src/lib/db/schema.js` | Registry entry, `TABLES` parity, `SCHEMA_VERSION 4` |
| `tests/unit/wave4-resilience.test.js` | Full unit coverage incl. negative control |
| `.unlazy/wave-004/GATES.md` | Runnable acceptance gates |

## Rollout / Rollback

- **Rollout**: merge dark. Nothing changes until `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1` is set; when set, only the reads/gates and the fire-and-forget observe hooks activate.
- **Rollback**: unset the variable (instant, no data loss). The `domain_circuit_breakers` columns are additive and harmless if unused; migration 003 is idempotent and forward-only, which is the same contract as every prior migration.

## Risks & Mitigations

| Risk | Mitigation |
| :--- | :--- |
| Breaker denies traffic during a dependency outage | Every gate path fails open to `proceed`; the breaker only denies when its own persisted state says OPEN with unexpired cooldown |
| Registry growth from high-cardinality connection ids | Cold-evict only CLOSED, zero-failure entries at 500 names |
| Redis outage cascades | Cache is best-effort, never awaited inline, errors swallowed once-logged |
| Migration breaks existing DBs | Additive `ADD COLUMN` behind `PRAGMA table_info` guards, own transaction, versioned as 3 |
| Credit/secret leakage in failure text | Reasons are truncated and derived from kind/status; no credential fields are persisted (FR-018) |

---
description: "Dependency-ordered checklist of tasks for Wave 2 Database Migrations & Hybrid Quota Store"
---

# Tasks: Wave 2 - Database Migrations & Hybrid Quota Store

**Input**: Design documents from `/specs/002-db-migrations-hybrid-quota-store/` (`spec.md`, `plan.md`)

**Prerequisites**: `spec.md` (required), `plan.md` (required)

**Tests**: Unit test suites `tests/unit/wave2-db-migrations.test.js`, `tests/unit/wave2-quota-store.test.js`, and baseline test `tests/__baseline__/verify-providers.mjs`.

**Organization**: Tasks are dependency-ordered across 5 phases to implement the versioned migration runner, additive-only schema expansion, hybrid quota store, settings cache, and comprehensive verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Migration Runner & Safety Snapshot Engine

**Purpose**: Establish the deterministic `_khatam_migrations` runner with automated WAL checkpointing and pre-migration backup snapshots.

- [ ] T001 [US1] Update `src/lib/db/migrate.js` to create and maintain `_khatam_migrations(version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)` and read already-applied versions from this table.
- [ ] T002 [US1] Implement pre-migration safety preflight in `src/lib/db/migrate.js`: on non-fresh databases with pending migrations, execute `PRAGMA wal_checkpoint(TRUNCATE)` and write `${DATA_FILE}.bak-${firstPendingVersion}` prior to applying migrations (skip on fresh DBs).
- [ ] T003 [US1] Implement transactional isolation in `src/lib/db/migrate.js`: execute each pending migration inside its own `adapter.transaction()`, record version upon success, and on error roll back and throw naming the failed migration version.

---

## Phase 2: Additive Schema Expansion & Migration 002

**Purpose**: Define the Wave 2 database additions while strictly preserving 9router's existing access control columns.

- [ ] T004 [US2] Create migration `src/lib/db/migrations/002-wave2-storage-quota.js` adding connection overrides (`rate_limit_overrides_json`, `max_concurrent`, `rate_limit_protection`, `rate_limited_until`, `backoff_level`, `quota_window_thresholds_json`), API key limit columns (`allowedProviders`, `allowedCombos`, `allowedKinds`, `rate_limits`, `throttle_delay_ms`, `usage_limit_enabled`, `daily_usage_limit_usd`, `weekly_usage_limit_usd`), and 9 new tables (`api_key_quota_limits`, `api_key_quota_counters`, `request_cost_ledger`, `domain_circuit_breakers`, `model_capabilities`, `model_context_overrides`, `model_capability_overrides`, `proxy_pool_fitness`, `cached_provider_models`).
- [ ] T005 [US2] Update `src/lib/db/migrations/index.js` to register `002-wave2-storage-quota.js` in monotonic version order.
- [ ] T006 [US2] Update `src/lib/db/schema.js` to bump `SCHEMA_VERSION = 3`, declare the new columns on `TABLES.providerConnections` and `TABLES.apiKeys` (preserving `accessRestricted` and `accessAllow`), add declarative schemas for all 9 new tables, and define views for `provider_connections` and `api_keys`.

---

## Phase 3: Hybrid Quota Store Subsystem

**Purpose**: Build the high-throughput sliding window quota engine with atomic float increments and resilient fail-open guarantees.

- [x] T007 [P] [US3] Implement `src/lib/quota/redisQuotaStore.js` with two-bucket sliding window calculation, `khatam:quota:` namespace prefixing, atomic `INCRBYFLOAT`, TTL maintenance, and fail-open contract `{ allowed: true, degraded: true }` on errors.
- [x] T008 [P] [US3] Implement `src/lib/quota/sqliteQuotaStore.js` with identical sliding window semantics backed by atomic transactions over `api_key_quota_counters`.
- [x] T009 [US3] Implement `src/lib/quota/index.js` exporting `quotaStoreFactory()` that selects `RedisQuotaStore` when Redis is configured and available, or `SqliteQuotaStore` otherwise.

---

## Phase 4: `settingsRepo` In-Memory TTL Cache

**Purpose**: Reduce SQLite read-lock contention on high-throughput proxy inference paths through a 5000ms in-memory cache.

- [x] T010 [US4] Update `src/lib/db/repos/settingsRepo.js` with an in-memory cache having a 5000ms TTL keyed by a `settings_revision` row in `_meta`.
- [x] T011 [US4] Implement `bumpSettingsRevision()` and `invalidateSettingsCache()` in `src/lib/db/repos/settingsRepo.js`, and wire `updateSettings()` to bump revision, clear cache, and publish `KHATAM_EVENTS.CONFIG_RELOAD`.

---

## Phase 5: Verification, Unit Testing & Gate Validation

**Purpose**: Validate all Wave 2 deliverables against acceptance scenarios, vitest suites, and Unlazy gates.

- [ ] T012 [P] [US1..US2] Author unit test suite `tests/unit/wave2-db-migrations.test.js` covering migration runner idempotency, version tracking in `_khatam_migrations`, transaction rollback on failure, WAL checkpointing, and `.bak-<version>` snapshots.
- [x] T013 [P] [US3..US4] Author unit test suite `tests/unit/wave2-quota-store.test.js` covering sliding window arithmetic, `INCRBYFLOAT` operations, fail-open behavior under simulated Redis failures, and `settingsRepo` 5s TTL caching and invalidation.
- [ ] T014 [US1..US4] Validate all Unlazy gates in `.unlazy/wave-002/GATES.md` (G1, G2, G3, G4) and verify that `node tests/__baseline__/verify-providers.mjs` passes with zero regressions.

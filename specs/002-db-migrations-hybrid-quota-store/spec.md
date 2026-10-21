# Feature Specification: Wave 2 - Database Migrations & Hybrid Quota Store

**Feature Branch**: `002-db-migrations-hybrid-quota-store`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Wave 2: Storage, migrations, and quota foundation. Versioned _khatam_migrations runner with ordered discovery, transactional execution, and .bak-<version> snapshot; additive-only schema expansion preserving 9router accessRestricted/accessAllow columns; RedisQuotaStore with two-bucket sliding window INCRBYFLOAT, khatam:quota: namespace, fail-open contract, and SQLite fallback; and settingsRepo 5s TTL in-memory cache keyed by settings_revision in _meta."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Versioned `_khatam_migrations` Runner with Automated WAL Checkpoint & Safety Snapshot (Priority: P1)

As a system operator and multi-runtime developer (running both Bun control-plane and Go data-plane processes against the shared SQLite database), I need a deterministic, versioned migration runner tracking schema revisions in `_khatam_migrations`, so that database migrations run idempotently on startup, roll back completely on errors, and create an automated pre-migration WAL snapshot before applying changes to an existing database.

**Why this priority**: Foundational prerequisite for all database evolutions across Bun and the Go gateway (Constitution Principle III). Schema corruption or half-applied migrations would compromise the entire proxy and gateway stack.

**Independent Test**: Can be fully tested by initializing a fresh SQLite database, executing the migration runner, verifying all migration rows exist in `_khatam_migrations`, re-running the migration runner to confirm 0 migrations applied (idempotency), simulating a failing migration to verify atomic transaction rollback and version-naming error throw, and verifying `PRAGMA wal_checkpoint(TRUNCATE)` along with the creation of a `.bak-<version>` snapshot on an existing non-fresh database.

**Acceptance Scenarios**:

1. **Given** a fresh or existing SQLite database, **When** the migration runner executes, **Then** it creates the tracking table `_khatam_migrations(version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)` if absent.
2. **Given** ordered migration scripts located under `src/lib/db/migrations/` (e.g. `001-initial.js`, `002-wave2-storage-quota.js`), **When** the runner evaluates pending migrations, **Then** it skips already-applied versions and executes each pending migration inside its own dedicated database transaction.
3. **Given** an existing database with prior data (not freshly created) and pending migrations, **When** the runner begins the migration run, **Then** it executes `PRAGMA wal_checkpoint(TRUNCATE)` and creates a snapshot file `${DATA_FILE}.bak-${firstPendingVersion}` prior to applying the first pending migration.
4. **Given** a brand-new database created during the current boot, **When** migrations run, **Then** the `.bak-<version>` snapshot step is skipped.
5. **Given** a migration script that throws an error during execution, **When** the transaction fails, **Then** the transaction is rolled back completely, no entry is added to `_khatam_migrations`, and the runner throws an explicit error naming the failed migration version.
6. **Given** a fully migrated database, **When** the migration runner is executed again on subsequent boots, **Then** it discovers 0 pending migrations and returns `{ applied: 0, from: currentVersion, to: currentVersion }` without altering the database.

---

### User Story 2 - Additive-Only Schema Expansion Preserving 9router Compatibility (Priority: P1)

As a proxy routing engine and policy enforcer, I need the SQLite database schema to support granular connection rate limits, per-key quota policies, USD cost tracking, domain circuit breakers, and model capability discovery, while strictly preserving 9router's existing `accessRestricted` and `accessAllow` access control columns.

**Why this priority**: Required by Constitution Principle I (Upstream Base Integrity) and Principle VI (Resilience, Granular Limits, Stealth & Dynamic Model Capabilities). Must not break existing 9router provider connections or API key models.

**Independent Test**: Can be fully tested by querying `PRAGMA table_info` on `providerConnections` and `apiKeys`, and verifying `sqlite_master` for the presence of the 9 new tables and indexes.

**Acceptance Scenarios**:

1. **Given** the `providerConnections` table, **When** migrations execute, **Then** the following additive columns are added (if not already present):
   - `rate_limit_overrides_json TEXT`
   - `max_concurrent INTEGER`
   - `rate_limit_protection INTEGER DEFAULT 0`
   - `rate_limited_until TEXT`
   - `backoff_level INTEGER DEFAULT 0`
   - `quota_window_thresholds_json TEXT`
2. **Given** the `apiKeys` table, **When** migrations execute, **Then** existing columns `accessRestricted` and `accessAllow` remain intact and functional, and the following additive columns are added (if not already present):
   - `allowedProviders TEXT`
   - `allowedCombos TEXT`
   - `allowedKinds TEXT`
   - `rate_limits TEXT`
   - `throttle_delay_ms INTEGER DEFAULT 0`
   - `usage_limit_enabled INTEGER DEFAULT 0`
   - `daily_usage_limit_usd REAL`
   - `weekly_usage_limit_usd REAL`
3. **Given** the migration execution, **When** inspecting `sqlite_master`, **Then** the following 9 new tables exist with appropriate primary keys and indexes:
   - `api_key_quota_limits`: Granular per-key rate, token, and USD spend limits.
   - `api_key_quota_counters`: SQLite fallback storage for sliding-window request/token/spend counters.
   - `request_cost_ledger`: Ledger of per-request token usage, provider unit cost, and total USD expenditure.
   - `domain_circuit_breakers`: State persistence tracking failure counters, error classifications, and cooldowns.
   - `model_capabilities`: Registry storing discovered context boundaries, modalities, and feature flags.
   - `model_context_overrides`: Admin context window overrides per model pattern.
   - `model_capability_overrides`: Admin capability overrides per model pattern.
   - `proxy_pool_fitness`: Outbound proxy latency, success rate, and health metrics.
   - `cached_provider_models`: Cache of upstream models discovered from provider `/models` endpoints.
4. **Given** queries using snake_case table aliases (`provider_connections` and `api_keys`), **When** accessed by the application, **Then** SQLite views or repository abstractions provide transparent access to both naming conventions.

---

### User Story 3 - Distributed RedisQuotaStore with Sliding Window & Transparent SQLite Fallback (Priority: P1)

As a high-throughput proxy gateway, I need a distributed sliding-window quota store that tracks request counts, token consumption, and USD expenditure across cluster replicas using atomic Redis commands (`INCRBYFLOAT`), strictly namespaces keys under `khatam:quota:`, fails open without blocking or throwing when Redis is unavailable, and transparently falls back to SQLite counters when `REDIS_URL` is omitted.

**Why this priority**: Required by Constitution Principle III (Shared SQLite3 WAL + Redis Hybrid State) and Principle VI for multi-instance quota enforcement.

**Independent Test**: Can be fully tested with unit tests exercising `peek()` and `consume()`:
- With Redis: verifying two-bucket weighted calculations, `khatam:quota:` key prefixing, and atomic float increments.
- Without Redis / Redis Error: asserting fail-open response `{ allowed: true, degraded: true, current: 0, remaining: limit }`.
- In SQLite fallback mode: verifying counter increments and window calculation over `api_key_quota_counters`.

**Acceptance Scenarios**:

1. **Given** a configured and reachable `REDIS_URL`, **When** `consume({ key, amount, window, limit })` is called, **Then** it calculates estimated usage using a two-bucket sliding window (`currentBucket * currentWeight + previousBucket * previousWeight`), atomically increments the current bucket via `INCRBYFLOAT`, sets appropriate key TTLs ($2 \times \text{window}$), and returns `{ allowed: boolean, current: number, limit: number, remaining: number, resetMs: number }`.
2. **Given** a configured and reachable `REDIS_URL`, **When** `peek({ key, window, limit })` is called, **Then** it inspects the current and previous bucket values without incrementing, returning `{ allowed: boolean, current: number, limit: number, remaining: number, resetMs: number }`.
3. **Given** `REDIS_URL` is unset, **When** `storeFactory()` initializes, **Then** it instantiates `SqliteQuotaStore` backed by `api_key_quota_counters` in `$DATA_DIR/db/data.sqlite`.
4. **Given** an active `RedisQuotaStore` and Redis becomes unreachable or throws a network/command error, **When** `consume()` or `peek()` is invoked, **Then** the method catches the error, emits a non-fatal warning once, and fails open returning `{ allowed: true, degraded: true, current: 0, remaining: limit }` without throwing.
5. **Given** all Redis keys written by `RedisQuotaStore`, **When** keys are inspected in Redis, **Then** every key begins with the normalized prefix `khatam:quota:`.

---

### User Story 4 - 5-Second In-Memory Settings Cache with Revision Tracking in `settingsRepo` (Priority: P1)

As a high-throughput LLM proxy pipeline, I need `settingsRepo.getSettings()` to use a 5-second TTL in-memory read-through cache keyed by a `settings_revision` row in `_meta`, so that hundreds of concurrent proxy requests per second do not saturate SQLite read locks or repeatedly deserialize JSON settings.

**Why this priority**: Minimizes SQLite lock contention on high-throughput inference paths while maintaining real-time consistency when settings change.

**Independent Test**: Can be fully tested by calling `getSettings()` repeatedly within 5 seconds to observe zero SQLite queries, calling `updateSettings()` and verifying that `settings_revision` in `_meta` is bumped, cache is invalidated immediately, and subsequent `getSettings()` returns the updated payload with an identical return shape.

**Acceptance Scenarios**:

1. **Given** cached settings within the 5000ms TTL window, **When** `getSettings()` is called, **Then** it returns the cached merged settings object synchronously/immediately without executing SQLite queries.
2. **Given** expired cache (>5000ms elapsed since last fetch), **When** `getSettings()` is called, **Then** it checks the `settings_revision` row in `_meta`, reads the `settings` table, updates the in-memory cache, and resets the expiration window to `Date.now() + 5000`.
3. **Given** an administrative change via `updateSettings(updates)`, **When** the update transaction commits, **Then** it atomically bumps `settings_revision` in `_meta`, invalidates the local in-memory cache, broadcasts `KHATAM_EVENTS.CONFIG_RELOAD` across the Redis event bus, and returns the merged settings object.
4. **Given** existing callers expecting the standard 9router settings schema, **When** calling `getSettings()`, `updateSettings()`, `isCloudEnabled()`, or `getCloudUrl()`, **Then** the return shape and field types remain 100% backward compatible.
5. **Given** manual invalidation needs, **When** `invalidateSettingsCache()` or `bumpSettingsRevision()` is called, **Then** subsequent calls to `getSettings()` immediately read fresh data from SQLite.

---

### Edge Cases

- **Concurrent Multi-Process Migrations**: When both Bun and Go processes start simultaneously, SQLite `PRAGMA busy_timeout = 5000` allows the second process to wait for the first process's migration transaction to complete; subsequent discovery sees all migrations in `_khatam_migrations` and safely skips them.
- **Migration Failure in Mid-Batch**: If migration 003 fails while 001 and 002 succeeded, 001 and 002 remain permanently recorded and applied; only 003 is rolled back and re-attempted on subsequent startup.
- **Database File Creation Boundary**: Fresh database files (0 bytes or newly initialized with no prior tables) skip the `.bak-<version>` backup step to avoid creating useless empty backup files.
- **Clock Drift in Sliding Windows**: Two-bucket sliding window calculation uses integer bucket math (`Math.floor(Date.now() / (windowMs))`) and clamps negative elapsed ratios to 0 and ratios exceeding 1 to 1.
- **Redis Offline Transition**: If Redis goes offline mid-request, `RedisQuotaStore` degrades gracefully to `{ allowed: true, degraded: true }`, ensuring inference requests are never blocked due to rate-limiting infrastructure failures.
- **Rapid Settings Mutation**: Concurrent calls to `updateSettings()` run inside `adapter.transaction()`, ensuring atomic read-merge-write without lost updates.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST create and maintain a `_khatam_migrations` table with schema `(version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)` in `$DATA_DIR/db/data.sqlite`.
- **FR-002**: Migration runner MUST discover migration scripts in `src/lib/db/migrations/` ordered by version number/prefix.
- **FR-003**: Migration runner MUST execute each migration in its own isolated transaction and record successful completion in `_khatam_migrations`.
- **FR-004**: Migration runner MUST skip migrations whose version already exists in `_khatam_migrations`.
- **FR-005**: Migration runner MUST be idempotent, returning `{ applied: 0, from: current, to: current }` when no pending migrations exist.
- **FR-006**: On migration failure, the runner MUST roll back that migration's transaction and throw an error explicitly stating the failed migration version and name.
- **FR-007**: When pending migrations exist on a non-fresh database, the runner MUST issue `PRAGMA wal_checkpoint(TRUNCATE)` and copy `${DATA_FILE}` to `${DATA_FILE}.bak-${version}` before applying the first pending migration.
- **FR-008**: System MUST expand `providerConnections` with columns: `rate_limit_overrides_json TEXT`, `max_concurrent INTEGER`, `rate_limit_protection INTEGER DEFAULT 0`, `rate_limited_until TEXT`, `backoff_level INTEGER DEFAULT 0`, and `quota_window_thresholds_json TEXT`.
- **FR-009**: System MUST expand `apiKeys` with columns: `allowedProviders TEXT`, `allowedCombos TEXT`, `allowedKinds TEXT`, `rate_limits TEXT`, `throttle_delay_ms INTEGER DEFAULT 0`, `usage_limit_enabled INTEGER DEFAULT 0`, `daily_usage_limit_usd REAL`, and `weekly_usage_limit_usd REAL`.
- **FR-010**: Schema MUST preserve existing 9router columns `accessRestricted` and `accessAllow` on `apiKeys`.
- **FR-011**: System MUST create the 9 new tables: `api_key_quota_limits`, `api_key_quota_counters`, `request_cost_ledger`, `domain_circuit_breakers`, `model_capabilities`, `model_context_overrides`, `model_capability_overrides`, `proxy_pool_fitness`, and `cached_provider_models`.
- **FR-012**: System MUST provide a `RedisQuotaStore` implementing a two-bucket sliding window algorithm using `INCRBYFLOAT` under the `khatam:quota:` namespace.
- **FR-013**: `RedisQuotaStore` MUST implement `consume()` and `peek()` methods, failing open with `{ allowed: true, degraded: true }` on Redis errors or when `REDIS_URL` is unset.
- **FR-014**: System MUST provide a `quotaStoreFactory()` selecting `RedisQuotaStore` when Redis is configured and available, and `SqliteQuotaStore` backed by `api_key_quota_counters` otherwise.
- **FR-015**: `settingsRepo` MUST implement an in-memory cache with a 5000ms TTL keyed by a `settings_revision` row in `_meta`, maintaining an identical return shape for `getSettings()`.
- **FR-016**: `settingsRepo` MUST provide `bumpSettingsRevision()` and `invalidateSettingsCache()` methods, automatically invalidating the cache and broadcasting `KHATAM_EVENTS.CONFIG_RELOAD` on `updateSettings()`.

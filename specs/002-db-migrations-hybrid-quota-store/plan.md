# Implementation Plan: Wave 2 - Database Migrations & Hybrid Quota Store

**Branch**: `002-db-migrations-hybrid-quota-store` | **Date**: 2026-10-21 | **Spec**: [Feature Spec](./spec.md)

**Input**: Feature specification from `/specs/002-db-migrations-hybrid-quota-store/spec.md`

---

## Summary

This plan establishes Wave 2 of the KhatamRouter architecture:
1. **Versioned `_khatam_migrations` Engine**: Migrates schema tracking to an authoritative `_khatam_migrations` table (`version TEXT PRIMARY KEY`, `name TEXT`, `applied_at TEXT`). Features automatic migration discovery, per-migration transactional isolation, rollback on failure with version-naming errors, and a safety preflight executing `PRAGMA wal_checkpoint(TRUNCATE)` and a `.bak-<version>` snapshot on existing non-fresh databases.
2. **Additive-Only Schema Expansion**: Expands `providerConnections` with connection rate limit overrides and concurrency fields; expands `apiKeys` with granular provider/combo/kind ACLs and spend caps while strictly preserving 9router's `accessRestricted`/`accessAllow` columns; and creates 9 new tables (`api_key_quota_limits`, `api_key_quota_counters`, `request_cost_ledger`, `domain_circuit_breakers`, `model_capabilities`, `model_context_overrides`, `model_capability_overrides`, `proxy_pool_fitness`, `cached_provider_models`).
3. **Distributed `RedisQuotaStore` with SQLite Fallback**: Implements a high-throughput two-bucket sliding window counter using Redis `INCRBYFLOAT` namespaced under `khatam:quota:`. Enforces a strict fail-open policy (`allowed: true, degraded: true`) when Redis is unreachable, paired with `SqliteQuotaStore` backed by `api_key_quota_counters` when `REDIS_URL` is omitted.
4. **5-Second Settings Cache in `settingsRepo`**: Implements an in-memory read-through cache (5000ms TTL) keyed by a `settings_revision` row in `_meta`. Ensures zero SQLite queries on high-throughput proxy inference calls, provides `bumpSettingsRevision()` and `invalidateSettingsCache()` methods, and broadcasts cluster invalidation over `khatam:events:config_reload`.

---

## Technical Context

**Language/Version**: JavaScript ES2022 / TypeScript 5.x / Bun v1.4.3 (Node.js 22+ fallback)

**Primary Dependencies**: `ioredis` ^5.4.0, native `bun:sqlite` (with `better-sqlite3`, `node:sqlite`, and `sql.js` fallbacks)

**Storage**:
- SQLite 3.45+ (via `bun:sqlite` with WAL mode at `$DATA_DIR/db/data.sqlite`)
- Redis 7+ (via `ioredis`, optional cluster accelerator)

**Testing**:
- Vitest (`npx vitest run` in `tests/`)
- Node.js provider baseline verification (`tests/__baseline__/verify-providers.mjs`)
- Unlazy gate suite (`.unlazy/wave-002/GATES.md`)

**Target Platform**: Linux x86_64 / arm64, Docker (`oven/bun:1.4.3-slim`), WSL2

**Performance Goals**:
- Quota store `peek()` and `consume()` latency < 1ms (Redis) / < 3ms (SQLite)
- `settingsRepo.getSettings()` cache hit latency < 0.05ms (in-memory)
- Migration runner startup overhead < 15ms for up-to-date databases
- Zero lock contention / `SQLITE_BUSY` errors under high concurrent proxy traffic

**Constraints**:
- Additive-only schema changes (no dropping or renaming columns; preserve `accessRestricted` and `accessAllow`)
- Migration transactions must be strictly isolated (one transaction per migration)
- Safe fail-open behavior: quota store errors must never reject or block valid user requests
- Full backward compatibility for existing callers of `settingsRepo`

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I: Upstream Base Integrity**: PASSED. Preserves 9router's `accessRestricted` and `accessAllow` columns on `apiKeys`, maintains all existing repository return shapes, and ensures 9router provider/combo routing logic remains untouched.
- **Principle II: Dual-Runtime Stack & Strict Port Separation**: PASSED. Preserves `DASHBOARD_PORT=20128` and `ENDPOINT_PORT=20129` configuration without changes.
- **Principle III: Shared SQLite3 WAL + Redis Hybrid State**: PASSED. Implements `_khatam_migrations` as the single migration authority at startup, WAL checkpointing before migrations, and `khatam:quota:` key namespacing in Redis with transparent SQLite fallback over `api_key_quota_counters`.
- **Principle IV: Graph-First Discovery & Coverage Invariant**: PASSED. Investigated `src/lib/db/driver.js`, `src/lib/db/migrate.js`, `src/lib/db/schema.js`, `src/lib/db/repos/settingsRepo.js`, and `src/lib/redis/client.js`.
- **Principle V: Spec-Kit SDD + Unlazy Gate-Driven Completion**: PASSED. Artifacts authored under `specs/002-db-migrations-hybrid-quota-store/`, and Unlazy ledger authored under `.unlazy/wave-002/GATES.md` passing `gate-lint.mjs`.
- **Principle VI: Resilience, Granular Limits, Stealth & Dynamic Model Capabilities**: PASSED. Prepares database tables for connection overrides, API key quotas, USD spend tracking (`request_cost_ledger`), 4-state circuit breakers (`domain_circuit_breakers`), and model capabilities (`model_capabilities`).

---

## Technical Architecture & Implementation Details

### 1. Versioned Migration Engine (`src/lib/db/migrations/` & `src/lib/db/migrate.js`)

#### A. Migration Tracking Table
```sql
CREATE TABLE IF NOT EXISTS _khatam_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

#### B. Discovery & Ordering
- Discovers migration modules from `src/lib/db/migrations/index.js` or ordered directory scan:
  - `001-initial.js` (version `"001"` or `1`, name `"initial"`)
  - `002-wave2-storage-quota.js` (version `"002"` or `2`, name `"wave2-storage-quota"`)
- Normalizes version identifiers to comparable strings / integers.
- Queries `SELECT version FROM _khatam_migrations` to build a `Set` of already applied versions.

#### C. Safety Preflight & Snapshot
- Determines if the database is fresh:
  ```javascript
  function isFreshDb(adapter) {
    try {
      const row = adapter.get("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      return !row || row.c === 0;
    } catch {
      return true;
    }
  }
  ```
- If pending migrations exist and the DB is NOT fresh:
  1. Issues `adapter.exec("PRAGMA wal_checkpoint(TRUNCATE);");`
  2. Creates a backup snapshot:
     ```javascript
     const bakFile = `${DATA_FILE}.bak-${firstPendingVersion}`;
     fs.copyFileSync(DATA_FILE, bakFile);
     ```

#### D. Transactional Execution & Rollback
- Loops through each pending migration:
  ```javascript
  for (const migration of pending) {
    try {
      adapter.transaction(() => {
        migration.up(adapter);
        adapter.run(
          "INSERT INTO _khatam_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [String(migration.version), migration.name, new Date().toISOString()]
        );
      });
      console.log(`[DB][migrate] applied #${migration.version} ${migration.name}`);
    } catch (error) {
      console.error(`[DB][migrate] failed #${migration.version} ${migration.name}: ${error.message}`);
      throw new Error(`[DB][migrate] Migration ${migration.version} (${migration.name}) failed: ${error.message}`);
    }
  }
  ```

---

### 2. Additive-Only Schema Expansion (`schema.js` & `002-wave2-storage-quota.js`)

#### A. `providerConnections` Additions
```sql
ALTER TABLE providerConnections ADD COLUMN rate_limit_overrides_json TEXT;
ALTER TABLE providerConnections ADD COLUMN max_concurrent INTEGER;
ALTER TABLE providerConnections ADD COLUMN rate_limit_protection INTEGER DEFAULT 0;
ALTER TABLE providerConnections ADD COLUMN rate_limited_until TEXT;
ALTER TABLE providerConnections ADD COLUMN backoff_level INTEGER DEFAULT 0;
ALTER TABLE providerConnections ADD COLUMN quota_window_thresholds_json TEXT;
```

#### B. `apiKeys` Additions (Preserving `accessRestricted` and `accessAllow`)
```sql
ALTER TABLE apiKeys ADD COLUMN allowedProviders TEXT;
ALTER TABLE apiKeys ADD COLUMN allowedCombos TEXT;
ALTER TABLE apiKeys ADD COLUMN allowedKinds TEXT;
ALTER TABLE apiKeys ADD COLUMN rate_limits TEXT;
ALTER TABLE apiKeys ADD COLUMN throttle_delay_ms INTEGER DEFAULT 0;
ALTER TABLE apiKeys ADD COLUMN usage_limit_enabled INTEGER DEFAULT 0;
ALTER TABLE apiKeys ADD COLUMN daily_usage_limit_usd REAL;
ALTER TABLE apiKeys ADD COLUMN weekly_usage_limit_usd REAL;
```

#### C. New Tables (`CREATE TABLE IF NOT EXISTS`)
1. **`api_key_quota_limits`**:
   `id TEXT PRIMARY KEY, api_key TEXT NOT NULL, window_type TEXT NOT NULL, limit_value REAL NOT NULL, action TEXT DEFAULT 'reject', created_at TEXT NOT NULL, updated_at TEXT NOT NULL`
   Indexes: `idx_akql_key ON api_key_quota_limits(api_key)`
2. **`api_key_quota_counters`**:
   `key TEXT NOT NULL, window_bucket INTEGER NOT NULL, counter_type TEXT NOT NULL, value REAL DEFAULT 0, updated_at INTEGER NOT NULL`
   Primary Key: `PRIMARY KEY (key, window_bucket, counter_type)`
   Indexes: `idx_akqc_updated ON api_key_quota_counters(updated_at)`
3. **`request_cost_ledger`**:
   `id TEXT PRIMARY KEY, request_id TEXT NOT NULL, api_key_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, input_cost_per_million REAL DEFAULT 0, output_cost_per_million REAL DEFAULT 0, total_cost_usd REAL DEFAULT 0, status TEXT DEFAULT 'success', created_at TEXT NOT NULL`
   Indexes: `idx_rcl_api_key`, `idx_rcl_provider_model`, `idx_rcl_created_at`
4. **`domain_circuit_breakers`**:
   `domain TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'CLOSED', failure_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0, last_failure_reason TEXT, last_failure_at TEXT, cooldown_until TEXT, degraded_until TEXT, updated_at TEXT NOT NULL`
   Indexes: `idx_dcb_state ON domain_circuit_breakers(state)`
5. **`model_capabilities`**:
   `id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, context_window INTEGER DEFAULT 0, max_output_tokens INTEGER DEFAULT 0, supports_vision INTEGER DEFAULT 0, supports_audio INTEGER DEFAULT 0, supports_video INTEGER DEFAULT 0, supports_tools INTEGER DEFAULT 0, supports_reasoning INTEGER DEFAULT 0, supports_streaming INTEGER DEFAULT 1, modalities_json TEXT, metadata_json TEXT, updated_at TEXT NOT NULL`
   Indexes: `idx_mc_provider_model ON model_capabilities(provider, model_id)`
6. **`model_context_overrides`**:
   `id TEXT PRIMARY KEY, model_pattern TEXT NOT NULL, context_window INTEGER NOT NULL, max_output_tokens INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`
7. **`model_capability_overrides`**:
   `id TEXT PRIMARY KEY, model_pattern TEXT NOT NULL, capabilities_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`
8. **`proxy_pool_fitness`**:
   `proxy_id TEXT PRIMARY KEY, latency_ms INTEGER DEFAULT 0, success_rate REAL DEFAULT 1.0, total_requests INTEGER DEFAULT 0, consecutive_errors INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, last_checked_at TEXT NOT NULL, updated_at TEXT NOT NULL`
9. **`cached_provider_models`**:
   `id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL`
   Indexes: `idx_cpm_provider`, `idx_cpm_expires`

#### D. Compatibility Views
```sql
CREATE VIEW IF NOT EXISTS provider_connections AS SELECT * FROM providerConnections;
CREATE VIEW IF NOT EXISTS api_keys AS SELECT * FROM apiKeys;
```

---

### 3. Distributed `RedisQuotaStore` with SQLite Fallback (`src/lib/quota/`)

#### A. Sliding Window Algorithm (Two-Bucket Sliding Window)
Given window duration $W$ in seconds (e.g. 60s for RPM):
1. Current timestamp $T = \text{Date.now()} / 1000$.
2. Bucket indices:
   - $\text{currentBucket} = \lfloor T / W \rfloor$
   - $\text{previousBucket} = \text{currentBucket} - 1$
3. Weight calculation:
   - $\text{elapsedInCurrent} = T \pmod W$
   - $\text{currentWeight} = \text{elapsedInCurrent} / W$
   - $\text{previousWeight} = 1 - \text{currentWeight}$
4. Estimated usage:
   - $\text{estimatedUsage} = \text{previousCount} \times \text{previousWeight} + \text{currentCount}$
5. Key format:
   - Using `withRedisKey()`: `khatam:quota:<key>:<window>:<bucket>`
6. Float increments:
   - `INCRBYFLOAT` for fractional tokens or USD amounts.
   - `EXPIRE` set to $2 \times W + 10$ seconds.

#### B. Fail-Open Contract
If Redis command fails or connection times out:
```javascript
try {
  // Execute Redis commands
} catch (error) {
  warnOffline(`quota operation failed on key ${key}: ${error.message}`);
  return {
    allowed: true,
    degraded: true,
    current: 0,
    limit,
    remaining: limit,
    resetMs: window * 1000,
  };
}
```

#### C. SQLite Quota Store Fallback (`SqliteQuotaStore`)
When `REDIS_URL` is unset:
- Computes identical bucket math.
- Queries and updates `api_key_quota_counters` inside an atomic transaction:
  ```sql
  INSERT INTO api_key_quota_counters (key, window_bucket, counter_type, value, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (key, window_bucket, counter_type)
  DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at;
  ```

---

### 4. 5-Second In-Memory Settings Cache in `settingsRepo`

#### A. Cache Structure
```javascript
let settingsCache = {
  data: null,
  expiresAt: 0,
  revision: 0,
};
```

#### B. Read Path (`getSettings()`)
1. If `Date.now() < settingsCache.expiresAt` and `settingsCache.data`:
   Return `settingsCache.data` immediately (zero DB queries).
2. Otherwise, fetch `settings_revision` from `_meta` (or default `"1"`).
3. Query `SELECT data FROM settings WHERE id = 1`.
4. Merge with defaults and update cache:
   ```javascript
   settingsCache.data = mergeWithDefaults(raw);
   settingsCache.expiresAt = Date.now() + 5000;
   settingsCache.revision = currentRevision;
   return settingsCache.data;
   ```

#### C. Write & Invalidation Path (`updateSettings()`)
1. Commits SQLite update inside transaction:
   ```javascript
   db.transaction(() => {
     db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [stringifyJson(next)]);
     db.run("INSERT INTO _meta(key, value) VALUES('settings_revision', 1) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
   });
   ```
2. Invalidates local cache:
   `invalidateSettingsCache();`
3. Broadcasts cluster event:
   `publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { scope: "settings", timestamp: Date.now() });`

---

## Project Structure & Files Touched

```text
/home/redsnow/KhatamRouter/
├── .unlazy/wave-002/
│   └── GATES.md                                    # Unlazy acceptance gates
├── specs/002-db-migrations-hybrid-quota-store/
│   ├── spec.md                                     # Feature specification
│   ├── plan.md                                     # Implementation plan (this file)
│   └── tasks.md                                    # Dependency-ordered tasks
├── src/lib/db/
│   ├── schema.js                                   # Updated TABLES with new columns and tables (SCHEMA_VERSION = 3)
│   ├── migrate.js                                  # Versioned runner with _khatam_migrations, WAL checkpoint & backup
│   ├── migrations/
│   │   ├── index.js                                # Migration registry
│   │   ├── 001-initial.js                          # Initial bootstrap
│   │   └── 002-wave2-storage-quota.js              # Wave 2 additive columns and new tables
│   └── repos/
│       └── settingsRepo.js                         # 5-second TTL cache, bumpSettingsRevision, invalidate
├── src/lib/quota/
│   ├── index.js                                    # Quota module export and storeFactory
│   ├── redisQuotaStore.js                          # Redis two-bucket sliding window INCRBYFLOAT with fail-open
│   └── sqliteQuotaStore.js                         # SQLite fallback sliding window over api_key_quota_counters
└── tests/unit/
    ├── wave2-db-migrations.test.js                 # Vitest suite: migration runner, idempotency, rollback, snapshots
    └── wave2-quota-store.test.js                   # Vitest suite: Redis & SQLite sliding window quota stores
```

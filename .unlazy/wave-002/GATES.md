# Wave 2 Acceptance Gates: Storage, Migrations, and Hybrid Quota Store

OWNS: src/lib/db/**, src/lib/quota/**, tests/unit/wave2-*.test.js, specs/002-db-migrations-hybrid-quota-store/**

- [ ] G1: Migration runner executes idempotently on fresh database
  CHECK: bun -e "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-g1-')); process.env.DATA_DIR = tmp; process.env.DATA_DIR_ALLOW_TEMP = '1'; const { getAdapter } = await import('./src/lib/db/driver.js'); const db = await getAdapter(); const rows = db.all('SELECT version FROM _khatam_migrations'); if (!rows.length) throw new Error('no migrations in _khatam_migrations'); const { runKhatamMigrations } = await import('./src/lib/db/migrate.js'); const rerun = await runKhatamMigrations(db); if (rerun.applied !== 0) throw new Error('migration rerun not idempotent'); db.close?.(); fs.rmSync(tmp, { recursive: true, force: true });" && echo WAVE2_G1_OK
  EXPECT: WAVE2_G1_OK
  CWD: ../..

- [ ] G2: Schema additive columns and new tables exist after migration
  CHECK: bun -e "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-g2-')); process.env.DATA_DIR = tmp; process.env.DATA_DIR_ALLOW_TEMP = '1'; const { getAdapter } = await import('./src/lib/db/driver.js'); const db = await getAdapter(); const tables = new Set(db.all(\"SELECT name FROM sqlite_master WHERE type='table'\").map(r => r.name)); const expectedTables = ['_khatam_migrations', 'api_key_quota_limits', 'api_key_quota_counters', 'request_cost_ledger', 'domain_circuit_breakers', 'model_capabilities', 'model_context_overrides', 'model_capability_overrides', 'proxy_pool_fitness', 'cached_provider_models']; for (const t of expectedTables) { if (!tables.has(t)) throw new Error('missing table ' + t); } const pcCols = new Set(db.all('PRAGMA table_info(providerConnections)').map(r => r.name)); for (const c of ['rate_limit_overrides_json', 'max_concurrent', 'rate_limit_protection', 'rate_limited_until', 'backoff_level', 'quota_window_thresholds_json']) { if (!pcCols.has(c)) throw new Error('missing providerConnections column ' + c); } const akCols = new Set(db.all('PRAGMA table_info(apiKeys)').map(r => r.name)); for (const c of ['allowedProviders', 'allowedCombos', 'allowedKinds', 'rate_limits', 'throttle_delay_ms', 'usage_limit_enabled', 'daily_usage_limit_usd', 'weekly_usage_limit_usd', 'accessRestricted', 'accessAllow']) { if (!akCols.has(c)) throw new Error('missing apiKeys column ' + c); } db.close?.(); fs.rmSync(tmp, { recursive: true, force: true });" && echo WAVE2_G2_OK
  EXPECT: WAVE2_G2_OK
  CWD: ../..

- [ ] G3: Quota store sliding window and fail-open unit tests pass
  CHECK: bun x vitest run unit/wave2-quota-store.test.js && echo WAVE2_G3_OK
  EXPECT: WAVE2_G3_OK
  CWD: ../../tests

- [ ] G4: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: bun tests/__baseline__/verify-providers.mjs && echo WAVE2_G4_OK
  EXPECT: WAVE2_G4_OK
  CWD: ../..

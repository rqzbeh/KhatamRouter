// Wave 2 migration: additive schema expansion for limits, quotas, and capabilities
//
// Strictly preserves existing 9router columns (including `accessRestricted` and
// `accessAllow` on `apiKeys`). Uses ADD COLUMN guarded by `PRAGMA table_info`
// plus `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so it is
// completely idempotent on re-run.

function tableExists(db, table) {
  const row = db.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return Boolean(row);
}

function addColumnIfMissing(db, table, colName, colDef) {
  // A partial/legacy database may not carry this table at all (migration 001
  // already ran, or the row was written by an older release). Skipping the
  // ALTER lets syncSchemaFromTables() create the table with the full column
  // set afterwards instead of failing the whole migration.
  if (!tableExists(db, table)) return;
  const existing = db.all(`PRAGMA table_info(${table})`) || [];
  const existingNames = new Set(existing.map((r) => r.name));
  if (!existingNames.has(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
  }
}

const migration = {
  version: 2,
  name: "wave2-storage-quota",
  up(db) {
    // 1. providerConnections connection overrides & resilience
    addColumnIfMissing(db, "providerConnections", "rate_limit_overrides_json", "TEXT");
    addColumnIfMissing(db, "providerConnections", "max_concurrent", "INTEGER");
    addColumnIfMissing(db, "providerConnections", "rate_limit_protection", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "providerConnections", "rate_limited_until", "TEXT");
    addColumnIfMissing(db, "providerConnections", "backoff_level", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "providerConnections", "quota_window_thresholds_json", "TEXT");

    // 2. apiKeys limits, spend caps & ACLs (preserving accessRestricted/accessAllow)
    addColumnIfMissing(db, "apiKeys", "allowedProviders", "TEXT");
    addColumnIfMissing(db, "apiKeys", "allowedCombos", "TEXT");
    addColumnIfMissing(db, "apiKeys", "allowedKinds", "TEXT");
    addColumnIfMissing(db, "apiKeys", "rate_limits", "TEXT");
    addColumnIfMissing(db, "apiKeys", "throttle_delay_ms", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "apiKeys", "usage_limit_enabled", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "apiKeys", "daily_usage_limit_usd", "REAL");
    addColumnIfMissing(db, "apiKeys", "weekly_usage_limit_usd", "REAL");

    // 3. New Wave 2 tables (9 tables)
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_key_quota_limits (
        id TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        window_type TEXT NOT NULL,
        limit_value REAL NOT NULL,
        action TEXT DEFAULT 'reject',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_akql_key ON api_key_quota_limits(api_key);

      CREATE TABLE IF NOT EXISTS api_key_quota_counters (
        key TEXT NOT NULL,
        window_bucket INTEGER NOT NULL,
        counter_type TEXT NOT NULL,
        value REAL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, window_bucket, counter_type)
      );
      CREATE INDEX IF NOT EXISTS idx_akqc_updated ON api_key_quota_counters(updated_at);

      CREATE TABLE IF NOT EXISTS request_cost_ledger (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        api_key_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        input_cost_per_million REAL DEFAULT 0,
        output_cost_per_million REAL DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        status TEXT DEFAULT 'success',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rcl_api_key ON request_cost_ledger(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_rcl_provider_model ON request_cost_ledger(provider, model);
      CREATE INDEX IF NOT EXISTS idx_rcl_created_at ON request_cost_ledger(created_at);

      CREATE TABLE IF NOT EXISTS domain_circuit_breakers (
        domain TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'CLOSED',
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        last_failure_reason TEXT,
        last_failure_at TEXT,
        cooldown_until TEXT,
        degraded_until TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dcb_state ON domain_circuit_breakers(state);

      CREATE TABLE IF NOT EXISTS model_capabilities (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        context_window INTEGER DEFAULT 0,
        max_output_tokens INTEGER DEFAULT 0,
        supports_vision INTEGER DEFAULT 0,
        supports_audio INTEGER DEFAULT 0,
        supports_video INTEGER DEFAULT 0,
        supports_tools INTEGER DEFAULT 0,
        supports_reasoning INTEGER DEFAULT 0,
        supports_streaming INTEGER DEFAULT 1,
        modalities_json TEXT,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mc_provider_model ON model_capabilities(provider, model_id);

      CREATE TABLE IF NOT EXISTS model_context_overrides (
        id TEXT PRIMARY KEY,
        model_pattern TEXT NOT NULL,
        context_window INTEGER NOT NULL,
        max_output_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_capability_overrides (
        id TEXT PRIMARY KEY,
        model_pattern TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxy_pool_fitness (
        proxy_id TEXT PRIMARY KEY,
        latency_ms INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 1.0,
        total_requests INTEGER DEFAULT 0,
        consecutive_errors INTEGER DEFAULT 0,
        is_healthy INTEGER DEFAULT 1,
        last_checked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cached_provider_models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cpm_provider ON cached_provider_models(provider);
      CREATE INDEX IF NOT EXISTS idx_cpm_expires ON cached_provider_models(expires_at);

      CREATE VIEW IF NOT EXISTS provider_connections AS SELECT * FROM providerConnections;
      CREATE VIEW IF NOT EXISTS api_keys AS SELECT * FROM apiKeys;
    `);
  },
};

export default migration;

// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 4;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Compatibility views for snake_case table access
export const VIEWS = [
  "CREATE VIEW IF NOT EXISTS provider_connections AS SELECT * FROM providerConnections;",
  "CREATE VIEW IF NOT EXISTS api_keys AS SELECT * FROM apiKeys;",
];

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      // Wave 2 additions: rate limit overrides, concurrency & backoff
      rate_limit_overrides_json: "TEXT",
      max_concurrent: "INTEGER",
      rate_limit_protection: "INTEGER DEFAULT 0",
      rate_limited_until: "TEXT",
      backoff_level: "INTEGER DEFAULT 0",
      quota_window_thresholds_json: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
      // Wave 2 additions: ACLs, rate limits & USD spend caps
      allowedProviders: "TEXT",
      allowedCombos: "TEXT",
      allowedKinds: "TEXT",
      allowedModels: "TEXT",
      rate_limits: "TEXT",
      throttle_delay_ms: "INTEGER DEFAULT 0",
      usage_limit_enabled: "INTEGER DEFAULT 0",
      daily_usage_limit_usd: "REAL",
      weekly_usage_limit_usd: "REAL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  // ─── Wave 2 tables ────────────────────────────────────────────────────────
  api_key_quota_limits: {
    columns: {
      id: "TEXT PRIMARY KEY",
      api_key: "TEXT NOT NULL",
      window_type: "TEXT NOT NULL",
      limit_value: "REAL NOT NULL",
      action: "TEXT DEFAULT 'reject'",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_akql_key ON api_key_quota_limits(api_key)"],
  },
  api_key_quota_counters: {
    columns: {
      key: "TEXT NOT NULL",
      window_bucket: "INTEGER NOT NULL",
      counter_type: "TEXT NOT NULL",
      value: "REAL DEFAULT 0",
      updated_at: "INTEGER NOT NULL",
    },
    primaryKey: "PRIMARY KEY (key, window_bucket, counter_type)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_akqc_updated ON api_key_quota_counters(updated_at)"],
  },
  request_cost_ledger: {
    columns: {
      id: "TEXT PRIMARY KEY",
      request_id: "TEXT NOT NULL",
      api_key_id: "TEXT",
      provider: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      prompt_tokens: "INTEGER DEFAULT 0",
      completion_tokens: "INTEGER DEFAULT 0",
      total_tokens: "INTEGER DEFAULT 0",
      input_cost_per_million: "REAL DEFAULT 0",
      output_cost_per_million: "REAL DEFAULT 0",
      total_cost_usd: "REAL DEFAULT 0",
      status: "TEXT DEFAULT 'success'",
      created_at: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rcl_api_key ON request_cost_ledger(api_key_id)",
      "CREATE INDEX IF NOT EXISTS idx_rcl_provider_model ON request_cost_ledger(provider, model)",
      "CREATE INDEX IF NOT EXISTS idx_rcl_created_at ON request_cost_ledger(created_at)",
    ],
  },
  domain_circuit_breakers: {
    columns: {
      domain: "TEXT PRIMARY KEY",
      state: "TEXT NOT NULL DEFAULT 'CLOSED'",
      failure_count: "INTEGER DEFAULT 0",
      success_count: "INTEGER DEFAULT 0",
      last_failure_reason: "TEXT",
      last_failure_at: "TEXT",
      cooldown_until: "TEXT",
      degraded_until: "TEXT",
      updated_at: "TEXT NOT NULL",
      // Wave 4 (migration 003): diagnostics needed to restore a breaker exactly.
      last_failure_kind: "TEXT",
      open_cycle_count: "INTEGER DEFAULT 0",
      kind_failure_counts_json: "TEXT",
      transition_history_json: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_dcb_state ON domain_circuit_breakers(state)",
      "CREATE INDEX IF NOT EXISTS idx_dcb_cooldown ON domain_circuit_breakers(cooldown_until)",
      "CREATE INDEX IF NOT EXISTS idx_dcb_updated ON domain_circuit_breakers(updated_at)",
    ],
  },
  model_capabilities: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      model_id: "TEXT NOT NULL",
      context_window: "INTEGER DEFAULT 0",
      max_output_tokens: "INTEGER DEFAULT 0",
      supports_vision: "INTEGER DEFAULT 0",
      supports_audio: "INTEGER DEFAULT 0",
      supports_video: "INTEGER DEFAULT 0",
      supports_tools: "INTEGER DEFAULT 0",
      supports_reasoning: "INTEGER DEFAULT 0",
      supports_streaming: "INTEGER DEFAULT 1",
      modalities_json: "TEXT",
      metadata_json: "TEXT",
      updated_at: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_mc_provider_model ON model_capabilities(provider, model_id)"],
  },
  model_context_overrides: {
    columns: {
      id: "TEXT PRIMARY KEY",
      model_pattern: "TEXT NOT NULL",
      context_window: "INTEGER NOT NULL",
      max_output_tokens: "INTEGER",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
    },
  },
  model_capability_overrides: {
    columns: {
      id: "TEXT PRIMARY KEY",
      model_pattern: "TEXT NOT NULL",
      capabilities_json: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
    },
  },
  proxy_pool_fitness: {
    columns: {
      proxy_id: "TEXT PRIMARY KEY",
      latency_ms: "INTEGER DEFAULT 0",
      success_rate: "REAL DEFAULT 1.0",
      total_requests: "INTEGER DEFAULT 0",
      consecutive_errors: "INTEGER DEFAULT 0",
      is_healthy: "INTEGER DEFAULT 1",
      last_checked_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
    },
  },
  cached_provider_models: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      model_id: "TEXT NOT NULL",
      raw_json: "TEXT NOT NULL",
      fetched_at: "TEXT NOT NULL",
      expires_at: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_cpm_provider ON cached_provider_models(provider)",
      "CREATE INDEX IF NOT EXISTS idx_cpm_expires ON cached_provider_models(expires_at)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}

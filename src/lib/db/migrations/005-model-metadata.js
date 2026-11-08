// Migration 005: Model metadata persistence, capability overrides scoping & imported catalog membership.
//
// Spec 017 foundational persistence slice. Strictly additive, idempotent,
// and safe across existing legacy wildcard rows (PRAGMA table_info guards).

function tableExists(db, table) {
  const row = db.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return Boolean(row);
}

function addColumnIfMissing(db, table, colName, colDef) {
  if (!tableExists(db, table)) return;
  const existing = db.all(`PRAGMA table_info(${table})`) || [];
  const existingNames = new Set(existing.map((r) => r.name));
  if (!existingNames.has(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
  }
}

const migration = {
  version: 5,
  name: "005-model-metadata",
  up(db) {
    // 1. Add provider, model_id, and source to model_capability_overrides
    addColumnIfMissing(db, "model_capability_overrides", "provider", "TEXT");
    addColumnIfMissing(db, "model_capability_overrides", "model_id", "TEXT");
    addColumnIfMissing(db, "model_capability_overrides", "source", "TEXT DEFAULT 'manual'");

    // Indexes for model_capability_overrides
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcap_provider_model ON model_capability_overrides(provider, model_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcap_source ON model_capability_overrides(source)`);
    // Scoped uniqueness only applies to scoped rows (where provider and model_id are non-null).
    // Legacy rows with provider IS NULL are excluded to safely preserve legacy pattern rows.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mcap_scope_unique ON model_capability_overrides(provider, model_id, source) WHERE provider IS NOT NULL AND model_id IS NOT NULL`);

    // 2. Create imported_models table for source-scoped catalog membership
    db.exec(`
      CREATE TABLE IF NOT EXISTS imported_models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provenance TEXT NOT NULL DEFAULT 'imported',
        lifecycle TEXT NOT NULL DEFAULT 'active',
        capabilities_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_provider_conn ON imported_models(provider, connection_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_provider_model ON imported_models(provider, model_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_lifecycle ON imported_models(lifecycle)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_unique_source ON imported_models(provider, connection_id, model_id)`);
  },
};

export default migration;

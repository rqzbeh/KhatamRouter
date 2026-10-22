// Wave 6 migration: provider, model_id, and source on model_context_overrides and model_capabilities.
//
// Migration 002 created `model_context_overrides` and `model_capabilities`.
// Wave 6 needs to differentiate manual operator pins (`source: 'manual'`) from
// self-healing reconciler overrides (`source: 'auto:discovery'`) and support
// provider-scoped model overrides.
//
// Strictly additive, guarded by `PRAGMA table_info`, and idempotent on re-run —
// the same contract as 002 and 003. No column is renamed, retyped, or dropped.

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
  version: 4,
  name: "wave6-model-capabilities",
  up(db) {
    addColumnIfMissing(db, "model_context_overrides", "provider", "TEXT");
    addColumnIfMissing(db, "model_context_overrides", "model_id", "TEXT");
    addColumnIfMissing(db, "model_context_overrides", "source", "TEXT DEFAULT 'manual'");
    addColumnIfMissing(db, "model_capabilities", "source", "TEXT DEFAULT 'auto:discovery'");

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mco_provider_model ON model_context_overrides(provider, model_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mco_source ON model_context_overrides(source)`);
  },
};

export default migration;

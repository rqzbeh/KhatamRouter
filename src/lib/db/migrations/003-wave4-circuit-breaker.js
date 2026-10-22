// Wave 4 migration: circuit-breaker diagnostics on `domain_circuit_breakers`.
//
// Migration 002 already created the table with the durable counters. Wave 4's
// state machine needs to persist a little more to restore a breaker faithfully:
// which kind of failure last opened it, how many probe cycles it has burned
// (that drives cooldown escalation), the per-kind counters, and a bounded
// transition history for diagnostics.
//
// Strictly additive, guarded by `PRAGMA table_info`, and idempotent on re-run —
// the same contract as 002. No column is renamed, retyped, or dropped.

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
  version: 3,
  name: "wave4-circuit-breaker",
  up(db) {
    // Failure-kind and escalation state.
    addColumnIfMissing(db, "domain_circuit_breakers", "last_failure_kind", "TEXT");
    addColumnIfMissing(db, "domain_circuit_breakers", "open_cycle_count", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "domain_circuit_breakers", "kind_failure_counts_json", "TEXT");
    addColumnIfMissing(db, "domain_circuit_breakers", "transition_history_json", "TEXT");

    // Indexes that back the cooldown sweep and kind diagnostics.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dcb_cooldown ON domain_circuit_breakers(cooldown_until)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dcb_updated ON domain_circuit_breakers(updated_at)`);
  },
};

export default migration;

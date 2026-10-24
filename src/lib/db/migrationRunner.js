// Versioned migration runner — the single authority for applying schema
// migrations against the SQLite database (Constitution Principle III:
// WAL + busy_timeout driven by bun:sqlite).
//
// Contracts (Wave 2 spec / FR-001..FR-007):
// - Bookkeeping lives in `_khatam_migrations (version PK, name, applied_at)`.
// - Migrations are discovered from `./migrations/` and applied in ascending
//   version order; versions already recorded there are skipped (idempotent).
// - Before applying the first pending migration to a NON-fresh database the
//   runner issues `PRAGMA wal_checkpoint(TRUNCATE)` and copies the DB file to
//   `<db>.bak-<version>`. Fresh databases (no pre-existing tables) skip the
//   backup so no useless empty snapshot files are created.
// - Each migration runs in its own transaction together with its bookkeeping
//   row: a failure rolls back only that migration, records nothing, and throws
//   an Error naming the failed version.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_FILE } from "./paths.js";
import { MIGRATIONS as STATIC_MIGRATIONS, latestVersion } from "./migrations/index.js";

export const MIGRATIONS_TABLE = "_khatam_migrations";

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** Ordered list of migration descriptors: `{ version, name, up }`. */
function normalizeMigrations(list) {
  return [...(list || [])].sort((a, b) => Number(a.version) - Number(b.version));
}

/**
 * Discover migrations under `src/lib/db/migrations/*`.
 *
 * The statically imported registry (`migrations/index.js`) wins whenever it is
 * non-empty — a bundler (Next.js/webpack) cannot see `fs.readdir` + dynamic
 * `import()` of on-disk files, so the static list is the shipping path. The
 * filesystem scan is a self-contained fallback for standalone runtimes (Bun /
 * Node without bundling) where the registry may lag the files on disk.
 */
export async function discoverMigrations(dir = null) {
  const registry = normalizeMigrations(STATIC_MIGRATIONS);
  if (registry.length) return registry;

  const migrationsDir = dir || path.join(path.dirname(new URL(import.meta.url).pathname), "migrations");
  let entries = [];
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "index.js" || entry.name.endsWith(".d.ts") || !/^[\d][\w-]*\.(js|ts|mjs)$/.test(entry.name)) continue;
    const mod = await import(pathToFileURL(path.join(migrationsDir, entry.name)).href);
    const migration = mod.default || mod;
    if (migration && Number.isFinite(Number(migration.version)) && typeof migration.up === "function") {
      discovered.push({ version: Number(migration.version), name: String(migration.name || entry.name), up: migration.up });
    }
  }
  return normalizeMigrations(discovered);
}

/** Create the bookkeeping table when absent (idempotent). */
export function ensureMigrationsTable(db) {
  db.exec(MIGRATIONS_TABLE_SQL);
}

/** Set of versions already recorded in `_khatam_migrations` (as strings). */
export function getAppliedVersions(db) {
  ensureMigrationsTable(db);
  let rows = [];
  try {
    rows = db.all(`SELECT version FROM ${MIGRATIONS_TABLE}`) || [];
  } catch {
    rows = [];
  }
  return new Set(rows.map((row) => String(row.version)));
}

/**
 * A database is "fresh" when, before this runner created the bookkeeping
 * table, it contained no application tables at all (a file created during the
 * current boot, or an empty legacy file). Fresh databases skip the
 * `.bak-<version>` pre-migration snapshot: an empty backup is pure noise.
 */
export function isFreshDatabase(db) {
  try {
    const row = db.get(
      `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${MIGRATIONS_TABLE}'`
    );
    return !row || Number(row.c) === 0;
  } catch {
    return true;
  }
}

function checkpointBeforeSnapshot(db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return true;
  } catch {
    try {
      db.checkpoint?.("TRUNCATE") ?? db.checkpoint?.();
      return true;
    } catch (e) {
      console.warn(`[DB][migrate] pre-migration WAL checkpoint failed (continuing): ${e.message}`);
      return false;
    }
  }
}

/**
 * Best-effort copy of the database file to `<dbFile>.bak-<version>`, taken
 * after a WAL checkpoint so pending WAL frames are already in the main file.
 * Returns the backup path, or null when nothing was written (fresh/`:memory:`
 * databases, missing file, or the snapshot step itself failed).
 */
export function backupDatabaseFile(db, dbFile, version) {
  if (!dbFile || dbFile === ":memory:") return null;

  checkpointBeforeSnapshot(db);

  if (!fs.existsSync(dbFile)) return null;
  const bakFile = `${dbFile}.bak-${version}`;
  if (fs.existsSync(bakFile)) return bakFile;
  try {
    fs.copyFileSync(dbFile, bakFile, fs.constants.COPYFILE_EXCL);
    return bakFile;
  } catch (e) {
    console.warn(`[DB][migrate] pre-migration snapshot failed (continuing): ${e.message}`);
    return null;
  }
}

/**
 * Apply all pending migrations, in order, each in its own transaction.
 *
 * Returns `{ applied, from, to, pending, backupFile }`. When nothing is
 * pending the database is not altered at all and the result is
 * `{ applied: 0, from: current, to: current, pending: [], backupFile: null }`.
 */
export async function runMigrations(db, options = {}) {
  const {
    migrations = await discoverMigrations(),
    dbFile = DATA_FILE,
    fresh = null,
    log = true,
  } = options || {};

  ensureMigrationsTable(db);

  const ordered = normalizeMigrations(migrations);
  const appliedVersions = getAppliedVersions(db);
  const pending = ordered.filter((m) => !appliedVersions.has(String(m.version)));
  const recordedLatest = [...appliedVersions].reduce((max, v) => Math.max(max, Number(v) || 0), 0);
  const current = Math.max(recordedLatest, 0);

  if (!pending.length) {
    return { applied: 0, from: current, to: current, pending: [], backupFile: null };
  }

  const firstPendingVersion = String(pending[0].version);
  const dbIsFresh = fresh === null || fresh === undefined ? isFreshDatabase(db) : Boolean(fresh);
  const backupFile = dbIsFresh ? null : backupDatabaseFile(db, dbFile, firstPendingVersion);

  for (const migration of pending) {
    const version = String(migration.version);
    const name = migration.name || `migration-${version}`;
    try {
      db.transaction(() => {
        migration.up(db);
        db.run(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
          [version, name, new Date().toISOString()]
        );
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (log) console.error(`[DB][migrate] failed #${version} ${name}: ${message}`);
      const failure = new Error(`[DB][migrate] Migration ${version} (${name}) failed: ${message}`);
      failure.cause = error;
      failure.migrationVersion = version;
      failure.migrationName = name;
      throw failure;
    }
    if (log) console.log(`[DB][migrate] applied #${version} ${name}`);
  }

  const appliedLatest = Number(pending[pending.length - 1].version) || current;
  return {
    applied: pending.length,
    from: current,
    to: Math.max(current, appliedLatest),
    pending: pending.map((m) => ({ version: String(m.version), name: m.name || "" })),
    backupFile,
  };
}

export { latestVersion };

/**
 * Versioned migration runner — the single authority for applying schema
 * migrations against the shared SQLite database (Constitution Principle III:
 * WAL + busy_timeout; the same file is opened by the Bun control-plane and the
 * Go data-plane process).
 *
 * TypeScript twin of `migrationRunner.js`. Keep both in sync.
 */

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

export interface MigrationDbAdapter {
  driver?: string;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint | null };
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  checkpoint?: (mode?: string) => void;
  raw?: {
    export?: () => Uint8Array;
  };
}

export interface MigrationDescriptor {
  version: number | string;
  name: string;
  up: (db: MigrationDbAdapter) => void;
}

export interface RunMigrationsOptions {
  migrations?: MigrationDescriptor[];
  dbFile?: string;
  fresh?: boolean | null;
  log?: boolean;
}

export interface RunMigrationsResult {
  applied: number;
  from: number;
  to: number;
  pending: Array<{ version: string; name: string }>;
  backupFile: string | null;
}

function normalizeMigrations(list: MigrationDescriptor[] | undefined | null): MigrationDescriptor[] {
  return [...(list || [])].sort((a, b) => Number(a.version) - Number(b.version));
}

export async function discoverMigrations(dir: string | null = null): Promise<MigrationDescriptor[]> {
  const registry = normalizeMigrations(STATIC_MIGRATIONS as MigrationDescriptor[]);
  if (registry.length) return registry;

  const migrationsDir = dir || path.join(path.dirname(new URL(import.meta.url).pathname), "migrations");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: MigrationDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "index.js" || entry.name.endsWith(".d.ts") || !/^[\d][\w-]*\.(js|ts|mjs)$/.test(entry.name)) {
      continue;
    }
    const mod = await import(pathToFileURL(path.join(migrationsDir, entry.name)).href);
    const migration = (mod.default || mod) as Partial<MigrationDescriptor>;
    if (migration && Number.isFinite(Number(migration.version)) && typeof migration.up === "function") {
      discovered.push({
        version: Number(migration.version),
        name: String(migration.name || entry.name),
        up: migration.up,
      });
    }
  }
  return normalizeMigrations(discovered);
}

export function ensureMigrationsTable(db: MigrationDbAdapter): void {
  db.exec(MIGRATIONS_TABLE_SQL);
}

export function getAppliedVersions(db: MigrationDbAdapter): Set<string> {
  ensureMigrationsTable(db);
  let rows: Array<{ version: string | number }> = [];
  try {
    rows = (db.all(`SELECT version FROM ${MIGRATIONS_TABLE}`) as Array<{ version: string | number }>) || [];
  } catch {
    rows = [];
  }
  return new Set(rows.map((row) => String(row.version)));
}

export function isFreshDatabase(db: MigrationDbAdapter): boolean {
  try {
    const row = db.get<{ c?: number }>(
      `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${MIGRATIONS_TABLE}'`
    );
    return !row || Number(row.c) === 0;
  } catch {
    return true;
  }
}

function checkpointBeforeSnapshot(db: MigrationDbAdapter): boolean {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return true;
  } catch {
    try {
      db.checkpoint?.("TRUNCATE");
      return true;
    } catch (e) {
      const err = e as Error;
      console.warn(`[DB][migrate] pre-migration WAL checkpoint failed (continuing): ${err?.message ?? err}`);
      return false;
    }
  }
}

export function backupDatabaseFile(db: MigrationDbAdapter, dbFile: string, version: string): string | null {
  if (!dbFile || dbFile === ":memory:") return null;

  checkpointBeforeSnapshot(db);

  const exportBytes =
    db && db.driver === "sql.js" && db.raw && typeof db.raw.export === "function" ? db.raw.export() : null;
  if (exportBytes) {
    const bakFile = `${dbFile}.bak-${version}`;
    try {
      fs.writeFileSync(bakFile, Buffer.from(exportBytes));
      return bakFile;
    } catch (e) {
      const err = e as Error;
      console.warn(`[DB][migrate] pre-migration snapshot failed (continuing): ${err?.message ?? err}`);
      return null;
    }
  }

  if (!fs.existsSync(dbFile)) return null;
  const bakFile = `${dbFile}.bak-${version}`;
  try {
    fs.copyFileSync(dbFile, bakFile);
    return bakFile;
  } catch (e) {
    const err = e as Error;
    console.warn(`[DB][migrate] pre-migration snapshot failed (continuing): ${err?.message ?? err}`);
    return null;
  }
}

export async function runMigrations(
  db: MigrationDbAdapter,
  options: RunMigrationsOptions = {}
): Promise<RunMigrationsResult> {
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
      const message = error instanceof Error ? error.message : String(error);
      if (log) console.error(`[DB][migrate] failed #${version} ${name}: ${message}`);
      const failure = new Error(`[DB][migrate] Migration ${version} (${name}) failed: ${message}`) as Error & {
        cause?: unknown;
        migrationVersion?: string;
        migrationName?: string;
      };
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

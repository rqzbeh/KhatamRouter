// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// Opening contract for every connection (Constitution Principle III: the file is
// shared with a second runtime process). busy_timeout comes first so the WAL
// switch below waits for concurrent writers instead of failing SQLITE_BUSY.
// Keep these literals in sync with src/lib/db/adapters/bunSqliteAdapter.ts.
export const OPEN_PRAGMAS = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
`;

/** Read a single-value PRAGMA result (`PRAGMA x = y` returns one row). */
function pragmaValue(db, sql) {
  try {
    const row = db.query(sql).get();
    if (!row) return null;
    return Object.values(row)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fail fast (FR-008) when the file on disk is corrupt, instead of handing the
 * caller a half-broken connection.
 */
export function assertIntegrity(db, filePath = "<memory>") {
  let row = null;
  try {
    row = db.query("PRAGMA integrity_check;").get();
  } catch (error) {
    throw new Error(
      `[DB] SQLite integrity check failed for ${filePath}: ${error?.message ?? error}. Database files were left in place.`
    );
  }
  const status = row ? Object.values(row)[0] ?? null : null;
  if (status !== "ok") {
    throw new Error(
      `[DB] SQLite integrity check failed for ${filePath}: ${JSON.stringify(row ?? null)}. Database files were left in place.`
    );
  }
}

export async function createBunSqliteAdapter(filePath) {
  // Dynamic import — only resolves under Bun runtime
  const { Database } = await import("bun:sqlite");
  const db = new Database(filePath, { create: true });
  try {
    db.exec(PRAGMA_SQL);
    db.exec(OPEN_PRAGMAS);
    const journal = pragmaValue(db, "PRAGMA journal_mode;");
    // `:memory:` databases cannot use WAL (journal_mode stays "memory"); the
    // shared-file contract only applies to on-disk databases.
    if (filePath !== ":memory:" && journal !== null && String(journal).toLowerCase() !== "wal") {
      throw new Error(
        `[DB] Could not enable WAL journal mode for ${filePath} (journal_mode=${journal}). Shared multi-process access requires WAL.`
      );
    }
    const busyTimeout = pragmaValue(db, "PRAGMA busy_timeout;");
    if (busyTimeout !== null && Number(busyTimeout) !== 5000) {
      throw new Error(
        `[DB] busy_timeout is ${busyTimeout}ms for ${filePath}; expected 5000ms for shared multi-process access.`
      );
    }
    assertIntegrity(db, filePath);
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const checkpointTimer = setInterval(() => {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  return {
    driver: "bun:sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec(sql) { return db.exec(sql); },
    /**
     * Run `PRAGMA <pragmaStr>`. With `{ simple: true }` return the first value
     * of the first row (e.g. `pragma("journal_mode", { simple: true })` → "wal").
     */
    pragma(pragmaStr, options) {
      const statement = db.query(`PRAGMA ${pragmaStr}`);
      if (options?.simple) {
        const row = statement.get();
        return row ? Object.values(row)[0] ?? null : null;
      }
      return statement.all();
    },
    transaction(fn) {
      // bun:sqlite has db.transaction() API (similar to better-sqlite3)
      const tx = db.transaction(fn);
      return tx();
    },
    checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}

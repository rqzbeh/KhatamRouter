// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// Opening contract for every connection (Constitution Principle III).
// busy_timeout comes first so the WAL switch below waits for concurrent
// writers instead of failing SQLITE_BUSY.
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

  // Cluster followers (KHATAM_WORKER_ROLE=worker) skip the periodic checkpoint. The leader, or an
  // unset/empty role (single-process), owns it. Close-time checkpoint in gracefulClose() runs everywhere.
  const workerRole = process.env.KHATAM_WORKER_ROLE;
  let checkpointTimer = null;
  if (!workerRole || workerRole === "leader") {
    checkpointTimer = setInterval(() => {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    }, CHECKPOINT_INTERVAL_MS);
    if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();
  }

  function gracefulClose() {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  if (!workerRole) {
    process.once("SIGINT", () => { onShutdown(); process.exit(0); });
    process.once("SIGTERM", () => { onShutdown(); process.exit(0); });
  } else {
    process.once("exit", onShutdown);
  }

  return {
    driver: "bun:sqlite",
    raw: db,
    prepare(sql) {
      return prepare(sql);
    },
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      const row = prepare(sql).get(...params);
      return row ?? null;
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
      // bun:sqlite has db.transaction() API (built-in)
      const tx = db.transaction(fn);
      return tx();
    },
    immediate(fn) {
      const tx = db.transaction(fn);
      if (typeof tx.immediate === "function") {
        return tx.immediate();
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const res = fn();
        db.exec("COMMIT");
        return res;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    async backup(destination) {
      if (filePath === ":memory:") return;
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      const { default: fs } = await import("node:fs");
      await fs.promises.copyFile(filePath, destination);
    },
    checkpoint(mode = "TRUNCATE") {
      try { db.exec(`PRAGMA wal_checkpoint(${mode})`); } catch {}
    },
    close() {
      gracefulClose();
    },
  };
}

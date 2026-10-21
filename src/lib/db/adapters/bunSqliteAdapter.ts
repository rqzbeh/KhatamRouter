/**
 * Bun runtime adapter — TypeScript twin of `bunSqliteAdapter.js`.
 *
 * Keep this file byte-for-byte equivalent in behaviour to the `.js` twin: the
 * runtime loads `bunSqliteAdapter.js` (driver.js imports it with an explicit
 * `.js` extension) while type-checking / Bun-era migrations resolve this file.
 */

export interface BunSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface BunSqliteDatabaseLike {
  query(sql: string): BunSqliteStatement;
  exec(sql: string): void;
  transaction<T>(fn: (...args: unknown[]) => T): ((...args: unknown[]) => T) & {
    immediate?: (...args: unknown[]) => T;
  };
  close(): void;
}

export interface BunSqliteAdapter {
  driver: "bun:sqlite";
  raw: BunSqliteDatabaseLike;
  prepare: (sql: string) => BunSqliteStatement;
  run: (sql: string, ...params: unknown[]) => { changes: number; lastInsertRowid: number };
  get: <T = unknown>(sql: string, ...params: unknown[]) => T | undefined;
  all: <T = unknown>(sql: string, ...params: unknown[]) => T[];
  exec: (sql: string) => void;
  pragma: (pragmaStr: string, options?: { simple?: boolean }) => unknown;
  transaction: <T>(fn: (...args: unknown[]) => T) => (...args: unknown[]) => T;
  immediate: (fn: () => void) => void;
  backup: (destination: string) => Promise<void>;
  checkpoint: (mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE") => void;
  close: () => void;
}

interface BunSqliteDatabaseConstructor {
  new (filePath: string, options?: { create?: boolean }): BunSqliteDatabaseLike;
}

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// Opening contract for every connection (Constitution Principle III: the file is
// shared with a second runtime process). busy_timeout comes first so the WAL
// switch below waits for concurrent writers instead of failing SQLITE_BUSY.
// Keep these literals in sync with src/lib/db/adapters/bunSqliteAdapter.js.
export const OPEN_PRAGMAS = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
`;

/** Read a single-value PRAGMA result (`PRAGMA x = y` returns one row). */
function pragmaValue(db: BunSqliteDatabaseLike, sql: string): unknown {
  try {
    const row = db.query(sql).get() as Record<string, unknown> | undefined | null;
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
export function assertIntegrity(db: BunSqliteDatabaseLike, filePath = "<memory>"): void {
  let row: unknown = null;
  try {
    row = db.query("PRAGMA integrity_check;").get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[DB] SQLite integrity check failed for ${filePath}: ${message}. Database files were left in place.`
    );
  }
  const status = row ? ((row as Record<string, unknown>)[Object.keys(row as object)[0]] ?? null) : null;
  if (status !== "ok") {
    throw new Error(
      `[DB] SQLite integrity check failed for ${filePath}: ${JSON.stringify(row ?? null)}. Database files were left in place.`
    );
  }
}

export async function createBunSqliteAdapter(filePath: string): Promise<BunSqliteAdapter> {
  // Dynamic import — only resolves under the Bun runtime. The specifier is held
  // in a variable so TypeScript does not try to resolve `bun:sqlite` (it has no
  // type declarations without bun-types installed).
  const bunSqliteSpecifier = "bun:sqlite";
  const mod = (await import(bunSqliteSpecifier)) as unknown as {
    Database: BunSqliteDatabaseConstructor;
  };
  const Database = mod.Database;
  const db = new Database(filePath, { create: true });
  try {
    // PRAGMA_SQL is defined in ../schema.js — import it the same way the .js twin does.
    const { PRAGMA_SQL } = (await import("../schema.js")) as unknown as { PRAGMA_SQL: string };
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

  const statementCache = new Map<string, BunSqliteStatement>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const keepAlive = () => {
    if (timer) return;
    timer = setInterval(() => {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    }, CHECKPOINT_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
  };
  keepAlive();

  const teardown = () => {
    if (timer) { clearInterval(timer); timer = null; }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  };
  process.once("beforeExit", teardown);

  return {
    driver: "bun:sqlite",
    raw: db,

    prepare(sql: string): BunSqliteStatement {
      let statement = statementCache.get(sql);
      if (!statement) {
        statement = db.query(sql);
        statementCache.set(sql, statement);
      }
      return statement;
    },

    run(sql: string, ...params: unknown[]) {
      const result = this.prepare(sql).run(...params);
      return { changes: Number(result.changes ?? 0), lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
    },

    get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
      const statement = this.prepare(sql);
      // bun:sqlite returns null when no row matches; contract call sites written to.
      return (statement.get(...params) ?? undefined) as T | undefined;
    },

    all<T = unknown>(sql: string, ...params: unknown[]): T[] {
      return this.prepare(sql).all(...params) as T[];
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    pragma(pragmaStr: string, options?: { simple?: boolean }): unknown {
      const statement = db.query(`PRAGMA ${pragmaStr}`);
      if (options?.simple) {
        const row = statement.get() as Record<string, unknown> | undefined;
        return row ? (Object.values(row)[0] ?? null) : null;
      }
      return statement.all();
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return db.transaction(fn) as (...args: unknown[]) => T;
    },

    immediate(fn: () => void): void {
      const transaction = db.transaction(fn) as unknown as { immediate?: () => void };
      if (typeof transaction.immediate === "function") {
        transaction.immediate();
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },

    async backup(destination: string): Promise<void> {
      if (filePath === ":memory:") return;
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      const { default: fs } = await import("node:fs");
      await fs.promises.copyFile(filePath, destination);
    },

    checkpoint(mode = "TRUNCATE" as "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): void {
      try { db.exec(`PRAGMA wal_checkpoint(${mode})`); } catch {}
    },

    close(): void {
      teardown();
      try { process.removeListener("beforeExit", teardown); } catch {}
      try { db.close(); } catch {}
      statementCache.clear();
    },
  };
}

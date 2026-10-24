import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { vi } from "vitest";
vi.mock("@/lib/dataDir.js", async () => {
  return await import("../../src/lib/dataDir.js");
});

import { createBunSqliteAdapter } from "../../src/lib/db/adapters/bunSqliteAdapter.js";
import { createBunSqliteAdapter as createBunSqliteAdapterTs } from "../../src/lib/db/adapters/bunSqliteAdapter.ts";
import { verifyDatabaseIntegrity, getAdapter, getAdapterSync } from "../../src/lib/db/driver.js";
import { backupDatabaseFile } from "../../src/lib/db/migrationRunner.js";

const isBun = typeof process !== "undefined" && Boolean(process.versions?.bun);

describe("Wave 7.5: Bun-Only SQLite Runtime", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-w75-sqlite-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("US1: Adapter Contract & Behavior (JS and TS twins)", () => {
    it("returns null on row miss in both .js and .ts adapter twins", async () => {
      if (!isBun) return;
      const jsDb = await createBunSqliteAdapter(":memory:");
      const tsDb = await createBunSqliteAdapterTs(":memory:");

      try {
        jsDb.exec("CREATE TABLE test_miss (id INT, val TEXT);");
        tsDb.exec("CREATE TABLE test_miss (id INT, val TEXT);");

        const jsMiss = jsDb.get("SELECT * FROM test_miss WHERE id = 999;");
        const tsMiss = tsDb.get("SELECT * FROM test_miss WHERE id = 999;");

        expect(jsMiss).toBeNull();
        expect(tsMiss).toBeNull();
      } finally {
        jsDb.close();
        tsDb.close();
      }
    });

    it("satisfies the full adapter contract: run, get, all, exec, pragma, transaction, checkpoint, close", async () => {
      if (!isBun) return;
      const dbFile = path.join(tmpDir, "contract.sqlite");
      const db = await createBunSqliteAdapter(dbFile);

      try {
        expect(db.driver).toBe("bun:sqlite");
        expect(db.raw).toBeDefined();

        // exec
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);");

        // run
        const r1 = db.run("INSERT INTO items (name) VALUES (?);", ["item-1"]);
        expect(r1.changes).toBe(1);
        expect(r1.lastInsertRowid).toBe(1);

        const r2 = db.run("INSERT INTO items (name) VALUES (?);", ["item-2"]);
        expect(r2.changes).toBe(1);
        expect(r2.lastInsertRowid).toBe(2);

        // get (hit)
        const hit = db.get("SELECT * FROM items WHERE id = ?;", [1]);
        expect(hit).toEqual({ id: 1, name: "item-1" });

        // get (miss)
        const miss = db.get("SELECT * FROM items WHERE id = ?;", [999]);
        expect(miss).toBeNull();

        // all
        const rows = db.all("SELECT * FROM items ORDER BY id;");
        expect(rows).toEqual([
          { id: 1, name: "item-1" },
          { id: 2, name: "item-2" },
        ]);

        // pragma simple
        const journal = db.pragma("journal_mode", { simple: true });
        expect(journal).toBe("wal");

        // pragma all
        const pragmaRows = db.pragma("journal_mode");
        expect(Array.isArray(pragmaRows)).toBe(true);
        expect(pragmaRows[0]).toEqual({ journal_mode: "wal" });

        // transaction: commit
        const txResult = db.transaction(() => {
          db.run("INSERT INTO items (name) VALUES (?);", ["item-tx"]);
          return "committed";
        });
        expect(txResult).toBe("committed");
        expect(db.get("SELECT name FROM items WHERE name = ?;", ["item-tx"])).toEqual({ name: "item-tx" });

        // transaction: rollback on error
        expect(() => {
          db.transaction(() => {
            db.run("INSERT INTO items (name) VALUES (?);", ["should-rollback"]);
            throw new Error("abort-tx");
          });
        }).toThrow("abort-tx");
        expect(db.get("SELECT name FROM items WHERE name = ?;", ["should-rollback"])).toBeNull();

        // checkpoint
        expect(() => db.checkpoint()).not.toThrow();
      } finally {
        db.close();
      }
    });

    it("enforces WAL journal mode and busy_timeout=5000 on on-disk databases", async () => {
      if (!isBun) return;
      const dbFile = path.join(tmpDir, "wal-check.sqlite");
      const db = await createBunSqliteAdapter(dbFile);

      try {
        const row = db.get("PRAGMA journal_mode;");
        expect(row?.journal_mode).toBe("wal");

        const busy = db.get("PRAGMA busy_timeout;");
        expect(Number(busy?.timeout ?? busy?.busy_timeout)).toBe(5000);
      } finally {
        db.close();
      }
    });
  });

  describe("US1: Fail-Closed When Bun Runtime Absent", () => {
    it("fails closed with an actionable message when process.versions.bun is missing", async () => {
      const originalBun = process.versions.bun;
      try {
        delete process.versions.bun;

        // Calling verifyDatabaseIntegrity on non-existent file returns false
        await expect(verifyDatabaseIntegrity(path.join(tmpDir, "nonexistent.sqlite"))).resolves.toBe(false);

        const realFile = path.join(tmpDir, "exists.sqlite");
        fs.writeFileSync(realFile, "not empty");
        await expect(verifyDatabaseIntegrity(realFile)).rejects.toThrow(/KhatamRouter requires the Bun runtime/);
      } finally {
        process.versions.bun = originalBun;
      }
    });
  });

  describe("US1: Database Integrity Preflight", () => {
    it("returns false for a non-existent database file", async () => {
      const res = await verifyDatabaseIntegrity(path.join(tmpDir, "does-not-exist.sqlite"));
      expect(res).toBe(false);
    });

    it("passes integrity check on a valid database file", async () => {
      if (!isBun) return;
      const validDb = path.join(tmpDir, "valid.sqlite");
      const db = await createBunSqliteAdapter(validDb);
      db.exec("CREATE TABLE t (id INT);");
      db.close();

      const ok = await verifyDatabaseIntegrity(validDb);
      expect(ok).toBe(true);
    });

    it("fails closed on a corrupted database file", async () => {
      if (!isBun) return;
      const corruptDb = path.join(tmpDir, "corrupt.sqlite");
      fs.writeFileSync(corruptDb, "SQLite format 3\0corrupted-garbage-header-and-pages");

      await expect(verifyDatabaseIntegrity(corruptDb)).rejects.toThrow(/Integrity check failed|not a database/);
    });
  });

  describe("US1: Driver Single Instance via driver.js", () => {
    it("initializes bun:sqlite adapter via getAdapter()", async () => {
      if (!isBun) return;
      const adapter = await getAdapter();
      expect(adapter.driver).toBe("bun:sqlite");
      expect(typeof adapter.run).toBe("function");
      expect(typeof adapter.get).toBe("function");
      expect(typeof adapter.all).toBe("function");

      const sync = getAdapterSync();
      expect(sync).toBe(adapter);
    });
  });

  describe("US1: Migration Runner Snapshot (without sql.js)", () => {
    it("creates backup snapshot without sql.js in-memory export", async () => {
      if (!isBun) return;
      const dbFile = path.join(tmpDir, "migrate-test.sqlite");
      const db = await createBunSqliteAdapter(dbFile);
      db.exec("CREATE TABLE t (x TEXT);");
      db.run("INSERT INTO t VALUES ('sample');");

      const bak = backupDatabaseFile(db, dbFile, "v1");
      expect(bak).toBeDefined();
      expect(bak).toContain(".bak-v1");
      expect(fs.existsSync(bak)).toBe(true);

      db.close();
    });

    it("skips backup for :memory: databases", () => {
      const bak = backupDatabaseFile({ driver: "bun:sqlite" }, ":memory:", "v1");
      expect(bak).toBeNull();
    });
  });

  describe("US1: Direct Consumers Use bun:sqlite in Read-Only Mode", () => {
    it("opens IDE SQLite databases read-only with bun:sqlite", async () => {
      if (!isBun) return;
      const ideDbFile = path.join(tmpDir, "ide.sqlite");
      const { Database } = await import("bun:sqlite");

      // Setup IDE test db
      const setupDb = new Database(ideDbFile, { create: true });
      setupDb.exec("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);");
      setupDb.query("INSERT INTO kv_store VALUES ('system_id', 'sys-12345');").run();
      setupDb.close();

      // Read-only access as done in zedCredentials
      const readDb = new Database(ideDbFile, { readonly: true });
      const row = readDb.query("SELECT value FROM kv_store WHERE key = ? LIMIT 1").get("system_id");
      expect(row?.value).toBe("sys-12345");

      // Verify read-only prevents write
      expect(() => {
        readDb.query("INSERT INTO kv_store VALUES ('hacked', 'fail');").run();
      }).toThrow();
      readDb.close();
    });
  });
});

// Wave 2 — Leaf A: versioned migration runner & additive schema tests.
//
// Proves:
// 1. Fresh temp DB applies all migrations and records them in `_khatam_migrations`.
// 2. Second run applies nothing (idempotent, returns applied: 0).
// 3. All required tables and additive columns exist via PRAGMA table_info and sqlite_master.
// 4. Compatibility views (provider_connections and api_keys) exist and are queryable.
// 5. A failing migration rolls back its transaction, is not recorded, and names the version in the Error.
// 6. Pre-migration safety snapshot (.bak-<version>) is created on existing DB with pending migrations,
//    and skipped on fresh databases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

async function openEmptyAdapter(file) {
  if (process.versions.bun) {
    const { createBunSqliteAdapter } = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    return createBunSqliteAdapter(file);
  }
  try {
    const { createBetterSqliteAdapter } = await import("@/lib/db/adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(file);
  } catch {}
  try {
    const { createNodeSqliteAdapter } = await import("@/lib/db/adapters/nodeSqliteAdapter.js");
    return createNodeSqliteAdapter(file);
  } catch {}
  const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
  return createSqlJsAdapter(file);
}

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-wave2-mig-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  delete global._dbAdapter;
  vi.resetModules?.();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
});

describe("Wave 2 Migrations & Runner", () => {
  it("fresh temp DB applies all migrations and records them in _khatam_migrations", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();

    const rows = db.all("SELECT version, name, applied_at FROM _khatam_migrations ORDER BY CAST(version AS INTEGER) ASC");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const versions = rows.map((r) => r.version);
    expect(versions).toContain("1");
    expect(versions).toContain("2");

    for (const r of rows) {
      expect(r.name).toBeTruthy();
      expect(r.applied_at).toBeTruthy();
      expect(new Date(r.applied_at).getTime()).toBeGreaterThan(0);
    }

    // _meta schemaVersion is also kept in sync
    const metaRow = db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'");
    expect(parseInt(metaRow.value, 10)).toBe(latestVersion());
  });

  it("second run applies nothing (idempotent)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { runKhatamMigrations } = await import("@/lib/db/migrate.js");
    const db = await getAdapter();

    const countBefore = db.get("SELECT COUNT(*) AS c FROM _khatam_migrations")?.c ?? 0;
    expect(countBefore).toBeGreaterThanOrEqual(2);

    const rerun = await runKhatamMigrations(db);
    expect(rerun.applied).toBe(0);
    expect(rerun.pending).toEqual([]);
    expect(rerun.backupFile).toBeNull();

    const countAfter = db.get("SELECT COUNT(*) AS c FROM _khatam_migrations")?.c ?? 0;
    expect(countAfter).toBe(countBefore);
  });

  it("all required tables exist in sqlite_master", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const tableRows = db.all("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = new Set(tableRows.map((r) => r.name));

    const expectedTables = [
      "_khatam_migrations",
      "api_key_quota_limits",
      "api_key_quota_counters",
      "request_cost_ledger",
      "domain_circuit_breakers",
      "model_capabilities",
      "model_context_overrides",
      "model_capability_overrides",
      "proxy_pool_fitness",
      "cached_provider_models",
      "providerConnections",
      "apiKeys",
      "settings",
      "_meta",
    ];

    for (const tbl of expectedTables) {
      expect(tableNames.has(tbl), `table ${tbl} should exist in sqlite_master`).toBe(true);
    }
  });

  it("all required additive columns exist via PRAGMA table_info", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // 1. providerConnections
    const pcCols = new Set((db.all("PRAGMA table_info(providerConnections)") || []).map((r) => r.name));
    const expectedPcCols = [
      "rate_limit_overrides_json",
      "max_concurrent",
      "rate_limit_protection",
      "rate_limited_until",
      "backoff_level",
      "quota_window_thresholds_json",
    ];
    for (const c of expectedPcCols) {
      expect(pcCols.has(c), `providerConnections should have column ${c}`).toBe(true);
    }

    // 2. apiKeys (strictly preserving accessRestricted and accessAllow)
    const akCols = new Set((db.all("PRAGMA table_info(apiKeys)") || []).map((r) => r.name));
    const expectedAkCols = [
      "allowedProviders",
      "allowedCombos",
      "allowedKinds",
      "rate_limits",
      "throttle_delay_ms",
      "usage_limit_enabled",
      "daily_usage_limit_usd",
      "weekly_usage_limit_usd",
      "accessRestricted",
      "accessAllow",
    ];
    for (const c of expectedAkCols) {
      expect(akCols.has(c), `apiKeys should have column ${c}`).toBe(true);
    }
  });

  it("compatibility views provider_connections and api_keys exist and are queryable", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const viewRows = db.all("SELECT name FROM sqlite_master WHERE type='view'");
    const viewNames = new Set(viewRows.map((r) => r.name));

    expect(viewNames.has("provider_connections")).toBe(true);
    expect(viewNames.has("api_keys")).toBe(true);

    // Querying the views should return same result as querying camelCase tables
    const pcViaView = db.all("SELECT COUNT(*) AS c FROM provider_connections");
    const pcDirect = db.all("SELECT COUNT(*) AS c FROM providerConnections");
    expect(pcViaView[0].c).toBe(pcDirect[0].c);

    const akViaView = db.all("SELECT COUNT(*) AS c FROM api_keys");
    const akDirect = db.all("SELECT COUNT(*) AS c FROM apiKeys");
    expect(akViaView[0].c).toBe(akDirect[0].c);
  });

  it("a failing migration rolls back and is not recorded in _khatam_migrations", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { runMigrations } = await import("@/lib/db/migrationRunner.js");
    const db = await getAdapter();

    const appliedBefore = new Set(
      db.all("SELECT version FROM _khatam_migrations").map((r) => String(r.version))
    );

    const failingMigration = {
      version: 999,
      name: "failing-test-migration",
      up(dbHandle) {
        dbHandle.exec("CREATE TABLE should_be_rolled_back (id INT PRIMARY KEY);");
        throw new Error("Intentional explosion in migration 999");
      },
    };

    let errorThrown = null;
    try {
      await runMigrations(db, {
        migrations: [failingMigration],
        log: false,
      });
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).toBeTruthy();
    expect(errorThrown.message).toContain("999");
    expect(errorThrown.message).toContain("failing-test-migration");
    expect(errorThrown.message).toContain("Intentional explosion");

    // The failing migration MUST NOT be recorded in _khatam_migrations
    const appliedAfter = new Set(
      db.all("SELECT version FROM _khatam_migrations").map((r) => String(r.version))
    );
    expect(appliedAfter.has("999")).toBe(false);
    expect(appliedAfter.size).toBe(appliedBefore.size);

    // The table created inside the failing migration transaction MUST NOT exist (rolled back)
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    expect(tables.has("should_be_rolled_back")).toBe(false);
  });

  it("creates a .bak-<version> snapshot on an existing database with pending migrations", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { runMigrations } = await import("@/lib/db/migrationRunner.js");
    const db = await getAdapter();

    const dbFile = path.join(tempDir, "db", "data.sqlite");
    expect(fs.existsSync(dbFile)).toBe(true);

    const pendingMigration = {
      version: 100,
      name: "pending-snapshot-test",
      up(dbHandle) {
        dbHandle.exec("CREATE TABLE IF NOT EXISTS snapshot_probe (id INT PRIMARY KEY);");
      },
    };

    const result = await runMigrations(db, {
      migrations: [pendingMigration],
      dbFile,
      fresh: false, // Force non-fresh to verify backup snapshot behavior
      log: false,
    });

    expect(result.applied).toBe(1);
    expect(result.backupFile).toBe(`${dbFile}.bak-100`);
    expect(fs.existsSync(`${dbFile}.bak-100`)).toBe(true);

    // Clean up test migration artifact
    db.run("DELETE FROM _khatam_migrations WHERE version = '100'");
    db.exec("DROP TABLE IF EXISTS snapshot_probe");
    try {
      fs.rmSync(`${dbFile}.bak-100`, { force: true });
    } catch {}
  });

  it("backup-before-migrate cannot overwrite an existing backup file", async () => {
    const { backupDatabaseFile } = await import("@/lib/db/migrationRunner.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const dbFile = path.join(tempDir, "db", "data.sqlite");
    const bakFile = `${dbFile}.bak-999`;
    fs.writeFileSync(bakFile, "pre-existing-critical-backup");

    const result = backupDatabaseFile(db, dbFile, "999");
    expect(result).toBe(bakFile);
    expect(fs.readFileSync(bakFile, "utf-8")).toBe("pre-existing-critical-backup");
    fs.rmSync(bakFile, { force: true });
  });

  it("skips .bak-<version> snapshot on a freshly created database", async () => {
    const { runMigrations, isFreshDatabase } = await import("@/lib/db/migrationRunner.js");
    const freshDb = await openEmptyAdapter(path.join(tempDir, "fresh-no-backup.sqlite"));
    const freshDbFile = path.join(tempDir, "fresh-no-backup.sqlite");

    try {
      expect(isFreshDatabase(freshDb)).toBe(true);

      const testMigration = {
        version: 50,
        name: "fresh-test",
        up(dbHandle) {
          dbHandle.exec("CREATE TABLE IF NOT EXISTS fresh_probe (id INT);");
        },
      };

      const result = await runMigrations(freshDb, {
        migrations: [testMigration],
        dbFile: freshDbFile,
        log: false,
      });

      expect(result.applied).toBe(1);
      expect(result.backupFile).toBeNull();
      expect(fs.existsSync(`${freshDbFile}.bak-50`)).toBe(false);
    } finally {
      freshDb.close();
    }
  });

  it("upgrades a legacy database stamped only in _meta without re-running applied migrations", async () => {
    // Simulate a database created by pre-Wave-2 code: tables exist and
    // _meta.schemaVersion = 1, but _khatam_migrations does not exist yet.
    const legacyFile = path.join(tempDir, "legacy.sqlite");
    const legacyDb = await openEmptyAdapter(legacyFile);
    try {
      legacyDb.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      legacyDb.exec("CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, accessRestricted INTEGER DEFAULT 0, accessAllow TEXT);");
      legacyDb.run("INSERT INTO _meta(key, value) VALUES('schemaVersion', '1')");
      legacyDb.run("INSERT INTO apiKeys(id, key) VALUES('legacy-key', 'legacy-secret')");

      const { runMigrations } = await import("@/lib/db/migrationRunner.js");
      // Migrations registry is (1, 2); 1 was stamped in _meta by legacy code.
      const seeded = await runMigrations(legacyDb, {
        migrations: [{ version: 1, name: "initial", up() {} }],
        dbFile: legacyFile,
        log: false,
      });
      expect(seeded.applied).toBe(1);

      // A second pass must see the DB as fully migrated.
      const again = await runMigrations(legacyDb, {
        migrations: [{ version: 1, name: "initial", up() {} }],
        dbFile: legacyFile,
        log: false,
      });
      expect(again.applied).toBe(0);

      // Existing data and access-control columns are preserved.
      const row = legacyDb.get("SELECT key, accessRestricted, accessAllow FROM apiKeys WHERE id = 'legacy-key'");
      expect(row.key).toBe("legacy-secret");
      expect(row.accessRestricted).toBe(0);
      expect(row.accessAllow).toBeNull();
    } finally {
      legacyDb.close();
    }
  });
});

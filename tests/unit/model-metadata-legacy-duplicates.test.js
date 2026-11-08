import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mm-dupes-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("independent migration 005 legacy-data safety", () => {
  it("upgrades an existing database whose legacy overrides share a model pattern", async () => {
    // Build a real database at the pre-005 schema with the current migration chain.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const first = await getAdapter();
    const dbFile = first.raw?.filename || path.join(tempDir, "db", "data.sqlite");
    first.close?.();
    delete global._dbAdapter;

    // Roll the database back to version 4 and insert duplicate legacy rows that
    // were valid before the scoped unique indexes existed.
    const raw = new Database(dbFile);
    raw.exec("DROP INDEX IF EXISTS idx_mco_scope_unique; DROP INDEX IF EXISTS idx_mcap_scope_unique;");
    raw.exec("DELETE FROM _khatam_migrations WHERE CAST(version AS INTEGER) >= 5");
    raw.exec("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");
    const now = new Date().toISOString();
    for (const id of ["legacy-a", "legacy-b"]) {
      raw.run(
        `INSERT INTO model_context_overrides (id, model_pattern, context_window, created_at, updated_at)
         VALUES (?, 'gpt-*', 128000, ?, ?)`,
        [id, now, now],
      );
      raw.run(
        `INSERT INTO model_capability_overrides (id, model_pattern, capabilities_json, created_at, updated_at)
         VALUES (?, 'gpt-*', '{}', ?, ?)`,
        [id, now, now],
      );
    }
    raw.close();

    vi.resetModules();
    const { getAdapter: reopen } = await import("@/lib/db/driver.js");
    const db = await reopen();
    // Startup must succeed and must not silently delete operator rows.
    expect(db.get("SELECT COUNT(*) AS c FROM model_context_overrides WHERE model_pattern = 'gpt-*'").c).toBe(2);
    expect(db.get("SELECT COUNT(*) AS c FROM model_capability_overrides WHERE model_pattern = 'gpt-*'").c).toBe(2);
  });
});

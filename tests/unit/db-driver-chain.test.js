// Wave 7.5: Bun-only driver contract (bun:sqlite; fail-closed when unavailable)
// Driver fallback chain (better-sqlite3 → node:sqlite → sql.js) removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Driver fallback chain removal — Bun-only contract", () => {
  it("fails closed when Bun runtime is absent (process.versions.bun missing)", async () => {
    const origBun = process.versions.bun;
    try {
      delete process.versions.bun;
      const { getAdapter } = await import("@/lib/db/driver.js");
      await expect(getAdapter()).rejects.toThrow(/KhatamRouter requires the Bun runtime \(bun:sqlite\)/);
    } finally {
      if (origBun !== undefined) process.versions.bun = origBun;
    }
  });

  it("verifyDatabaseIntegrity fails closed when Bun runtime is absent on existing DB file", async () => {
    const origBun = process.versions.bun;
    try {
      delete process.versions.bun;
      const { verifyDatabaseIntegrity } = await import("@/lib/db/driver.js");
      const dbFile = path.join(tempDir, "existing.sqlite");
      fs.writeFileSync(dbFile, "sqlite dummy content");
      await expect(verifyDatabaseIntegrity(dbFile)).rejects.toThrow(/KhatamRouter requires the Bun runtime \(bun:sqlite\)/);
    } finally {
      if (origBun !== undefined) process.versions.bun = origBun;
    }
  });

  it("verifyDatabaseIntegrity returns false when DB file does not exist", async () => {
    const { verifyDatabaseIntegrity } = await import("@/lib/db/driver.js");
    const res = await verifyDatabaseIntegrity(path.join(tempDir, "missing.sqlite"));
    expect(res).toBe(false);
  });

  it("picks bun:sqlite when Bun runtime is present", async () => {
    if (!process.versions.bun) {
      // Mock bun environment & adapter to assert the Bun-only resolution contract
      process.versions.bun = "1.4.3";
      vi.doMock("@/lib/db/adapters/bunSqliteAdapter.js", () => ({
        createBunSqliteAdapter: async () => ({
          driver: "bun:sqlite",
          instance: { close: () => {} },
          exec: () => {},
          run: () => {},
          get: () => null,
          all: () => [],
          pragma: () => "wal",
          transaction: (fn) => fn(),
          checkpoint: () => {},
          close: () => {},
        }),
      }));
    }
    try {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const db = await getAdapter();
      expect(db.driver).toBe("bun:sqlite");
    } finally {
      if (process.versions.bun === "1.4.3") delete process.versions.bun;
    }
  });
});

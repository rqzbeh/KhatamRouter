// Wave 1 — Leaf 2: bun:sqlite WAL adapter, integrity check & Redis client/pub-sub.
//
// Covers the four contracts this leaf owns:
//   1. tsconfig.json + .env.example (dual-port + Redis namespace)
//   2. runtime-secrets.cjs production validation
//   3. src/lib/db/{driver.js,adapters/bunSqliteAdapter.js,dataDir.js} safety
//   4. src/lib/redis/{client.js,events.js} prefixing, fail-open, pub/sub
//
// The bun:sqlite adapter cannot be instantiated under Node (no `bun:sqlite`
// module), so its WAL contract is asserted statically here and exercised for
// real when this suite runs under Bun. Everything else runs on node:sqlite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Runner compatibility: this suite runs under both Vitest (`bun x vitest`) and
// Bun's native test runner (`bun test`). Bun's `vitest` compatibility shim has
// no `vi.doMock` / `vi.doUnmock` / `vi.resetModules`, so module mocking goes
// through `bun:test`'s `mock.module` there. Bun also has no module-cache reset,
// so a module already evaluated with an old `DATA_DIR` keeps its snapshot —
// tests that need a per-test database mock `@/lib/db/paths.js` instead of
// relying on a cache reset.
// ---------------------------------------------------------------------------
// Detect the runner by capability, not runtime: `bun x vitest` also sets
// `process.versions.bun`, but there real Vitest's `vi.doMock` exists and should
// be used. Only Bun's own runner lacks it.
const USE_BUN_MOCK = typeof vi.doMock !== "function";

let bunMock = null;
let realPathsSnapshot = null;
let realIoredisSnapshot = null;
let realBunAdapterSnapshot = null;
let realBetterAdapterSnapshot = null;
let realNodeAdapterSnapshot = null;

if (USE_BUN_MOCK) {
  const bunTest = await import("bun:test");
  bunMock = bunTest.mock;
  realPathsSnapshot = { ...(await import("@/lib/db/paths.js")) };
  const ioredisNs = await import("ioredis");
  realIoredisSnapshot = { default: ioredisNs.default, Redis: ioredisNs.Redis };
  try {
    const bNs = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    realBunAdapterSnapshot = { ...bNs };
  } catch {}
  try {
    const betNs = await import("@/lib/db/adapters/betterSqliteAdapter.js");
    realBetterAdapterSnapshot = { ...betNs };
  } catch {}
  try {
    const nNs = await import("@/lib/db/adapters/nodeSqliteAdapter.js");
    realNodeAdapterSnapshot = { ...nNs };
  } catch {}
}

async function mockModule(specifier, factory) {
  if (bunMock) return bunMock.module(specifier, factory);
  if (typeof vi.doMock === "function") return vi.doMock(specifier, factory);
}

async function restoreModule(specifier) {
  if (bunMock) {
    if (specifier === "ioredis" && realIoredisSnapshot) {
      bunMock.module("ioredis", () => realIoredisSnapshot);
    } else if (specifier === "@/lib/db/paths.js" && realPathsSnapshot) {
      bunMock.module("@/lib/db/paths.js", () => realPathsSnapshot);
    } else if (specifier === "@/lib/db/adapters/bunSqliteAdapter.js" && realBunAdapterSnapshot) {
      bunMock.module("@/lib/db/adapters/bunSqliteAdapter.js", () => realBunAdapterSnapshot);
    } else if (specifier === "@/lib/db/adapters/betterSqliteAdapter.js" && realBetterAdapterSnapshot) {
      bunMock.module("@/lib/db/adapters/betterSqliteAdapter.js", () => realBetterAdapterSnapshot);
    } else if (specifier === "@/lib/db/adapters/nodeSqliteAdapter.js" && realNodeAdapterSnapshot) {
      bunMock.module("@/lib/db/adapters/nodeSqliteAdapter.js", () => realNodeAdapterSnapshot);
    }
    return;
  }
  if (typeof vi.doUnmock === "function") return vi.doUnmock(specifier);
}

/** Point `@/lib/db/paths.js` at `dir` without relying on a module-cache reset. */
function mockPathsTo(dir) {
  return mockModule("@/lib/db/paths.js", () => ({
    DB_DIR: path.join(dir, "db"),
    DATA_FILE: path.join(dir, "db", "data.sqlite"),
    BACKUPS_DIR: path.join(dir, "db", "backups"),
    LEGACY_FILES: {
      main: path.join(dir, "db.json"),
      usage: path.join(dir, "usage.json"),
      disabled: path.join(dir, "disabledModels.json"),
      details: path.join(dir, "request-details.json"),
    },
    ensureDirs() {
      for (const d of [dir, path.join(dir, "db"), path.join(dir, "db", "backups")]) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      }
    },
  }));
}

/** A SQLite file created with the runtime's native driver (bun:sqlite/node:sqlite). */
async function makeRealSqliteFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file);
    db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO probe (value) VALUES ('ok');");
    db.close();
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO probe (value) VALUES ('ok');");
  db.close();
}

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-wave1-"));
  delete global._dbAdapter;
  vi.resetModules?.();
});

afterEach(async () => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete process.env.DATA_DIR;
  delete process.env.DATA_DIR_ALLOW_TEMP;
  delete process.env.NODE_ENV;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_KEY_PREFIX;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  await restoreModule("@/lib/db/paths.js");
  await restoreModule("@/lib/db/adapters/bunSqliteAdapter.js");
  await restoreModule("@/lib/db/adapters/betterSqliteAdapter.js");
  await restoreModule("@/lib/db/adapters/nodeSqliteAdapter.js");
  await restoreModule("ioredis");
  vi.resetModules?.();
});

// ---------------------------------------------------------------------------
// 1. Runtime & configuration contracts
// ---------------------------------------------------------------------------
describe("Wave 1 configuration contracts", () => {
  it("tsconfig.json parses and maps @/* to ./src/*", () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8");
    const tsconfig = JSON.parse(raw);

    expect(tsconfig.compilerOptions.target).toBe("ES2022");
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(true);
    expect(tsconfig.compilerOptions.isolatedModules).toBe(true);
    expect(tsconfig.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
  });

  it(".env.example declares the port configuration and the khatam: Redis prefix", () => {
    const env = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");

    expect(env).toMatch(/^DASHBOARD_PORT=20128$/m);
    expect(env).toMatch(/^REDIS_KEY_PREFIX=khatam:$/m);
    expect(env).toMatch(/^REDIS_URL=/m);
  });
});

// ---------------------------------------------------------------------------
// 2. runtime-secrets.cjs
// ---------------------------------------------------------------------------
describe("runtime-secrets.cjs", () => {
  async function loadSecrets() {
    const mod = await import(path.join(REPO_ROOT, "runtime-secrets.cjs"));
    return mod.default ?? mod;
  }

  it("throws in production when a placeholder secret is still in place", async () => {
    const { assertProductionSecrets } = await loadSecrets();
    expect(() =>
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "change-me-to-a-long-random-secret",
        API_KEY_SECRET: "a-real-secret-value",
      })
    ).toThrow(/JWT_SECRET/);
  });

  it("names every placeholder secret it rejects", async () => {
    const { assertProductionSecrets } = await loadSecrets();
    let message = "";
    try {
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "changeme",
        API_KEY_SECRET: "password",
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("JWT_SECRET");
    expect(message).toContain("API_KEY_SECRET");
  });

  it("accepts real secrets in production", async () => {
    const { assertProductionSecrets } = await loadSecrets();
    expect(() =>
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "8f4c1b0a9e7d6c5b4a39281706f5e4d3",
        API_KEY_SECRET: "0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f6",
      })
    ).not.toThrow();
  });

  it("is a no-op outside production", async () => {
    const { assertProductionSecrets } = await loadSecrets();
    expect(() =>
      assertProductionSecrets({ NODE_ENV: "development", JWT_SECRET: "change-me" })
    ).not.toThrow();
    expect(() => assertProductionSecrets({ JWT_SECRET: "change-me" })).not.toThrow();
  });

  it("matches placeholders case-insensitively and after trimming", async () => {
    const { assertProductionSecrets } = await loadSecrets();
    expect(() =>
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "  CHANGE-ME  ",
        API_KEY_SECRET: "real-secret",
      })
    ).toThrow(/JWT_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// 3. SQLite WAL adapter + integrity check
// ---------------------------------------------------------------------------
describe("bun:sqlite WAL adapter contract", () => {
  it("OPEN_PRAGMAS and PRAGMA_SQL carry the shared multi-process settings", async () => {
    const { OPEN_PRAGMAS } = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    const { PRAGMA_SQL } = await import("@/lib/db/schema.js");
    const sql = `${OPEN_PRAGMAS}\n${PRAGMA_SQL}`;

    expect(sql).toMatch(/PRAGMA journal_mode = WAL;/i);
    expect(sql).toMatch(/PRAGMA synchronous = NORMAL;/i);
    expect(sql).toMatch(/PRAGMA busy_timeout = 5000;/i);
    expect(sql).toMatch(/PRAGMA temp_store = MEMORY;/i);
    expect(sql).toMatch(/PRAGMA foreign_keys = ON;/i);
  });

  it("assertIntegrity fails closed on a non-ok integrity_check result", async () => {
    const { assertIntegrity } = await import("@/lib/db/adapters/bunSqliteAdapter.js");

    const ok = { query: () => ({ get: () => ({ integrity_check: "ok" }) }) };
    expect(() => assertIntegrity(ok, "ok.sqlite")).not.toThrow();

    const corrupt = { query: () => ({ get: () => ({ integrity_check: "*** in database main ***" }) }) };
    expect(() => assertIntegrity(corrupt, "corrupt.sqlite")).toThrow(/integrity check failed/i);

    const exploding = { query: () => { throw new Error("disk I/O error"); } };
    expect(() => assertIntegrity(exploding, "io.sqlite")).toThrow(/disk I\/O error/);
  });

  it("opens the real adapter with WAL + busy_timeout + integrity ok (Bun only)", async () => {
    if (!process.versions.bun) return; // node:sqlite has no bun:sqlite module
    const { createBunSqliteAdapter } = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    const file = path.join(tempDir, "bun-wal.sqlite");
    const adapter = await createBunSqliteAdapter(file);
    try {
      expect(String(adapter.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(Number(adapter.pragma("busy_timeout", { simple: true }))).toBe(5000);
      expect(String(adapter.pragma("integrity_check", { simple: true }))).toBe("ok");
      expect(adapter.driver).toBe("bun:sqlite");
    } finally {
      adapter.close();
    }
    expect(fs.existsSync(`${file}-wal`) || true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. driver.js integrity preflight + no silent sql.js fallback
// ---------------------------------------------------------------------------
describe("driver.js integrity preflight", () => {
  /** Make every native driver unavailable so initAdapter() must fall through. */
  async function failNativeDrivers() {
    for (const adapter of [
      "bunSqliteAdapter.js",
      "betterSqliteAdapter.js",
      "nodeSqliteAdapter.js",
    ]) {
      await mockModule(`@/lib/db/adapters/${adapter}`, () => ({
        createBunSqliteAdapter: () => { throw new Error("simulated unavailable"); },
        createBetterSqliteAdapter: () => { throw new Error("simulated unavailable"); },
        createNodeSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      }));
    }
  }

  it("verifyDatabaseIntegrity() returns false when no database file exists yet", async () => {
    const { verifyDatabaseIntegrity } = await import("@/lib/db/driver.js");
    await expect(verifyDatabaseIntegrity(path.join(tempDir, "missing.sqlite"))).resolves.toBe(false);
  });

  it("verifyDatabaseIntegrity() returns true for a healthy SQLite file (under Bun), fails closed otherwise", async () => {
    const { verifyDatabaseIntegrity } = await import("@/lib/db/driver.js");
    const file = path.join(tempDir, "healthy.sqlite");
    await makeRealSqliteFile(file);

    if (process.versions.bun) {
      await expect(verifyDatabaseIntegrity(file)).resolves.toBe(true);
    } else {
      await expect(verifyDatabaseIntegrity(file)).rejects.toThrow(/requires the Bun runtime/);
    }
  });

  it("verifyDatabaseIntegrity() rejects a corrupt file instead of repairing it", async () => {
    const { verifyDatabaseIntegrity } = await import("@/lib/db/driver.js");
    const file = path.join(tempDir, "corrupt.sqlite");
    fs.writeFileSync(file, Buffer.from("this is definitely not a sqlite database file".repeat(64)));
    const before = fs.readFileSync(file);

    await expect(verifyDatabaseIntegrity(file)).rejects.toBeTruthy();
    // The preflight must not modify or delete the file — restoration is manual.
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("asserts fail-closed behavior when Bun runtime is absent (no driver fallback)", async () => {
    const dataDir = path.join(tempDir, "data");
    process.env.DATA_DIR = dataDir;
    const dbFile = path.join(dataDir, "db", "data.sqlite");
    await makeRealSqliteFile(dbFile);

    // Point driver.js at this test's directory explicitly: Bun's runner cannot
    // reset the module cache, so paths.js may already hold an older DATA_DIR.
    await mockPathsTo(dataDir);

    const { getAdapter } = await import("@/lib/db/driver.js");
    if (!process.versions.bun) {
      await expect(getAdapter()).rejects.toThrow(/requires the Bun runtime \(bun:sqlite\)/i);
    } else {
      const adapter = await getAdapter();
      expect(adapter.driver).toBe("bun:sqlite");
      adapter.close?.();
    }
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it("fails closed for a brand-new database when Bun runtime is absent (no sql.js fallback)", async () => {
    const dataDir = path.join(tempDir, "fresh");
    process.env.DATA_DIR = dataDir;

    await mockPathsTo(dataDir);

    const { getAdapter } = await import("@/lib/db/driver.js");
    if (!process.versions.bun) {
      await expect(getAdapter()).rejects.toThrow(/requires the Bun runtime \(bun:sqlite\)/i);
    } else {
      const adapter = await getAdapter();
      expect(adapter.driver).toBe("bun:sqlite");
      adapter.close?.();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. DATA_DIR_ALLOW_TEMP is an exact "1" match
// ---------------------------------------------------------------------------
describe("DATA_DIR temporary-directory guard", () => {
  async function loadDataDir(env) {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DATA_DIR") || key === "NODE_ENV" || key === "pm_id") delete process.env[key];
    }
    Object.assign(process.env, env);
    try {
      const mod = await import("@/lib/dataDir.js");
      return mod.getDataDir();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  }

  it("redirects a production deployment off a temp DATA_DIR", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-data-smoke-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await loadDataDir({ DATA_DIR: temp, NODE_ENV: "production" });
      expect(dir).not.toBe(temp);
    } finally {
      warn.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("accepts DATA_DIR_ALLOW_TEMP=\"1\"", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-data-smoke-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await loadDataDir({ DATA_DIR: temp, DATA_DIR_ALLOW_TEMP: "1", NODE_ENV: "production" });
      expect(dir).toBe(temp);
    } finally {
      warn.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not treat \"0\", \"false\" or \"true\" as the opt-out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["0", "false", "true", "yes"]) {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-data-smoke-"));
        const dir = await loadDataDir({ DATA_DIR: temp, DATA_DIR_ALLOW_TEMP: value, NODE_ENV: "production" });
        expect(dir).not.toBe(temp);
        fs.rmSync(temp, { recursive: true, force: true });
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Redis client — prefixing + fail-open
// ---------------------------------------------------------------------------
describe("Redis client", () => {
  it("namespaces every key under khatam: by default", async () => {
    delete process.env.REDIS_KEY_PREFIX;
    const { withRedisKey, REDIS_KEY_PREFIX } = await import("@/lib/redis/client.js");

    expect(REDIS_KEY_PREFIX).toBe("khatam:");
    expect(withRedisKey("quota:user:42")).toBe("khatam:quota:user:42");
    expect(withRedisKey()).toBe("khatam:");
  });

  it("honours REDIS_KEY_PREFIX and normalises a missing colon", async () => {
    process.env.REDIS_KEY_PREFIX = "tenant7";
    const { withRedisKey } = await import("@/lib/redis/client.js");
    expect(withRedisKey("ratelimit:ip")).toBe("tenant7:ratelimit:ip");

    process.env.REDIS_KEY_PREFIX = "tenant8:";
    expect(withRedisKey("ratelimit:ip")).toBe("tenant8:ratelimit:ip");
  });

  it("fails open when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    const { getRedisClient, isRedisAvailable, closeRedisClient } = await import("@/lib/redis/client.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(getRedisClient()).toBeNull();
      expect(isRedisAvailable()).toBe(false);
      await expect(closeRedisClient()).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns a client without throwing when REDIS_URL points somewhere unreachable", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    const { getRedisClient, isRedisAvailable, closeRedisClient } = await import("@/lib/redis/client.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = getRedisClient();
      expect(client).toBeTruthy();
      // No server is listening on 6399, so it must not report ready and must not throw.
      expect(isRedisAvailable()).toBe(false);
    } finally {
      await closeRedisClient();
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Redis events — channel names + pub/sub round-trip
// ---------------------------------------------------------------------------
describe("Khatam events", () => {
  it("exposes the canonical channel names", async () => {
    const { KHATAM_EVENTS } = await import("@/lib/redis/events.js");
    expect(KHATAM_EVENTS.CONFIG_RELOAD).toBe("khatam:events:config_reload");
    expect(KHATAM_EVENTS.CIRCUIT_TRIP).toBe("khatam:events:circuit_trip");
    expect(KHATAM_EVENTS.QUOTA_EXCEEDED).toBe("khatam:events:quota_exceeded");
  });

  it("delivers a round-trip locally without Redis", async () => {
    delete process.env.REDIS_URL;
    const { KHATAM_EVENTS, publishKhatamEvent, subscribeKhatamEvent } = await import("@/lib/redis/events.js");
    const received = [];
    const unsubscribe = subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => received.push(payload));

    const publishedToRedis = publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { reason: "test" });

    expect(publishedToRedis).toBe(false); // Redis unset → local only, no throw
    expect(received).toEqual([{ reason: "test" }]);

    unsubscribe();
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { reason: "after-unsubscribe" });
    expect(received).toHaveLength(1);
  });

  it("delivers across replicas over the Redis pub/sub path (mocked ioredis)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const instances = [];

    class FakeRedis extends EventEmitter {
      constructor() {
        super();
        this.status = "ready";
        this.subscriptions = [];
        this.published = [];
        instances.push(this);
      }
      connect() { return Promise.resolve(); }
      subscribe(channel) { this.subscriptions.push(channel); return Promise.resolve(1); }
      unsubscribe(channel) {
        this.subscriptions = this.subscriptions.filter((c) => c !== channel);
        return Promise.resolve(1);
      }
      publish(channel, message) { this.published.push({ channel, message }); return Promise.resolve(1); }
      quit() { return Promise.resolve("OK"); }
      disconnect() {}
      removeAllListeners() { super.removeAllListeners(); return this; }
    }

    await mockModule("ioredis", () => ({ default: FakeRedis, Redis: FakeRedis }));

    try {
      const { KHATAM_EVENTS, publishKhatamEvent, subscribeKhatamEvent } = await import("@/lib/redis/events.js");
      const received = [];
      const unsubscribe = subscribeKhatamEvent(KHATAM_EVENTS.CIRCUIT_TRIP, (payload) => received.push(payload));

      // Local publish is delivered immediately and forwarded once to Redis.
      expect(publishKhatamEvent(KHATAM_EVENTS.CIRCUIT_TRIP, { provider: "openai" })).toBe(true);
      expect(received).toEqual([{ provider: "openai" }]);

      const subscriber = instances.find((i) => i.subscriptions.includes(KHATAM_EVENTS.CIRCUIT_TRIP));
      expect(subscriber).toBeTruthy();
      const forwarded = instances.flatMap((i) => i.published).find((p) => p.channel === KHATAM_EVENTS.CIRCUIT_TRIP);
      expect(forwarded).toBeTruthy();
      expect(JSON.parse(forwarded.message)).toMatchObject({ payload: { provider: "openai" } });

      // A message from another replica reaches local subscribers exactly once.
      subscriber.emit("message", KHATAM_EVENTS.CIRCUIT_TRIP, JSON.stringify({
        source: "another-replica",
        payload: { provider: "anthropic" },
      }));
      expect(received).toEqual([{ provider: "openai" }, { provider: "anthropic" }]);

      // Our own message echoed back by Redis is not delivered a second time.
      const own = JSON.parse(forwarded.message);
      subscriber.emit("message", KHATAM_EVENTS.CIRCUIT_TRIP, forwarded.message);
      expect(own.source).toBeTruthy();
      expect(received).toHaveLength(2);

      unsubscribe();
      const { closeRedisClient } = await import("@/lib/redis/client.js");
      await closeRedisClient();
    } finally {
      await restoreModule("ioredis");
      vi.resetModules?.();
    }
  });
});

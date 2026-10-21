// Wave 2 — Leaf B: hybrid Redis/SQLite sliding-window quota store + settings TTL cache.
//
// Covers:
// 1. RedisQuotaStore two-bucket weighted sliding-window math (INCRBYFLOAT path + Lua path)
// 2. Fail-open contract: no REDIS_URL, and Redis throwing → { allowed: true, degraded: true }
// 3. Key security: khatam:quota: namespace, SHA-256 hashed keys, no cleartext secret
// 4. SQLite fallback over api_key_quota_counters (temp DB table created by this suite —
//    Leaf A owns the migration; if the migration lands first, IF NOT EXISTS keeps this safe)
// 5. settingsRepo 5000ms TTL cache: hit, miss, invalidate, revision bump visibility

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WINDOW_MS = 60_000;
// A fixed clock 15s into a bucket: bucket start + 15s ⇒ previous-bucket weight 0.75.
const NOW = 1_699_999_980_000 + 15_000;
const BUCKET = Math.floor(NOW / WINDOW_MS);
const PREV_BUCKET = BUCKET - 1;
const ELAPSED = NOW - BUCKET * WINDOW_MS; // 15000
const WEIGHT_PREV = (WINDOW_MS - ELAPSED) / WINDOW_MS; // 0.75

// ---------------------------------------------------------------------------
// Fake ioredis command surface (no `eval`, so the INCRBYFLOAT path runs)
// ---------------------------------------------------------------------------
class FakeRedis {
  constructor({ failOn = [] } = {}) {
    this.store = new Map();
    this.expires = new Map();
    this.failOn = new Set(failOn);
  }
  async get(k) {
    if (this.failOn.has("get")) throw new Error("ECONNREFUSED");
    return this.store.has(k) ? this.store.get(k) : null;
  }
  async incrbyfloat(k, amount) {
    if (this.failOn.has("incrbyfloat")) throw new Error("ECONNREFUSED");
    const next = (parseFloat(this.store.get(k) || "0") || 0) + Number(amount);
    this.store.set(k, String(next));
    return String(next);
  }
  async expire(k, ttl) {
    if (this.failOn.has("expire")) throw new Error("ECONNREFUSED");
    this.expires.set(k, ttl);
    return 1;
  }
}

function quotaKeys(client) {
  return [...client.store.keys()];
}

function keyFor(hash, counterType, bucket) {
  return `khatam:quota:${hash}:${counterType}:${bucket}`;
}

describe("RedisQuotaStore — two-bucket sliding window math", () => {
  let store;
  let client;

  beforeEach(async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const { RedisQuotaStore, resetRedisQuotaWarning } = await import("@/lib/quota/redisQuotaStore.js");
    resetRedisQuotaWarning();
    client = new FakeRedis();
    store = new RedisQuotaStore({ client });
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it("weights the previous bucket by the fraction of the window still inside it", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("test-key");

    // 100 requests landed in the previous bucket; 0 so far in the current one.
    client.store.set(keyFor(hash, "default", PREV_BUCKET), "100");

    // Estimated usage before consuming = 100 * 0.75 = 75.
    const res = await store.consume({
      key: "test-key",
      limit: 100,
      windowMs: WINDOW_MS,
      amount: 10,
      now: NOW,
    });

    expect(WEIGHT_PREV).toBe(0.75);
    expect(res.allowed).toBe(true);
    expect(res.current).toBeCloseTo(85, 10);
    expect(res.remaining).toBeCloseTo(15, 10);
    expect(res.limit).toBe(100);
    expect(res.resetAtMs).toBe((BUCKET + 1) * WINDOW_MS);
    expect(res.resetMs).toBe(45_000);
    expect(res.degraded).toBeUndefined();

    // Current bucket was atomically incremented by exactly `amount`.
    expect(parseFloat(client.store.get(keyFor(hash, "default", BUCKET)))).toBeCloseTo(10, 10);
    // Previous bucket untouched.
    expect(parseFloat(client.store.get(keyFor(hash, "default", PREV_BUCKET)))).toBeCloseTo(100, 10);
  });

  it("sets a TTL of at least 2x the window on the incremented bucket", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("ttl-key");
    await store.consume({ key: "ttl-key", limit: 10, windowMs: WINDOW_MS, amount: 1, now: NOW });
    const ttl = client.expires.get(keyFor(hash, "default", BUCKET));
    expect(ttl).toBeGreaterThanOrEqual((2 * WINDOW_MS) / 1000);
  });

  it("rejects without incrementing when the weighted estimate would exceed the limit", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("reject-key");
    client.store.set(keyFor(hash, "default", PREV_BUCKET), "100");

    const res = await store.consume({
      key: "reject-key",
      limit: 100,
      windowMs: WINDOW_MS,
      amount: 30, // 75 + 30 = 105 > 100
      now: NOW,
    });

    expect(res.allowed).toBe(false);
    expect(res.current).toBeCloseTo(75, 10);
    expect(res.remaining).toBeCloseTo(25, 10);
    // Nothing was written for the current bucket.
    expect(client.store.get(keyFor(hash, "default", BUCKET))).toBeUndefined();
  });

  it("decays the previous bucket fully once a whole window has passed", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("decay-key");
    // Everything sits two buckets back → contributes nothing to this window.
    client.store.set(keyFor(hash, "default", BUCKET - 2), "1000");

    const res = await store.consume({
      key: "decay-key",
      limit: 10,
      windowMs: WINDOW_MS,
      amount: 1,
      now: NOW,
    });

    expect(res.allowed).toBe(true);
    expect(res.current).toBeCloseTo(1, 10);
  });

  it("defaults amount to 1 and window to 60s", async () => {
    const res = await store.consume({ key: "defaults-key", limit: 5, now: NOW });
    expect(res.allowed).toBe(true);
    expect(res.current).toBeCloseTo(1, 10);
    expect(res.limit).toBe(5);
    expect(res.remaining).toBeCloseTo(4, 10);
  });

  it("peek reads both buckets without incrementing", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("peek-key");
    client.store.set(keyFor(hash, "default", PREV_BUCKET), "40");
    client.store.set(keyFor(hash, "default", BUCKET), "10");

    const res = await store.peek({ key: "peek-key", limit: 100, windowMs: WINDOW_MS, now: NOW });

    // 40*0.75 + 10 = 40
    expect(res.current).toBeCloseTo(40, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBeCloseTo(60, 10);
    // No writes at all.
    expect(parseFloat(client.store.get(keyFor(hash, "default", BUCKET)))).toBeCloseTo(10, 10);
    expect(parseFloat(client.store.get(keyFor(hash, "default", PREV_BUCKET)))).toBeCloseTo(40, 10);
  });

  it("peek reports not-allowed once the estimate is at the limit", async () => {
    const { hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const hash = hashQuotaKey("peek-full");
    client.store.set(keyFor(hash, "default", BUCKET), "100");
    const res = await store.peek({ key: "peek-full", limit: 100, windowMs: WINDOW_MS, now: NOW });
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
  });

  it("parses the atomic Lua (eval) path result", async () => {
    const { RedisQuotaStore } = await import("@/lib/quota/redisQuotaStore.js");
    const evalClient = {
      eval: vi.fn(async () => [1, "7", "0", "7"]),
    };
    const s = new RedisQuotaStore({ client: evalClient });
    const res = await s.consume({ key: "lua-key", limit: 10, windowMs: WINDOW_MS, amount: 7, now: NOW });

    expect(evalClient.eval).toHaveBeenCalledTimes(1);
    // eval(script, numkeys, key1, key2, amount, limit, weightPrev, ttlSec)
    const args = evalClient.eval.mock.calls[0];
    expect(args[1]).toBe(2);
    expect(args[2]).toMatch(/^khatam:quota:[a-f0-9]{64}:default:\d+$/);
    expect(args[3]).toMatch(/^khatam:quota:[a-f0-9]{64}:default:\d+$/);
    expect(res.allowed).toBe(true);
    expect(res.current).toBeCloseTo(7, 10);
    expect(res.remaining).toBeCloseTo(3, 10);
  });

  it("falls back to INCRBYFLOAT when eval is unsupported", async () => {
    const evalClient = {
      eval: vi.fn(async () => {
        throw new Error("ERR unknown command 'eval'");
      }),
      get: vi.fn(async () => null),
      incrbyfloat: vi.fn(async () => "1"),
      expire: vi.fn(async () => 1),
    };
    const { RedisQuotaStore } = await import("@/lib/quota/redisQuotaStore.js");
    const res = await new RedisQuotaStore({ client: evalClient }).consume({
      key: "fallback-key",
      limit: 5,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(res.allowed).toBe(true);
    expect(evalClient.incrbyfloat).toHaveBeenCalledTimes(1);
  });
});

describe("RedisQuotaStore — fail-open contract", () => {
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.restoreAllMocks();
  });

  it("returns degraded success when REDIS_URL is unset (never throws)", async () => {
    delete process.env.REDIS_URL;
    const { RedisQuotaStore } = await import("@/lib/quota/redisQuotaStore.js");
    const store = new RedisQuotaStore();

    const consumed = await store.consume({ key: "no-redis", limit: 10, windowMs: WINDOW_MS });
    expect(consumed).toMatchObject({ allowed: true, degraded: true, current: 0, limit: 10, remaining: 10 });
    expect(typeof consumed.resetAtMs).toBe("number");
    expect(typeof consumed.resetMs).toBe("number");

    const peeked = await store.peek({ key: "no-redis", limit: 10, windowMs: WINDOW_MS });
    expect(peeked).toMatchObject({ allowed: true, degraded: true, remaining: 10 });
  });

  it("fails open (and warns once) when Redis commands throw", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { RedisQuotaStore, resetRedisQuotaWarning } = await import("@/lib/quota/redisQuotaStore.js");
    resetRedisQuotaWarning();
    const store = new RedisQuotaStore({ client: new FakeRedis({ failOn: ["get"] }) });

    const first = await store.consume({ key: "boom", limit: 10, windowMs: WINDOW_MS });
    const second = await store.consume({ key: "boom", limit: 10, windowMs: WINDOW_MS });
    const peeked = await store.peek({ key: "boom", limit: 10, windowMs: WINDOW_MS });

    expect(first).toMatchObject({ allowed: true, degraded: true, remaining: 10 });
    expect(second).toMatchObject({ allowed: true, degraded: true, remaining: 10 });
    expect(peeked).toMatchObject({ allowed: true, degraded: true, remaining: 10 });

    // Single non-fatal warning across all failures.
    const quotaWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("[quota:redis]"));
    expect(quotaWarnings).toHaveLength(1);
    // And it never leaks an API key into the log line.
    expect(quotaWarnings[0].join(" ")).not.toContain("sk-live");
  });

  it("fails open when INCRBYFLOAT itself throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { RedisQuotaStore, resetRedisQuotaWarning } = await import("@/lib/quota/redisQuotaStore.js");
    resetRedisQuotaWarning();
    const store = new RedisQuotaStore({ client: new FakeRedis({ failOn: ["incrbyfloat"] }) });
    const res = await store.consume({ key: "boom2", limit: 10, windowMs: WINDOW_MS, now: NOW });
    expect(res).toMatchObject({ allowed: true, degraded: true });
    warn.mockRestore();
  });
});

describe("RedisQuotaStore — key namespacing and secret hygiene", () => {
  it("namespaces every key under khatam:quota: and never embeds the raw API key", async () => {
    const client = new FakeRedis();
    const { RedisQuotaStore, hashQuotaKey } = await import("@/lib/quota/redisQuotaStore.js");
    const store = new RedisQuotaStore({ client });
    const rawKey = "sk-live-super-secret-api-key-1234567890";

    for (let i = 0; i < 3; i++) {
      await store.consume({ key: rawKey, limit: 100, windowMs: WINDOW_MS, amount: 1, now: NOW });
    }
    await store.peek({ key: rawKey, limit: 100, windowMs: WINDOW_MS, now: NOW });

    const keys = quotaKeys(client);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith("khatam:quota:")).toBe(true);
      expect(k).not.toContain(rawKey);
      expect(k).not.toContain("sk-live");
    }

    const hash = hashQuotaKey(rawKey);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashQuotaKey(rawKey)); // deterministic
    expect(hash).not.toBe(hashQuotaKey("another-key"));
    expect(keys.some((k) => k.includes(hash))).toBe(true);
  });

  it("separates counter types and hashes different keys differently", async () => {
    const client = new FakeRedis();
    const { RedisQuotaStore } = await import("@/lib/quota/redisQuotaStore.js");
    const store = new RedisQuotaStore({ client });
    await store.consume({ key: "key-a", counterType: "requests", limit: 10, windowMs: WINDOW_MS, now: NOW });
    await store.consume({ key: "key-a", counterType: "tokens", limit: 10, windowMs: WINDOW_MS, now: NOW });
    await store.consume({ key: "key-b", counterType: "requests", limit: 10, windowMs: WINDOW_MS, now: NOW });

    expect(quotaKeys(client)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SQLite fallback over api_key_quota_counters
// ---------------------------------------------------------------------------
const COUNTERS_DDL = `
CREATE TABLE IF NOT EXISTS api_key_quota_counters (
  key TEXT NOT NULL,
  window_bucket INTEGER NOT NULL,
  counter_type TEXT NOT NULL,
  value REAL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_bucket, counter_type)
);
CREATE INDEX IF NOT EXISTS idx_akqc_updated ON api_key_quota_counters(updated_at);
`;

describe("SqliteQuotaStore — fallback over api_key_quota_counters", () => {
  let tempDir;
  let originalDataDir;
  let db;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kw2q-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter } = await import("@/lib/db/driver.js");
    db = await getAdapter();
    // Leaf A owns this table in migration 002. Until it exists in this worktree the
    // suite creates the same schema in its own temp DB so the fallback path is real.
    db.exec(COUNTERS_DDL);
  });

  afterEach(() => {
    try { db?.close?.(); } catch {}
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
  });

  it("uses the same two-bucket weighted math as Redis", async () => {
    const { SqliteQuotaStore, hashQuotaKey } = await import("@/lib/quota/sqliteQuotaStore.js");
    const hash = hashQuotaKey("sqlite-key");
    db.run(
      `INSERT INTO api_key_quota_counters (key, window_bucket, counter_type, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [hash, PREV_BUCKET, "default", 100, NOW]
    );

    const store = new SqliteQuotaStore();
    const res = await store.consume({ key: "sqlite-key", limit: 100, windowMs: WINDOW_MS, amount: 10, now: NOW });

    expect(res.allowed).toBe(true);
    expect(res.current).toBeCloseTo(85, 10);
    expect(res.remaining).toBeCloseTo(15, 10);
    expect(res.degraded).toBeUndefined();

    const row = db.get(
      `SELECT value FROM api_key_quota_counters WHERE key = ? AND window_bucket = ? AND counter_type = 'default'`,
      [hash, BUCKET]
    );
    expect(Number(row.value)).toBeCloseTo(10, 10);
  });

  it("accumulates repeated consumes in the same bucket", async () => {
    const { SqliteQuotaStore } = await import("@/lib/quota/sqliteQuotaStore.js");
    const store = new SqliteQuotaStore();
    let last;
    for (let i = 0; i < 3; i++) {
      last = await store.consume({ key: "acc-key", limit: 10, windowMs: WINDOW_MS, amount: 2, now: NOW });
    }
    expect(last.allowed).toBe(true);
    expect(last.current).toBeCloseTo(6, 10);
    expect(last.remaining).toBeCloseTo(4, 10);
  });

  it("rejects at the limit and leaves the counter unchanged", async () => {
    const { SqliteQuotaStore, hashQuotaKey } = await import("@/lib/quota/sqliteQuotaStore.js");
    const hash = hashQuotaKey("full-key");
    db.run(
      `INSERT INTO api_key_quota_counters (key, window_bucket, counter_type, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [hash, BUCKET, "default", 9, NOW]
    );

    const res = await new SqliteQuotaStore().consume({
      key: "full-key", limit: 10, windowMs: WINDOW_MS, amount: 5, now: NOW,
    });
    expect(res.allowed).toBe(false);
    expect(res.current).toBeCloseTo(9, 10);
    expect(res.remaining).toBeCloseTo(1, 10);

    const row = db.get(
      `SELECT value FROM api_key_quota_counters WHERE key = ? AND window_bucket = ?`,
      [hash, BUCKET]
    );
    expect(Number(row.value)).toBeCloseTo(9, 10);
  });

  it("peek does not write", async () => {
    const { SqliteQuotaStore } = await import("@/lib/quota/sqliteQuotaStore.js");
    const store = new SqliteQuotaStore();
    await store.consume({ key: "peek-sql", limit: 10, windowMs: WINDOW_MS, amount: 4, now: NOW });
    const res = await store.peek({ key: "peek-sql", limit: 10, windowMs: WINDOW_MS, now: NOW });
    expect(res.current).toBeCloseTo(4, 10);
    expect(res.remaining).toBeCloseTo(6, 10);
  });

  it("stores only the SHA-256 hash, never the raw API key", async () => {
    const { SqliteQuotaStore, hashQuotaKey } = await import("@/lib/quota/sqliteQuotaStore.js");
    const rawKey = "sk-live-super-secret-api-key-1234567890";
    await new SqliteQuotaStore().consume({ key: rawKey, limit: 10, windowMs: WINDOW_MS, now: NOW });

    const rows = db.all(`SELECT key FROM api_key_quota_counters`);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(hashQuotaKey(rawKey));
    expect(rows[0].key).not.toContain("sk-live");
  });

  it("fails open when the counters table is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { SqliteQuotaStore, resetSqliteQuotaWarning } = await import("@/lib/quota/sqliteQuotaStore.js");
    resetSqliteQuotaWarning();
    db.exec(`DROP TABLE api_key_quota_counters`);

    const store = new SqliteQuotaStore();
    const consumed = await store.consume({ key: "missing-table", limit: 10, windowMs: WINDOW_MS, now: NOW });
    const peeked = await store.peek({ key: "missing-table", limit: 10, windowMs: WINDOW_MS, now: NOW });

    expect(consumed).toMatchObject({ allowed: true, degraded: true, remaining: 10 });
    expect(peeked).toMatchObject({ allowed: true, degraded: true, remaining: 10 });

    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("[quota:sqlite]"));
    expect(warnings).toHaveLength(1);
  });
});

describe("storeFactory — Redis vs SQLite selection", () => {
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.resetModules();
  });

  it("returns a SQLite store when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    vi.resetModules();
    const { storeFactory } = await import("@/lib/quota/storeFactory.js");
    const store = storeFactory();
    expect(store.driver).toBe("sqlite");
  });

  it("returns a Redis store when REDIS_URL is configured", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    vi.resetModules();
    const { storeFactory } = await import("@/lib/quota/storeFactory.js");
    const store = storeFactory();
    expect(store.driver).toBe("redis");
  });

  it("honours forceStore for deterministic call sites", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    vi.resetModules();
    const { storeFactory } = await import("@/lib/quota/storeFactory.js");
    expect(storeFactory({ forceStore: "sqlite" }).driver).toBe("sqlite");
    expect(storeFactory({ forceStore: "redis" }).driver).toBe("redis");
  });

  it("memoises the default store and can be reset", async () => {
    delete process.env.REDIS_URL;
    vi.resetModules();
    const { getQuotaStore, resetDefaultQuotaStore } = await import("@/lib/quota/storeFactory.js");
    const a = getQuotaStore();
    expect(getQuotaStore()).toBe(a);
    resetDefaultQuotaStore();
    expect(getQuotaStore()).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// settingsRepo — 5s TTL cache, revision tracking, invalidation
// ---------------------------------------------------------------------------
describe("settingsRepo — 5s TTL in-memory cache keyed by settings_revision", () => {
  let tempDir;
  let originalDataDir;
  let db;
  let repo;

  async function loadRepo() {
    vi.resetModules();
    delete global._dbAdapter;
    const { getAdapter } = await import("@/lib/db/driver.js");
    db = await getAdapter();
    repo = await import("@/lib/db/repos/settingsRepo.js");
    return repo;
  }

  function readRevision() {
    const row = db.get(`SELECT value FROM _meta WHERE key = 'settings_revision'`);
    return row ? String(row.value) : null;
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kw2q-settings-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    await loadRepo();
  });

  afterEach(() => {
    try { db?.close?.(); } catch {}
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
  });

  it("exposes the same merged shape callers expect", async () => {
    const settings = await repo.getSettings();
    // Shape contract used across auth, proxy and dashboard code paths.
    expect(settings.requireLogin).toBe(true);
    expect(settings.requireApiKey).toBe(true);
    expect(settings.authMode).toBe("password");
    expect(settings.cloudEnabled).toBe(false);
    expect(settings.capacityAdapter.vision.enabled).toBe(true);
    expect(settings.providerOverrides).toEqual({});
    expect(settings.mitmRouterBaseUrl).toBe("http://localhost:20128");
    expect(typeof settings.stickyRoundRobinLimit).toBe("number");
  });

  it("serves a cache hit inside the TTL (no second SQLite read)", async () => {
    await repo.getSettings();

    // Write behind the repository's back: a cached read must not see this yet.
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ requireLogin: false })]);

    const cached = await repo.getSettings();
    expect(cached.requireLogin).toBe(true);
  });

  it("re-reads after the 5s TTL expires", async () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await repo.getSettings();

      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [JSON.stringify({ requireLogin: false })]);

      // Still inside the TTL.
      nowSpy.mockReturnValue(base + 4000);
      expect((await repo.getSettings()).requireLogin).toBe(true);

      // TTL expired.
      nowSpy.mockReturnValue(base + 5001);
      expect((await repo.getSettings()).requireLogin).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("invalidateSettingsCache() forces an immediate fresh read", async () => {
    await repo.getSettings();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ requireLogin: false })]);

    expect((await repo.getSettings()).requireLogin).toBe(true);
    repo.invalidateSettingsCache();
    expect((await repo.getSettings()).requireLogin).toBe(false);
  });

  it("updateSettings() persists, bumps the revision and invalidates the cache", async () => {
    await repo.getSettings();
    const before = readRevision();

    const merged = await repo.updateSettings({ requireLogin: false });
    expect(merged.requireLogin).toBe(false);

    const after = readRevision();
    expect(after).not.toBe(before);
    expect(Number(after)).toBe((Number(before) || 0) + 1);

    // Cache was invalidated, so the next read is fresh without waiting 5s.
    expect((await repo.getSettings()).requireLogin).toBe(false);
  });

  it("bumpSettingsRevision() is visible to the next getSettings()", async () => {
    await repo.getSettings();
    const before = readRevision();

    const bumped = await repo.bumpSettingsRevision();
    expect(bumped).toBe((Number(before) || 0) + 1);
    expect(readRevision()).toBe(String(bumped));

    // Local cache dropped; the next read is fresh even though nothing changed.
    const snap = repo.getCachedSettingsSnapshot();
    expect(snap.data).toBeNull();
    await repo.getSettings();
    expect(repo.getCachedSettingsSnapshot().revision).toBe(String(bumped));
  });

  it("converges when another process bumps the revision during the TTL", async () => {
    // Prime the cache as process A.
    await repo.getSettings();

    // Process B (simulated) writes settings then bumps the revision in _meta.
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ requireLogin: false, authMode: "oidc" })]);
    const cur = Number(readRevision() || 0);
    db.run(
      `INSERT INTO _meta(key, value) VALUES('settings_revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(cur + 1)]
    );

    // TTL has elapsed but only the revision changed: the read refreshes.
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base + 5001);
    try {
      const settings = await repo.getSettings();
      expect(settings.requireLogin).toBe(false);
      expect(settings.authMode).toBe("oidc");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("records the current revision in the cache on a miss", async () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await repo.getSettings();
      const snap = repo.getCachedSettingsSnapshot();
      expect(snap.revision).toBe(readRevision());
      expect(snap.expiresAt).toBe(base + 5000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("seeds settings_revision on first read of a legacy database", async () => {
    expect(readRevision()).toBeNull();
    await repo.getSettings();
    expect(readRevision()).toBe("1");
  });

  it("keeps isCloudEnabled/getCloudUrl/exportSettings behaviour", async () => {
    expect(await repo.isCloudEnabled()).toBe(false);
    await repo.updateSettings({ cloudEnabled: true });
    expect(await repo.isCloudEnabled()).toBe(true);

    delete process.env.CLOUD_URL;
    delete process.env.NEXT_PUBLIC_CLOUD_URL;
    expect(await repo.getCloudUrl()).toBe("");
    process.env.CLOUD_URL = "https://cloud.example";
    expect(await repo.getCloudUrl()).toBe("https://cloud.example");
    delete process.env.CLOUD_URL;

    // exportSettings returns the raw row (not merged defaults), as before.
    const raw = await repo.exportSettings();
    expect(raw.cloudEnabled).toBe(true);
    expect(raw.requireLogin).toBeUndefined();
  });

  it("publishes CONFIG_RELOAD so other replicas invalidate", async () => {
    const { KHATAM_EVENTS, subscribeKhatamEvent } = await import("@/lib/redis/events.js");
    const seen = [];
    const unsubscribe = subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => seen.push(payload));
    try {
      await repo.updateSettings({ requireLogin: false });
      const settingsEvents = seen.filter((e) => e && e.scope === "settings");
      expect(settingsEvents.length).toBeGreaterThanOrEqual(1);
      expect(typeof settingsEvents[0].revision).toBe("number");
    } finally {
      unsubscribe();
    }
  });
});

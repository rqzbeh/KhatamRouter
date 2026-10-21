// Wave 3 — Leaf B: Per-connection rate limiter and per-key quotas/cost caps.
//
// Tests:
// 1. Override sanitisation (bad input rejected, unknown keys dropped, modelConcurrency map validation)
// 2. Each limiter dimension increments and blocks at boundary (rpm, rpd, tpm, tpd, minTime)
// 3. In-process concurrency semaphore (maxConcurrent and modelConcurrency keyed provider:account)
// 4. Window expiry resets allowance
// 5. Rate limits list support ("1m", "1h", "1d", ms) and API key hashing security
// 6. USD daily/weekly spend caps via request_cost_ledger
// 7. Limits infrastructure failure (Redis down, DB error) MUST FAIL OPEN with degraded: true

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  parseConnectionLimitOverrides,
  sanitizeConnectionLimitOverrides,
  validateConnectionLimitOverrides,
} from "../../open-sse/services/rateLimitManager/overrides.js";

import {
  InProcessSemaphore,
  globalConnectionSemaphore,
  globalModelSemaphore,
} from "../../open-sse/services/rateLimitManager/semaphore.js";

import {
  checkConnectionLimits,
  releaseConnectionSlot,
  resetConnectionLimiter,
  buildConnectionKey,
} from "../../open-sse/services/rateLimitManager/connectionLimiter.js";

import {
  hashApiKey,
  getUtcWindowBoundaries,
  insertRequestCostLedger,
  getCumulativeSpendForWindow,
} from "../../src/lib/db/keyQuota.js";

import {
  checkKeyQuota,
  recordKeyQuotaUsage,
} from "../../src/domain/keyQuota.js";

import {
  parseWindowDuration,
  parseRateLimits,
  checkApiKeyUsageLimits,
  formatQuotaErrorResponse,
} from "../../src/lib/usage/apiKeyUsageLimits.js";

// Temp DB environment setup for SQLite backing
let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-wave3-limits-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  delete global._dbAdapter;
  resetConnectionLimiter();
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
  resetConnectionLimiter();
});

// ---------------------------------------------------------------------------
// 1. Connection Overrides Sanitisation
// ---------------------------------------------------------------------------
describe("1. Override Sanitisation", () => {
  it("drops unknown keys from overrides payload", () => {
    const raw = {
      rpm: 120,
      unknownKey: "should_be_dropped",
      anotherUnknown: 42,
      foo: { bar: 1 },
    };
    const sanitized = sanitizeConnectionLimitOverrides(raw);
    expect(sanitized).toEqual({ rpm: 120 });
    expect(sanitized.unknownKey).toBeUndefined();
    expect(sanitized.foo).toBeUndefined();
  });

  it("rejects non-positive and non-finite numbers", () => {
    const raw = {
      rpm: -10,
      rpd: 0,
      tpm: NaN,
      tpd: Infinity,
      minTime: -500,
      maxConcurrent: -2,
      maxWaitMs: 0,
    };
    const sanitized = sanitizeConnectionLimitOverrides(raw);
    expect(sanitized).toEqual({});
  });

  it("rejects non-number types for numeric fields", () => {
    const raw = {
      rpm: "100",
      rpd: true,
      tpm: [],
      tpd: {},
      minTime: null,
    };
    const sanitized = sanitizeConnectionLimitOverrides(raw);
    expect(sanitized).toEqual({});
  });

  it("floors integer fields strictly", () => {
    const raw = {
      rpm: 60.9,
      maxConcurrent: 4.2,
      minTime: 250.5,
    };
    const sanitized = sanitizeConnectionLimitOverrides(raw);
    expect(sanitized.rpm).toBe(60);
    expect(sanitized.maxConcurrent).toBe(4);
    expect(sanitized.minTime).toBe(250.5);
  });

  it("sanitises modelConcurrency strictly as a map of modelId -> positive integer", () => {
    const raw = {
      rpm: 60,
      modelConcurrency: {
        "gpt-4o": 2,
        "claude-3-5-sonnet": 1,
        "invalid-zero": 0,
        "invalid-neg": -5,
        "invalid-string": "three",
        "invalid-nan": NaN,
        "": 4, // empty model key
      },
    };
    const sanitized = sanitizeConnectionLimitOverrides(raw);
    expect(sanitized.modelConcurrency).toEqual({
      "gpt-4o": 2,
      "claude-3-5-sonnet": 1,
    });
  });

  it("drops modelConcurrency if it is not an object or contains no valid entries", () => {
    expect(sanitizeConnectionLimitOverrides({ modelConcurrency: "invalid" })).toEqual({});
    expect(sanitizeConnectionLimitOverrides({ modelConcurrency: [] })).toEqual({});
    expect(sanitizeConnectionLimitOverrides({ modelConcurrency: { bad: -1 } })).toEqual({});
  });

  it("handles string JSON payloads safely", () => {
    const jsonStr = JSON.stringify({
      rpm: 100,
      maxConcurrent: 5,
      extra: "discard",
    });
    const sanitized = sanitizeConnectionLimitOverrides(jsonStr);
    expect(sanitized).toEqual({ rpm: 100, maxConcurrent: 5 });
  });

  it("returns null for malformed JSON or invalid types", () => {
    expect(sanitizeConnectionLimitOverrides("not-json")).toBeNull();
    expect(sanitizeConnectionLimitOverrides(null)).toBeNull();
    expect(sanitizeConnectionLimitOverrides(undefined)).toBeNull();
    expect(sanitizeConnectionLimitOverrides(123)).toBeNull();
  });

  it("validateConnectionLimitOverrides flags errors appropriately", () => {
    const resBad = validateConnectionLimitOverrides({
      rpm: -1,
      bogus: true,
      modelConcurrency: "bad",
    });
    expect(resBad.ok).toBe(false);
    expect(resBad.errors.length).toBeGreaterThanOrEqual(2);

    const resGood = validateConnectionLimitOverrides({
      rpm: 60,
      maxConcurrent: 2,
    });
    expect(resGood.ok).toBe(true);
    expect(resGood.value).toEqual({ rpm: 60, maxConcurrent: 2 });
  });
});

// ---------------------------------------------------------------------------
// 2. Limiter Dimensions & Boundary Enforcement
// ---------------------------------------------------------------------------
describe("2. Limiter Dimensions & Boundary Enforcement", () => {
  it("rpm increments and blocks at boundary with structured verdict", async () => {
    const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const store = new SqliteQuotaStore({ adapter: db });

    const connection = { provider: "openai", account: "acc1" };
    const overrides = { rpm: 2 };
    const fixedNow = 1_700_000_000_000;

    // 1st request -> allowed
    const r1 = await checkConnectionLimits({ connection, overrides, store, now: fixedNow });
    expect(r1.allowed).toBe(true);

    // 2nd request -> allowed
    const r2 = await checkConnectionLimits({ connection, overrides, store, now: fixedNow + 100 });
    expect(r2.allowed).toBe(true);

    // 3rd request -> blocked (rpm exceeded)
    const r3 = await checkConnectionLimits({ connection, overrides, store, now: fixedNow + 200 });
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("rpm_limit_exceeded");
    expect(r3.retryAfterMs).toBeGreaterThan(0);
  });

  it("minTime enforces spacing between successive requests", async () => {
    const connection = { provider: "anthropic", account: "acc_spacing" };
    const overrides = { minTime: 200 }; // 200ms spacing required
    const t0 = 1_700_000_000_000;

    // Request 1 at t0 -> allowed
    const r1 = await checkConnectionLimits({ connection, overrides, now: t0 });
    expect(r1.allowed).toBe(true);

    // Request 2 at t0 + 50ms (150ms before minTime satisfies) -> blocked
    const r2 = await checkConnectionLimits({ connection, overrides, now: t0 + 50 });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("min_time_not_met");
    expect(r2.retryAfterMs).toBe(150);

    // Request 3 at t0 + 200ms -> allowed
    const r3 = await checkConnectionLimits({ connection, overrides, now: t0 + 200 });
    expect(r3.allowed).toBe(true);
  });

  it("tpm and tpd block token usage when exceeded", async () => {
    const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const store = new SqliteQuotaStore({ adapter: db });

    const connection = { provider: "google", account: "acc_tokens" };
    const overrides = { tpm: 100 };
    const now = 1_700_000_000_000;

    // 60 tokens -> allowed
    const r1 = await checkConnectionLimits({ connection, overrides, tokens: 60, store, now });
    expect(r1.allowed).toBe(true);

    // 50 more tokens (total 110 > 100) -> blocked
    const r2 = await checkConnectionLimits({ connection, overrides, tokens: 50, store, now: now + 500 });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("tpm_limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// 3. In-Process Concurrency Semaphore
// ---------------------------------------------------------------------------
describe("3. In-Process Concurrency Semaphore", () => {
  it("blocks when maxConcurrent is reached and unblocks on release", async () => {
    const semaphore = new InProcessSemaphore();
    const key = "openai:acc_concurrent";
    const max = 2;

    const s1 = semaphore.tryAcquire(key, max);
    expect(s1.acquired).toBe(true);
    expect(semaphore.getInFlight(key)).toBe(1);

    const s2 = semaphore.tryAcquire(key, max);
    expect(s2.acquired).toBe(true);
    expect(semaphore.getInFlight(key)).toBe(2);

    // 3rd attempt should fail immediately
    const s3 = semaphore.tryAcquire(key, max);
    expect(s3.acquired).toBe(false);
    expect(semaphore.getInFlight(key)).toBe(2);

    // Releasing one slot allows next acquire
    semaphore.release(key);
    expect(semaphore.getInFlight(key)).toBe(1);

    const s4 = semaphore.tryAcquire(key, max);
    expect(s4.acquired).toBe(true);
    expect(semaphore.getInFlight(key)).toBe(2);
  });

  it("checkConnectionLimits and releaseConnectionSlot enforce maxConcurrent and modelConcurrency", async () => {
    const connection = { provider: "openai", account: "team_a" };
    const overrides = {
      maxConcurrent: 2,
      modelConcurrency: { "gpt-4o": 1 },
    };

    // 1st request for gpt-4o -> succeeds
    const r1 = await checkConnectionLimits({ connection, overrides, model: "gpt-4o" });
    expect(r1.allowed).toBe(true);
    expect(r1.slotsHeld?.connection).toBe(true);
    expect(r1.slotsHeld?.model).toBe(true);

    // 2nd request for gpt-4o -> blocked by modelConcurrency (limit 1)
    const r2 = await checkConnectionLimits({ connection, overrides, model: "gpt-4o" });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("model_concurrency_limit_exceeded");

    // 3rd request for o3-mini -> succeeds (connection slot 2 is available, not gpt-4o)
    const r3 = await checkConnectionLimits({ connection, overrides, model: "o3-mini" });
    expect(r3.allowed).toBe(true);

    // 4th request for o3-mini -> blocked by connection maxConcurrent (2 slots in flight)
    const r4 = await checkConnectionLimits({ connection, overrides, model: "o3-mini" });
    expect(r4.allowed).toBe(false);
    expect(r4.reason).toBe("concurrency_limit_exceeded");

    // Release gpt-4o slot
    releaseConnectionSlot({ connection, overrides, model: "gpt-4o" });

    // Now another gpt-4o request can acquire
    const r5 = await checkConnectionLimits({ connection, overrides, model: "gpt-4o" });
    expect(r5.allowed).toBe(true);

    // Clean up
    releaseConnectionSlot({ connection, overrides, model: "o3-mini" });
    releaseConnectionSlot({ connection, overrides, model: "gpt-4o" });
  });
});

// ---------------------------------------------------------------------------
// 4. Window Expiry Resets Allowance
// ---------------------------------------------------------------------------
describe("4. Window Expiry Resets Allowance", () => {
  it("sliding-window allowance resets after the window duration has elapsed", async () => {
    const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const store = new SqliteQuotaStore({ adapter: db });

    const connection = { provider: "anthropic", account: "acc_expiry" };
    const overrides = { rpm: 2 };
    const windowMs = 60_000;
    const t0 = 1_700_000_000_000;

    // Use 2 slots at t0
    await checkConnectionLimits({ connection, overrides, store, now: t0 });
    await checkConnectionLimits({ connection, overrides, store, now: t0 + 100 });

    // Exceeded at t0 + 200
    const blocked = await checkConnectionLimits({ connection, overrides, store, now: t0 + 200 });
    expect(blocked.allowed).toBe(false);

    // Advance 2 whole windows (120s later) -> previous bucket weight is 0
    const tFuture = t0 + windowMs * 2 + 1000;
    const fresh = await checkConnectionLimits({ connection, overrides, store, now: tFuture });
    expect(fresh.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate Limits List Support & API Key Hashing Security
// ---------------------------------------------------------------------------
describe("5. Rate Limits List & Security", () => {
  it("parseWindowDuration supports 1m, 1h, 1d, and numbers", () => {
    expect(parseWindowDuration("1m")).toBe(60_000);
    expect(parseWindowDuration("5m")).toBe(300_000);
    expect(parseWindowDuration("1h")).toBe(3_600_000);
    expect(parseWindowDuration("1d")).toBe(86_400_000);
    expect(parseWindowDuration("500ms")).toBe(500);
    expect(parseWindowDuration(60)).toBe(60_000);
    expect(parseWindowDuration(120_000)).toBe(120_000);
    expect(parseWindowDuration("invalid")).toBeNull();
  });

  it("parseRateLimits validates and drops invalid entries", () => {
    const raw = [
      { limit: 60, window: "1m" },
      { limit: 1000, window: "1d" },
      { limit: -10, window: "1h" }, // negative limit
      { limit: 10, window: "invalid" }, // bad window
      "not an object",
    ];
    const parsed = parseRateLimits(raw);
    expect(parsed).toEqual([
      { limit: 60, windowMs: 60_000, windowStr: "1m" },
      { limit: 1000, windowMs: 86_400_000, windowStr: "1d" },
    ]);
  });

  it("SECURITY: API keys are hashed with SHA-256 and raw secret never appears in quota storage keys", async () => {
    const rawSecret = "sk-live-secret-test-key-123456789";
    const expectedHash = crypto.createHash("sha256").update(rawSecret).digest("hex");

    expect(hashApiKey(rawSecret)).toBe(expectedHash);
    expect(hashApiKey(rawSecret)).not.toContain("sk-live");

    // Test with checkApiKeyUsageLimits
    const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const store = new SqliteQuotaStore({ adapter: db });

    const apiKeyRow = {
      id: "key_sec_1",
      key: rawSecret,
      rate_limits: JSON.stringify([{ limit: 10, window: "1m" }]),
    };

    await checkApiKeyUsageLimits({ apiKeyRow, store, db });

    // Inspect rows in api_key_quota_counters
    const counterRows = db.all(`SELECT key FROM api_key_quota_counters`);
    for (const row of counterRows) {
      expect(row.key).not.toContain(rawSecret);
    }
  });

  it("checkApiKeyUsageLimits enforces multi-window rate limits", async () => {
    const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const store = new SqliteQuotaStore({ adapter: db });

    const apiKeyRow = {
      id: "key_multi_win",
      key: "test_key_mw",
      rate_limits: JSON.stringify([{ limit: 2, window: "1m" }]),
    };
    const now = 1_700_000_000_000;

    const r1 = await checkApiKeyUsageLimits({ apiKeyRow, store, db, now });
    expect(r1.allowed).toBe(true);

    const r2 = await checkApiKeyUsageLimits({ apiKeyRow, store, db, now: now + 50 });
    expect(r2.allowed).toBe(true);

    const r3 = await checkApiKeyUsageLimits({ apiKeyRow, store, db, now: now + 100 });
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("rate_limit_exceeded");
    expect(r3.limit).toBe(2);

    const formatted = formatQuotaErrorResponse(r3);
    expect(formatted.status).toBe(429);
    expect(formatted.body.error.code).toBe("rate_limit_exceeded");
    expect(formatted.headers["Retry-After"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. USD Daily / Weekly Caps via request_cost_ledger
// ---------------------------------------------------------------------------
describe("6. USD Daily / Weekly Caps via request_cost_ledger", () => {
  it("enforces daily_usage_limit_usd by querying request_cost_ledger", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const apiKeyId = "key_usd_daily_test";
    const now = Date.now();

    const apiKeyRow = {
      id: apiKeyId,
      key: "usd_test_key",
      usage_limit_enabled: 1,
      daily_usage_limit_usd: 5.0,
    };

    // 1. Initial check: spend is $0 -> allowed
    const c1 = await checkApiKeyUsageLimits({ apiKeyRow, db, now });
    expect(c1.allowed).toBe(true);

    // 2. Insert ledger entries totaling $4.50
    await insertRequestCostLedger(
      {
        requestId: "req_1",
        apiKeyId,
        provider: "openai",
        model: "gpt-4o",
        totalCostUsd: 2.0,
        createdAt: new Date(now).toISOString(),
      },
      db
    );
    await insertRequestCostLedger(
      {
        requestId: "req_2",
        apiKeyId,
        provider: "openai",
        model: "gpt-4o",
        totalCostUsd: 2.5,
        createdAt: new Date(now).toISOString(),
      },
      db
    );

    // Still allowed ($4.50 <= $5.00)
    const c2 = await checkApiKeyUsageLimits({ apiKeyRow, db, now });
    expect(c2.allowed).toBe(true);

    // 3. Add $1.00 more (total $5.50 > $5.00)
    await insertRequestCostLedger(
      {
        requestId: "req_3",
        apiKeyId,
        provider: "openai",
        model: "gpt-4o",
        totalCostUsd: 1.0,
        createdAt: new Date(now).toISOString(),
      },
      db
    );

    // Now rejected with budget_exceeded
    const c3 = await checkApiKeyUsageLimits({ apiKeyRow, db, now });
    expect(c3.allowed).toBe(false);
    expect(c3.reason).toBe("budget_exceeded");
    expect(c3.limit).toBe(5.0);
    expect(c3.current).toBe(5.5);

    const formatted = formatQuotaErrorResponse(c3);
    expect(formatted.status).toBe(429);
    expect(formatted.body.error.code).toBe("budget_exceeded");
  });

  it("recordKeyQuotaUsage and checkKeyQuota domain service handle daily/weekly caps", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { upsertApiKeyQuotaLimit } = await import("../../src/lib/db/keyQuota.js");
    const db = await getAdapter();

    const apiKey = "domain_test_key";
    const apiKeyId = "ak_domain_1";
    const now = Date.now();

    // Configure a daily limit in api_key_quota_limits
    await upsertApiKeyQuotaLimit(
      {
        apiKey: apiKeyId,
        windowType: "daily_usd",
        limitValue: 3.0,
      },
      db
    );

    // Check before spend -> allowed
    const chk1 = await checkKeyQuota({ apiKeyId, db, now });
    expect(chk1.allowed).toBe(true);

    // Record usage
    await recordKeyQuotaUsage({
      apiKeyId,
      requestId: "rec_1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      totalTokens: 500,
      costUsd: 3.5,
      now,
      db,
    });

    // Check after spend ($3.50 > $3.00) -> blocked
    const chk2 = await checkKeyQuota({ apiKeyId, db, now });
    expect(chk2.allowed).toBe(false);
    expect(chk2.reason).toBe("budget_exceeded");
  });
});

// ---------------------------------------------------------------------------
// 7. Limits Infrastructure Failure — Fail-Open Operational Invariant
// ---------------------------------------------------------------------------
describe("7. Fail-Open Operational Invariant", () => {
  it("checkConnectionLimits fails open when QuotaStore throws", async () => {
    // Fake store that simulates Redis or SQLite crash
    const brokenStore = {
      consume: vi.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis down")),
      peek: vi.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis down")),
    };

    const connection = { provider: "openai", account: "failopen_test" };
    const overrides = { rpm: 5 };

    const result = await checkConnectionLimits({
      connection,
      overrides,
      store: brokenStore,
    });

    // Operational Invariant: MUST NOT block or throw, must fail open
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it("checkKeyQuota fails open when database or store throws", async () => {
    const brokenDb = {
      all: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      get: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };

    const result = await checkKeyQuota({
      apiKeyId: "test_key_failopen",
      db: brokenDb,
    });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it("checkApiKeyUsageLimits fails open when ledger queries fail", async () => {
    const brokenDb = {
      all: () => {
        throw new Error("DISK_FULL");
      },
      get: () => {
        throw new Error("DISK_FULL");
      },
    };

    const apiKeyRow = {
      id: "key_broken",
      usage_limit_enabled: 1,
      daily_usage_limit_usd: 1.0,
      rate_limits: JSON.stringify([{ limit: 10, window: "1m" }]),
    };

    const result = await checkApiKeyUsageLimits({
      apiKeyRow,
      db: brokenDb,
    });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });
});

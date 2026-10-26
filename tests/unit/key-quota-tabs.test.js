import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Setup isolated DATA_DIR for DB tests ───────────────────────────────────

let tempDir;
let originalDataDir;

function setupTempDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-test-key-quota-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  delete global._dbAdapter;
}

function teardownTempDb() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete process.env.DATA_DIR_ALLOW_TEMP;
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

// ─── Suite 1: Types & Interfaces (T005) ────────────────────────────────────

describe("Key Quota Types & Interfaces", () => {
  it("exports valid quota window types and actions matching contract", async () => {
    const {
      VALID_QUOTA_WINDOW_TYPES,
      VALID_QUOTA_ACTIONS,
      validateApiKeyQuotaPayload,
    } = await import("@/shared/types/keyQuota.js");

    expect(VALID_QUOTA_WINDOW_TYPES).toEqual([
      "rpm",
      "rph",
      "rpd",
      "tpm",
      "tpd",
      "daily_usd",
      "weekly_usd",
      "monthly_usd",
    ]);

    expect(VALID_QUOTA_ACTIONS).toEqual(["reject", "warn", "throttle"]);

    // Valid payload with all window types and explicit actions
    const validPayload = {
      limits: [
        { windowType: "rpm", limitValue: 60, action: "reject" },
        { windowType: "rph", limitValue: 1000, action: "warn" },
        { windowType: "rpd", limitValue: 10000, action: "throttle" },
        { windowType: "tpm", limitValue: 50000 }, // action should default to reject
        { windowType: "tpd", limitValue: 1000000 },
        { windowType: "daily_usd", limitValue: 25.5 },
        { windowType: "weekly_usd", limitValue: 100.0 },
        { windowType: "monthly_usd", limitValue: 350.0 },
      ],
    };

    const res = validateApiKeyQuotaPayload(validPayload);
    expect(res.ok).toBe(true);
    expect(res.value.limits).toHaveLength(8);
    expect(res.value.limits[3].action).toBe("reject");
    expect(res.value.limits[0].limitValue).toBe(60);
  });

  it("rejects payloads that violate schema rules (negative, zero, NaN, invalid types)", async () => {
    const { validateApiKeyQuotaPayload } = await import("@/shared/types/keyQuota.js");

    // Missing limits array
    expect(validateApiKeyQuotaPayload(null).ok).toBe(false);
    expect(validateApiKeyQuotaPayload({}).ok).toBe(false);
    expect(validateApiKeyQuotaPayload({ limits: "not-an-array" }).ok).toBe(false);

    // Empty limit object
    expect(validateApiKeyQuotaPayload({ limits: [{}] }).ok).toBe(false);

    // Invalid windowType
    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "yearly_usd", limitValue: 100 }],
      }).ok
    ).toBe(false);

    // Limit value <= 0 or not finite
    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "rpm", limitValue: 0 }],
      }).ok
    ).toBe(false);

    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "rpm", limitValue: -10 }],
      }).ok
    ).toBe(false);

    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "rpm", limitValue: NaN }],
      }).ok
    ).toBe(false);

    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "rpm", limitValue: Infinity }],
      }).ok
    ).toBe(false);

    // Invalid action
    expect(
      validateApiKeyQuotaPayload({
        limits: [{ windowType: "rpm", limitValue: 100, action: "block" }],
      }).ok
    ).toBe(false);
  });
});

// ─── Suite 2: Utilization & Reset Timer (G1 / T015) ─────────────────────────

describe("Key Quota Utilization & Reset Timer", () => {
  it("calculates window reset timestamp and duration for sliding and calendar windows", async () => {
    const { calculateWindowReset } = await import("@/shared/types/keyQuota.js");

    // Anchor time: 2026-10-26T14:30:15.000Z (Monday)
    const fixedNow = new Date("2026-10-26T14:30:15.000Z").getTime();

    // 1. Minute windows (rpm, tpm) -> resets at 14:31:00 (45,000 ms remaining)
    const rpmReset = calculateWindowReset("rpm", fixedNow);
    expect(rpmReset.resetMs).toBe(45000);
    expect(rpmReset.resetsAtIso).toBe("2026-10-26T14:31:00.000Z");

    const tpmReset = calculateWindowReset("tpm", fixedNow);
    expect(tpmReset.resetMs).toBe(45000);

    // 2. Hour window (rph) -> resets at 15:00:00 (29m 45s = 1,785,000 ms)
    const rphReset = calculateWindowReset("rph", fixedNow);
    expect(rphReset.resetMs).toBe(29 * 60 * 1000 + 45000);
    expect(rphReset.resetsAtIso).toBe("2026-10-26T15:00:00.000Z");

    // 3. Daily windows (rpd, tpd, daily_usd) -> resets at next UTC midnight (2026-10-27T00:00:00Z)
    const dailyReset = calculateWindowReset("daily_usd", fixedNow);
    expect(dailyReset.resetsAtIso).toBe("2026-10-27T00:00:00.000Z");
    expect(dailyReset.resetMs).toBe(
      new Date("2026-10-27T00:00:00.000Z").getTime() - fixedNow
    );

    // 4. Weekly window (weekly_usd) -> resets at next Monday midnight (2026-11-02T00:00:00Z)
    const weeklyReset = calculateWindowReset("weekly_usd", fixedNow);
    expect(weeklyReset.resetsAtIso).toBe("2026-11-02T00:00:00.000Z");

    // 5. Monthly window (monthly_usd) -> resets at next month 1st (2026-11-01T00:00:00Z)
    const monthlyReset = calculateWindowReset("monthly_usd", fixedNow);
    expect(monthlyReset.resetsAtIso).toBe("2026-11-01T00:00:00.000Z");
  });

  it("formats human-readable reset countdown timers accurately", async () => {
    const { formatResetTimer } = await import("@/shared/types/keyQuota.js");

    expect(formatResetTimer(0)).toBe("0s");
    expect(formatResetTimer(-500)).toBe("0s");
    expect(formatResetTimer(45000)).toBe("45s");
    expect(formatResetTimer(125000)).toBe("2m 5s");
    expect(formatResetTimer(3665000)).toBe("1h 1m");
    expect(formatResetTimer(90000000)).toBe("1d 1h");
  });

  it("calculates utilization percentage and status bands correctly", async () => {
    const {
      calculateUtilizationPercent,
      getQuotaStatus,
      computeKeyQuotaUtilization,
    } = await import("@/shared/types/keyQuota.js");

    // Percentage calculation
    expect(calculateUtilizationPercent(0, 100)).toBe(0);
    expect(calculateUtilizationPercent(50, 100)).toBe(50.0);
    expect(calculateUtilizationPercent(33.333, 100)).toBe(33.3);
    expect(calculateUtilizationPercent(120, 100)).toBe(120.0);
    expect(calculateUtilizationPercent(10, 0)).toBe(0);

    // Status classification: < 70% healthy, 70-90% warning, > 90% exceeded
    expect(getQuotaStatus(0)).toBe("healthy");
    expect(getQuotaStatus(69.9)).toBe("healthy");
    expect(getQuotaStatus(70.0)).toBe("warning");
    expect(getQuotaStatus(85.5)).toBe("warning");
    expect(getQuotaStatus(90.0)).toBe("warning");
    expect(getQuotaStatus(90.1)).toBe("exceeded");
    expect(getQuotaStatus(100)).toBe("exceeded");
    expect(getQuotaStatus(150)).toBe("exceeded");

    // Aggregate utilization
    const utilization = computeKeyQuotaUtilization({
      keyId: "key-123",
      keyName: "Production Worker",
      rawKey: "kh-sec-live-prod-token-9876543210",
      limitsWithUsage: [
        { windowType: "rpm", limit: 100, used: 25, resetMs: 30000, resetsAtIso: "2026-10-26T14:31:00.000Z" },
        { windowType: "daily_usd", limit: 50.0, used: 46.0, resetMs: 34200000, resetsAtIso: "2026-10-27T00:00:00.000Z" },
      ],
      spendSummary: {
        todayUsd: 46.0,
        thisWeekUsd: 120.0,
        thisMonthUsd: 450.0,
        totalTokensToday: 150000,
      },
    });

    expect(utilization.keyId).toBe("key-123");
    expect(utilization.keyName).toBe("Production Worker");
    // Secret masking
    expect(utilization.keyMasked).not.toContain("sec-live");
    expect(utilization.keyMasked).toContain("***");
    expect(utilization.status).toBe("exceeded"); // daily_usd is at 92% -> exceeded
    expect(utilization.limits[0].utilizationPercent).toBe(25.0);
    expect(utilization.limits[0].remaining).toBe(75);
    expect(utilization.limits[1].utilizationPercent).toBe(92.0);
    expect(utilization.limits[1].remaining).toBe(4.0);
  });
});

// ─── Suite 3: Spend Trends & Ledger Retrieval (G2 / T014) ───────────────────

describe("Spend Trends Aggregation & Ledger Retrieval", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
  });

  it("aggregates raw cost ledger entries into hourly and daily trend buckets", async () => {
    const { aggregateSpendTrends } = await import("@/shared/types/keyQuota.js");

    const rawRows = [
      {
        created_at: "2026-10-26T10:15:00.000Z",
        total_cost_usd: 0.05,
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
      {
        created_at: "2026-10-26T10:45:00.000Z",
        total_cost_usd: 0.03,
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
      {
        created_at: "2026-10-26T11:05:00.000Z",
        total_cost_usd: 0.12,
        prompt_tokens: 2500,
        completion_tokens: 1500,
        total_tokens: 4000,
      },
    ];

    // Hourly aggregation (24h period)
    const hourlyTrends = aggregateSpendTrends(rawRows, "24h");
    expect(hourlyTrends).toHaveLength(2);
    expect(hourlyTrends[0].timestamp).toBe("2026-10-26 10:00");
    expect(hourlyTrends[0].totalCostUsd).toBeCloseTo(0.08, 4);
    expect(hourlyTrends[0].promptTokens).toBe(1800);
    expect(hourlyTrends[0].completionTokens).toBe(700);
    expect(hourlyTrends[0].requestCount).toBe(2);

    expect(hourlyTrends[1].timestamp).toBe("2026-10-26 11:00");
    expect(hourlyTrends[1].totalCostUsd).toBeCloseTo(0.12, 4);
    expect(hourlyTrends[1].requestCount).toBe(1);

    // Empty rows check
    expect(aggregateSpendTrends([], "24h")).toEqual([]);
  });

  it("queries spend trends directly from SQLite request_cost_ledger with bounded limits", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { insertRequestCostLedger } = await import("@/lib/db/keyQuota.js");
    const { getSpendTrendsFromLedger } = await import("@/shared/types/keyQuota.js");

    const db = await getAdapter();
    const apiKeyId = "key-test-trends-1";

    // Insert test entries
    await insertRequestCostLedger({
      id: "req-1",
      requestId: "r1",
      apiKeyId,
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      totalCostUsd: 0.05,
      createdAt: "2026-10-26T08:00:00.000Z",
    });

    await insertRequestCostLedger({
      id: "req-2",
      requestId: "r2",
      apiKeyId,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      promptTokens: 2000,
      completionTokens: 1000,
      totalTokens: 3000,
      totalCostUsd: 0.15,
      createdAt: "2026-10-26T08:30:00.000Z",
    });

    // Another key's entry (should NOT be aggregated)
    await insertRequestCostLedger({
      id: "req-other",
      requestId: "r3",
      apiKeyId: "other-key",
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 5000,
      completionTokens: 2000,
      totalTokens: 7000,
      totalCostUsd: 0.50,
      createdAt: "2026-10-26T08:45:00.000Z",
    });

    const res = await getSpendTrendsFromLedger({
      apiKeyId,
      period: "24h",
      now: new Date("2026-10-26T12:00:00.000Z").getTime(),
    }, db);

    expect(res.degraded).toBe(false);
    expect(res.points).toHaveLength(1);
    expect(res.points[0].totalCostUsd).toBeCloseTo(0.20, 4);
    expect(res.points[0].promptTokens).toBe(3000);
    expect(res.points[0].completionTokens).toBe(1500);
    expect(res.points[0].requestCount).toBe(2);
  });

  it("fails open when database errors occur on spend trends query", async () => {
    const { getSpendTrendsFromLedger } = await import("@/shared/types/keyQuota.js");

    const faultyDb = {
      all: vi.fn(() => {
        throw new Error("Disk I/O error or table locked");
      }),
    };

    const res = await getSpendTrendsFromLedger({ apiKeyId: "broken" }, faultyDb);
    expect(res.degraded).toBe(true);
    expect(res.points).toEqual([]);
  });

  it("returns degraded fail-open result without throwing when called without a db argument", async () => {
    const { getSpendTrendsFromLedger } = await import("@/shared/types/keyQuota.js");

    const res = await getSpendTrendsFromLedger({ apiKeyId: "no-db-key" });
    expect(res).toEqual({ points: [], degraded: true });
  });
});

// ─── Suite 4: Key Quota Backend API & FailOpen (G3 / T013) ───────────────────

describe("Key Quota Backend API & FailOpen", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
  });

  it("enforces authentication and rejects unauthorized GET and PUT requests", async () => {
    const { GET, PUT } = await import("@/app/api/keys/[id]/quota/route.js");

    // Unauthenticated GET request with requireLogin enabled
    const unauthReq = new Request("http://localhost:20128/api/keys/key-123/quota", {
      method: "GET",
      headers: {},
    });

    const getRes = await GET(unauthReq, { params: Promise.resolve({ id: "key-123" }) });
    expect(getRes.status).toBe(401);
    const getBody = await getRes.json();
    expect(getBody.error).toBe("Unauthorized");

    // Unauthenticated PUT request
    const putReq = new Request("http://localhost:20128/api/keys/key-123/quota", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limits: [{ windowType: "rpm", limitValue: 100 }] }),
    });

    const putRes = await PUT(putReq, { params: Promise.resolve({ id: "key-123" }) });
    expect(putRes.status).toBe(401);
  });

  it("returns 404 when key ID does not exist in database", async () => {
    const { GET, PUT } = await import("@/app/api/keys/[id]/quota/route.js");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({ user: "admin" });

    const authHeaders = {
      cookie: `auth_token=${token}`,
      "content-type": "application/json",
    };

    const getReq = new Request("http://localhost:20128/api/keys/non-existent-id/quota", {
      method: "GET",
      headers: authHeaders,
    });

    const getRes = await GET(getReq, { params: Promise.resolve({ id: "non-existent-id" }) });
    expect(getRes.status).toBe(404);
    const getBody = await getRes.json();
    expect(getBody.error).toBe("Key not found");

    const putReq = new Request("http://localhost:20128/api/keys/non-existent-id/quota", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ limits: [{ windowType: "rpm", limitValue: 100 }] }),
    });

    const putRes = await PUT(putReq, { params: Promise.resolve({ id: "non-existent-id" }) });
    expect(putRes.status).toBe(404);
  });

  it("never returns raw API keys or cleartext SHA-256 hashes in GET or PUT responses", async () => {
    const { GET, PUT } = await import("@/app/api/keys/[id]/quota/route.js");
    const { createApiKey } = await import("@/lib/localDb");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const { hashApiKey } = await import("@/lib/db/keyQuota.js");

    const token = await createDashboardAuthToken({ user: "admin" });
    const authHeaders = {
      cookie: `auth_token=${token}`,
      "content-type": "application/json",
    };

    // Create an API key
    const rawSecret = "kh-live-super-secret-key-999888777";
    const createdKey = await createApiKey("Secret Production Key", "test-machine");

    const keyHash = hashApiKey(createdKey.key);

    // 1. PUT to configure quota limits
    const putReq = new Request(`http://localhost:20128/api/keys/${createdKey.id}/quota`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        limits: [
          { windowType: "rpm", limitValue: 120, action: "reject" },
          { windowType: "daily_usd", limitValue: 50.0, action: "warn" },
        ],
      }),
    });

    const putRes = await PUT(putReq, { params: Promise.resolve({ id: createdKey.id }) });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();

    // Security assertions: Neither raw key nor key hash appears in JSON response
    const putBodyStr = JSON.stringify(putBody);
    expect(putBodyStr).not.toContain(createdKey.key);
    expect(putBodyStr).not.toContain(keyHash);
    expect(putBody.keyMasked).toContain("***");
    expect(putBody.limits).toHaveLength(2);

    // 2. GET to read back quota utilization and spend trends
    const getReq = new Request(`http://localhost:20128/api/keys/${createdKey.id}/quota?period=24h`, {
      method: "GET",
      headers: authHeaders,
    });

    const getRes = await GET(getReq, { params: Promise.resolve({ id: createdKey.id }) });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();

    const getBodyStr = JSON.stringify(getBody);
    expect(getBodyStr).not.toContain(createdKey.key);
    expect(getBodyStr).not.toContain(keyHash);
    expect(getBody.keyMasked).toContain("***");
    expect(getBody.limits).toHaveLength(2);
    expect(getBody.utilization).toBeDefined();
    expect(getBody.spendTrends).toBeDefined();
  });

  it("handles unconfigured keys gracefully with zero / unlimited placeholders", async () => {
    const { GET } = await import("@/app/api/keys/[id]/quota/route.js");
    const { createApiKey } = await import("@/lib/localDb");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");

    const token = await createDashboardAuthToken({ user: "admin" });
    const authHeaders = { cookie: `auth_token=${token}` };

    const unconfiguredKey = await createApiKey("Brand New Key", "test-machine");

    const getReq = new Request(`http://localhost:20128/api/keys/${unconfiguredKey.id}/quota`, {
      method: "GET",
      headers: authHeaders,
    });

    const getRes = await GET(getReq, { params: Promise.resolve({ id: unconfiguredKey.id }) });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();

    expect(body.limits).toEqual([]);
    expect(body.unconfigured).toBe(true);
    expect(body.utilization.status).toBe("healthy");
    expect(body.utilization.limits).toEqual([]);
  });

  it("fails open with degraded: true when database or quota store operations fail", async () => {
    const { GET } = await import("@/app/api/keys/[id]/quota/route.js");
    const { createApiKey } = await import("@/lib/localDb");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");

    const token = await createDashboardAuthToken({ user: "admin" });
    const authHeaders = { cookie: `auth_token=${token}` };

    const key = await createApiKey("Key for Fault Injection", "test-machine");

    // Close underlying DB instance to induce failure
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}

    const getReq = new Request(`http://localhost:20128/api/keys/${key.id}/quota`, {
      method: "GET",
      headers: authHeaders,
    });

    // Should FAIL OPEN: return 200 with degraded: true rather than crashing 500
    const res = await GET(getReq, { params: Promise.resolve({ id: key.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
  });
});

// ─── Suite 5: UTC Window Boundaries Parity (T005 / Server vs Shared) ─────────

describe("UTC Window Boundaries Parity (server vs shared-types)", () => {
  it("enforces exact parity across 18 window types and 25 fixed timestamps", async () => {
    const { getUtcWindowBoundaries: serverGetUtcWindowBoundaries } = await import("@/lib/db/keyQuota.js");
    const { getUtcWindowBoundaries: sharedGetUtcWindowBoundaries } = await import("@/shared/types/keyQuota.js");

    const windowTypes = [
      "daily",
      "day",
      "1d",
      "rpd",
      "tpd",
      "daily_usd",
      "weekly",
      "week",
      "7d",
      "weekly_usd",
      "monthly",
      "month",
      "30d",
      "monthly_usd",
      "unknown",
      "",
      null,
      undefined,
    ];

    const fixedTimestamps = [
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T12:34:56.789Z",
      "2020-02-29T12:00:00.000Z",
      "2024-02-29T23:59:59.999Z",
      "2028-02-29T12:00:00.000Z",
      "2028-02-29T00:00:00.000Z",
      "2026-10-25T10:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z",
      "2026-02-28T23:59:59.999Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-30T23:59:59.999Z",
      "2026-05-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
      "2026-08-01T00:00:00.000Z",
      "2000-01-01T00:00:00.000Z",
      "2038-01-19T03:14:07.000Z",
      "2023-06-15T15:30:45.123Z",
      "2025-11-30T23:59:59.000Z",
      "2027-02-28T12:00:00.000Z",
      "2026-10-26T14:30:15.000Z",
      "2026-06-21T06:00:00.000Z",
      "9999-12-31T12:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ];

    expect(fixedTimestamps).toHaveLength(25);

    const mismatches = [];

    for (const wt of windowTypes) {
      for (const iso of fixedTimestamps) {
        const nowMs = new Date(iso).getTime();
        const serverResult = serverGetUtcWindowBoundaries(wt, nowMs);
        const sharedResult = sharedGetUtcWindowBoundaries(wt, nowMs);

        if (
          serverResult.sinceIso !== sharedResult.sinceIso ||
          serverResult.untilIso !== sharedResult.untilIso ||
          serverResult.resetMs !== sharedResult.resetMs
        ) {
          mismatches.push({
            windowType: wt,
            timestamp: iso,
            server: serverResult,
            shared: sharedResult,
          });
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});


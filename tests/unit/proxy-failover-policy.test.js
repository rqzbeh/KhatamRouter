import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROXY_FAILOVER,
  MAX_CUSTOM_RETRIES_CEILING,
  normalizeProxyFailoverSettings,
  isProxyFailoverRetryable,
  resolveRotationCandidates,
  pickNextDistinctPool,
  hasRemainingFailoverBudget,
} from "@/lib/network/proxyFailover.js";

describe("normalizeProxyFailoverSettings", () => {
  it("defaults to disabled none mode with 0 retries", () => {
    const r1 = normalizeProxyFailoverSettings(undefined);
    expect(r1.ok).toBe(true);
    expect(r1.value).toMatchObject({
      enabled: false,
      mode: "none",
      maxRetries: 0,
      strategy: "round-robin",
    });

    const r2 = normalizeProxyFailoverSettings(null);
    expect(r2.ok).toBe(true);
    expect(r2.value.mode).toBe("none");
    expect(r2.value.maxRetries).toBe(0);
  });

  it("accepts canonical mode 'none' and numeric 0", () => {
    expect(normalizeProxyFailoverSettings({ mode: "none" }).value).toMatchObject({
      enabled: false,
      mode: "none",
      maxRetries: 0,
    });
    expect(normalizeProxyFailoverSettings({ maxRetries: 0 }).value).toMatchObject({
      enabled: false,
      mode: "none",
      maxRetries: 0,
    });
  });

  it("accepts canonical mode 'all' and maxRetries 'all'", () => {
    const r1 = normalizeProxyFailoverSettings({ mode: "all" });
    expect(r1.ok).toBe(true);
    expect(r1.value).toMatchObject({
      enabled: true,
      mode: "all",
      maxRetries: "all",
    });

    const r2 = normalizeProxyFailoverSettings({ maxRetries: "all" });
    expect(r2.ok).toBe(true);
    expect(r2.value).toMatchObject({
      enabled: true,
      mode: "all",
      maxRetries: "all",
    });
  });

  it.each([1, 5, 10, 20, 100])("accepts custom positive integer %d", (num) => {
    const r1 = normalizeProxyFailoverSettings({ maxRetries: num });
    expect(r1.ok).toBe(true);
    expect(r1.value).toMatchObject({
      enabled: true,
      mode: "custom",
      maxRetries: num,
    });

    const r2 = normalizeProxyFailoverSettings({ mode: "custom", maxRetries: num });
    expect(r2.ok).toBe(true);
    expect(r2.value).toMatchObject({
      enabled: true,
      mode: "custom",
      maxRetries: num,
    });
  });

  it.each([
    [{ maxRetries: -1 }, "integer"],
    [{ maxRetries: -5 }, "integer"],
    [{ maxRetries: 5.5 }, "integer"],
    [{ maxRetries: "5.5" }, "integer"],
    [{ maxRetries: "invalid" }, "integer"],
    [{ maxRetries: 1001 }, "integer"],
    [{ mode: "unknown" }, "mode must be"],
    [{ mode: "custom" }, "custom maxRetries must be an integer"],
    [{ mode: "all", maxRetries: 5 }, "cannot be numeric when mode is 'all'"],
    [{ mode: "none", maxRetries: 5 }, "must be 0 when mode is 'none'"],
    [{ enabled: true, maxRetries: 0 }, "enabled cannot be true when maxRetries is 0"],
    [{ strategy: "invalid" }, "strategy must be"],
  ])("rejects invalid input %j with clear errors", (input, expectedSubstr) => {
    const r = normalizeProxyFailoverSettings(input);
    expect(r.ok).toBe(false);
    expect(r.errors.join("; ")).toContain(expectedSubstr);
  });

  it("rejects non-object inputs", () => {
    expect(normalizeProxyFailoverSettings("none").ok).toBe(false);
    expect(normalizeProxyFailoverSettings(5).ok).toBe(false);
    expect(normalizeProxyFailoverSettings([5]).ok).toBe(false);
  });
});

describe("hasRemainingFailoverBudget", () => {
  it("returns false when disabled or mode is none", () => {
    expect(hasRemainingFailoverBudget({ enabled: false, mode: "none", maxRetries: 0 }, 0)).toBe(false);
    expect(hasRemainingFailoverBudget({ enabled: false, mode: "custom", maxRetries: 5 }, 0)).toBe(false);
  });

  it("returns true for mode 'all' regardless of retries count", () => {
    expect(hasRemainingFailoverBudget({ enabled: true, mode: "all", maxRetries: "all" }, 0)).toBe(true);
    expect(hasRemainingFailoverBudget({ enabled: true, mode: "all", maxRetries: "all" }, 99)).toBe(true);
  });

  it("enforces custom positive integer bounds strictly", () => {
    const config = { enabled: true, mode: "custom", maxRetries: 5 };
    expect(hasRemainingFailoverBudget(config, 0)).toBe(true);
    expect(hasRemainingFailoverBudget(config, 4)).toBe(true);
    expect(hasRemainingFailoverBudget(config, 5)).toBe(false);
    expect(hasRemainingFailoverBudget(config, 6)).toBe(false);
  });
});

describe("isProxyFailoverRetryable", () => {
  it("allows generic 429 rate-limit responses", () => {
    expect(isProxyFailoverRetryable({ status: 429, errorText: "rate limited" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "Too many requests from this IP" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "{}" })).toBe(true);
  });

  it("excludes 429 stating explicit account/billing/quota exhaustion", () => {
    expect(isProxyFailoverRetryable({ status: 429, errorText: "You exceeded your current quota, please check your plan and billing details" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "insufficient credits" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "daily limit reached" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "monthly request quota exceeded" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "Organization TPD rate limit exceeded" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "Your account has run out of credits" })).toBe(false);
  });

  it("excludes client and authentication errors", () => {
    expect(isProxyFailoverRetryable({ status: 400, errorText: "Bad request" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 401, errorText: "Invalid API key" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 404, errorText: "Model not found" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 422, errorText: "Unprocessable entity" })).toBe(false);
  });

  it("excludes content policy and safety refusals", () => {
    expect(isProxyFailoverRetryable({ status: 400, errorText: "Request blocked by safety policy" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 403, errorText: "content_policy_violation" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 429, errorText: "blocked by safety system" })).toBe(false);
  });

  it("only retries 403 when explicit IP/proxy/region evidence is present", () => {
    expect(isProxyFailoverRetryable({ status: 403, errorText: "Forbidden" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 403, errorText: "API key does not have access to this model" })).toBe(false);
    expect(isProxyFailoverRetryable({ status: 403, errorText: "Account is suspended" })).toBe(false);

    expect(isProxyFailoverRetryable({ status: 403, errorText: "Requests from this IP address are blocked" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 403, errorText: "This service is not available in your region" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 403, errorText: "Proxy tunnel failed to connect" })).toBe(true);
  });

  it("retries gateway errors and transport exceptions", () => {
    expect(isProxyFailoverRetryable({ status: 451, errorText: "Unavailable for legal reasons" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 502, errorText: "Bad Gateway" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 503, errorText: "Service Unavailable" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 504, errorText: "Gateway Timeout" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 500, errorText: "connect timeout" })).toBe(true);
    expect(isProxyFailoverRetryable({ status: 500, errorText: "ECONNRESET" })).toBe(true);
  });
});

describe("resolveRotationCandidates & pickNextDistinctPool", () => {
  const pools = [
    { id: "pool-1", name: "Pool 1", proxyUrl: "http://127.0.0.1:8001" },
    { id: "pool-2", name: "Pool 2", proxyUrl: "http://127.0.0.1:8002" },
    { id: "pool-3", name: "Pool 3", proxyUrl: "http://127.0.0.1:8003" },
  ];

  it("returns empty candidate list when rotation strategy is 'none'", () => {
    const res = resolveRotationCandidates({
      providerId: "opencode",
      settings: { providerStrategies: { opencode: { rotateStrategy: "none" } } },
      allActivePools: pools,
    });
    expect(res.strategy).toBe("none");
    expect(res.candidatePoolIds).toEqual([]);
  });

  it("uses the explicit failover strategy for a static authenticated connection", () => {
    const res = resolveRotationCandidates({
      providerId: "antigravity",
      credentials: { providerSpecificData: { proxyPoolId: "pool-1", connectionProxyPoolId: "pool-1" } },
      settings: { proxyFailover: { mode: "all", maxRetries: "all", strategy: "random" } },
      allActivePools: pools,
    });
    expect(res.strategy).toBe("random");
    expect(res.candidatePoolIds).toEqual(["pool-1", "pool-2", "pool-3"]);
  });

  it("does not switch the dedicated WARP lane to unrelated proxies", () => {
    const res = resolveRotationCandidates({
      providerId: "opencode-warp",
      credentials: { providerSpecificData: { connectionProxyPoolId: "warp" } },
      settings: { providerStrategies: { "opencode-warp": { proxyPoolIds: [] } }, proxyFailover: { mode: "all", maxRetries: "all" } },
      allActivePools: pools,
    });
    expect(res.candidatePoolIds).toEqual([]);
  });

  it("respects an explicit proxy opt-out even with All recovery enabled", () => {
    const res = resolveRotationCandidates({
      providerId: "antigravity",
      credentials: { providerSpecificData: { proxyPoolId: "__none__" } },
      settings: { proxyFailover: { mode: "all", maxRetries: "all" } },
      allActivePools: pools,
    });
    expect(res.candidatePoolIds).toEqual([]);
  });

  it("keeps an explicitly restricted candidate list during static failover", () => {
    const res = resolveRotationCandidates({
      providerId: "antigravity",
      credentials: { providerSpecificData: { proxyPoolId: "pool-1", proxyPoolIds: ["pool-1", "pool-3"] } },
      settings: { proxyFailover: { mode: "all", maxRetries: "all" } },
      allActivePools: pools,
    });
    expect(res.candidatePoolIds).toEqual(["pool-1", "pool-3"]);
  });

  it("returns active pool candidates when rotation is round-robin or random", () => {
    const res = resolveRotationCandidates({
      providerId: "opencode",
      settings: { providerStrategies: { opencode: { rotateStrategy: "round-robin" } } },
      allActivePools: pools,
    });
    expect(res.strategy).toBe("round-robin");
    expect(res.candidatePoolIds).toEqual(["pool-1", "pool-2", "pool-3"]);
  });

  it("picks distinct unattempted pools and stops when all candidates are attempted", () => {
    const candidatePoolIds = ["pool-1", "pool-2", "pool-3"];
    const attempted = new Set(["pool-1"]);

    const pick1 = pickNextDistinctPool({
      candidatePoolIds,
      attemptedPoolIds: attempted,
      strategy: "round-robin",
      providerId: "opencode",
      isPoolFitFn: () => true,
    });
    expect(["pool-2", "pool-3"]).toContain(pick1);

    attempted.add(pick1);
    const pick2 = pickNextDistinctPool({
      candidatePoolIds,
      attemptedPoolIds: attempted,
      strategy: "round-robin",
      providerId: "opencode",
      isPoolFitFn: () => true,
    });
    const expectedLast = ["pool-2", "pool-3"].find((p) => p !== pick1);
    expect(pick2).toBe(expectedLast);

    attempted.add(pick2);
    const pick3 = pickNextDistinctPool({
      candidatePoolIds,
      attemptedPoolIds: attempted,
      strategy: "round-robin",
      providerId: "opencode",
      isPoolFitFn: () => true,
    });
    expect(pick3).toBeNull(); // All candidate pools exhausted
  });

  it("excludes unfit cooling pools during failover", () => {
    const candidatePoolIds = ["pool-1", "pool-2", "pool-3"];
    const attempted = new Set(["pool-1"]);
    // pool-2 is cooling down
    const isPoolFitFn = (id) => id !== "pool-2";

    const picked = pickNextDistinctPool({
      candidatePoolIds,
      attemptedPoolIds: attempted,
      strategy: "round-robin",
      providerId: "opencode",
      isPoolFitFn,
    });
    expect(picked).toBe("pool-3");
  });
});

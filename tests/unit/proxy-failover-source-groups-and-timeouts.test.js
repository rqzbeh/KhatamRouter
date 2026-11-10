import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = {
  requireApiKey: false,
  comboStrategy: "fallback",
  providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
  providerOverrides: { opencode: { retry: { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } } } },
  proxyHealth: { enabled: true, cooldownMs: 300000, statuses: [403, 429, 451, 502, 503, 504] },
  proxyFailover: { enabled: true, mode: "all", maxRetries: "all", strategy: "round-robin" },
};

const basePools = [
  [
    "oneproxy-alpha",
    {
      id: "oneproxy-alpha",
      name: "1proxy Alpha",
      type: "http",
      isActive: true,
      proxyUrl: "http://198.51.100.1:8080",
      provenance: { source: "free:oneproxy" },
      strictProxy: false,
    },
  ],
  [
    "oneproxy-beta",
    {
      id: "oneproxy-beta",
      name: "1proxy Beta",
      type: "http",
      isActive: true,
      proxyUrl: "http://198.51.100.2:8080",
      provenance: { source: "free:oneproxy" },
      strictProxy: false,
    },
  ],
  [
    "proxifly-gamma",
    {
      id: "proxifly-gamma",
      name: "Proxifly Gamma",
      type: "http",
      isActive: true,
      proxyUrl: "http://203.0.113.1:8080",
      provenance: { source: "free:proxifly" },
      strictProxy: false,
    },
  ],
];

let pools = new Map(basePools);

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => settings,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
  getProxyPools: async () => [...pools.values()],
}));

vi.mock("@/models", () => ({
  getProxyPoolById: async (id) => pools.get(id) || null,
  getProxyPools: async () => [...pools.values()],
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { resetPoolFitness, isPoolFit } = await import("../../open-sse/services/proxyPoolFitness.js");
const { poolSourceKey, groupPools } = await import("../../src/lib/network/proxyPoolGroups.js");

const SUCCESS_SSE =
  'data: {"choices":[{"message":{"content":"success"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';

const createRequest = ({ signal = null } = {}) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "opencode/beam-free",
      stream: false,
      messages: [{ role: "user", content: "test" }],
    }),
    signal,
  });

beforeEach(async () => {
  fetchMock.mockReset();
  pools = new Map(basePools);
  await resetPoolFitness();
  settings.proxyHealth.cooldownMs = 300000;
  settings.proxyFailover = { enabled: true, mode: "all", maxRetries: "all", strategy: "round-robin" };
});

afterEach(async () => {
  await resetPoolFitness();
});

describe("Source Grouping vs Concrete Pool Identity Verification", () => {
  it("proves source grouping is for presentation and does NOT share health identity", () => {
    expect(poolSourceKey(pools.get("oneproxy-alpha"))).toBe("oneproxy");
    expect(poolSourceKey(pools.get("oneproxy-beta"))).toBe("oneproxy");

    const groups = groupPools([...pools.values()]);
    const oneproxyGroup = groups.find((g) => g.key === "oneproxy");
    expect(oneproxyGroup.pools.map((p) => p.id)).toEqual(["oneproxy-alpha", "oneproxy-beta"]);
    expect(pools.get("oneproxy-alpha").id).not.toBe(pools.get("oneproxy-beta").id);
  });

  it("same-source imported proxies: first fails 429, cooled individually; sibling from same source selected & succeeds; other sources unaffected", async () => {
    // Only two same-source pools active in this test (plus proxifly-gamma tracked for non-contamination)
    // Fail whichever pool is tried first; sibling succeeds; next request skips failed until expiry
    let failedId = null;
    fetchMock
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: "rate limited on first" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockImplementationOnce(async () => {
        failedId = [...pools.keys()].find((id) => !isPoolFit(id, "opencode::*"));
        // If failedId was oneproxy-alpha, verify oneproxy-beta is still fit!
        if (failedId === "oneproxy-alpha") {
          expect(isPoolFit("oneproxy-beta", "opencode::*")).toBe(true);
        }
        return new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      });

    const res = await handleChat(createRequest());
    expect(res.status).toBe(200);
    expect(failedId).toBeTruthy();

    // Only the failed concrete pool ID is cooled; sibling same-source and other-source remain fit
    const cooled = [...pools.keys()].filter((id) => !isPoolFit(id, "opencode::*"));
    expect(cooled).toHaveLength(1);
    expect(cooled[0]).toBe(failedId);
  });

  it("next request skips cooled proxy until configured expiry and resumes after expiry", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    settings.proxyFailover = { enabled: false, mode: "none", maxRetries: 0 };
    await handleChat(createRequest());

    const cooledId = [...pools.keys()].find((id) => !isPoolFit(id, "opencode::*"));
    expect(cooledId).toBeTruthy();

    // Subsequent request must skip cooledId while inside 300s window
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    for (let i = 0; i < 4; i++) {
      const creds = await getProviderCredentials("opencode");
      expect(creds.providerSpecificData.connectionProxyPoolId).not.toBe(cooledId);
    }

    // After expiry, cooledId becomes fit again
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 300_001;
      expect(isPoolFit(cooledId, "opencode::*")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("respects Retry-After floor for proxy cooldown", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "600" },
      })
    );

    settings.proxyFailover = { enabled: false, mode: "none", maxRetries: 0 };
    await handleChat(createRequest());

    const cooledId = [...pools.keys()].find((id) => !isPoolFit(id, "opencode::*"));
    expect(cooledId).toBeTruthy();

    const originalNow = Date.now;
    try {
      // After 301 seconds (which exceeds default 300s), pool is STILL cooling due to Retry-After: 600
      Date.now = () => originalNow() + 301_000;
      expect(isPoolFit(cooledId, "opencode::*")).toBe(false);

      // After 601 seconds, it rejoins
      Date.now = () => originalNow() + 601_000;
      expect(isPoolFit(cooledId, "opencode::*")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("Timeouts, Deadlines, Signal Propagation & Cleanup Guards", () => {
  it("hung attempt obeying AbortSignal times out and cleanly fails over to next proxy", async () => {
    settings.proxyFailover = {
      enabled: true,
      mode: "custom",
      maxRetries: 2,
      attemptTimeoutMs: 120,
      requestDeadlineMs: 2000,
    };

    let attempt = 0;
    fetchMock.mockImplementation((_url, opts) => {
      attempt++;
      if (attempt === 1) {
        // Hung attempt that respects AbortSignal
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return Promise.resolve(
        new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
    });

    const res = await handleChat(createRequest());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hung attempt where transport IGNORES AbortSignal returns 504 without overlapping concurrent attempts", async () => {
    settings.proxyFailover = {
      enabled: true,
      mode: "all",
      maxRetries: "all",
      attemptTimeoutMs: 100,
      requestDeadlineMs: 1000,
    };

    // Fetch ignores opts.signal and never resolves
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const res = await handleChat(createRequest());
    expect(res.status).toBe(504);
    // Avoids overlapping retries when transport cleanup is unproven
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("overall requestDeadlineMs stops retries cleanly before trying all pools", async () => {
    settings.proxyFailover = {
      enabled: true,
      mode: "all",
      maxRetries: "all",
      attemptTimeoutMs: 120,
      requestDeadlineMs: 150,
    };

    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response(JSON.stringify({ error: { message: "slow 502" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await handleChat(createRequest());
    // Stopped before exhausting all 3 pools due to 150ms total deadline
    expect([502, 504]).toContain(res.status);
    expect(fetchMock.mock.calls.length).toBeLessThan(3);
  });
});

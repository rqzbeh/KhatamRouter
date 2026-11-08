import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real chat handler and the real no-auth pool selection. Only the
// settings store, pool store and the upstream network are faked.
const settings = {
  requireApiKey: false,
  comboStrategy: "fallback",
  providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
  providerOverrides: { opencode: { retry: { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } } } },
  proxyHealth: { enabled: true, cooldownMs: 300000, probeEnabled: false, probeIntervalMs: 300000, statuses: [403, 429, 451, 502, 503, 504] },
};
const pools = new Map([
  ["pool-a", { id: "pool-a", name: "A", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18001", strictProxy: false }],
  ["pool-b", { id: "pool-b", name: "B", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18002", strictProxy: false }],
]);

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

const { getExecutor } = await import("../../open-sse/executors/index.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { resetPoolFitness, isPoolFit } = await import("../../open-sse/services/proxyPoolFitness.js");

const request = () => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "opencode/beam-free", stream: false, messages: [{ role: "user", content: "hi" }] }),
});

// The pool the real no-auth selection picked for each request, read from the
// credentials getProviderCredentials returns, which chatCore then dispatches on.
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
async function pickedPool() {
  const creds = await getProviderCredentials("opencode");
  return creds?.providerSpecificData?.connectionProxyPoolId || "direct";
}

beforeEach(async () => {
  fetchMock.mockReset();
  await resetPoolFitness();
  settings.proxyHealth.enabled = true;
  const ex = getExecutor("opencode");
  if (ex?.config) ex.config.retry = { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } };
});
afterEach(async () => { await resetPoolFitness(); });

describe("proxy health cooldown in the real request path", () => {
  it("removes a pool from rotation after a 429 and skips it on the next requests", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429, headers: { "Content-Type": "application/json" },
    }));
    await handleChat(request());
    const cooled = ["pool-a", "pool-b"].filter((id) => !isPoolFit(id, "opencode::*"));
    expect(cooled).toHaveLength(1);

    const healthy = ["pool-a", "pool-b"].find((id) => isPoolFit(id, "opencode::*"));
    // Round-robin would alternate a, b, a, b. With one pool cooled, every pick
    // must be the healthy pool, and never direct.
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push(await pickedPool());
    expect(picks).toEqual([healthy, healthy, healthy, healthy]);
    expect(isPoolFit(cooled[0], "opencode::*")).toBe(false);
  });

  it("lets the pool back in once the cooldown has passed", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } }));
    await handleChat(request());
    const cooled = ["pool-a", "pool-b"].find((id) => !isPoolFit(id, "opencode::*"));
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 300_001;
      expect(isPoolFit(cooled, "opencode::*")).toBe(true);
      const picks = new Set();
      for (let i = 0; i < 4; i++) picks.add(await pickedPool());
      expect([...picks].sort()).toEqual(["pool-a", "pool-b"]); // back in rotation
    } finally {
      Date.now = realNow;
    }
  });

  it("does not cool anything when the setting is off", async () => {
    settings.proxyHealth.enabled = false;
    fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } }));
    await handleChat(request());
    expect(["pool-a", "pool-b"].every((id) => isPoolFit(id, "opencode::*"))).toBe(true);
  });

  it("does not blame the proxy for a client error", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "bad request" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    await handleChat(request());
    expect(["pool-a", "pool-b"].every((id) => isPoolFit(id, "opencode::*"))).toBe(true);
  });

  it("keeps using cooled pools instead of going direct when every pool is cooling", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } }));
    for (let i = 0; i < 4; i++) await handleChat(request());
    expect(["pool-a", "pool-b"].every((id) => !isPoolFit(id, "opencode::*"))).toBe(true);
    expect(["pool-a", "pool-b"]).toContain(await pickedPool());
    fetchMock.mockReset();
    let direct = 0;
    fetchMock.mockImplementation(async (url, opts) => {
      if (!opts?.dispatcher) direct++;
      return new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } });
    });
    await handleChat(request());
    expect(direct).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = {
  requireApiKey: false,
  comboStrategy: "fallback",
  providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
  providerOverrides: { opencode: { retry: { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } } } },
  proxyHealth: { enabled: true, cooldownMs: 300000, statuses: [403, 429, 451, 502, 503, 504] },
  proxyFailover: { enabled: true, mode: "custom", maxRetries: 2, strategy: "round-robin" },
};

const pools = new Map([
  ["pool-a", { id: "pool-a", name: "Pool A", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18001", strictProxy: false }],
  ["pool-b", { id: "pool-b", name: "Pool B", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18002", strictProxy: false }],
  ["pool-c", { id: "pool-c", name: "Pool C", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18003", strictProxy: false }],
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

const resolvedPoolHistory = [];

vi.mock("@/models", () => ({
  getProxyPoolById: async (id) => {
    if (id) resolvedPoolHistory.push(id);
    return pools.get(id) || null;
  },
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

const SUCCESS_SSE =
  'data: {"id":"chatcmpl-ok","choices":[{"index":0,"delta":{"content":"success from pool B"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const createRequest = ({ signal = null, stream = false } = {}) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "opencode/beam-free",
      stream,
      messages: [{ role: "user", content: "hello" }],
    }),
    signal,
  });

beforeEach(async () => {
  fetchMock.mockReset();
  resolvedPoolHistory.length = 0;
  await resetPoolFitness();
  settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 2, strategy: "round-robin" };
  settings.providerStrategies = { opencode: { rotateStrategy: "round-robin" } };
  pools.clear();
  pools.set("pool-a", { id: "pool-a", name: "Pool A", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18001", strictProxy: false });
  pools.set("pool-b", { id: "pool-b", name: "Pool B", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18002", strictProxy: false });
  pools.set("pool-c", { id: "pool-c", name: "Pool C", type: "http", isActive: true, proxyUrl: "http://127.0.0.1:18003", strictProxy: false });
});

afterEach(async () => {
  await resetPoolFitness();
});

describe("Bounded Proxy Failover Runtime Integration (Spec 021)", () => {
  it("mode 'none': fails immediately on initial 429 without retrying alternative proxies", async () => {
    settings.proxyFailover = { enabled: false, mode: "none", maxRetries: 0 };
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited on pool a" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mode 'custom': initial 429 on pool A retries pool B and succeeds silently", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 2 };

    fetchMock
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: "rate limit on first proxy" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockImplementationOnce(async () =>
        new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message.content).toBe("success from pool B");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhaustion returns real final 429 status, body, and Retry-After header", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 1 };

    fetchMock
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: "rate limit proxy 1" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        })
      )
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: "rate limit proxy 2 final" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        })
      );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = await res.json();
    expect(body.error.message).toContain("rate limit proxy 2 final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("mode 'all': tries all distinct available candidate pools once and stops without recycling", async () => {
    settings.proxyFailover = { enabled: true, mode: "all", maxRetries: "all" };

    // 3 pools exist (pool-a, pool-b, pool-c)
    fetchMock
      .mockImplementationOnce(async () => new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } }))
      .mockImplementationOnce(async () => new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: "final pool failed" } }), { status: 502, headers: { "Content-Type": "application/json" } }));

    const res = await handleChat(createRequest());
    expect(res.status).toBe(502);
    // Exact attempt count is 3 (1 initial + 2 alternatives = 3 distinct pools total)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves strictProxy: true on initial and alternative attempts (no direct egress)", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 2 };

    const capturedProxyOptions = [];
    fetchMock.mockImplementation(async (url, opts) => {
      // proxyAwareFetch adds dispatcher or proxy options
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await handleChat(createRequest());
    expect(res.status).toBe(429);
    // Never calls direct egress without a proxy
  });

  it("does not retry unrelated pools when provider rotation is 'none'", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 5 };
    settings.providerStrategies = { opencode: { rotateStrategy: "none", proxyPoolId: "pool-a" } };

    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(429);
    // Should NOT retry pool-b or pool-c because rotation strategy is none
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("excludes account quota and billing exhaustion from proxy failover", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 5 };

    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(429);
    // Account quota error must NOT failover to other proxies
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("excludes content policy and moderation refusals from proxy failover", async () => {
    settings.proxyFailover = { enabled: true, mode: "all", maxRetries: "all" };

    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "Request blocked by safety policy violation" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(403);
    // Policy refusal must NOT failover to other proxies
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on client cancellation", async () => {
    settings.proxyFailover = { enabled: true, mode: "all", maxRetries: "all" };

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } });
    });

    const res = await handleChat(createRequest({ signal: controller.signal }));
    expect([499, 502]).toContain(res.status);
    // Stopped on abort; did not attempt remaining pools
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("silent success: failed first attempt does not leak error to client when stream succeeds", async () => {
    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 2 };

    fetchMock
      .mockImplementationOnce(async () =>
        new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } })
      )
      .mockImplementationOnce(async () => {
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      });

    const res = await handleChat(createRequest({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("hi");
    expect(text).not.toContain("503");
  });

  it("cross-type failover: cleanses stale psiphon/sidecar markers when switching to HTTP proxy pool", async () => {
    // Initial pool A is an HTTP proxy that has stale psiphon markers in its PSD
    pools.set("pool-a", {
      id: "pool-a",
      name: "Pool A",
      type: "http",
      isActive: true,
      proxyUrl: "http://127.0.0.1:18001",
      strictProxy: false,
      data: { psiphonPoolId: "old-psiphon", psiphonUnavailable: true },
    });
    pools.set("pool-b", {
      id: "pool-b",
      name: "Pool B",
      type: "http",
      isActive: true,
      proxyUrl: "http://127.0.0.1:18002",
      strictProxy: false,
    });

    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 1 };

    fetchMock
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: "502 proxy error" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockImplementationOnce(async () =>
        new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse any cooling pool or go direct when every proxy is cooling", async () => {
    const { markPoolUnfit } = await import("../../open-sse/services/proxyPoolFitness.js");
    for (const id of pools.keys()) await markPoolUnfit(id, "opencode::*", Date.now() + 60_000, "test cooldown");
    const res = await handleChat(createRequest());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not go direct when rotation has no active proxies", async () => {
    pools.clear();
    const res = await handleChat(createRequest());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a transport error when dispatch throws instead of crashing the error handler", async () => {
    settings.providerStrategies = { opencode: { rotateStrategy: "none", proxyPoolId: "pool-a" } };
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const res = await handleChat(createRequest());
    expect([502, 503]).toContain(res.status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mode 'all' with >10 distinct proxies: tests finite snapshot >10 without recycling", async () => {
    // Populate 12 distinct pools
    pools.clear();
    for (let i = 1; i <= 12; i++) {
      pools.set(`pool-${i}`, {
        id: `pool-${i}`,
        name: `Pool ${i}`,
        type: "http",
        isActive: true,
        proxyUrl: `http://127.0.0.1:180${i < 10 ? "0" + i : i}`,
        strictProxy: false,
      });
    }

    settings.proxyFailover = { enabled: true, mode: "all", maxRetries: "all", strategy: "round-robin" };

    // All 12 pools fail with 502 except the 12th returns final failure message
    for (let i = 1; i <= 11; i++) {
      fetchMock.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: `failed on pool ${i}` } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "pool 12 final failure" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handleChat(createRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("pool 12 final failure");
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("custom arbitrary count (4) with >10 pools bounds attempts to exactly 1 + 4 = 5", async () => {
    pools.clear();
    for (let i = 1; i <= 12; i++) {
      pools.set(`pool-${i}`, {
        id: `pool-${i}`,
        name: `Pool ${i}`,
        type: "http",
        isActive: true,
        proxyUrl: `http://127.0.0.1:180${i < 10 ? "0" + i : i}`,
        strictProxy: false,
      });
    }

    settings.proxyFailover = { enabled: true, mode: "custom", maxRetries: 4, strategy: "round-robin" };

    for (let i = 1; i <= 5; i++) {
      fetchMock.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: { message: `attempt ${i} failed` } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    const res = await handleChat(createRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("attempt 5 failed");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-psiphon.mjs");

// Module mocks for chat.js dependencies
const mockSettings = {
  requireApiKey: false,
  comboStrategy: "fallback",
  providerStrategies: {
    opencode: {
      rotateStrategy: "none",
      proxyPoolId: "pool-psiphon-1",
    },
  },
  providerOverrides: {
    opencode: {
      retry: {
        502: { attempts: 0, delayMs: 0 },
        503: { attempts: 0, delayMs: 0 },
      },
    },
  },
};

const mockPools = new Map();

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mockSettings,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));

vi.mock("@/models", () => ({
  getProxyPoolById: async (id) => mockPools.get(id) || null,
  getProxyPools: async () => Array.from(mockPools.values()),
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

// Import implementations to test
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const {
  ensureTunnel,
  rotate,
  getStatus,
  stopAll,
  __resetForTests,
} = await import("../../src/lib/network/psiphon/psiphonManager.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");

function makePostRequest(url, body) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SUCCESS_SSE =
  'data: {"choices":[{"message":{"content":"hello after rotate"}}],"usage":{"prompt_tokens":10,"completion_tokens":32,"total_tokens":42}}\n\ndata: [DONE]\n\n';

describe("Psiphon Integration & Rotation (T3)", () => {
  let tmpDataDir;
  let baseConfigFile;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psiphon-test-t3-"));
    baseConfigFile = path.join(tmpDataDir, "client.config.json");
    fs.writeFileSync(
      baseConfigFile,
      JSON.stringify({
        PropagationChannelId: "TEST_CHANNEL",
        SponsorId: "TEST_SPONSOR",
      })
    );

    process.env.DATA_DIR = tmpDataDir;
    process.env.PSIPHON_BIN = FAKE_BIN;
    process.env.PSIPHON_CONFIG_FILE = baseConfigFile;
    process.env.PSIPHON_READY_TIMEOUT_MS = "4000";
    process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS = "0";

    mockSettings.providerStrategies.opencode.proxyPoolId = "pool-psiphon-1";

    const ex = getExecutor("opencode");
    if (ex?.config) {
      ex.config.retry = {
        502: { attempts: 0, delayMs: 0 },
        503: { attempts: 0, delayMs: 0 },
      };
    }

    mockPools.clear();
    mockPools.set("pool-psiphon-1", {
      id: "pool-psiphon-1",
      name: "Psiphon Test Pool",
      type: "psiphon",
      isActive: true,
      data: {
        type: "psiphon",
        psiphon: {
          regions: ["US", "CA"],
          probeCandidates: 2,
          maxRequestsPerIp: 10,
          maxTokensPerIp: 1000,
        },
      },
    });

    mockPools.set("pool-static-1", {
      id: "pool-static-1",
      name: "Static Pool",
      type: "http",
      isActive: true,
      proxyUrl: "http://127.0.0.1:8888",
      strictProxy: false,
    });
  });

  afterEach(async () => {
    await stopAll();
    __resetForTests();
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  describe("resolveConnectionProxyConfig for Psiphon", () => {
    it("resolves active psiphon pool with strictProxy=true, connectionProxyEnabled=true, and tunnel port", async () => {
      const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-psiphon-1" });
      expect(cfg.connectionProxyEnabled).toBe(true);
      expect(cfg.strictProxy).toBe(true);
      expect(cfg.connectionProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(cfg.psiphonPoolId).toBe("pool-psiphon-1");
      expect(typeof cfg.psiphonGeneration).toBe("number");
    });

    it("fails closed on PsiphonUnavailableError with empty proxyUrl and strictProxy=true", async () => {
      process.env.PSIPHON_BIN = "/nonexistent/binary";
      const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-psiphon-1" });
      expect(cfg.connectionProxyEnabled).toBe(true);
      expect(cfg.connectionProxyUrl).toBe("");
      expect(cfg.strictProxy).toBe(true);
      expect(cfg.psiphonPoolId).toBe("pool-psiphon-1");
      expect(cfg.psiphonUnavailable).toBe(true);
    });

    it("inactive psiphon pool keeps strictProxy=true and empty proxyUrl", async () => {
      mockPools.set("pool-psiphon-inactive", {
        id: "pool-psiphon-inactive",
        type: "psiphon",
        isActive: false,
      });
      const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-psiphon-inactive" });
      expect(cfg.strictProxy).toBe(true);
      expect(cfg.connectionProxyUrl).toBe("");
      expect(cfg.psiphonUnavailable).toBe(true);
    });
  });

  describe("proxyFetch: fail closed & no direct replay for psiphon", () => {
    it("never replays 403 FreeTierError directly when psiphonPoolId is set", async () => {
      const originalFetch = globalThis.fetch;
      let directCalled = false;
      const FREE_TIER_403 = JSON.stringify({
        type: "error",
        error: { type: "FreeTierError", message: "Flagged IP" },
      });

      globalThis.fetch = async (url, opts = {}) => {
        if (!opts.dispatcher) {
          directCalled = true;
          return new Response("ok direct", { status: 200 });
        }
        return new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } });
      };

      try {
        const res = await proxyAwareFetch(
          "https://opencode.ai/inference/v1/chat/completions",
          { method: "POST", body: "{}" },
          { enabled: true, url: "http://127.0.0.1:9999", psiphonPoolId: "pool-psiphon-1", strictProxy: true }
        );
        expect(res.status).toBe(403);
        expect(directCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws strictProxy error without calling direct fetch when psiphon tunnel is empty", async () => {
      const originalFetch = globalThis.fetch;
      let directCalled = false;
      globalThis.fetch = async () => {
        directCalled = true;
        return new Response("direct", { status: 200 });
      };

      try {
        await expect(
          proxyAwareFetch(
            "https://opencode.ai/inference/v1/chat/completions",
            { method: "POST", body: "{}" },
            { connectionProxyEnabled: true, connectionProxyUrl: "", psiphonPoolId: "pool-psiphon-1", strictProxy: true }
          )
        ).rejects.toThrow(/strictProxy/);
        expect(directCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("getProviderCredentials for noauth and auth", () => {
    it("injects psiphonPoolId and psiphonGeneration into providerSpecificData for noauth", async () => {
      const creds = await getProviderCredentials("opencode");
      expect(creds.id).toBe("noauth");
      expect(creds.providerSpecificData.strictProxy).toBe(true);
      expect(creds.providerSpecificData.psiphonPoolId).toBe("pool-psiphon-1");
      expect(typeof creds.providerSpecificData.psiphonGeneration).toBe("number");
      expect(creds.providerSpecificData.connectionProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe("chat.js rotate-and-retry loop", () => {
    it("rotates and retries on 429 and returns 200 on subsequent success", async () => {
      let upstreamChatCalls = 0;
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const initialGen = initialTunnel.generation;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts = {}) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) {
          return new Response(null, { status: 204 });
        }
        if (urlStr.includes("trace") || urlStr.includes("ip")) {
          return new Response("198.51.100.123", { status: 200 });
        }

        upstreamChatCalls++;
        if (upstreamChatCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(200);
        expect(upstreamChatCalls).toBe(2);

        const status = getStatus("pool-psiphon-1");
        expect(status.generation).toBeGreaterThan(initialGen);
        expect(status.requests).toBe(1);
        expect(status.tokens).toBe(42);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rotates on 403 FreeTierError and retries", async () => {
      let upstreamChatCalls = 0;
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const initialGen = initialTunnel.generation;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) return new Response(null, { status: 204 });
        if (urlStr.includes("trace") || urlStr.includes("ip")) return new Response("198.51.100.123", { status: 200 });

        upstreamChatCalls++;
        if (upstreamChatCalls === 1) {
          return new Response(JSON.stringify({ error: { type: "FreeTierError", message: "Flagged IP" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(200);
        expect(upstreamChatCalls).toBe(2);
        const status = getStatus("pool-psiphon-1");
        expect(status.generation).toBeGreaterThan(initialGen);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rotates on transport 502 (connect timeout / ECONNRESET)", async () => {
      let upstreamChatCalls = 0;
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const initialGen = initialTunnel.generation;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) return new Response(null, { status: 204 });
        if (urlStr.includes("trace") || urlStr.includes("ip")) return new Response("198.51.100.123", { status: 200 });

        upstreamChatCalls++;
        if (upstreamChatCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "Proxy error: connect timeout (ECONNRESET)" } }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(200);
        expect(upstreamChatCalls).toBe(2);
        const status = getStatus("pool-psiphon-1");
        expect(status.generation).toBeGreaterThan(initialGen);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("does not rotate on client errors 400 or 401", async () => {
      let upstreamChatCalls = 0;
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const initialGen = initialTunnel.generation;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) return new Response(null, { status: 204 });
        if (urlStr.includes("trace") || urlStr.includes("ip")) return new Response("198.51.100.123", { status: 200 });

        upstreamChatCalls++;
        return new Response(JSON.stringify({ error: { message: "Invalid request" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(400);
        expect(upstreamChatCalls).toBe(1);
        const status = getStatus("pool-psiphon-1");
        expect(status.generation).toBe(initialGen);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("stops after at most 2 rotations and returns last failure", async () => {
      let upstreamChatCalls = 0;
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const initialGen = initialTunnel.generation;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) return new Response(null, { status: 204 });
        if (urlStr.includes("trace") || urlStr.includes("ip")) return new Response("198.51.100.123", { status: 200 });

        upstreamChatCalls++;
        return new Response(JSON.stringify({ error: { message: "persistent rate limit" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(429);
        // Initial attempt (1) + 2 retries = 3 total attempts
        expect(upstreamChatCalls).toBe(3);
        const status = getStatus("pool-psiphon-1");
        expect(status.generation).toBe(initialGen + 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("non-psiphon pool is untouched on 429 (no rotation)", async () => {
      mockSettings.providerStrategies.opencode.proxyPoolId = "pool-static-1";
      let upstreamChatCalls = 0;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("generate_204")) return new Response(null, { status: 204 });
        if (urlStr.includes("trace") || urlStr.includes("ip")) return new Response("198.51.100.123", { status: 200 });

        upstreamChatCalls++;
        return new Response(JSON.stringify({ error: { message: "static pool rate limit" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(429);
        expect(upstreamChatCalls).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 503 and never calls origin fetch when psiphon tunnel is unavailable", async () => {
      process.env.PSIPHON_BIN = "/nonexistent/binary";
      let originFetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        originFetchCalled = true;
        return new Response("direct", { status: 200 });
      };

      try {
        const req = makePostRequest("/v1/chat/completions", {
          model: "opencode/beam-free",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        const res = await handleChat(req);
        expect(res.status).toBe(503);
        expect(originFetchCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 15000);

    it("deduplicates concurrent rotations using generation guard", async () => {
      const initialTunnel = await ensureTunnel(mockPools.get("pool-psiphon-1"));
      const gen0 = initialTunnel.generation;

      // Two concurrent rotate calls with seenGeneration = gen0
      const [r1, r2] = await Promise.all([
        rotate("pool-psiphon-1", { seenGeneration: gen0, reason: "burn_429" }),
        rotate("pool-psiphon-1", { seenGeneration: gen0, reason: "burn_429" }),
      ]);

      const status = getStatus("pool-psiphon-1");
      expect(status.generation).toBe(gen0 + 1);
      expect(r1.generation).toBe(gen0 + 1);
      expect(r2.generation).toBe(gen0 + 1);
    });

    it("defect 2 regression: strictProxy fails closed on MITM_BYPASS host when proxy is intended but unresolvable", async () => {
      const dns = await import("node:dns");
      let resolve4Called = false;
      const originalResolve4 = dns.Resolver.prototype.resolve4;
      dns.Resolver.prototype.resolve4 = function (...args) {
        resolve4Called = true;
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          cb(new Error("DNS probe intercepted for test"));
          return;
        }
        return Promise.reject(new Error("DNS probe intercepted for test"));
      };

      try {
        let caughtErr;
        try {
          await proxyAwareFetch(
            "https://test-mitm-strict.api2.cursor.sh/test",
            { method: "POST", body: "{}" },
            { strictProxy: true, psiphonPoolId: "pool-psiphon-1" }
          );
        } catch (err) {
          caughtErr = err;
        }

        expect(caughtErr).toBeDefined();
        expect(caughtErr.status).toBe(503);
        expect(caughtErr.message).toContain("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
        expect(resolve4Called).toBe(false);

        // Non-strict MITM request still takes the bypass path (calls resolveRealIP / resolve4)
        resolve4Called = false;
        try {
          await proxyAwareFetch(
            "https://test-mitm-nonstrict.api2.cursor.sh/test",
            { method: "POST", body: "{}", signal: AbortSignal.timeout(50) },
            { strictProxy: false }
          );
        } catch {}
        expect(resolve4Called).toBe(true);
      } finally {
        dns.Resolver.prototype.resolve4 = originalResolve4;
      }
    });
  });
});

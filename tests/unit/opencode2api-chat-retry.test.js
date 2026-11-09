// Spec 018: chat.js retry semantics for a managed opencode2api sidecar.
//
// The daemon rotates its own WARP exits, so a quota signal (429/403) must be
// retried against the SAME daemon — a restart would throw away the whole WARP
// pool and cost a multi-second rebuild. A restart is reserved for a daemon that
// is actually gone (unavailable / no loopback URL) or degraded by a transport
// failure, and it is bounded so a permanently dead daemon cannot loop.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-opencode2api.mjs");

const mockSettings = {
  requireApiKey: false,
  comboStrategy: "fallback",
  providerStrategies: {
    opencode: { rotateStrategy: "none", proxyPoolId: "pool-o2a-1" },
  },
  providerOverrides: {
    opencode: {
      retry: { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } },
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

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const {
  sidecarSpawnCount,
  __resetSidecarSpawnCount,
} = await import("../../src/lib/network/opencode2api/sidecarManager.js");

const SUCCESS_SSE =
  'data: {"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';

function makePostRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "opencode/beam-free",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

describe("chat.js sidecar retry semantics", () => {
  let tmpDataDir;
  let spawnBehaviour;
  let spawnAttempts = 0;
  const prevEnv = {};
  const ENV_KEYS = [
    "DATA_DIR",
    "DATA_DIR_ALLOW_TEMP",
    "OPENCODE2API_BIN",
    "OPENCODE2API_READY_TIMEOUT_MS",
    "OPENCODE2API_HEALTH_INTERVAL_MS",
  ];

  beforeEach(async () => {
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key];

    fetchMock.mockReset();
    // The suite spawned through the real binary path, which does not exist
    // on a dev machine; point it at the fake daemon fixture.
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-chat-test-"));
    process.env.DATA_DIR = tmpDataDir;
    process.env.DATA_DIR_ALLOW_TEMP = "1";
    process.env.OPENCODE2API_BIN = FAKE_BIN;
    process.env.OPENCODE2API_READY_TIMEOUT_MS = "8000";

    // The fixture is a script with a bun shebang; run it through the current
    // runtime so the test exercises the real spawn/exit/watchdog path.
    const { __setSpawnForTests } = await import(
      "../../src/lib/network/opencode2api/sidecarManager.js"
    );
    __setSpawnForTests((binPath, args, options) => {
      // The fixture is not chmod +x; run it through the current runtime, but
      // let a test force a hard spawn failure by pointing at a bogus binary.
      if (spawnBehaviour === "missing") {
        return spawn("/nonexistent/opencode2api", args, options);
      }
      if (spawnBehaviour === "fail-first") {
        if (spawnAttempts === 0) {
          spawnAttempts++;
          return spawn("/nonexistent/opencode2api", args, options);
        }
        spawnAttempts++;
      }
      return spawn(process.execPath, [FAKE_BIN, ...args], options);
    });

    __resetSidecarSpawnCount();

    // The supervisor probes /healthz with globalThis.fetch, which is mocked
    // here. Route only the health probe to the real fetch so the mock records
    // exactly the requests that the gateway sent.
    const { __setHealthFetchForTests } = await import(
      "../../src/lib/network/opencode2api/sidecarManager.js"
    );
    __setHealthFetchForTests(async (url) => {
      try {
        const res = await realFetch(url);
        return await res.json();
      } catch {
        return null;
      }
    });

    mockPools.clear();
    mockPools.set("pool-o2a-1", {
      id: "pool-o2a-1",
      name: "Managed Sidecar",
      type: "opencode2api",
      isActive: true,
      proxyUrl: "opencode2api://managed",
      data: { type: "opencode2api", opencode2api: { poolSize: 2, warmStandby: 1 } },
    });

    const ex = getExecutor("opencode");
    if (ex?.config) {
      ex.config.retry = { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } };
    }
  });

  afterEach(async () => {
    const { stopSidecar, __resetForTests } = await import(
      "../../src/lib/network/opencode2api/sidecarManager.js"
    );
    await stopSidecar("pool-o2a-1");
    await __resetForTests();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("retries a 429 against the same daemon without respawning it", async () => {
    let upstreamCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      // The request must have been rewritten onto the loopback sidecar.
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(SUCCESS_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const res = await handleChat(makePostRequest());

    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    // One spawn for the whole request: the 429 never tore the daemon down.
    expect(sidecarSpawnCount()).toBe(1);
  }, 25000);

  it("restarts a daemon that died, then serves the retry", async () => {
    // First launch cannot find the binary → the pass fails closed as
    // unavailable; chat.js must restart and the second launch succeeds.
    spawnBehaviour = "fail-first";
    spawnAttempts = 0;

    let upstreamCalls = 0;
    fetchMock.mockImplementation(async () => {
      upstreamCalls++;
      return new Response(SUCCESS_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const res = await handleChat(makePostRequest());

    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(sidecarSpawnCount()).toBe(2);
  }, 25000);

  it("gives up after a bounded number of restarts when the daemon never comes up", async () => {
    fetchMock.mockResolvedValue(
      new Response(SUCCESS_SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );
    spawnBehaviour = "missing";

    const res = await handleChat(makePostRequest());

    // Bounded: the two sidecar restarts plus the fallback attempt that follows
    // must not spiral. Anything above 4 means the budget leaked.
    expect(sidecarSpawnCount()).toBeGreaterThanOrEqual(3);
    expect(sidecarSpawnCount()).toBeLessThanOrEqual(4);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 20000);
});
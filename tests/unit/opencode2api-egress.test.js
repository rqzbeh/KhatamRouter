// Spec 018 egress contract for the bundled opencode2api sidecar.
//
// The daemon is not an HTTP proxy: it is a local origin that serves `/v1/*`
// and maps it onto the anonymous OpenCode upstream itself. Three things must
// therefore hold and are asserted here against a real loopback listener:
//
// 1. The resolver returns a loopback URL plus the per-spawn local key, is
//    strict by construction, and fails closed when the daemon is unavailable.
// 2. proxyAwareFetch rewrites the URL onto the sidecar, strips the upstream
//    `/inference` segment, REPLACES Authorization with the local key and sends
//    the body byte-identically.
// 3. A strict sidecar pool never lets the request leave over the server IP.
//
// A real listener is used because proxyFetch captures globalThis.fetch at
// module load, so patching it after import has no effect on the native path.
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
}));

vi.mock("@/lib/network/opencode2api/sidecarManager.js", async (orig) => {
  const actual = await orig();
  return { ...actual, ensureSidecar: vi.fn() };
});

const { getProxyPoolById } = await import("@/models");
const { ensureSidecar } = await import("@/lib/network/opencode2api/sidecarManager.js");
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const sidecarPool = {
  id: "pool-1",
  type: "opencode2api",
  isActive: true,
  proxyUrl: "opencode2api://managed",
  data: { type: "opencode2api", opencode2api: { poolSize: 3, warmStandby: 2, retryAttempts: 4 } },
};

// Minimal stand-in for the daemon: records exactly what reached it.
const received = [];
let server;
let baseUrl;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      received.push({
        path: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        allHeaders: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  vi.clearAllMocks();
  received.length = 0;
});

describe("resolver returns the sidecar contract", () => {
  it("returns source opencode2api, loopback url, key and generation, strict", async () => {
    getProxyPoolById.mockResolvedValue(sidecarPool);
    ensureSidecar.mockResolvedValue({ proxyUrl: baseUrl, apiKey: "abc123", generation: 7, health: { ready: true } });

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });

    expect(cfg.source).toBe("opencode2api");
    expect(cfg.strictProxy).toBe(true);
    expect(cfg.opencodeSidecarUrl).toBe(baseUrl);
    expect(cfg.opencodeSidecarKey).toBe("abc123");
    expect(cfg.opencodeSidecarGeneration).toBe(7);
    // The sidecar is not an HTTP_PROXY proxy.
    expect(cfg.connectionProxyUrl).toBe("");
    expect(cfg.opencodeSidecarPoolId).toBe("pool-1");
    expect(ensureSidecar).toHaveBeenCalledWith(sidecarPool);
  });

  it("fails closed when the daemon cannot start", async () => {
    getProxyPoolById.mockResolvedValue(sidecarPool);
    ensureSidecar.mockRejectedValue(new Error("boom"));

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });

    expect(cfg.strictProxy).toBe(true);
    expect(cfg.opencodeSidecarUrl).toBe("");
    expect(cfg.opencodeSidecarUnavailable).toBe(true);
    expect(cfg.opencodeSidecarGeneration).toBe(-1);
  });

  it("fails closed for an inactive sidecar pool without spawning", async () => {
    getProxyPoolById.mockResolvedValue({ ...sidecarPool, isActive: false });

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });

    expect(cfg.strictProxy).toBe(true);
    expect(cfg.opencodeSidecarUnavailable).toBe(true);
    expect(ensureSidecar).not.toHaveBeenCalled();
  });
});

describe("proxyAwareFetch rewrites onto the sidecar", () => {
  it("rewrites the url, strips /inference and replaces Authorization", async () => {
    const body = '{"model":"glm-5.3-flash-free","messages":[]}';
    await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: "Bearer public", "content-type": "application/json" },
        body,
      },
      { opencodeSidecarPoolId: "pool-1", opencodeSidecarUrl: baseUrl, opencodeSidecarKey: "local-key" }
    );

    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/v1/chat/completions");
    expect(received[0].authorization).toBe("Bearer local-key");
    expect(JSON.stringify(received[0].allHeaders)).not.toContain("Bearer public");
    // Body must be byte-identical, never re-serialized.
    expect(received[0].body).toBe(body);
  });

  it("keeps the query string and handles the /responses and /messages lanes", async () => {
    await proxyAwareFetch(
      "https://opencode.ai/inference/v1/messages?beta=true",
      { method: "POST", headers: {} },
      { opencodeSidecarPoolId: "p", opencodeSidecarUrl: `${baseUrl}/`, opencodeSidecarKey: "k" }
    );
    await proxyAwareFetch(
      "https://opencode.ai/inference/v1/responses",
      { method: "POST", headers: {} },
      { opencodeSidecarPoolId: "p", opencodeSidecarUrl: baseUrl, opencodeSidecarKey: "k" }
    );

    expect(received.map((r) => `${r.path}${r.search}`)).toEqual([
      "/v1/messages?beta=true",
      "/v1/responses",
    ]);
  });

  it("drops x-api-key so only the local bearer authenticates the daemon", async () => {
    await proxyAwareFetch(
      "https://opencode.ai/inference/v1/messages",
      { method: "POST", headers: { Authorization: "Bearer public", "x-api-key": "public" } },
      { opencodeSidecarPoolId: "p", opencodeSidecarUrl: baseUrl, opencodeSidecarKey: "k" }
    );

    expect(received[0].authorization).toBe("Bearer k");
    expect(received[0].allHeaders["x-api-key"]).toBeUndefined();
  });

  it("fails closed with 503 when the sidecar url is empty", async () => {
    await expect(
      proxyAwareFetch(
        "https://opencode.ai/inference/v1/chat/completions",
        {},
        { opencodeSidecarPoolId: "p", opencodeSidecarUrl: "", strictProxy: true }
      )
    ).rejects.toMatchObject({ status: 503 });
  });

  it("does not treat the sidecar as a relay or an HTTP proxy", async () => {
    await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: {} },
      {
        opencodeSidecarPoolId: "p",
        opencodeSidecarUrl: baseUrl,
        opencodeSidecarKey: "k",
        // Both are also present; the sidecar branch must win.
        vercelRelayUrl: "https://relay.example.com",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:7890",
        proxyPoolId: "p",
      }
    );

    expect(received).toHaveLength(1);
    expect(received[0].allHeaders["x-relay-target"]).toBeUndefined();
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

const { connection, node, proxy } = vi.hoisted(() => ({ connection: vi.fn(), node: vi.fn(), proxy: vi.fn(async () => ({})) }));
vi.mock("@/lib/network/connectionProxy.js", () => ({ resolveConnectionProxyConfig: proxy }));
vi.mock("@/models", () => ({
  getProviderConnectionById: connection,
  getProviderNodeById: node,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => true }));
const { GET } = await import("@/app/api/providers/[id]/models/route.js");
const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  proxy.mockResolvedValue({});
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

describe("persisted gateway authority", () => {
  it("does not bypass an assigned relay when model discovery cannot honor it", async () => {
    let directHits = 0;
    const origin = await serve((req, res) => {
      directHits++;
      res.setHeader("Content-Type", "application/json");
      res.end('{"data":[]}');
    });
    const provider = "openai-compatible-chat-review";
    node.mockResolvedValue({ id: provider, baseUrl: `${origin}/v1`, isSelfHosted: true });
    connection.mockResolvedValue({ id: "relay-review", provider, apiKey: "review-only",
      providerSpecificData: { baseUrl: `${origin}/v1`, proxyPoolId: "relay-fixture" } });
    proxy.mockResolvedValue({ vercelRelayUrl: "https://relay.invalid", strictProxy: false,
      connectionProxyEnabled: false, source: "vercel" });
    const response = await GET(new Request("http://localhost/api/providers/relay-review/models"), {
      params: Promise.resolve({ id: "relay-review" }),
    });
    expect(directHits).toBe(0);
    expect(response.status).toBe(503);
  });

  it("does not grant private target authority from a connection URL that differs from its trusted node", async () => {
    let unauthorizedReached = false;
    const trusted = await serve((req, res) => res.end("{}"));
    const unauthorized = await serve((req, res) => {
      unauthorizedReached = true;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "unauthorized" }] }));
    });
    node.mockResolvedValue({
      id: "openai-compatible-chat-review", baseUrl: `${trusted}/v1`, isSelfHosted: true,
    });
    connection.mockResolvedValue({
      id: "review", provider: "openai-compatible-chat-review", apiKey: "review-fixture-only",
      providerSpecificData: { baseUrl: `${unauthorized}/v1` },
    });
    const response = await GET(new Request("http://localhost/api/providers/review/models"), {
      params: Promise.resolve({ id: "review" }),
    });
    expect(unauthorizedReached).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

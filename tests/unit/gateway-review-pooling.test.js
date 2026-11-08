import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestOriginServer } from "../integration/fixtures/proxy-reliability/testServer.js";

const { resolvePublic, resolveConnect } = vi.hoisted(() => ({
  resolvePublic: vi.fn(), resolveConnect: vi.fn(),
}));
vi.mock("node:dns", async () => {
  const actual = await vi.importActual("node:dns");
  return { ...actual, default: { ...actual.default, lookup: resolveConnect,
    promises: { ...actual.promises, lookup: resolvePublic } } };
});
const { fetchGateway, createScopedTlsAgent } = await import("@/lib/network/gatewayTrust.js");
let origin;
let agent;
let previousCa;
afterEach(async () => {
  if (agent) { agent.destroy(); agent.options.ca = previousCa; }
  if (origin) { origin.server.closeAllConnections(); await origin.close(); }
});

describe("independent gateway pooled connection authority", () => {
  it("does not reuse a privately authorized socket for an unprivileged public request", async () => {
    origin = await createTestOriginServer({ hostname: "pool-review.example" });
    const url = `https://pool-review.example:${origin.port}`;
    agent = createScopedTlsAgent();
    previousCa = agent.options.ca;
    agent.options.ca = origin.certPem;
    resolvePublic.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    resolveConnect.mockImplementation((host, options, callback) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    });
    const first = await fetchGateway(url, { signal: AbortSignal.timeout(2000) }, {
      isSelfHosted: true, authorizedOrigin: new URL(url).origin,
    });
    await first.text();
    expect(origin.getRequestsCount()).toBe(1);
    // Let the HTTP agent return the socket to its free pool.
    await new Promise((resolve) => setImmediate(resolve));
    let rejected = false;
    try {
      const second = await fetchGateway(url, { signal: AbortSignal.timeout(2000) });
      await second.text();
    } catch { rejected = true; }
    expect(origin.getRequestsCount()).toBe(1);
    expect(rejected).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createTestOriginServer } from "../integration/fixtures/proxy-reliability/testServer.js";
import { fetchGateway } from "@/lib/network/gatewayTrust.js";

const origins = [];
afterEach(async () => {
  await Promise.all(origins.splice(0).map(async (origin) => {
    origin.server.closeAllConnections();
    await origin.close();
  }));
});

describe("independent actual TLS gateway verification", () => {
  it("rejects a self-signed certificate by default but permits the explicitly authorized local exception", async () => {
    const origin = await createTestOriginServer({ hostname: "localhost" });
    origins.push(origin);
    const url = `https://127.0.0.1:${origin.port}`;
    const trust = { isSelfHosted: true, trustedHost: new URL(url).host };
    await expect(fetchGateway(url, { signal: AbortSignal.timeout(2000) }, trust)).rejects.toThrow();
    expect(origin.getRequestsCount()).toBe(0);
    const response = await fetchGateway(url, { signal: AbortSignal.timeout(2000) }, {
      ...trust, allowInsecureTls: true,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(origin.getRequestsCount()).toBe(1);
  });
});

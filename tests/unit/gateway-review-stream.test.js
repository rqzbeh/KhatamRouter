import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { fetchGateway } from "@/lib/network/gatewayTrust.js";
let server;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function serve(handler) {
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
describe("independent gateway stream bounds", () => {
  it("aborts an active body read after headers without leaving the socket open", async () => {
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    const url = await serve((req, res) => {
      res.writeHead(200);
      res.write("first chunk");
      res.on("close", closed);
    });
    const controller = new AbortController();
    const response = await fetchGateway(url, { signal: controller.signal }, {
      isSelfHosted: true, authorizedOrigin: new URL(url).origin,
    });
    const body = response.text();
    controller.abort();
    await expect(body).rejects.toThrow();
    const didClose = await Promise.race([
      disconnected.then(() => true),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 1000); timer.unref(); }),
    ]);
    expect(didClose).toBe(true);
  });
  it("rejects an oversized response body", async () => {
    const url = await serve((req, res) => res.end("a".repeat(1024)));
    const response = await fetchGateway(url, { signal: AbortSignal.timeout(2000) }, {
      isSelfHosted: true, authorizedOrigin: new URL(url).origin, maxResponseBytes: 64,
    });
    await expect(response.text()).rejects.toThrow(/limit|large|maximum/i);
  });
});

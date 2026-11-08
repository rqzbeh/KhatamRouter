import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { assertGatewayUrlAllowed, fetchGateway, normalizeHeaders } from "@/lib/network/gatewayTrust.js";

const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

describe("independent gateway trust regression review", () => {
  it.each(["192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1"])(
    "refuses reserved non-public IPv4 range %s", async (address) => {
      await expect(assertGatewayUrlAllowed(`http://${address}/models`)).rejects.toThrow();
    },
  );

  it("preserves standard array-pair headers", () => {
    expect(normalizeHeaders([["Authorization", "Bearer review-fixture-only"]]))
      .toEqual({ Authorization: "Bearer review-fixture-only" });
  });

  it.each(["file:///etc/hosts", "ftp://127.0.0.1/models", "http://user:password@127.0.0.1/models"])(
    "refuses unsupported schemes or embedded credentials: %s", async (url) => {
      await expect(assertGatewayUrlAllowed(url, {
        isSelfHosted: true,
        trustedHost: new URL(url).host,
      })).rejects.toThrow();
    },
  );
  it("does not follow a local gateway redirect to an undeclared port", async () => {
    let reached = false;
    const other = await serve((req, res) => {
      reached = true;
      res.end("unrelated internal service");
    });
    const origin = await serve((req, res) => {
      res.writeHead(302, { Location: other });
      res.end();
    });
    let rejected = false;
    try {
      const response = await fetchGateway(origin, { signal: AbortSignal.timeout(2000) }, {
        isSelfHosted: true,
        trustedHost: new URL(origin).host,
      });
      await response.text();
    } catch {
      rejected = true;
    }
    expect(reached).toBe(false);
    expect(rejected).toBe(true);
  });

  it("supports successful no-content discovery validation responses", async () => {
    const origin = await serve((req, res) => {
      res.writeHead(204);
      res.end();
    });
    const response = await fetchGateway(origin, { signal: AbortSignal.timeout(2000) }, {
      isSelfHosted: true,
      trustedHost: new URL(origin).host,
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("supports Headers instances without silently dropping credentials", async () => {
    let authorization;
    const origin = await serve((req, res) => {
      authorization = req.headers.authorization;
      res.end("ok");
    });
    const response = await fetchGateway(origin, {
      headers: new Headers({ Authorization: "Bearer review-fixture-only" }),
      signal: AbortSignal.timeout(2000),
    }, { isSelfHosted: true, trustedHost: new URL(origin).host });
    await response.text();
    expect(authorization).toBe("Bearer review-fixture-only");
  });
});

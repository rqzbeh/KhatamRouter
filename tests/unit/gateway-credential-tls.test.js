import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", async () => {
  const actual = await vi.importActual("node:dns");
  return {
    ...actual,
    default: {
      ...actual.default,
      lookup: lookupMock,
      promises: { ...actual.promises, lookup: lookupMock },
    },
    lookup: lookupMock,
    promises: { ...actual.promises, lookup: lookupMock },
  };
});

const {
  fetchGateway,
  sanitizeGatewayError,
  createScopedTlsAgent,
} = await import("@/lib/network/gatewayTrust.js");

describe("Credential stripping across redirect (FR-063, SC-021)", () => {
  let serverA;
  let serverB;
  let portA;
  let portB;

  beforeEach(async () => {
    lookupMock.mockReset();
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      cb(null, [{ address: "127.0.0.1", family: 4 }]);
    });
  });

  afterEach(() => {
    if (serverA) serverA.close();
    if (serverB) serverB.close();
  });

  it("rejects an unsafe redirect from a declared local gateway to an undeclared internal port", async () => {
    serverB = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
    portB = serverB.address().port;

    serverA = http.createServer((req, res) => {
      // Attempt redirect to undeclared port B
      res.writeHead(302, { Location: `http://localhost:${portB}/target` });
      res.end();
    });
    await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
    portA = serverA.address().port;

    await expect(
      fetchGateway(`http://localhost:${portA}/source`, {
        headers: {
          Authorization: "Bearer sensitive-key-12345",
        },
      }, {
        isSelfHosted: true,
        trustedHost: `localhost:${portA}`,
      })
    ).rejects.toThrow(/target origin mismatch|blocked/i);
  });

  it("retains credentials on same-origin redirect", async () => {
    let step2Headers = null;

    serverA = http.createServer((req, res) => {
      if (req.url === "/step1") {
        res.writeHead(302, { Location: `http://localhost:${portA}/step2` });
        res.end();
      } else {
        step2Headers = req.headers;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ step: 2 }));
      }
    });
    await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
    portA = serverA.address().port;

    const res = await fetchGateway(`http://localhost:${portA}/step1`, {
      headers: {
        Authorization: "Bearer secret-token",
        "x-api-key": "secret-key",
      },
    }, {
      isSelfHosted: true,
      trustedHost: `localhost:${portA}`,
    });

    expect(res.status).toBe(200);
    expect(step2Headers.authorization).toBe("Bearer secret-token");
    expect(step2Headers["x-api-key"]).toBe("secret-key");
  });

  it("sanitizes secrets from error objects and message strings", () => {
    const rawError = new Error("Failed to connect with Bearer sk-live-secret123456789 to http://localhost");
    const sanitized = sanitizeGatewayError(rawError, ["sk-live-secret123456789"]);
    expect(sanitized.message).not.toContain("sk-live-secret123456789");
    expect(sanitized.message).toContain("[REDACTED]");
  });
});

describe("Gateway TLS verification & scoped relaxation (FR-063a, SC-024)", () => {
  it("rejects allowInsecureTls when isSelfHosted is false", () => {
    expect(() => {
      createScopedTlsAgent({ isSelfHosted: false, allowInsecureTls: true });
    }).toThrow(/insecure tls.*only.*self-hosted/i);
  });

  it("leaves global process.env.NODE_TLS_REJECT_UNAUTHORIZED untouched", () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    createScopedTlsAgent({ isSelfHosted: true, allowInsecureTls: true });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });

  it("returns strict agent with rejectUnauthorized=true by default", () => {
    const agent = createScopedTlsAgent({ isSelfHosted: true, allowInsecureTls: false });
    expect(agent.options.rejectUnauthorized).toBe(true);
  });

  it("returns scoped agent with rejectUnauthorized=false only when explicitly permitted on self-hosted", () => {
    const agent = createScopedTlsAgent({ isSelfHosted: true, allowInsecureTls: true });
    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it("never enables insecure TLS when allowInsecureTls is false or omitted", () => {
    const agentDefault = createScopedTlsAgent();
    expect(agentDefault.options.rejectUnauthorized).toBe(true);
    const agentExplicit = createScopedTlsAgent({ isSelfHosted: true, allowInsecureTls: false });
    expect(agentExplicit.options.rejectUnauthorized).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  isGatewaySelfHostedAllowed,
  assertGatewayUrlAllowed,
} = await import("@/lib/network/gatewayTrust.js");

describe("isGatewaySelfHostedAllowed & local vs proxy evaluation", () => {
  it("allows self-hosted declaration when request is a trusted direct loopback caller", () => {
    process.env.NINEROUTER_PEER_TOKEN = "test-peer-token";
    const req = {
      headers: new Headers({
        host: "localhost:20128",
        "x-9r-peer-token": "test-peer-token",
        "x-9r-real-ip": "127.0.0.1",
      }),
    };
    const allowed = isGatewaySelfHostedAllowed({
      request: req,
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(allowed).toBe(true);
  });

  it("refuses self-hosted declaration when request came via reverse proxy (x-9r-via-proxy)", () => {
    const req = {
      headers: new Headers({
        host: "localhost:20128",
        "x-9r-via-proxy": "1",
      }),
    };
    const allowed = isGatewaySelfHostedAllowed({
      request: req,
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(allowed).toBe(false);
  });

  it("refuses self-hosted declaration when request came with untrusted forwarding headers", () => {
    const req = {
      headers: new Headers({
        host: "localhost:20128",
        "x-forwarded-for": "203.0.113.195",
      }),
    };
    const allowed = isGatewaySelfHostedAllowed({
      request: req,
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(allowed).toBe(false);
  });

  it("refuses self-hosted declaration when isSelfHosted flag is false even if request is local", () => {
    const req = {
      headers: new Headers({
        host: "localhost:20128",
      }),
    };
    const allowed = isGatewaySelfHostedAllowed({
      request: req,
      isSelfHosted: false,
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(allowed).toBe(false);
  });
});

describe("Background authorization (no request context)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("authorizes background work for persisted isSelfHosted pinned strictly to declared host", async () => {
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      cb(null, [{ address: "127.0.0.1", family: 4 }]);
    });

    const node = {
      id: "node-ollama",
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434",
    };

    // Background call: request is undefined
    const check = assertGatewayUrlAllowed("http://127.0.0.1:11434/api/tags", {
      isSelfHosted: node.isSelfHosted,
      authorizedOrigin: "http://127.0.0.1:11434",
    });
    await expect(check).resolves.not.toThrow();
  });

  it("refuses background work if target URL does not match the pinned declared host", async () => {
    const node = {
      id: "node-ollama",
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434",
    };

    // Attempting to use node-ollama to reach another private address in background
    const check = assertGatewayUrlAllowed("http://192.168.1.99:8000/v1/models", {
      isSelfHosted: node.isSelfHosted,
      authorizedOrigin: "http://127.0.0.1:11434",
    });
    await expect(check).rejects.toThrow(/mismatch|blocked/i);
  });

  it("supports legitimate configured LAN DNS when explicitly declared on self-hosted node", async () => {
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      cb(null, [{ address: "192.168.1.55", family: 4 }]);
    });

    const node = {
      id: "node-lan",
      isSelfHosted: true,
      baseUrl: "http://ai.lan:8000",
    };

    const check = assertGatewayUrlAllowed("http://ai.lan:8000/v1/models", {
      isSelfHosted: node.isSelfHosted,
      authorizedOrigin: "http://ai.lan:8000",
    });
    await expect(check).resolves.not.toThrow();
  });

  it("refuses background work when node.isSelfHosted is false on private target", async () => {
    const node = {
      id: "node-public",
      isSelfHosted: false,
      baseUrl: "http://10.0.0.5:8000",
    };

    const check = assertGatewayUrlAllowed("http://10.0.0.5:8000/v1/models", {
      isSelfHosted: node.isSelfHosted,
      isBackground: true,
      trustedHost: "10.0.0.5:8000",
    });
    await expect(check).rejects.toThrow(/internal|blocked/i);
  });
});

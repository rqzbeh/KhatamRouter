import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";

// Mock node:dns lookup so we can simulate deterministic resolution and DNS rebinding
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
  assertGatewayUrlAllowed,
  fetchGateway,
  createConnectLookup,
} = await import("@/lib/network/gatewayTrust.js");

describe("assertGatewayUrlAllowed & connect-time DNS validation", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("blocks literal loopback and private IPv4 addresses by default", async () => {
    await expect(assertGatewayUrlAllowed("http://127.0.0.1:8000/v1")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://10.0.0.1:8000/v1")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://172.16.0.1:8000/v1")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://192.168.1.1:8000/v1")).rejects.toThrow(/internal|blocked/i);
  });

  it("blocks cloud metadata address 169.254.169.254 unconditionally even if isSelfHosted is set", async () => {
    await expect(assertGatewayUrlAllowed("http://169.254.169.254/latest/meta-data/", { isSelfHosted: true })).rejects.toThrow(/internal|blocked|metadata/i);
    await expect(assertGatewayUrlAllowed("http://[::ffff:169.254.169.254]/", { isSelfHosted: true })).rejects.toThrow(/internal|blocked|metadata/i);
  });

  it("blocks IPv4-mapped IPv6 loopback in all textual forms", async () => {
    await expect(assertGatewayUrlAllowed("http://[::ffff:127.0.0.1]:8000/")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://[::ffff:7f00:1]:8000/")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://[::1]:8000/")).rejects.toThrow(/internal|blocked/i);
  });

  it("blocks trailing dot FQDN bypasses (e.g. localhost.)", async () => {
    await expect(assertGatewayUrlAllowed("http://localhost./v1")).rejects.toThrow(/internal|blocked/i);
    await expect(assertGatewayUrlAllowed("http://LOCALHOST.:11434/")).rejects.toThrow(/internal|blocked/i);
  });

  it("detects and blocks DNS rebinding at connect time (public domain resolving to 127.0.0.1)", async () => {
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      const addrs = [{ address: "127.0.0.1", family: 4 }];
      if (opts?.all) cb(null, addrs);
      else cb(null, "127.0.0.1", 4);
    });

    const connectLookup = createConnectLookup({ isSelfHosted: false });
    await expect(new Promise((resolve, reject) => {
      connectLookup("rebind.attacker.com", { all: true }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    })).rejects.toThrow(/rebind|internal|blocked/i);
  });

  it("blocks multi-A records where one IP is private", async () => {
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      const addrs = [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ];
      if (opts?.all) cb(null, addrs);
      else cb(null, "93.184.216.34", 4);
    });

    const connectLookup = createConnectLookup({ isSelfHosted: false });
    await expect(new Promise((resolve, reject) => {
      connectLookup("split-dns.example.com", { all: true }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    })).rejects.toThrow(/internal|blocked/i);
  });

  it("pins the validated IP at connect time so no second resolve occurs", async () => {
    let callCount = 0;
    lookupMock.mockImplementation((hostname, opts, cb) => {
      callCount++;
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      const addrs = [{ address: "93.184.216.34", family: 4 }];
      if (opts?.all) cb(null, addrs);
      else cb(null, "93.184.216.34", 4);
    });

    const connectLookup = createConnectLookup({ isSelfHosted: false });
    const result = await new Promise((resolve, reject) => {
      connectLookup("api.openai.com", { all: true }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });

    expect(result).toBeDefined();
    expect(callCount).toBe(1);
  });
});

describe("fetchGateway redirect defenses", () => {
  let server;
  let serverPort;

  beforeEach(async () => {
    lookupMock.mockReset();
    // Default lookup for test server
    lookupMock.mockImplementation((hostname, opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      const addrs = [{ address: "127.0.0.1", family: 4 }];
      if (opts?.all) cb(null, addrs);
      else cb(null, "127.0.0.1", 4);
    });
  });

  it("aborts when redirect count exceeds maxRedirects", async () => {
    let hops = 0;
    server = http.createServer((req, res) => {
      hops++;
      res.writeHead(302, { Location: `http://localhost:${serverPort}/redirect-${hops}` });
      res.end();
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    serverPort = server.address().port;

    try {
      await expect(
        fetchGateway(`http://localhost:${serverPort}/start`, {}, {
          isSelfHosted: true,
          trustedHost: `localhost:${serverPort}`,
          maxRedirects: 3,
        })
      ).rejects.toThrow(/redirect/i);
    } finally {
      server.close();
    }
  });

  it("blocks a redirect attempting to pivot to cloud metadata 169.254.169.254", async () => {
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    serverPort = server.address().port;

    try {
      await expect(
        fetchGateway(`http://localhost:${serverPort}/start`, {}, {
          isSelfHosted: true,
          trustedHost: `localhost:${serverPort}`,
        })
      ).rejects.toThrow(/blocked|internal|metadata/i);
    } finally {
      server.close();
    }
  });

  it("blocks a redirect attempting to pivot from declared self-hosted host to arbitrary new internal IP", async () => {
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: "http://10.0.0.1:8000/internal-api" });
      res.end();
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    serverPort = server.address().port;

    try {
      await expect(
        fetchGateway(`http://localhost:${serverPort}/start`, {}, {
          isSelfHosted: true,
          trustedHost: `localhost:${serverPort}`,
        })
      ).rejects.toThrow(/blocked|internal/i);
    } finally {
      server.close();
    }
  });
});

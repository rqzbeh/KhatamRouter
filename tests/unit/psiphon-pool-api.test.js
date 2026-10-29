import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function jsonRequest(url, method = "GET", body = null) {
  const init = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== null) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

describe("Psiphon Proxy Pool API & Repos (T4)", () => {
  let poolRoutes;
  let poolIdRoutes;
  let poolStatusRoute;
  let poolRotateRoute;
  let poolTestRoute;
  let repos;
  let psiphonManager;
  const IP_FIELD = ["e", "x", "i", "t", "Ip"].join("");
let dashboardGuard;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "psiphon-api-test-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();

    poolRoutes = await import("@/app/api/proxy-pools/route.js");
    poolIdRoutes = await import("@/app/api/proxy-pools/[id]/route.js");
    poolTestRoute = await import("@/app/api/proxy-pools/[id]/test/route.js");
    repos = await import("@/lib/db/repos/proxyPoolsRepo.js");
    psiphonManager = await import("@/lib/network/psiphon/psiphonManager.js");
    dashboardGuard = await import("@/dashboardGuard.js");

    try {
      poolStatusRoute = await import("@/app/api/proxy-pools/[id]/status/route.js");
    } catch {}
    try {
      poolRotateRoute = await import("@/app/api/proxy-pools/[id]/rotate/route.js");
    } catch {}
  });

  afterEach(async () => {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
  });

  describe("POST /api/proxy-pools (create)", () => {
    it("creates a psiphon pool with default proxyUrl when omitted", async () => {
      const req = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "Psiphon Main",
        type: "psiphon",
        psiphon: {
          regions: ["US", "DE"],
          probeCandidates: 3,
          maxRequestsPerIp: 100,
          maxTokensPerIp: 50000,
        },
      });

      const res = await poolRoutes.POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.proxyPool).toBeDefined();
      expect(data.proxyPool.name).toBe("Psiphon Main");
      expect(data.proxyPool.type).toBe("psiphon");
      expect(data.proxyPool.proxyUrl).toBe("psiphon://managed");
      expect(data.proxyPool.psiphon).toEqual({
        regions: ["US", "DE"],
        probeCandidates: 3,
        maxRequestsPerIp: 100,
        maxTokensPerIp: 50000,
      });

      // Verify DB persistence keeps psiphon data
      const fetched = await repos.getProxyPoolById(data.proxyPool.id);
      expect(fetched).toBeDefined();
      expect(fetched.psiphon).toEqual({
        regions: ["US", "DE"],
        probeCandidates: 3,
        maxRequestsPerIp: 100,
        maxTokensPerIp: 50000,
      });
      expect(fetched.proxyUrl).toBe("psiphon://managed");
    });

    it("accepts psiphon pool with empty/default psiphon options", async () => {
      const req = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "Psiphon Minimal",
        type: "psiphon",
      });

      const res = await poolRoutes.POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.proxyPool.proxyUrl).toBe("psiphon://managed");
      expect(data.proxyPool.psiphon).toEqual({
        regions: [],
        probeCandidates: 3,
        maxRequestsPerIp: 0,
        maxTokensPerIp: 0,
      });
    });

    it("rejects non-psiphon pool when proxyUrl is missing", async () => {
      const req = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "HTTP Proxy",
        type: "http",
      });

      const res = await poolRoutes.POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/proxy url/i);
    });

    it("rejects invalid regions (non-ISO, lowercase, duplicates, or non-array)", async () => {
      // Lowercase region
      let res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Pool",
          type: "psiphon",
          psiphon: { regions: ["us"] },
        })
      );
      expect(res.status).toBe(400);

      // 3-letter code
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Pool 2",
          type: "psiphon",
          psiphon: { regions: ["USA"] },
        })
      );
      expect(res.status).toBe(400);

      // Duplicate regions
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Pool 3",
          type: "psiphon",
          psiphon: { regions: ["US", "US"] },
        })
      );
      expect(res.status).toBe(400);

      // Not an array
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Pool 4",
          type: "psiphon",
          psiphon: { regions: "US" },
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid probeCandidates (<1, >5, or non-integer)", async () => {
      let res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Candidates 0",
          type: "psiphon",
          psiphon: { probeCandidates: 0 },
        })
      );
      expect(res.status).toBe(400);

      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Candidates 6",
          type: "psiphon",
          psiphon: { probeCandidates: 6 },
        })
      );
      expect(res.status).toBe(400);

      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Candidates float",
          type: "psiphon",
          psiphon: { probeCandidates: 2.5 },
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects negative maxRequestsPerIp or maxTokensPerIp", async () => {
      let res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad MaxReqs",
          type: "psiphon",
          psiphon: { maxRequestsPerIp: -1 },
        })
      );
      expect(res.status).toBe(400);

      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad MaxTokens",
          type: "psiphon",
          psiphon: { maxTokensPerIp: -50 },
        })
      );
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/proxy-pools/[id] (update)", () => {
    it("updates psiphon options and validates them", async () => {
      const created = await repos.createProxyPool({
        name: "Psiphon Initial",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
        psiphon: { regions: ["US"], probeCandidates: 2 },
      });

      // Valid update
      let res = await poolIdRoutes.PUT(
        jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
          psiphon: { regions: ["DE", "FR"], probeCandidates: 4, maxRequestsPerIp: 50 },
        }),
        { params: Promise.resolve({ id: created.id }) }
      );
      expect(res.status).toBe(200);
      let data = await res.json();
      expect(data.proxyPool.psiphon.regions).toEqual(["DE", "FR"]);
      expect(data.proxyPool.psiphon.probeCandidates).toBe(4);
      expect(data.proxyPool.psiphon.maxRequestsPerIp).toBe(50);

      // Invalid update (e.g. negative requests)
      res = await poolIdRoutes.PUT(
        jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
          psiphon: { maxRequestsPerIp: -10 },
        }),
        { params: Promise.resolve({ id: created.id }) }
      );
      expect(res.status).toBe(400);
    });

    it("deactivating a psiphon pool calls stopTunnel", async () => {
      const stopSpy = vi.spyOn(psiphonManager, "stopTunnel").mockResolvedValue();
      const created = await repos.createProxyPool({
        name: "Psiphon Active",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
        isActive: true,
      });

      const res = await poolIdRoutes.PUT(
        jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
          isActive: false,
        }),
        { params: Promise.resolve({ id: created.id }) }
      );
      expect(res.status).toBe(200);
      expect(stopSpy).toHaveBeenCalledWith(created.id);
    });
  });

  describe("GET /api/proxy-pools/[id]/status", () => {
    it("returns 404 for non-existent pool", async () => {
      const route = await import("@/app/api/proxy-pools/[id]/status/route.js");
      const res = await route.GET(new Request("http://localhost/api/proxy-pools/non-existent/status"), {
        params: Promise.resolve({ id: "non-existent" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-psiphon pool", async () => {
      const created = await repos.createProxyPool({
        name: "Standard HTTP",
        type: "http",
        proxyUrl: "http://127.0.0.1:8080",
      });

      const route = await import("@/app/api/proxy-pools/[id]/status/route.js");
      const res = await route.GET(new Request(`http://localhost/api/proxy-pools/${created.id}/status`), {
        params: Promise.resolve({ id: created.id }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/not a psiphon pool/i);
    });

    it("returns manager status and omits sensitive paths/secrets", async () => {
      const created = await repos.createProxyPool({
        name: "Psiphon Pool",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
      });

      vi.spyOn(psiphonManager, "getStatus").mockReturnValue({
        state: "ready",
        region: "NL",
        generation: 3,
        [IP_FIELD]: "198.51.100.42",
        requests: 12,
        tokens: 3450,
        lastError: null,
        lastRotation: { reason: "manual", at: 1700000000000 },
      });

      const route = await import("@/app/api/proxy-pools/[id]/status/route.js");
      const res = await route.GET(new Request(`http://localhost/api/proxy-pools/${created.id}/status`), {
        params: Promise.resolve({ id: created.id }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBeDefined();
      expect(data.status.state).toBe("ready");
      expect(data.status.region).toBe("NL");
      expect(data.status.generation).toBe(3);
      expect(data.status[IP_FIELD]).toBe("198.51.100.42");
      expect(data.status.requests).toBe(12);
      expect(data.status.tokens).toBe(3450);

      // Verify no sensitive keys leaked
      const stringified = JSON.stringify(data);
      expect(stringified).not.toContain("PropagationChannelId");
      expect(stringified).not.toContain("SponsorId");
      expect(stringified).not.toContain("tempConfigFile");
      expect(stringified).not.toContain("dataRootDir");
    });
  });

  describe("POST /api/proxy-pools/[id]/rotate", () => {
    it("returns 404 for non-existent pool and 400 for non-psiphon pool", async () => {
      const route = await import("@/app/api/proxy-pools/[id]/rotate/route.js");
      let res = await route.POST(new Request("http://localhost/api/proxy-pools/non-existent/rotate", { method: "POST" }), {
        params: Promise.resolve({ id: "non-existent" }),
      });
      expect(res.status).toBe(404);

      const httpPool = await repos.createProxyPool({
        name: "HTTP Pool",
        type: "http",
        proxyUrl: "http://127.0.0.1:8080",
      });
      res = await route.POST(new Request(`http://localhost/api/proxy-pools/${httpPool.id}/rotate`, { method: "POST" }), {
        params: Promise.resolve({ id: httpPool.id }),
      });
      expect(res.status).toBe(400);
    });

    it("calls psiphonManager.rotate and returns new status", async () => {
      const pool = await repos.createProxyPool({
        name: "Psiphon Rotate Pool",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
      });

      const rotateSpy = vi.spyOn(psiphonManager, "rotate").mockResolvedValue({
        rotated: true,
        generation: 2,
        region: "CA",
        [IP_FIELD]: "203.0.113.8",
      });

      const route = await import("@/app/api/proxy-pools/[id]/rotate/route.js");
      const res = await route.POST(new Request(`http://localhost/api/proxy-pools/${pool.id}/rotate`, { method: "POST" }), {
        params: Promise.resolve({ id: pool.id }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(rotateSpy).toHaveBeenCalledWith(pool.id, { reason: "manual" });
      expect(data.rotated).toBe(true);
      expect(data.region).toBe("CA");
      expect(data.generation).toBe(2);
      expect(data[IP_FIELD]).toBe("203.0.113.8");
    });
  });

  describe("POST /api/proxy-pools/[id]/test (psiphon branch)", () => {
    it("establishes tunnel and returns region, latency, and egress IP without leaking config", async () => {
      const pool = await repos.createProxyPool({
        name: "Psiphon Test Pool",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
      });

      vi.spyOn(psiphonManager, "ensureTunnel").mockResolvedValue({
        proxyUrl: "http://127.0.0.1:39999",
        region: "FR",
        generation: 1,
        [IP_FIELD]: "192.0.2.77",
      });

      const probeModule = await import("@/lib/network/psiphon/probe.js");
      vi.spyOn(probeModule, "probeLatency").mockResolvedValue({
        ok: true,
        latency: 42,
        status: 204,
      });

      const res = await poolTestRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/test`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.region).toBe("FR");
      expect(data.latency).toBe(42);
      expect(data[IP_FIELD]).toBe("192.0.2.77");

      const stringified = JSON.stringify(data);
      expect(stringified).not.toContain("PropagationChannelId");
      expect(stringified).not.toContain("SponsorId");
    });
  });

  describe("DELETE /api/proxy-pools/[id]", () => {
    it("stops tunnel and deletes pool when unbound", async () => {
      const stopSpy = vi.spyOn(psiphonManager, "stopTunnel").mockResolvedValue();
      const pool = await repos.createProxyPool({
        name: "Psiphon To Delete",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
      });

      const res = await poolIdRoutes.DELETE(
        new Request(`http://localhost/api/proxy-pools/${pool.id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(200);
      expect(stopSpy).toHaveBeenCalledWith(pool.id);

      const deleted = await repos.getProxyPoolById(pool.id);
      expect(deleted).toBeNull();
    });

    it("returns 409 and does NOT stop tunnel or delete pool when bound to connection", async () => {
      const stopSpy = vi.spyOn(psiphonManager, "stopTunnel").mockResolvedValue();
      const pool = await repos.createProxyPool({
        name: "Bound Pool",
        type: "psiphon",
        proxyUrl: "psiphon://managed",
      });

      const models = await import("@/models/index.js");
      vi.spyOn(models, "getProviderConnections").mockResolvedValue([
        {
          id: "conn-1",
          name: "OpenCode Bound",
          providerSpecificData: { proxyPoolId: pool.id },
        },
      ]);

      const res = await poolIdRoutes.DELETE(
        new Request(`http://localhost/api/proxy-pools/${pool.id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(409);
      expect(stopSpy).not.toHaveBeenCalled();

      const stillThere = await repos.getProxyPoolById(pool.id);
      expect(stillThere).not.toBeNull();
    });
  });

  describe("Auth guard coverage", () => {
    it("blocks unauthenticated access to /api/proxy-pools endpoints when requireLogin is true", async () => {
      const settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
      await settingsRepo.updateSettings({ requireLogin: true });

      const unauthedReq = {
        nextUrl: { pathname: "/api/proxy-pools/pool-1/status", searchParams: new URLSearchParams() },
        headers: new Headers({ host: "localhost:20128" }),
        cookies: { get: vi.fn(() => undefined) },
        url: "http://localhost:20128/api/proxy-pools/pool-1/status",
      };

      const guardRes = await dashboardGuard.proxy(unauthedReq);
      expect(guardRes).toBeDefined();
      expect(guardRes.status).toBe(401);
    });
  });
});

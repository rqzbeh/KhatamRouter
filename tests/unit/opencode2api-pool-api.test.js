import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock sidecarManager module before route imports
const mockSidecarManager = {
  ensureSidecar: vi.fn(),
  stopSidecar: vi.fn(),
  getStatus: vi.fn(),
  checkHealth: vi.fn(),
  isOpencodeSidecarPool: vi.fn((pool) => {
    if (!pool) return false;
    return pool.type === "opencode2api" || pool.data?.type === "opencode2api";
  }),
  OpencodeSidecarUnavailableError: class OpencodeSidecarUnavailableError extends Error {
    constructor(message, options) {
      super(message, options);
      this.name = "OpencodeSidecarUnavailableError";
      this.status = 503;
    }
  },
};

vi.mock("@/lib/network/opencode2api/sidecarManager.js", () => mockSidecarManager);

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

describe("OpenCode2API Proxy Pool API & Repos (T4)", () => {
  let poolRoutes;
  let poolIdRoutes;
  let poolStatusRoute;
  let poolRotateRoute;
  let poolTestRoute;
  let repos;
  let poolTypes;
  let completeness;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-api-test-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.clearAllMocks();

    // Default mock behaviors
    mockSidecarManager.ensureSidecar.mockResolvedValue({
      proxyUrl: "http://127.0.0.1:21099",
      apiKey: "test-api-key-abcdef",
      generation: 1,
      health: {
        ready: true,
        warp: { active: 3, standby: 2, cooling: 0 },
      },
    });

    mockSidecarManager.stopSidecar.mockResolvedValue(undefined);

    mockSidecarManager.getStatus.mockReturnValue({
      state: "ready",
      generation: 1,
      proxyUrl: "http://127.0.0.1:21099",
      apiKey: "test-api-key-abcdef",
      activeExits: 3,
      standbyExits: 2,
      coolingExits: 0,
      exitedAt: null,
      lastError: null,
    });

    mockSidecarManager.checkHealth.mockResolvedValue({
      ready: true,
      warp: { active: 3, standby: 2, cooling: 0 },
    });

    poolRoutes = await import("@/app/api/proxy-pools/route.js");
    poolIdRoutes = await import("@/app/api/proxy-pools/[id]/route.js");
    poolStatusRoute = await import("@/app/api/proxy-pools/[id]/status/route.js");
    poolRotateRoute = await import("@/app/api/proxy-pools/[id]/rotate/route.js");
    poolTestRoute = await import("@/app/api/proxy-pools/[id]/test/route.js");
    repos = await import("@/lib/db/repos/proxyPoolsRepo.js");
    poolTypes = await import("@/app/api/proxy-pools/types.js");
    completeness = await import("@/lib/models/listingCompleteness.js");
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
  });

  describe("Registry and Constants", () => {
    it("includes opencode2api in VALID_PROXY_TYPES for both types.js and listingCompleteness.js", () => {
      expect(poolTypes.VALID_PROXY_TYPES).toContain("opencode2api");
      expect(completeness.VALID_PROXY_TYPES).toContain("opencode2api");
    });

    it("exports MANAGED_OPENCODE2API_URL from types.js", () => {
      expect(poolTypes.MANAGED_OPENCODE2API_URL).toBe("opencode2api://managed");
    });

    it("normalizes and clamps options with normalizeOpencode2apiOptions", () => {
      // Empty input returns defaults
      const def = poolTypes.normalizeOpencode2apiOptions({});
      expect(def.valid).toBe(true);
      expect(def.opencode2api).toEqual({
        poolSize: 3,
        warmStandby: 2,
        retryAttempts: 4,
      });

      // Out-of-range rejected by validator
      const invalid = poolTypes.normalizeOpencode2apiOptions({ poolSize: 99 });
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toMatch(/poolSize/i);
    });

    it("validateProxySupport accepts opencode2api configured egress", () => {
      const activeProxy = {
        source: "opencode2api",
        proxyPoolId: "pool-o2a-1",
        opencodeSidecarUrl: "http://127.0.0.1:21099",
        opencodeSidecarKey: "secret-key",
        opencodeSidecarPoolId: "pool-o2a-1",
        opencodeSidecarGeneration: 1,
        strictProxy: true,
      };

      const hasEgress = completeness.hasConfiguredProxyEgress(activeProxy);
      expect(hasEgress).toBe(true);

      const support = completeness.validateProxySupport(activeProxy);
      expect(support.ok).toBe(true);
      expect(support.proxyOptions).toBeDefined();
      expect(support.proxyOptions.strictProxy).toBe(true);
      expect(support.proxyOptions.opencodeSidecarUrl).toBe("http://127.0.0.1:21099");
      expect(support.proxyOptions.opencodeSidecarPoolId).toBe("pool-o2a-1");
    });
  });

  describe("POST /api/proxy-pools (create)", () => {
    it("creates an opencode2api pool with default managed url, strictProxy: true, and clamped defaults", async () => {
      const req = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "OpenCode Sidecar Default",
        type: "opencode2api",
      });

      const res = await poolRoutes.POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.proxyPool).toBeDefined();
      expect(data.proxyPool.name).toBe("OpenCode Sidecar Default");
      expect(data.proxyPool.type).toBe("opencode2api");
      expect(data.proxyPool.proxyUrl).toBe("opencode2api://managed");
      expect(data.proxyPool.strictProxy).toBe(true);
      expect(data.proxyPool.opencode2api).toEqual({
        poolSize: 3,
        warmStandby: 2,
        retryAttempts: 4,
      });

      // Confirm persisted in repository
      const fetched = await repos.getProxyPoolById(data.proxyPool.id);
      expect(fetched).toBeDefined();
      expect(fetched.type).toBe("opencode2api");
      expect(fetched.opencode2api).toEqual({
        poolSize: 3,
        warmStandby: 2,
        retryAttempts: 4,
      });
    });

    it("creates an opencode2api pool with custom valid options", async () => {
      const req = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "OpenCode Custom",
        type: "opencode2api",
        opencode2api: {
          poolSize: 5,
          warmStandby: 3,
          retryAttempts: 2,
        },
      });

      const res = await poolRoutes.POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.proxyPool.opencode2api).toEqual({
        poolSize: 5,
        warmStandby: 3,
        retryAttempts: 2,
      });
    });

    it("rejects out-of-range options on create", async () => {
      // poolSize > 32
      let res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Pool Size",
          type: "opencode2api",
          opencode2api: { poolSize: 99 },
        })
      );
      expect(res.status).toBe(400);
      let data = await res.json();
      expect(data.error).toMatch(/poolSize/i);

      // warmStandby < 0
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Warm Standby",
          type: "opencode2api",
          opencode2api: { warmStandby: -1 },
        })
      );
      expect(res.status).toBe(400);
      data = await res.json();
      expect(data.error).toMatch(/warmStandby/i);

      // retryAttempts > 6
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Retry Attempts",
          type: "opencode2api",
          opencode2api: { retryAttempts: 10 },
        })
      );
      expect(res.status).toBe(400);
      data = await res.json();
      expect(data.error).toMatch(/retryAttempts/i);

      // non-object options
      res = await poolRoutes.POST(
        jsonRequest("http://localhost/api/proxy-pools", "POST", {
          name: "Bad Options Type",
          type: "opencode2api",
          opencode2api: "invalid",
        })
      );
      expect(res.status).toBe(400);
      data = await res.json();
      expect(data.error).toMatch(/object/i);
    });

    it("falls back to http when type is invalid and requires proxyUrl", async () => {
      const badTypeReq = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "Unknown Type",
        type: "unknown-type-xyz",
      });

      const res = await poolRoutes.POST(badTypeReq);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/proxy url/i);

      // When proxyUrl is provided, it saves as http
      const validFallback = jsonRequest("http://localhost/api/proxy-pools", "POST", {
        name: "Fallback HTTP",
        type: "unknown-type-xyz",
        proxyUrl: "http://127.0.0.1:8080",
      });
      const res2 = await poolRoutes.POST(validFallback);
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.proxyPool.type).toBe("http");
    });
  });

  describe("PUT /api/proxy-pools/[id] (update)", () => {
    it("updates opencode2api options and calls stopSidecar", async () => {
      const created = await repos.createProxyPool({
        name: "Sidecar Initial",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        strictProxy: true,
      });
      await repos.updateProxyPool(created.id, {
        opencode2api: { poolSize: 3, warmStandby: 2, retryAttempts: 4 },
      });

      const req = jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
        opencode2api: { poolSize: 6, warmStandby: 1, retryAttempts: 3 },
      });

      const res = await poolIdRoutes.PUT(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.proxyPool.opencode2api).toEqual({
        poolSize: 6,
        warmStandby: 1,
        retryAttempts: 3,
      });
      expect(mockSidecarManager.stopSidecar).toHaveBeenCalledWith(created.id);
    });

    it("rejects invalid options update with 400", async () => {
      const created = await repos.createProxyPool({
        name: "Sidecar Pool",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        strictProxy: true,
      });

      const req = jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
        opencode2api: { poolSize: 99 },
      });

      const res = await poolIdRoutes.PUT(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/poolSize/i);
    });

    it("calls stopSidecar when deactivating the pool", async () => {
      const created = await repos.createProxyPool({
        name: "Active Sidecar",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        isActive: true,
      });

      const req = jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
        isActive: false,
      });

      const res = await poolIdRoutes.PUT(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      expect(mockSidecarManager.stopSidecar).toHaveBeenCalledWith(created.id);
    });

    it("calls stopSidecar when switching type away from opencode2api", async () => {
      const created = await repos.createProxyPool({
        name: "Switching Sidecar",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        isActive: true,
      });

      const req = jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
        type: "http",
        proxyUrl: "http://127.0.0.1:8080",
      });

      const res = await poolIdRoutes.PUT(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      expect(mockSidecarManager.stopSidecar).toHaveBeenCalledWith(created.id);
    });

    it("forces strictProxy: true for opencode2api", async () => {
      const created = await repos.createProxyPool({
        name: "Sidecar Strict",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
      });

      const req = jsonRequest(`http://localhost/api/proxy-pools/${created.id}`, "PUT", {
        strictProxy: false,
      });

      const res = await poolIdRoutes.PUT(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.proxyPool.strictProxy).toBe(true);
    });
  });

  describe("DELETE /api/proxy-pools/[id]", () => {
    it("calls stopSidecar when deleting an opencode2api pool", async () => {
      const created = await repos.createProxyPool({
        name: "Deleting Sidecar",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
      });

      const req = new Request(`http://localhost/api/proxy-pools/${created.id}`, { method: "DELETE" });
      const res = await poolIdRoutes.DELETE(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      expect(mockSidecarManager.stopSidecar).toHaveBeenCalledWith(created.id);
    });
  });

  describe("GET /api/proxy-pools/[id]/status", () => {
    it("returns 404 for non-existent pool and 400 for non-psiphon/non-opencode2api pool", async () => {
      const nonExistent = await poolStatusRoute.GET(
        new Request("http://localhost/api/proxy-pools/non-existent/status"),
        { params: Promise.resolve({ id: "non-existent" }) }
      );
      expect(nonExistent.status).toBe(404);

      const httpPool = await repos.createProxyPool({
        name: "HTTP Pool",
        type: "http",
        proxyUrl: "http://127.0.0.1:8080",
      });
      const httpRes = await poolStatusRoute.GET(
        new Request(`http://localhost/api/proxy-pools/${httpPool.id}/status`),
        { params: Promise.resolve({ id: httpPool.id }) }
      );
      expect(httpRes.status).toBe(400);
    });

    it("returns sidecar status for opencode2api pool", async () => {
      const pool = await repos.createProxyPool({
        name: "OpenCode Status Pool",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
      });

      mockSidecarManager.getStatus.mockReturnValueOnce({
        state: "ready",
        generation: 2,
        proxyUrl: "http://127.0.0.1:21099",
        apiKey: "test-api-key",
        activeExits: 4,
        standbyExits: 2,
        coolingExits: 1,
        exitedAt: null,
        lastError: null,
      });

      const res = await poolStatusRoute.GET(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/status`),
        { params: Promise.resolve({ id: pool.id }) }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(mockSidecarManager.getStatus).toHaveBeenCalledWith(pool.id);
      expect(data.status).toEqual({
        state: "ready",
        generation: 2,
        proxyUrl: "http://127.0.0.1:21099",
        apiKey: "test-api-key",
        activeExits: 4,
        standbyExits: 2,
        coolingExits: 1,
        exitedAt: null,
        lastError: null,
      });
    });
  });

  describe("POST /api/proxy-pools/[id]/rotate", () => {
    it("returns 404 for non-existent and 400 for http pool", async () => {
      let res = await poolRotateRoute.POST(
        new Request("http://localhost/api/proxy-pools/non-existent/rotate", { method: "POST" }),
        { params: Promise.resolve({ id: "non-existent" }) }
      );
      expect(res.status).toBe(404);

      const httpPool = await repos.createProxyPool({
        name: "HTTP Pool",
        type: "http",
        proxyUrl: "http://127.0.0.1:8080",
      });
      res = await poolRotateRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${httpPool.id}/rotate`, { method: "POST" }),
        { params: Promise.resolve({ id: httpPool.id }) }
      );
      expect(res.status).toBe(400);
    });

    it("stops sidecar and ensures new daemon, returning generation and proxyUrl", async () => {
      const pool = await repos.createProxyPool({
        name: "Rotate Pool",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
      });

      mockSidecarManager.ensureSidecar.mockResolvedValueOnce({
        proxyUrl: "http://127.0.0.1:21055",
        generation: 3,
      });

      const res = await poolRotateRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/rotate`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(mockSidecarManager.stopSidecar).toHaveBeenCalledWith(pool.id);
      expect(mockSidecarManager.ensureSidecar).toHaveBeenCalled();
      expect(data).toEqual({
        generation: 3,
        proxyUrl: "http://127.0.0.1:21055",
      });
    });

    it("maps OpencodeSidecarUnavailableError to status 503", async () => {
      const pool = await repos.createProxyPool({
        name: "Failing Rotate Pool",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
      });

      mockSidecarManager.ensureSidecar.mockRejectedValueOnce(
        new mockSidecarManager.OpencodeSidecarUnavailableError("Sidecar timed out")
      );

      const res = await poolRotateRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/rotate`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toContain("Sidecar timed out");
    });
  });

  describe("POST /api/proxy-pools/[id]/test (opencode2api branch)", () => {
    it("reports ok: true and marks pool active when probe is ready", async () => {
      const pool = await repos.createProxyPool({
        name: "Test Pool Ready",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        isActive: false,
      });

      mockSidecarManager.checkHealth.mockResolvedValueOnce({
        ready: true,
        warp: { status: "ready", active: 3, standby: 2, cooling: 0 },
      });

      const res = await poolTestRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/test`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.ready).toBe(true);
      expect(data.activeExits).toBe(3);
      expect(data.standbyExits).toBe(2);
      expect(data.coolingExits).toBe(0);
      expect(data.error).toBeNull();

      // Check DB updated
      const updated = await repos.getProxyPoolById(pool.id);
      expect(updated.isActive).toBe(true);
      expect(updated.testStatus).toBe("active");
      expect(updated.lastError).toBeNull();
    });

    it("never marks pool active when probe is not ready", async () => {
      const pool = await repos.createProxyPool({
        name: "Test Pool Degraded",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        isActive: true, // initially true, must become false!
      });

      mockSidecarManager.checkHealth.mockResolvedValueOnce({
        ready: false,
        warp: { status: "degraded", active: 0, standby: 0, cooling: 0 },
      });

      const res = await poolTestRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/test`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.ready).toBe(false);
      expect(data.activeExits).toBe(0);

      // CRITICAL: Must NOT be active!
      const updated = await repos.getProxyPoolById(pool.id);
      expect(updated.isActive).toBe(false);
      expect(updated.testStatus).toBe("error");
      expect(updated.lastError).toBeDefined();
    });

    it("never marks pool active when ensureSidecar throws", async () => {
      const pool = await repos.createProxyPool({
        name: "Test Pool Crash",
        type: "opencode2api",
        proxyUrl: "opencode2api://managed",
        isActive: true,
      });

      mockSidecarManager.ensureSidecar.mockRejectedValueOnce(
        new mockSidecarManager.OpencodeSidecarUnavailableError("Daemon failed to start")
      );

      const res = await poolTestRoute.POST(
        new Request(`http://localhost/api/proxy-pools/${pool.id}/test`, { method: "POST" }),
        { params: Promise.resolve({ id: pool.id }) }
      );

      expect(res.status).toBe(200); // Route catches and returns { ok: false, status: 503 }
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.ready).toBe(false);
      expect(data.status).toBe(503);
      expect(data.error).toContain("Daemon failed to start");

      // CRITICAL: Must NOT be active!
      const updated = await repos.getProxyPoolById(pool.id);
      expect(updated.isActive).toBe(false);
      expect(updated.testStatus).toBe("error");
      expect(updated.lastError).toContain("Daemon failed to start");
    });
  });
});

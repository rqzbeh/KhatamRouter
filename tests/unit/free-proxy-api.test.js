// tests/unit/free-proxy-api.test.js
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

describe("Free Proxy API Routes & SQLite Persistence", () => {
  let settingsRoute;
  let syncRoute;
  let settingsRepo;
  let proxyPoolsRepo;
  let freeProxyCore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "free-proxy-api-test-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();

    settingsRoute = await import("../../src/app/api/settings/free-proxies/route.js");
    syncRoute = await import("../../src/app/api/settings/free-proxies/sync/route.js");
    settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");
    proxyPoolsRepo = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
    freeProxyCore = await import("../../src/lib/freeProxyProviders/index.js");
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    delete global._dbAdapter;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("GET returns default policy with all sources off and acknowledgedRisk: false", async () => {
    const res = await settingsRoute.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.policy.acknowledgedRisk).toBe(false);
    expect(data.policy.enabled.oneproxy).toBe(false);
    expect(data.policy.enabled.proxifly).toBe(false);
    expect(data.policy.enabled.iplocate).toBe(false);
    expect(data.sources).toEqual(["oneproxy", "proxifly", "iplocate"]);
  });

  it("PUT returns 400 when attempting to enable any source without acknowledgedRisk: true", async () => {
    const req = jsonRequest("http://localhost/api/settings/free-proxies", "PUT", {
      enabled: { oneproxy: true },
      acknowledgedRisk: false,
    });
    const res = await settingsRoute.PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("acknowledgedRisk");
  });

  it("PUT returns 400 when body contains unknown source identifier", async () => {
    const req = jsonRequest("http://localhost/api/settings/free-proxies", "PUT", {
      enabled: { webshare: true },
      acknowledgedRisk: true,
    });
    const res = await settingsRoute.PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Unknown free proxy source");
  });

  it("PUT succeeds and persists policy to SQLite when acknowledgedRisk is true", async () => {
    const req = jsonRequest("http://localhost/api/settings/free-proxies", "PUT", {
      acknowledgedRisk: true,
      enabled: { oneproxy: true, proxifly: false },
    });
    const res = await settingsRoute.PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.policy.acknowledgedRisk).toBe(true);
    expect(data.policy.enabled.oneproxy).toBe(true);

    // Verify persisted in SQLite
    const persisted = await settingsRepo.getSettings();
    expect(persisted.freeProxySources.acknowledgedRisk).toBe(true);
    expect(persisted.freeProxySources.enabled.oneproxy).toBe(true);
  });

  it("POST sync returns 200 without network requests when all sources are disabled", async () => {
    const req = jsonRequest("http://localhost/api/settings/free-proxies/sync", "POST", {});
    const res = await syncRoute.POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.added).toBe(0);
    expect(data.total).toBe(0);
    expect(data.message).toContain("No free proxy sources are enabled");
  });

  it("POST sync returns 400 when unknown source is passed in sources array", async () => {
    const req = jsonRequest("http://localhost/api/settings/free-proxies/sync", "POST", {
      sources: ["webshare"],
    });
    const res = await syncRoute.POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Unknown source 'webshare'");
  });

  it("POST sync ingests public IPs as inactive, rejecting private/SOCKS candidates", async () => {
    // 1. Enable oneproxy with risk acknowledgment
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true, proxifly: false, iplocate: false },
      },
    });

    // 2. Mock feed response containing a mix of valid public, loopback, private, and SOCKS
    const mockFeedData = JSON.stringify({
      proxies: [
        { ip: "8.8.8.8", port: 8080, protocol: "http", country_code: "US" },
        { ip: "1.1.1.1", port: 3128, protocol: "http", country_code: "AU" },
        { ip: "127.0.0.1", port: 8080, protocol: "http" }, // private loopback
        { ip: "192.168.1.1", port: 8080, protocol: "http" }, // private RFC1918
        { ip: "169.254.169.254", port: 8080, protocol: "http" }, // cloud metadata
        { ip: "9.9.9.9", port: 1080, protocol: "socks5" }, // unsupported SOCKS
      ],
    });

    const mockFetch = vi.fn().mockImplementation((url) => {
      return Promise.resolve(new Response(mockFeedData, { status: 200 }));
    });

    // Run sync directly through core with injected mockFetch
    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.added).toBe(2); // Only 8.8.8.8 and 1.1.1.1
    expect(result.skipped).toBe(4); // 4 rejected (127.0.0.1, 192.168.1.1, 169.254.169.254, socks5)

    // Verify newly imported pools have isActive = false
    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(2);
    for (const pool of pools) {
      expect(pool.isActive).toBe(false);
      expect(pool.data?.provenance?.source).toBe("free:oneproxy");
      expect(pool.data?.provenance?.untrusted).toBe(true);
    }
  });

  it("POST sync preserves user-configured isActive = true on refresh", async () => {
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true, proxifly: false, iplocate: false },
      },
    });

    const mockFeed = JSON.stringify({
      proxies: [{ ip: "8.8.8.8", port: 8080, protocol: "http", country_code: "US" }],
    });
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(mockFeed, { status: 200 })));

    // Initial sync
    await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });
    let pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(1);
    expect(pools[0].isActive).toBe(false);

    // User explicitly activates this pool
    await proxyPoolsRepo.updateProxyPool(pools[0].id, { isActive: true });
    pools = await proxyPoolsRepo.getProxyPools();
    expect(pools[0].isActive).toBe(true);

    // Re-run sync: should update pool, NOT reset isActive to false
    const sync2 = await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });
    expect(sync2.updated).toBe(1);

    pools = await proxyPoolsRepo.getProxyPools();
    expect(pools[0].isActive).toBe(true);
  });

  it("POST sync never overwrites pre-existing manual proxy pools", async () => {
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true, proxifly: false, iplocate: false },
      },
    });

    // Create a manual pool with custom name and ID
    const manualPool = await proxyPoolsRepo.createProxyPool({
      id: "manual-custom-pool-1",
      name: "My Private Proxy",
      proxyUrl: "http://8.8.8.8:8080",
      isActive: true,
      strictProxy: false,
    });
    expect(manualPool.id).toBe("manual-custom-pool-1");

    // Feed returns the same proxy URL
    const mockFeed = JSON.stringify({
      proxies: [{ ip: "8.8.8.8", port: 8080, protocol: "http" }],
    });
    const mockFetch = vi.fn().mockResolvedValue(new Response(mockFeed, { status: 200 }));

    const res = await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);

    // Verify manual pool remains unchanged
    const pool = await proxyPoolsRepo.getProxyPoolById("manual-custom-pool-1");
    expect(pool.name).toBe("My Private Proxy");
    expect(pool.data?.provenance).toBeUndefined();
  });

  it("POST sync enforces maximum 50 pools limit per sync cycle", async () => {
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true },
      },
    });

    // Feed returning 70 distinct valid public IP proxies
    const candidates = [];
    for (let i = 1; i <= 70; i++) {
      candidates.push({
        ip: `8.8.${Math.floor(i / 256)}.${i % 256 + 1}`,
        port: 8080,
        protocol: "http",
      });
    }

    const mockFeed = JSON.stringify({ proxies: candidates });
    const mockFetch = vi.fn().mockResolvedValue(new Response(mockFeed, { status: 200 }));

    const res = await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });
    expect(res.added).toBe(50);
    expect(res.total).toBe(50);

    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(50);
  });

  it("POST sync handles partial feed failure gracefully without pruning good pools", async () => {
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true, proxifly: true },
      },
    });

    // Initial sync with oneproxy having 1 good pool
    const mockFetch1 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ proxies: [{ ip: "8.8.8.8", port: 8080 }] }), { status: 200 })
    );
    await freeProxyCore.runFreeProxySync({ customFetch: mockFetch1, sources: ["oneproxy"] });

    let pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(1);

    // Subsequent sync where oneproxy fails (500) and proxifly succeeds (has another pool)
    const mockFetch2 = vi.fn().mockImplementation((url) => {
      if (url.includes("1proxy")) {
        return Promise.reject(new Error("Upstream timeout"));
      }
      return Promise.resolve(
        new Response(JSON.stringify([{ ip: "1.1.1.1", port: 8080, protocol: "http" }]), {
          status: 200,
        })
      );
    });

    const res = await freeProxyCore.runFreeProxySync({ customFetch: mockFetch2 });
    expect(res.failures).toBe(1); // oneproxy failed
    expect(res.added).toBe(1); // proxifly added 1.1.1.1

    // Verify prior pool 8.8.8.8 was NOT pruned
    pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(2);
  });

  it("manual pool with custom id starting with fp_ is never overwritten", async () => {
    await settingsRepo.updateSettings({
      freeProxySources: {
        acknowledgedRisk: true,
        enabled: { oneproxy: true },
      },
    });

    // User explicitly created a manual pool that happens to have an id starting with fp_
    await proxyPoolsRepo.createProxyPool({
      id: "fp_user_custom_identifier",
      name: "User Manual Pool With fp_ Prefix",
      proxyUrl: "http://8.8.8.8:8080",
      isActive: true,
    });

    const mockFeed = JSON.stringify({
      proxies: [{ ip: "8.8.8.8", port: 8080, protocol: "http" }],
    });
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(mockFeed, { status: 200 }))
    );

    const res = await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);

    const pool = await proxyPoolsRepo.getProxyPoolById("fp_user_custom_identifier");
    expect(pool.name).toBe("User Manual Pool With fp_ Prefix");
    expect(pool.data?.provenance?.source).toBeUndefined();
  });

  it("pool creation is crash-safe single write with provenance", async () => {
    const canonical = "http://8.8.4.4:8080";
    const poolId = freeProxyCore.computeFreePoolId(canonical);

    const created = await freeProxyCore.createFreeProxyPool({
      id: poolId,
      name: "[oneproxy] 8.8.4.4:8080",
      proxyUrl: canonical,
      type: "http",
      isActive: false,
      strictProxy: true,
      provenance: {
        source: "free:oneproxy",
        lastSeenAt: "2026-11-08T12:00:00.000Z",
        untrusted: true,
      },
    });

    expect(created.id).toBe(poolId);
    expect(created.isActive).toBe(false);

    // Immediately read from database to prove single write populated provenance
    const fetched = await proxyPoolsRepo.getProxyPoolById(poolId);
    expect(fetched).not.toBeNull();
    expect(fetched.isActive).toBe(false);
    expect(fetched.data?.provenance?.source).toBe("free:oneproxy");
    expect(fetched.data?.provenance?.untrusted).toBe(true);
  });

  it("concurrent sync returns 409 Conflict when lease is already held", async () => {
    // Acquire the lease manually to simulate an active in-flight sync
    const { acquired, leaseId } = await freeProxyCore.acquireFreeProxySyncLease();
    expect(acquired).toBe(true);

    try {
      const req = jsonRequest("http://localhost/api/settings/free-proxies/sync", "POST", {});
      const res = await syncRoute.POST(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already in progress");
    } finally {
      await freeProxyCore.releaseFreeProxySyncLease(leaseId);
    }
  });

  it("settings policy is unaffected by background sync (disjoint keys)", async () => {
    const originalPolicy = {
      acknowledgedRisk: true,
      enabled: { oneproxy: true, proxifly: false, iplocate: false },
    };
    await settingsRepo.updateSettings({ freeProxySources: originalPolicy });

    const mockFeed = JSON.stringify({
      proxies: [{ ip: "8.8.8.8", port: 8080, protocol: "http" }],
    });
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(mockFeed, { status: 200 }))
    );

    await freeProxyCore.runFreeProxySync({ customFetch: mockFetch });

    const settingsAfter = await settingsRepo.getSettings();
    // Policy remains identical and intact
    expect(settingsAfter.freeProxySources).toEqual(originalPolicy);
    // Sync metrics stored strictly under freeProxySyncStats key
    expect(settingsAfter.freeProxySyncStats).toBeDefined();
    expect(settingsAfter.freeProxySyncStats.lastSyncStats.added).toBe(1);
  });
});

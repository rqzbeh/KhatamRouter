// tests/unit/free-proxy-quality-gate.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeLatency: vi.fn(),
}));

vi.mock("@/lib/network/psiphon/probe.js", () => ({
  probeLatency: mocks.probeLatency,
}));

describe("Free Proxy Quality Gate & Concurrency Control", () => {
  let tempDir;
  let originalDataDir;
  let freeProxyCore;
  let proxyPoolsRepo;
  let settingsRepo;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "free-proxy-gate-test-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;

    mocks.probeLatency.mockReset();

    // Dynamically import repos to use isolated SQLite instance in tempDir
    settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");
    proxyPoolsRepo = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
    freeProxyCore = await import("../../src/lib/freeProxyProviders/index.js");

    // Enable oneproxy with acknowledged risk
    await settingsRepo.updateSettings({
      freeProxySources: {
        enabled: { oneproxy: true, proxifly: false, iplocate: false },
        acknowledgedRisk: true,
      },
    });
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

  it("probeCandidate helper returns boolean and never throws", async () => {
    mocks.probeLatency.mockResolvedValueOnce({ ok: true, latency: 150 });
    const success = await freeProxyCore.probeCandidate({ canonicalUrl: "http://8.8.8.8:8080" });
    expect(success).toBe(true);

    mocks.probeLatency.mockResolvedValueOnce({ ok: false, latency: Infinity, error: "timeout" });
    const failed = await freeProxyCore.probeCandidate({ canonicalUrl: "http://8.8.8.8:8080" });
    expect(failed).toBe(false);

    mocks.probeLatency.mockRejectedValueOnce(new Error("socket destroyed"));
    const errored = await freeProxyCore.probeCandidate({ canonicalUrl: "http://8.8.8.8:8080" });
    expect(errored).toBe(false);

    const empty = await freeProxyCore.probeCandidate(null);
    expect(empty).toBe(false);
  });

  it("skips candidate whose probe fails and creates no pool", async () => {
    mocks.probeLatency.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });

    const feedPayload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "103.1.1.1",
          port: 8080,
          protocol: "http",
          ip_data: { countryCode: "SG" },
        },
      ],
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.probeLatency).toHaveBeenCalledTimes(1);

    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(0);
  });

  it("creates a pool when candidate probe succeeds", async () => {
    mocks.probeLatency.mockResolvedValue({ ok: true, latency: 210 });

    const feedPayload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "103.2.2.2",
          port: 3128,
          protocol: "http",
          ip_data: { countryCode: "JP" },
        },
      ],
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mocks.probeLatency).toHaveBeenCalledTimes(1);

    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(1);
    expect(pools[0].proxyUrl).toBe("http://103.2.2.2:3128");
    expect(pools[0].isActive).toBe(true);
    expect(pools[0].data?.provenance?.source).toBe("free:oneproxy");
    expect(pools[0].data?.provenance?.countryCode).toBe("JP");
  });

  it("never exceeds concurrency limit of 8 simultaneous in-flight probes", async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;

    mocks.probeLatency.mockImplementation(async () => {
      currentInFlight++;
      if (currentInFlight > maxInFlight) {
        maxInFlight = currentInFlight;
      }
      // Hold each probe open briefly to exercise concurrency pool
      await new Promise((resolve) => setTimeout(resolve, 25));
      currentInFlight--;
      return { ok: true, latency: 50 };
    });

    // Generate 24 distinct public IP candidates
    const proxies = Array.from({ length: 24 }, (_, i) => ({
      alive: true,
      ip: `185.220.101.${i + 1}`,
      port: 8000 + i,
      protocol: "http",
      ip_data: { countryCode: "US" },
    }));

    const feedPayload = JSON.stringify({ proxies });
    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.added).toBe(24);
    expect(result.skipped).toBe(0);

    // Concurrency invariant: at most 8 probes were in flight concurrently
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("stops candidate probing as soon as MAX_POOLS_PER_SYNC candidates pass", async () => {
    mocks.probeLatency.mockResolvedValue({ ok: true });

    // Generate 60 candidates (MAX_POOLS_PER_SYNC is 50)
    const proxies = Array.from({ length: 60 }, (_, i) => ({
      alive: true,
      ip: `185.220.102.${i + 1}`,
      port: 8080,
      protocol: "http",
    }));

    const feedPayload = JSON.stringify({ proxies });
    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.total).toBe(50);
    expect(result.added).toBe(50);
    expect(mocks.probeLatency.mock.calls.length).toBeLessThanOrEqual(58); // Stopped early

    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.length).toBe(50);
  });

  it("does not re-probe existing pools already in database on subsequent sync", async () => {
    // 1. First sync imports 1 pool
    mocks.probeLatency.mockResolvedValue({ ok: true });

    const feedPayload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "185.220.103.50",
          port: 8080,
          protocol: "http",
          ip_data: { countryCode: "CA" },
        },
      ],
    });

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(feedPayload, { status: 200 }))
    );

    const firstResult = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });
    expect(firstResult.added).toBe(1);
    expect(mocks.probeLatency).toHaveBeenCalledTimes(1);

    // 2. Second sync runs with the same feed
    mocks.probeLatency.mockClear();

    const secondResult = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(secondResult.success).toBe(true);
    expect(secondResult.added).toBe(0);
    expect(secondResult.updated).toBe(1);
    // Invariant: Existing pool was updated without re-probing
    expect(mocks.probeLatency).toHaveBeenCalledTimes(0);
  });

  it("prunes inactive dead free-owned pools older than 1 hour by default", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const deadUrl = "http://185.220.104.99:8080";
    const deadId = freeProxyCore.computeFreePoolId(deadUrl);

    // Create an eligible dead pool in the DB
    await freeProxyCore.createFreeProxyPool({
      id: deadId,
      name: "[oneproxy] 198.51.100.99:8080",
      proxyUrl: deadUrl,
      type: "http",
      isActive: false,
      provenance: {
        source: "free:oneproxy",
        lastSeenAt: twoHoursAgo,
        untrusted: true,
      },
    });

    // Mark testStatus as error and backdate createdAt
    const db = await (await import("../../src/lib/db/driver.js")).getAdapter();
    db.run(
      "UPDATE proxyPools SET testStatus = ?, createdAt = ?, updatedAt = ? WHERE id = ?",
      ["error", twoHoursAgo, twoHoursAgo, deadId]
    );

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ proxies: [] }), { status: 200 })
    );

    // Run sync with default prune: true
    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.pruned).toBe(1);

    const pools = await proxyPoolsRepo.getProxyPools();
    expect(pools.find((p) => p.id === deadId)).toBeUndefined();
  });

  it("preserves an operator-disabled free pool with testStatus 'unknown' after sync", async () => {
    const poolUrl = "http://185.220.106.10:8080";
    const poolId = freeProxyCore.computeFreePoolId(poolUrl);

    // Seed existing inactive pool with testStatus 'unknown' (e.g. from old build default)
    await freeProxyCore.createFreeProxyPool({
      id: poolId,
      name: "[oneproxy] 185.220.106.10:8080",
      proxyUrl: poolUrl,
      type: "http",
      isActive: false,
      provenance: {
        source: "free:oneproxy",
        lastSeenAt: new Date().toISOString(),
        untrusted: true,
      },
    });

    const db = await (await import("../../src/lib/db/driver.js")).getAdapter();
    db.run("UPDATE proxyPools SET isActive = 0, testStatus = 'unknown' WHERE id = ?", [poolId]);

    const before = await proxyPoolsRepo.getProxyPoolById(poolId);
    expect(before.isActive).toBe(false);
    expect(before.testStatus).toBe("unknown");

    const feedPayload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "185.220.106.10",
          port: 8080,
          protocol: "http",
        },
      ],
    });
    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);

    const after = await proxyPoolsRepo.getProxyPoolById(poolId);
    expect(after.isActive).toBe(false);
  });

  it("keeps an inactive free pool with testStatus 'error' inactive after sync", async () => {
    const poolUrl = "http://185.220.106.20:8080";
    const poolId = freeProxyCore.computeFreePoolId(poolUrl);
    const recent = new Date().toISOString();

    // Seed existing inactive pool with testStatus 'error' created recently (so prune doesn't delete it)
    await freeProxyCore.createFreeProxyPool({
      id: poolId,
      name: "[oneproxy] 185.220.106.20:8080",
      proxyUrl: poolUrl,
      type: "http",
      isActive: false,
      provenance: {
        source: "free:oneproxy",
        lastSeenAt: recent,
        untrusted: true,
      },
    });

    const db = await (await import("../../src/lib/db/driver.js")).getAdapter();
    db.run(
      "UPDATE proxyPools SET isActive = 0, testStatus = 'error', createdAt = ?, updatedAt = ? WHERE id = ?",
      [recent, recent, poolId]
    );

    const before = await proxyPoolsRepo.getProxyPoolById(poolId);
    expect(before.isActive).toBe(false);
    expect(before.testStatus).toBe("error");

    const feedPayload = JSON.stringify({
      proxies: [
        {
          alive: true,
          ip: "185.220.106.20",
          port: 8080,
          protocol: "http",
        },
      ],
    });
    const mockFetch = vi.fn().mockResolvedValue(new Response(feedPayload, { status: 200 }));

    const result = await freeProxyCore.runFreeProxySync({
      customFetch: mockFetch,
      prune: false,
    });

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);

    const after = await proxyPoolsRepo.getProxyPoolById(poolId);
    expect(after.isActive).toBe(false);
    expect(after.testStatus).toBe("error");
  });
});

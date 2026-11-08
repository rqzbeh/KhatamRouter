import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createProviderSyncScheduler,
  runProviderSyncOnce,
  DEFAULT_SYNC_POLICY,
} from "@/lib/models/providerSync.js";

describe("createProviderSyncScheduler - Cluster role gating", () => {
  const originalRole = process.env.KHATAM_WORKER_ROLE;

  afterEach(() => {
    if (originalRole === undefined) delete process.env.KHATAM_WORKER_ROLE;
    else process.env.KHATAM_WORKER_ROLE = originalRole;
  });

  it("follower worker (KHATAM_WORKER_ROLE=worker) skips scheduler startup", () => {
    process.env.KHATAM_WORKER_ROLE = "worker";
    let timerSetCount = 0;

    const scheduler = createProviderSyncScheduler({
      setTimer: () => {
        timerSetCount++;
        return 123;
      },
      listConnections: vi.fn(),
      importConnection: vi.fn(),
    });

    const res = scheduler.start();
    expect(res.started).toBe(false);
    expect(res.reason).toBe("follower-skip");
    expect(timerSetCount).toBe(0);
    expect(scheduler.getStatus().isLeader).toBe(false);
  });

  it("leader worker (KHATAM_WORKER_ROLE=leader) starts scheduler", () => {
    process.env.KHATAM_WORKER_ROLE = "leader";
    let timerSetCount = 0;

    const scheduler = createProviderSyncScheduler({
      setTimer: () => {
        timerSetCount++;
        return 123;
      },
      clearTimer: vi.fn(),
      listConnections: vi.fn(),
      importConnection: vi.fn(),
    });

    const res = scheduler.start();
    expect(res.started).toBe(true);
    expect(timerSetCount).toBe(1);
    expect(scheduler.getStatus().isLeader).toBe(true);
    scheduler.stop();
  });

  it("single process (unset KHATAM_WORKER_ROLE) acts as leader and starts scheduler", () => {
    delete process.env.KHATAM_WORKER_ROLE;
    let timerSetCount = 0;

    const scheduler = createProviderSyncScheduler({
      setTimer: () => {
        timerSetCount++;
        return 123;
      },
      clearTimer: vi.fn(),
      listConnections: vi.fn(),
      importConnection: vi.fn(),
    });

    const res = scheduler.start();
    expect(res.started).toBe(true);
    expect(timerSetCount).toBe(1);
    expect(scheduler.getStatus().isLeader).toBe(true);
    scheduler.stop();
  });
});

describe("createProviderSyncScheduler - Policy off safety & execution", () => {
  it("when policy is completely off, does NOT call listConnections or importConnection", async () => {
    const listConnectionsMock = vi.fn();
    const importConnectionMock = vi.fn();

    const scheduler = createProviderSyncScheduler({
      getPolicy: async () => ({
        globalDefault: "disabled",
        providers: { openai: "disabled", anthropic: "inherit" },
        intervalMs: 86400000,
      }),
      listConnections: listConnectionsMock,
      importConnection: importConnectionMock,
      setTimer: (fn) => setTimeout(fn, 1),
      clearTimer: (id) => clearTimeout(id),
    });

    await scheduler.runNow();

    expect(listConnectionsMock).not.toHaveBeenCalled();
    expect(importConnectionMock).not.toHaveBeenCalled();
  });

  it("enforces single in-flight execution", async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;

    const importConnection = async () => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((r) => setTimeout(r, 20));
      activeCalls--;
      return { ok: true };
    };

    const scheduler = createProviderSyncScheduler({
      getPolicy: async () => ({
        globalDefault: "enabled",
        providers: {},
        intervalMs: 86400000,
      }),
      listConnections: async () => [
        { id: "c1", provider: "openai", isActive: true },
      ],
      importConnection,
      setTimer: (fn) => setTimeout(fn, 1),
      clearTimer: (id) => clearTimeout(id),
    });

    // Fire two runs concurrently
    const p1 = scheduler.runNow();
    const p2 = scheduler.runNow();
    await Promise.all([p1, p2]);

    expect(maxConcurrent).toBe(1);
  });

  it("stop() clears active timer and aborts in-flight execution", async () => {
    let aborted = false;

    const scheduler = createProviderSyncScheduler({
      getPolicy: async () => ({
        globalDefault: "enabled",
        providers: {},
        intervalMs: 86400000,
      }),
      listConnections: async () => [
        { id: "c1", provider: "openai", isActive: true },
      ],
      importConnection: async (conn, { signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true };
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    const runPromise = scheduler.runNow();
    await new Promise((r) => setTimeout(r, 10)); // allow run to enter in-flight
    scheduler.stop();
    await runPromise;

    expect(aborted).toBe(true);
    expect(scheduler.getStatus().running).toBe(false);
  });
});

describe("runProviderSyncOnce - Chunking, error isolation and filtering", () => {
  it("skips inactive connections and policy-disabled providers, recording counts", async () => {
    const connections = [
      { id: "c1", provider: "openai", isActive: true },
      { id: "c2", provider: "openai", isActive: false }, // inactive
      { id: "c3", provider: "anthropic", isActive: 0 }, // inactive
      { id: "c4", provider: "custom-bad", isActive: true }, // policy disabled
    ];

    const policy = {
      globalDefault: "disabled",
      providers: { openai: "enabled", "custom-bad": "disabled" },
      intervalMs: 86400000,
    };

    const imported = [];
    const res = await runProviderSyncOnce({
      policy,
      connections,
      importConnection: async (conn) => {
        imported.push(conn.id);
        return { ok: true, models: ["m1", "m2"] };
      },
    });

    expect(imported).toEqual(["c1"]);
    expect(res.processed).toBe(1);
    expect(res.skipped.inactive).toBe(2);
    expect(res.skipped.policyDisabled).toBe(1);
    expect(res.hasMore).toBe(false);
  });

  it("bounds batch size and reports hasMore without silent drops", async () => {
    // Generate 120 eligible connections
    const connections = Array.from({ length: 120 }, (_, i) => ({
      id: `conn-${i}`,
      provider: "openai",
      isActive: true,
    }));

    const policy = {
      globalDefault: "enabled",
      providers: {},
      intervalMs: 86400000,
    };

    const imported = [];
    const res = await runProviderSyncOnce({
      policy,
      connections,
      maxConnections: 100,
      importConnection: async (conn) => {
        imported.push(conn.id);
        return { ok: true };
      },
    });

    expect(imported.length).toBe(100);
    expect(res.processed).toBe(100);
    expect(res.hasMore).toBe(true);
    expect(res.remainingCount).toBe(20);
  });

  it("isolates errors per connection and continues run", async () => {
    const connections = [
      { id: "c1", provider: "openai", isActive: true },
      { id: "c2", provider: "anthropic", isActive: true },
      { id: "c3", provider: "gemini", isActive: true },
    ];

    const policy = {
      globalDefault: "enabled",
      providers: {},
      intervalMs: 86400000,
    };

    const res = await runProviderSyncOnce({
      policy,
      connections,
      importConnection: async (conn) => {
        if (conn.id === "c2") {
          throw new Error("Provider rate limit 429");
        }
        return { ok: true, modelsCount: 5 };
      },
    });

    expect(res.processed).toBe(3);
    expect(res.results.find((r) => r.connectionId === "c1").success).toBe(true);
    expect(res.results.find((r) => r.connectionId === "c2").success).toBe(false);
    expect(res.results.find((r) => r.connectionId === "c2").error).toContain("429");
    expect(res.results.find((r) => r.connectionId === "c3").success).toBe(true);
  });

  it("enforces per-connection timeout with finite abort", async () => {
    const connections = [
      { id: "slow-conn", provider: "openai", isActive: true },
    ];

    const policy = {
      globalDefault: "enabled",
      providers: {},
      intervalMs: 86400000,
    };

    const res = await runProviderSyncOnce({
      policy,
      connections,
      perConnectionTimeoutMs: 25,
      importConnection: async (conn, { signal }) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("Connection aborted");
            err.name = "AbortError";
            reject(err);
          });
          // Do not resolve normally
        });
      },
    });

    expect(res.results[0].success).toBe(false);
    expect(res.results[0].error).toMatch(/timed out or aborted/i);
  });

  it("timeoutfirst nosecondprobe: stops cycle immediately on timeout to prevent overlapping orphans", async () => {
    const probed = [];
    const connections = [
      { id: "conn-1-slow", provider: "openai", isActive: true },
      { id: "conn-2-normal", provider: "openai", isActive: true },
    ];
    const policy = { globalDefault: "enabled", providers: {}, intervalMs: 86400000 };

    const res = await runProviderSyncOnce({
      policy,
      connections,
      perConnectionTimeoutMs: 20,
      importConnection: async (conn) => {
        probed.push(conn.id);
        if (conn.id === "conn-1-slow") {
          return new Promise(() => {}); // hang to trigger timeout
        }
        return { ok: true };
      },
    });

    expect(probed).toEqual(["conn-1-slow"]);
    expect(res.aborted).toBe(true);
    expect(res.results.length).toBe(1);
    expect(res.results[0].success).toBe(false);
  });
});

describe("createProviderSyncScheduler - Negative lifecycle & cancellation", () => {
  it("follower runNow skips execution as well", async () => {
    const listMock = vi.fn();
    const scheduler = createProviderSyncScheduler({
      role: "worker",
      listConnections: listMock,
      importConnection: vi.fn(),
    });

    const res = await scheduler.runNow();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("follower-skip");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("stopduringhunglist: stopping during hung listConnections cancels cycle with no importConnection calls", async () => {
    let listStarted = false;
    const importMock = vi.fn();

    const scheduler = createProviderSyncScheduler({
      role: "leader",
      getPolicy: async () => ({ globalDefault: "enabled", providers: {}, intervalMs: 86400000 }),
      listConnections: async () => {
        listStarted = true;
        return new Promise(() => {}); // never resolve
      },
      importConnection: importMock,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    const runPromise = scheduler.runNow();
    await new Promise((r) => setTimeout(r, 15));
    expect(listStarted).toBe(true);

    scheduler.stop();
    const result = await runPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out or aborted/i);
    expect(importMock).not.toHaveBeenCalled();
    expect(scheduler.getStatus().inFlight).toBe(false);
    expect(scheduler.getStatus().running).toBe(false);
  });

  it("stoprestart nooverlap: stop then restart increments generation and runs cleanly without overlap", async () => {
    let runCount = 0;
    const scheduler = createProviderSyncScheduler({
      role: "leader",
      getPolicy: async () => ({ globalDefault: "enabled", providers: {}, intervalMs: 86400000 }),
      listConnections: async () => [{ id: "c1", provider: "openai", isActive: true }],
      importConnection: async () => {
        runCount++;
        return { ok: true };
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(runCount).toBeGreaterThanOrEqual(1);

    scheduler.stop();
    const countAfterStop = runCount;

    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(runCount).toBeGreaterThan(countAfterStop);
    scheduler.stop();
  });
});

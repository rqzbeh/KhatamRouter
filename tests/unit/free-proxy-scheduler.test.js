import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), sync: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/freeProxyProviders/index.js", () => ({
  KNOWN_SOURCES: ["oneproxy", "proxifly", "iplocate"],
  DEFAULT_FREE_PROXY_POLICY: { acknowledgedRisk: false, enabled: {} },
  runFreeProxySync: mocks.sync,
  acquireFreeProxySyncLease: mocks.acquire,
  releaseFreeProxySyncLease: mocks.release,
}));

import {
  startFreeProxySyncScheduler, stopFreeProxySyncScheduler,
  isFreeProxySyncSchedulerRunning, runSchedulerTick, parseSyncInterval, isPolicyActive,
  DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS, MIN_FREE_PROXY_SYNC_INTERVAL_MS,
} from "../../src/lib/freeProxyProviders/scheduler.js";

const active = { freeProxySources: { acknowledgedRisk: true, enabled: { oneproxy: true } } };

describe("free proxy periodic sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.sync.mockResolvedValue({ success: true });
    mocks.acquire.mockResolvedValue({ acquired: true, leaseId: "test-lease" });
    mocks.release.mockResolvedValue(undefined);
  });
  afterEach(() => {
    stopFreeProxySyncScheduler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds intervals including timer overflow and malformed input", () => {
    expect(parseSyncInterval({})).toBe(DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS);
    for (const value of ["oops", "60000oops", "Infinity"]) {
      expect(parseSyncInterval({ FREE_PROXY_SYNC_INTERVAL_MS: value })).toBe(DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS);
    }
    expect(parseSyncInterval({ FREE_PROXY_SYNC_INTERVAL_MS: "0" })).toBe(MIN_FREE_PROXY_SYNC_INTERVAL_MS);
    expect(parseSyncInterval({ FREE_PROXY_SYNC_INTERVAL_MS: "9000000000" })).toBe(2147483647);
    expect(parseSyncInterval({ FREE_PROXY_SYNC_INTERVAL_MS: "120000" })).toBe(120000);
  });

  it("requires literal risk acknowledgement and a known enabled source", () => {
    expect(isPolicyActive(active.freeProxySources)).toBe(true);
    for (const policy of [null, {}, { acknowledgedRisk: "true", enabled: { oneproxy: true } },
      { acknowledgedRisk: true, enabled: { unknown: true } },
      { acknowledgedRisk: true, enabled: { oneproxy: "true" } }]) {
      expect(isPolicyActive(policy)).toBe(false);
    }
  });

  it("starts without network imports when disabled, then notices enable and disable", async () => {
    expect(await startFreeProxySyncScheduler()).toBe(true);
    expect(isFreeProxySyncSchedulerRunning()).toBe(true);
    expect(mocks.sync).not.toHaveBeenCalled();
    mocks.getSettings.mockResolvedValue(active);
    await vi.advanceTimersByTimeAsync(DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    mocks.getSettings.mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it("runs an opted-in startup sync and is idempotent with synchronous shutdown", async () => {
    mocks.getSettings.mockResolvedValue(active);
    expect(await startFreeProxySyncScheduler()).toBe(true);
    expect(await startFreeProxySyncScheduler()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    globalThis.__freeProxySyncScheduler.stop();
    expect(isFreeProxySyncSchedulerRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS * 2);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps a single timer across module reloads", async () => {
    await startFreeProxySyncScheduler();
    await vi.advanceTimersByTimeAsync(0);
    vi.resetModules();
    const reloaded = await import("../../src/lib/freeProxyProviders/scheduler.js");
    expect(await reloaded.startFreeProxySyncScheduler()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    reloaded.stopFreeProxySyncScheduler();
    expect(isFreeProxySyncSchedulerRunning()).toBe(false);
  });

  it("does not overlap slow ticks", async () => {
    mocks.getSettings.mockResolvedValue(active);
    let release;
    mocks.sync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = runSchedulerTick();
    await vi.advanceTimersByTimeAsync(0);
    await runSchedulerTick();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    release();
    await first;
    await runSchedulerTick();
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("never acquires a sync lease without literal risk acknowledgement", async () => {
    mocks.getSettings.mockResolvedValue({ freeProxySources: { acknowledgedRisk: "false", enabled: { oneproxy: true } } });
    await runSchedulerTick();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("skips when a manual sync owns the shared lease", async () => {
    mocks.getSettings.mockResolvedValue(active);
    mocks.acquire.mockResolvedValueOnce({ acquired: false });
    await runSchedulerTick();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    await runSchedulerTick();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith("test-lease");
  });

  it("recovers even if releasing the shared lease fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSettings.mockResolvedValue(active);
    mocks.release.mockRejectedValueOnce(new Error("db busy"));
    await expect(runSchedulerTick()).resolves.toBeUndefined();
    await runSchedulerTick();
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("recovers after a failed settings read or sync", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSettings.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(runSchedulerTick()).resolves.toBeUndefined();
    mocks.getSettings.mockResolvedValue(active);
    mocks.sync.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(runSchedulerTick()).resolves.toBeUndefined();
    await runSchedulerTick();
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});

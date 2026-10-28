// Wave 8 T020 — leader-only background daemons in initializeApp.js.
// Leader (KHATAM_WORKER_ROLE=leader) or unset (single-process) starts every heavy
// daemon. Followers (KHATAM_WORKER_ROLE=worker) start none, but keep the cheap
// request-serving init (signal cleanup, settings warm-up).
//
// Every dependency of initializeApp.js is mocked, so no DB, tunnel, MITM or
// network code runs. Timers are faked; STARTUP_DEFER_MS (3000) is advanced manually.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  cleanupProviderConnections: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => {}),
  getApiKeys: vi.fn(async () => []),
}));

vi.mock("@/lib/tunnel", () => {
  const svc = () => ({ cancelToken: { cancelled: false }, spawnInProgress: false, lastRestartAt: 0, activeLocalPort: null });
  return {
    enableTunnel: vi.fn(async () => {}),
    enableTailscale: vi.fn(async () => {}),
    isTunnelManuallyDisabled: vi.fn(() => false),
    isTunnelReconnecting: vi.fn(() => false),
    isTailscaleReconnecting: vi.fn(() => false),
    getTunnelService: vi.fn(svc),
    getTailscaleService: vi.fn(svc),
    setTunnelUnexpectedExitCallback: vi.fn(),
    killCloudflared: vi.fn(),
    isCloudflaredRunning: vi.fn(() => false),
    ensureCloudflared: vi.fn(async () => {}),
    isTailscaleRunning: vi.fn(() => false),
    isTailscaleRunningStrict: vi.fn(async () => false),
    isDaemonAlive: vi.fn(() => false),
    startFunnel: vi.fn(async () => {}),
    checkInternet: vi.fn(async () => true),
    RESTART_COOLDOWN_MS: 60000,
    NETWORK_SETTLE_MS: 1000,
    WATCHDOG_INTERVAL_MS: 60000,
    NETWORK_CHECK_INTERVAL_MS: 15000,
    VIRTUAL_IFACE_REGEX: /^$/,
  };
});

vi.mock("@/mitm/manager", () => ({
  getMitmStatus: vi.fn(async () => ({ running: false })),
  startMitm: vi.fn(async () => {}),
  loadEncryptedPassword: vi.fn(async () => "pw"),
  initDbHooks: vi.fn(),
  restoreToolDNS: vi.fn(async () => {}),
  removeAllDNSEntriesSync: vi.fn(),
}));

vi.mock("@/lib/mitmAliasCache", () => ({ syncToJson: vi.fn(async () => {}) }));
vi.mock("@/lib/mcp/stdioSseBridge", () => ({ killAllBridges: vi.fn() }));
vi.mock("@/shared/services/quotaAutoPing", () => ({ startQuotaAutoPing: vi.fn(async () => {}) }));
vi.mock("@/sse/services/backgroundTokenRefresh.js", () => ({ startBackgroundTokenRefresh: vi.fn(async () => {}) }));

import { initializeApp } from "@/shared/services/initializeApp.js";
import * as localDb from "@/lib/localDb";
import * as tunnel from "@/lib/tunnel";
import * as mitm from "@/mitm/manager";
import * as quota from "@/shared/services/quotaAutoPing";
import * as refresh from "@/sse/services/backgroundTokenRefresh.js";

const ALL_ON_SETTINGS = {
  tunnelEnabled: true,
  tailscaleEnabled: true,
  mitmEnabled: true,
  claudeAutoPing: { connections: { c1: true }, schedules: {} },
};

const ALL_OFF = {
  tunnel: false, tailscale: false, cloudflared: false, mitm: false,
  watchdog: false, quotaAutoPing: false, tokenRefresh: false, providerCleanup: false,
};

function startedDaemons() {
  return {
    tunnel: tunnel.enableTunnel.mock.calls.length > 0,
    tailscale: tunnel.enableTailscale.mock.calls.length > 0,
    cloudflared: tunnel.ensureCloudflared.mock.calls.length > 0,
    mitm: mitm.startMitm.mock.calls.length > 0,
    watchdog: vi.getTimerCount() > 0,
    quotaAutoPing: quota.startQuotaAutoPing.mock.calls.length > 0,
    tokenRefresh: refresh.startBackgroundTokenRefresh.mock.calls.length > 0,
    providerCleanup: localDb.cleanupProviderConnections.mock.calls.length > 0,
  };
}

async function settle() {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

async function bootWithRole(role, settings = ALL_ON_SETTINGS) {
  if (role === undefined) delete process.env.KHATAM_WORKER_ROLE;
  else process.env.KHATAM_WORKER_ROLE = role;
  localDb.getSettings.mockResolvedValue(settings);
  await initializeApp();
  await vi.advanceTimersByTimeAsync(3000); // STARTUP_DEFER_MS
  await settle();
}

const ORIGINAL_ROLE = process.env.KHATAM_WORKER_ROLE;
let listenersBefore;

describe("initializeApp leader-only daemons (cluster role gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // Module singleton is captured at import time; reset its fields in place.
    Object.assign(global.__appSingleton, {
      signalHandlersRegistered: false,
      watchdogInterval: null,
      networkMonitorInterval: null,
      lastNetworkFingerprint: null,
      lastWatchdogTick: Date.now(),
      lastOnline: null,
      mitmStartInProgress: false,
      tunnelAutoResumed: false,
      tailscaleAutoResumed: false,
    });
    listenersBefore = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
      exit: process.listeners("exit"),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const sig of ["SIGTERM", "SIGINT", "exit"]) {
      for (const l of process.listeners(sig)) {
        if (!listenersBefore[sig].includes(l)) process.removeListener(sig, l);
      }
    }
    if (ORIGINAL_ROLE === undefined) delete process.env.KHATAM_WORKER_ROLE;
    else process.env.KHATAM_WORKER_ROLE = ORIGINAL_ROLE;
  });

  it("starts every heavy daemon when KHATAM_WORKER_ROLE=leader", async () => {
    await bootWithRole("leader");

    expect(startedDaemons()).toEqual({
      tunnel: true,
      tailscale: true,
      cloudflared: true,
      mitm: true,
      watchdog: true,
      quotaAutoPing: true,
      tokenRefresh: true,
      providerCleanup: true,
    });
  });

  it("starts every heavy daemon when KHATAM_WORKER_ROLE is unset (single-process mode)", async () => {
    await bootWithRole(undefined);

    expect(startedDaemons()).toEqual({
      tunnel: true,
      tailscale: true,
      cloudflared: true,
      mitm: true,
      watchdog: true,
      quotaAutoPing: true,
      tokenRefresh: true,
      providerCleanup: true,
    });
  });

  it("starts no heavy daemon when KHATAM_WORKER_ROLE=worker, even with everything enabled", async () => {
    await bootWithRole("worker");

    expect(startedDaemons()).toEqual(ALL_OFF);
  });

  it("keeps request-serving init on followers: signal cleanup, exit callback, settings warm-up", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    await bootWithRole("worker");

    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(sigintBefore);
    expect(tunnel.setTunnelUnexpectedExitCallback).toHaveBeenCalledTimes(1);
    expect(localDb.getSettings).toHaveBeenCalled();
  });
});

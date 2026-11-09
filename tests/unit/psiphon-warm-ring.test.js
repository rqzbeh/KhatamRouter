import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  ensureTunnel,
  rotate,
  getStatus,
  stopTunnel,
  stopAll,
  stopStandby,
  __setSpawnForTests,
  __resetForTests,
  __getActiveChildForTests,
  __getStandbyForTests,
} from "@/lib/network/psiphon/psiphonManager.js";
import * as probe from "@/lib/network/psiphon/probe.js";
import "../../open-sse/utils/proxyFetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-psiphon.mjs");
const IP_KEY = ["e", "x", "i", "t", "Ip"].join("");

async function waitForCondition(fn, timeoutMs = 4000, intervalMs = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe("Psiphon Pre-warmed Standby Ring", () => {
  let tmpDataDir;
  let baseConfigFile;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psiphon-ring-test-"));
    baseConfigFile = path.join(tmpDataDir, "client.config.json");
    fs.writeFileSync(
      baseConfigFile,
      JSON.stringify({
        PropagationChannelId: "TEST_CHANNEL",
        SponsorId: "TEST_SPONSOR",
      })
    );

    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;

    process.env.DATA_DIR = tmpDataDir;
    process.env.PSIPHON_BIN = FAKE_BIN;
    process.env.PSIPHON_CONFIG_FILE = baseConfigFile;
    process.env.PSIPHON_READY_TIMEOUT_MS = "4000";
    process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS = "0";
    process.env.PSIPHON_PROBE_URL = "http://cp.cloudflare.com/generate_204";
    process.env.PSIPHON_IP_URL = "http://cp.cloudflare.com/trace";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopAll();
    __resetForTests();
    delete process.env.FAKE_PSIPHON_CRASH;
    delete process.env.FAKE_PSIPHON_NEVER_READY;
    delete process.env.FAKE_PSIPHON_LATENCY_MAP;
    delete process.env.FAKE_PSIPHON_STATIC_IP;
    delete process.env.FAKE_PSIPHON_READY_DELAY;
    delete process.env.FAKE_PSIPHON_IGNORE_SIGTERM;
    delete process.env.FAKE_PSIPHON_FLOOD_STDOUT;
    delete process.env.FAKE_PSIPHON_CRASH_AFTER_READY;
    delete process.env.PSIPHON_CRASH_BACKOFF_MS;
    delete process.env.PSIPHON_STANDBY_TTL_MS;
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  it("warmStandby config is read and clamped 0..4", async () => {
    const poolNormal = {
      id: "pool-cfg-3",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 1, warmStandby: 3 } },
    };
    await ensureTunnel(poolNormal);
    expect(getStatus("pool-cfg-3").warmStandby).toBe(3);

    const poolHigh = {
      id: "pool-cfg-high",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 1, warmStandby: 99 } },
    };
    await ensureTunnel(poolHigh);
    expect(getStatus("pool-cfg-high").warmStandby).toBe(4);

    const poolLow = {
      id: "pool-cfg-low",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 1, warmStandby: -5 } },
    };
    await ensureTunnel(poolLow);
    expect(getStatus("pool-cfg-low").warmStandby).toBe(0);

    const poolDefault = {
      id: "pool-cfg-default",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 1 } },
    };
    await ensureTunnel(poolDefault);
    expect(getStatus("pool-cfg-default").warmStandby).toBe(2);
  });

  it("after a ready pool with probeCandidates>=2 and warmStandby 2, state.standby.length becomes 2 (poll with a bounded loop)", async () => {
    const pool = {
      id: "pool-ring-2",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    const initial = await ensureTunnel(pool);
    expect(initial.generation).toBe(1);
    expect(getStatus("pool-ring-2").state).toBe("ready");

    const filled = await waitForCondition(() => {
      const st = getStatus("pool-ring-2");
      return st.standbyReady === 2;
    });

    expect(filled).toBe(true);
    const standbyList = __getStandbyForTests("pool-ring-2");
    expect(standbyList.length).toBe(2);
    expect(standbyList[0].proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(standbyList[1].proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("rotate() with a standby present returns promptly (< 250 ms measured with performance.now()) and bumps the generation", async () => {
    const pool = {
      id: "pool-prompt-rot",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    const initial = await ensureTunnel(pool);
    expect(initial.generation).toBe(1);

    const filled = await waitForCondition(() => getStatus("pool-prompt-rot").standbyReady >= 1);
    expect(filled).toBe(true);

    const genBefore = getStatus("pool-prompt-rot").generation;
    const t0 = performance.now();
    const rot = await rotate("pool-prompt-rot", { reason: "fast_rotation" });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(250);
    expect(rot.rotated).toBe(true);
    expect(rot.generation).toBe(genBefore + 1);
    expect(getStatus("pool-prompt-rot").generation).toBe(genBefore + 1);
  });

  it("the promoted exit IP differs from the previous active", async () => {
    const pool = {
      id: "pool-diff-ip",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    const initial = await ensureTunnel(pool);
    const ipBefore = initial[IP_KEY];
    expect(ipBefore).toBeTruthy();

    await waitForCondition(() => getStatus("pool-diff-ip").standbyReady >= 1);

    const rot = await rotate("pool-diff-ip", { reason: "verify_ip_change" });
    expect(rot.rotated).toBe(true);
    expect(rot.exitIp).toBeTruthy();
    expect(rot.exitIp).not.toBe(ipBefore);
  });

  it("refill restores the ring after promotion", async () => {
    const pool = {
      id: "pool-refill-restore",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE", "FR", "JP"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    await ensureTunnel(pool);
    await waitForCondition(() => getStatus("pool-refill-restore").standbyReady === 2);
    expect(getStatus("pool-refill-restore").standbyReady).toBe(2);

    // Promote one standby tunnel
    await rotate("pool-refill-restore", { reason: "consume_one" });

    // Standby was spliced immediately
    // Wait for detached refill to restore ring length back to target 2
    const restored = await waitForCondition(() => {
      return getStatus("pool-refill-restore").standbyReady === 2;
    });

    expect(restored).toBe(true);
    expect(getStatus("pool-refill-restore").standbyReady).toBe(2);
  });

  it("a short PSIPHON_STANDBY_TTL_MS makes an old standby be pruned rather than promoted", async () => {
    process.env.PSIPHON_STANDBY_TTL_MS = "40";

    const pool = {
      id: "pool-ttl-prune",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 1,
        },
      },
    };

    await ensureTunnel(pool);
    await waitForCondition(() => getStatus("pool-ttl-prune").standbyReady === 1);

    const standbyBefore = __getStandbyForTests("pool-ttl-prune");
    expect(standbyBefore.length).toBe(1);
    const staleChild = standbyBefore[0].child;
    const staleProxyUrl = standbyBefore[0].proxyUrl;

    // Sleep long enough for the standby to exceed 40ms TTL
    await new Promise((r) => setTimeout(r, 60));

    // Rotate should prune the stale standby and fall back to fresh establishment
    const rot = await rotate("pool-ttl-prune", { reason: "ttl_test" });
    expect(rot.rotated).toBe(true);

    // The stale child must have been terminated and not promoted
    const currentActiveChild = __getActiveChildForTests("pool-ttl-prune");
    expect(currentActiveChild).not.toBe(staleChild);
    expect(getStatus("pool-ttl-prune").proxyUrl).not.toBe(staleProxyUrl);
    expect(staleChild.killed || staleChild.exitCode !== null).toBe(true);
  });

  it("stopStandby empties the ring and terminates children", async () => {
    const pool = {
      id: "pool-stop-standby",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    await ensureTunnel(pool);
    await waitForCondition(() => getStatus("pool-stop-standby").standbyReady === 2);

    const standbys = [...__getStandbyForTests("pool-stop-standby")];
    expect(standbys.length).toBe(2);
    const [s1, s2] = standbys;

    await stopStandby("pool-stop-standby");

    expect(getStatus("pool-stop-standby").standbyReady).toBe(0);
    expect(__getStandbyForTests("pool-stop-standby").length).toBe(0);
    expect(s1.child.killed || s1.child.exitCode !== null).toBe(true);
    expect(s2.child.killed || s2.child.exitCode !== null).toBe(true);
  });

  it("an unverified loser (no exit IP) is not retained", async () => {
    const originalProbeExitIp = probe.probeExitIp;
    let exitProbeCount = 0;

    // Spy on probeExitIp: winner gets verified IP, but loser returns null (no exit IP)
    vi.spyOn(probe, "probeExitIp").mockImplementation(async (proxyUrl) => {
      exitProbeCount++;
      // Probe 1: initial active tunnel winner -> returns IP
      // Probe 2: refill standby winner -> returns IP
      // Probe 3: refill standby loser -> returns null (unverified!)
      if (exitProbeCount === 3) {
        return null;
      }
      return originalProbeExitIp(proxyUrl);
    });

    const pool = {
      id: "pool-unverified-loser",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    await ensureTunnel(pool);

    // Wait for the first refill attempt to finish
    await waitForCondition(() => getStatus("pool-unverified-loser").standbyReady >= 1);

    // Because loser failed exit IP probe, only winner was retained in this cycle
    const standbyList = __getStandbyForTests("pool-unverified-loser");
    for (const entry of standbyList) {
      expect(entry.exitIp).toBeTruthy();
    }
  });

  it("a standby exists but rotate() with a stale seenGeneration does not promote", async () => {
    const pool = {
      id: "pool-stale-gen",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL", "DE"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    await ensureTunnel(pool);
    await waitForCondition(() => getStatus("pool-stale-gen").standbyReady >= 1);

    const statusBefore = getStatus("pool-stale-gen");
    const currentGen = statusBefore.generation;
    const standbyCountBefore = statusBefore.standbyReady;

    // Attempt rotation with older seenGeneration
    const rot = await rotate("pool-stale-gen", {
      reason: "429_stale",
      seenGeneration: currentGen - 1,
    });

    expect(rot.rotated).toBe(false);
    expect(rot.generation).toBe(currentGen);
    expect(getStatus("pool-stale-gen").generation).toBe(currentGen);
    // Standby was not promoted or consumed
    expect(getStatus("pool-stale-gen").standbyReady).toBe(standbyCountBefore);
  });

  it("getStatus reports standbyReady and never the apiKey/ports beyond proxyUrl", async () => {
    const pool = {
      id: "pool-status-hygiene",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL"],
          probeCandidates: 2,
          warmStandby: 2,
        },
      },
    };

    await ensureTunnel(pool);
    await waitForCondition(() => getStatus("pool-status-hygiene").standbyReady >= 1);

    const status = getStatus("pool-status-hygiene");
    expect(status.standbyReady).toBeGreaterThanOrEqual(1);
    expect(status.warmStandby).toBe(2);
    expect(status.standbyTunnels).toBeInstanceOf(Array);
    expect(typeof status.refillInFlight).toBe("boolean");

    for (const t of status.standbyTunnels) {
      expect(t.region).toBeDefined();
      expect(t.exitIp).toBeDefined();
      expect(t.generation).toBeDefined();
      expect(t.apiKey).toBeUndefined();
      expect(t.proxyUrl).toBeUndefined();
      expect(t.port).toBeUndefined();
      expect(t.child).toBeUndefined();
      expect(t.dataDir).toBeUndefined();
    }

    const rawJson = JSON.stringify(status);
    expect(rawJson).not.toContain("child");
    expect(rawJson).not.toContain("tempConfigFile");
    expect(rawJson).not.toContain("dataRootDir");
    expect(rawJson).not.toContain("apiKey");
  });
});

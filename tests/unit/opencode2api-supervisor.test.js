import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isOpencodeSidecarPool,
  ensureSidecar,
  stopSidecar,
  getStatus,
  checkHealth,
  OpencodeSidecarUnavailableError,
  __setSpawnForTests,
  __resetForTests,
  __getActiveChildForTests,
  sidecarSpawnCount,
  __resetSidecarSpawnCount,
} from "@/lib/network/opencode2api/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-opencode2api.mjs");

async function waitFor(fn, timeoutMs = 6000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor condition timed out after ${timeoutMs}ms`);
}

describe("opencode2api sidecar supervisor", () => {
  let tmpDataDir;
  const origDataDir = process.env.DATA_DIR;
  const origDataDirAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;

  beforeAll(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-sup-test-"));
    process.env.DATA_DIR = tmpDataDir;
    process.env.DATA_DIR_ALLOW_TEMP = "1";
  });

  afterAll(() => {
    if (origDataDir !== undefined) {
      process.env.DATA_DIR = origDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    if (origDataDirAllowTemp !== undefined) {
      process.env.DATA_DIR_ALLOW_TEMP = origDataDirAllowTemp;
    } else {
      delete process.env.DATA_DIR_ALLOW_TEMP;
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    __setSpawnForTests((binPath, args, options) => {
      return spawn(process.execPath, [FAKE_BIN, ...args], options);
    });
  });

  afterEach(async () => {
    await __resetForTests();
    delete process.env.FAKE_SIDECAR_NEVER_READY;
    delete process.env.FAKE_SIDECAR_DEGRADED;
    delete process.env.FAKE_SIDECAR_CRASH_AFTER_READY;
    delete process.env.FAKE_SIDECAR_IGNORE_SIGTERM;
    delete process.env.FAKE_SIDECAR_WRITE_MARKER;
    delete process.env.FAKE_SIDECAR_WARP_FAIL;
    delete process.env.OPENCODE2API_READY_TIMEOUT_MS;
    delete process.env.OPENCODE2API_HEALTH_INTERVAL_MS;
  });

  it("identifies opencode2api pools with isOpencodeSidecarPool", () => {
    expect(isOpencodeSidecarPool({ type: "opencode2api" })).toBe(true);
    expect(isOpencodeSidecarPool({ data: { type: "opencode2api" } })).toBe(true);
    expect(isOpencodeSidecarPool({ type: "psiphon" })).toBe(false);
    expect(isOpencodeSidecarPool(null)).toBe(false);
  });

  it("ensureSidecar reaches ready with health", async () => {
    const pool = {
      id: "pool-ready-test",
      type: "opencode2api",
      config: { poolSize: 2, warmStandby: 1 },
    };

    const res = await ensureSidecar(pool);
    expect(res).toBeDefined();
    expect(res.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(res.apiKey).toMatch(/^[0-9a-f]{48}$/);
    expect(res.generation).toBe(1);
    expect(res.health).toEqual({
      status: "ok",
      ready: true,
      warp: { status: "ready", active: 2, standby: 2, cooling: 0 },
    });

    const status = getStatus(pool.id);
    expect(status.state).toBe("ready");
    expect(status.generation).toBe(1);
    expect(status.proxyUrl).toBe(res.proxyUrl);
    expect(status.apiKey).toBe(res.apiKey);
    expect(status.activeExits).toBe(2);
    expect(status.standbyExits).toBe(2);
    expect(status.coolingExits).toBe(0);
    expect(status.lastError).toBeNull();

    const health = await checkHealth(pool.id);
    expect(health).toEqual({
      ready: true,
      warp: { status: "ready", active: 2, standby: 2, cooling: 0 },
    });
  });

  it("second ensure returns the same generation without respawn", async () => {
    const pool = {
      id: "pool-cache-test",
      type: "opencode2api",
      config: { poolSize: 3 },
    };

    const first = await ensureSidecar(pool);
    const second = await ensureSidecar(pool);

    expect(second.generation).toBe(first.generation);
    expect(second.proxyUrl).toBe(first.proxyUrl);
    expect(second.apiKey).toBe(first.apiKey);
  });

  it("never-ready fixture times out with OpencodeSidecarUnavailableError", async () => {
    process.env.FAKE_SIDECAR_NEVER_READY = "1";
    process.env.OPENCODE2API_READY_TIMEOUT_MS = "800";

    const pool = {
      id: "pool-never-ready",
      type: "opencode2api",
    };

    await expect(ensureSidecar(pool)).rejects.toThrow(OpencodeSidecarUnavailableError);

    const status = getStatus(pool.id);
    expect(status.state).toBe("failed");
    expect(status.lastError).toContain("readiness timed out");
  });

  it("falls back to no-WARP instead of failing when WARP registration is blocked", async () => {
    process.env.FAKE_SIDECAR_WARP_FAIL = "1";
    __resetSidecarSpawnCount();

    const pool = {
      id: "pool-warp-fallback",
      type: "opencode2api",
    };

    // The daemon aborts startup on a blocked WARP registration; the supervisor
    // must relaunch it with warp.enabled=false and still reach readiness, so a
    // filtered uplink degrades to host-IP egress instead of an unusable pool.
    const res = await ensureSidecar(pool);
    expect(res.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const status = getStatus(pool.id);
    expect(status.state).toBe("ready");
    expect(status.lastError).toBeNull();

    // Exactly one extra process: the WARP-enabled attempt plus the fallback.
    expect(sidecarSpawnCount()).toBe(2);

    // The relaunched config really carries warp.enabled=false.
    const runDir = path.join(tmpDataDir, "opencode2api", "run");
    const configFile = fs.readdirSync(runDir).find((f) => f.startsWith(`${pool.id}-pid-`));
    expect(configFile).toBeTruthy();
    const written = JSON.parse(fs.readFileSync(path.join(runDir, configFile), "utf8"));
    expect(written.warp.enabled).toBe(false);
  });

  it("degraded healthz triggers a background restart (marker file grows)", async () => {
    const markerFile = path.join(tmpDataDir, "marker-degraded.txt");
    const degradedFlag = path.join(tmpDataDir, "degraded-flag.txt");
    process.env.FAKE_SIDECAR_WRITE_MARKER = markerFile;
    process.env.FAKE_SIDECAR_DEGRADED = degradedFlag;
    process.env.OPENCODE2API_HEALTH_INTERVAL_MS = "100";

    const pool = {
      id: "pool-watchdog-degraded",
      type: "opencode2api",
    };

    const initial = await ensureSidecar(pool);
    expect(initial.generation).toBe(1);

    const countInitial = fs.readFileSync(markerFile, "utf-8").trim().split("\n").length;
    expect(countInitial).toBe(1);

    // Switch fixture to degraded state dynamically via flag file
    fs.writeFileSync(degradedFlag, "1");

    // Watchdog should detect ready: false within ~200-500ms and restart
    await waitFor(() => {
      if (!fs.existsSync(markerFile)) return false;
      const lines = fs.readFileSync(markerFile, "utf-8").trim().split("\n");
      return lines.length >= 2;
    });

    const linesAfter = fs.readFileSync(markerFile, "utf-8").trim().split("\n");
    expect(linesAfter.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it("crash-after-ready restarts in background", async () => {
    const markerFile = path.join(tmpDataDir, "marker-crash.txt");
    process.env.FAKE_SIDECAR_WRITE_MARKER = markerFile;
    process.env.FAKE_SIDECAR_CRASH_AFTER_READY = "1";

    const pool = {
      id: "pool-crash-restart",
      type: "opencode2api",
    };

    const first = await ensureSidecar(pool);
    expect(first.generation).toBe(1);

    // Turn off crash flag for subsequent spawns so the restarted child stays alive
    delete process.env.FAKE_SIDECAR_CRASH_AFTER_READY;

    // The supervisor detects the exit and restarts in background
    await waitFor(async () => {
      const status = getStatus(pool.id);
      return status.generation > 1 && status.state === "ready";
    });

    const status = getStatus(pool.id);
    expect(status.generation).toBeGreaterThan(1);
    expect(status.state).toBe("ready");
  });

  it("stopSidecar kills the process and cleans the config file", async () => {
    const pool = {
      id: "pool-stop-test",
      type: "opencode2api",
    };

    const res = await ensureSidecar(pool);
    expect(res).toBeDefined();

    const child = __getActiveChildForTests(pool.id);
    expect(child).not.toBeNull();
    const pid = child.pid;

    await stopSidecar(pool.id);

    const status = getStatus(pool.id);
    expect(status.state).toBe("stopped");
    expect(status.proxyUrl).toBeNull();

    // Verify child process is dead
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    // Verify config files for this pool are cleaned up
    const runDir = path.join(tmpDataDir, "opencode2api", "run");
    if (fs.existsSync(runDir)) {
      const files = fs.readdirSync(runDir).filter((f) => f.startsWith(`${pool.id}-`));
      expect(files).toHaveLength(0);
    }
  });

  it("crash-loop gives up after 3 exits and stays failed", async () => {
    process.env.FAKE_SIDECAR_CRASH_AFTER_READY = "1";

    const pool = {
      id: "pool-crash-loop",
      type: "opencode2api",
    };

    await ensureSidecar(pool);

    // Wait until crashLoopFailed is triggered (3 exits within 30s)
    await waitFor(() => {
      const status = getStatus(pool.id);
      return status.state === "failed" && status.lastError?.includes("crash-loop");
    }, 8000);

    const status = getStatus(pool.id);
    expect(status.state).toBe("failed");
    expect(status.lastError).toContain("crash-loop detected");

    // Subsequent ensure throws immediately without respawn
    await expect(ensureSidecar(pool)).rejects.toThrow(OpencodeSidecarUnavailableError);

    // Manual stop resets crash loop
    await stopSidecar(pool.id);
    delete process.env.FAKE_SIDECAR_CRASH_AFTER_READY;

    // Can ensure again after manual stop
    const recovered = await ensureSidecar(pool);
    expect(recovered.generation).toBeGreaterThan(0);
    expect(getStatus(pool.id).state).toBe("ready");
  });

  it("honors persisted pool options from the pool data block", async () => {
    // The pool API stores options under data.opencode2api, and rowToPool spreads
    // `data` onto the row, so both shapes must reach the generated config.
    const pool = {
      id: "pool-persisted-options",
      type: "opencode2api",
      data: { type: "opencode2api", opencode2api: { poolSize: 5, warmStandby: 1, retryAttempts: 2 } },
    };

    await ensureSidecar(pool);

    const runDir = path.join(tmpDataDir, "opencode2api", "run");
    const configFile = fs.readdirSync(runDir).find((f) => f.startsWith("pool-persisted-options"));
    expect(configFile).toBeTruthy();
    const written = JSON.parse(fs.readFileSync(path.join(runDir, configFile), "utf8"));

    // poolSize is the registered ceiling, so the warm standbys are added on top.
    expect(written.warp.pool_size).toBe(6);
    expect(written.retry.max_attempts).toBe(2);
  });

  it("getStatus never hides a failure", async () => {
    process.env.FAKE_SIDECAR_NEVER_READY = "1";
    process.env.OPENCODE2API_READY_TIMEOUT_MS = "500";

    const pool = {
      id: "pool-status-failure",
      type: "opencode2api",
    };

    await expect(ensureSidecar(pool)).rejects.toThrow();

    const status = getStatus(pool.id);
    expect(status.state).toBe("failed");
    expect(status.lastError).toBeTruthy();
    expect(status.proxyUrl).toBeNull();
  });
});

import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  OpencodeSidecarUnavailableError,
  normalizeSidecarConfig,
  getSidecarBinPath,
  allocatePort,
  createSidecarConfigFile,
  cleanSidecarConfigFile,
  sweepStaleSidecarDirs,
} from "./config.js";
import { ensureSidecarBinary } from "./downloader.js";

export { OpencodeSidecarUnavailableError };

// Map of poolId -> poolState
const poolsState = new Map();

// Test hooks
let testSpawnFn = null;
export function __setSpawnForTests(fn) {
  testSpawnFn = fn;
}

let testHealthFetchFn = null;
export function __setHealthFetchForTests(fn) {
  testHealthFetchFn = fn;
}

export function __getActiveChildForTests(poolId) {
  return poolsState.get(poolId)?.child || null;
}

/**
 * Checks if a pool definition is an opencode2api sidecar pool.
 * @param {object} pool
 * @returns {boolean}
 */
export function isOpencodeSidecarPool(pool) {
  if (!pool) return false;
  return pool.type === "opencode2api" || pool.data?.type === "opencode2api";
}

export async function terminateProcess(child, sigkillTimeoutMs = 1500) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    let fallbackTimer = null;

    const onExit = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolve();
    };

    child.once("exit", onExit);
    child.once("close", onExit);

    killTimer = setTimeout(() => {
      if (!settled && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, sigkillTimeoutMs);

    fallbackTimer = setTimeout(onExit, sigkillTimeoutMs + 1000);

    try {
      child.kill("SIGTERM");
    } catch {
      onExit();
    }
  });
}

export async function __resetForTests() {
  testSpawnFn = null;
  testHealthFetchFn = null;
  for (const state of poolsState.values()) {
    state.intentionalStop = true;
    if (state.watchdog) {
      clearInterval(state.watchdog);
      state.watchdog = null;
    }
    if (state.child) {
      const child = state.child;
      state.child = null;
      await terminateProcess(child, 500);
    }
    if (state.configFile) {
      cleanSidecarConfigFile(state.configFile);
      state.configFile = null;
    }
  }
  poolsState.clear();
}

function getOrCreatePoolState(poolId) {
  if (!poolsState.has(poolId)) {
    poolsState.set(poolId, {
      id: poolId,
      state: "idle", // 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'
      child: null,
      port: null,
      apiKey: null,
      generation: 0,
      configFile: null,
      config: null,
      dataDir: null,
      exitTimestamps: [],
      crashLoopFailed: false,
      lastError: null,
      watchdog: null,
      inFlightPromise: null,
      intentionalStop: false,
      health: null,
      exitedAt: null,
      // Cleared permanently once WARP registration was seen to fail for this
      // pool, so background restarts do not keep retrying it.
      warpEnabled: true,
      stdoutLines: [],
      stderrLines: [],
    });
  }
  return poolsState.get(poolId);
}

// Sweep stale run directories on startup
sweepStaleSidecarDirs();

// Register graceful exit handlers once
let exitHooksRegistered = false;
function registerExitHooks() {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;

  const cleanup = () => {
    for (const state of poolsState.values()) {
      state.intentionalStop = true;
      if (state.watchdog) {
        clearInterval(state.watchdog);
        state.watchdog = null;
      }
      if (state.child) {
        try {
          state.child.kill("SIGTERM");
        } catch {}
        state.child = null;
      }
      if (state.configFile) {
        cleanSidecarConfigFile(state.configFile);
        state.configFile = null;
      }
    }
  };

  process.once("exit", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}

registerExitHooks();

const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "OPENCODE2API_BIN",
  "OPENCODE2API_PORT_BASE",
  "OPENCODE2API_READY_TIMEOUT_MS",
  "OPENCODE2API_HEALTH_INTERVAL_MS",
  "FAKE_SIDECAR_NEVER_READY",
  "FAKE_SIDECAR_DEGRADED",
  "FAKE_SIDECAR_CRASH_AFTER_READY",
  "FAKE_SIDECAR_IGNORE_SIGTERM",
  "FAKE_SIDECAR_WRITE_MARKER",
  "FAKE_SIDECAR_WARP_FAIL",
  "DATA_DIR",
  "DATA_DIR_ALLOW_TEMP",
  "NODE_ENV",
]);

function buildScrubbedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ALLOWED_ENV_VARS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

// Total child processes spawned since load (test/observability aid).
let spawnCount = 0;

export function sidecarSpawnCount() {
  return spawnCount;
}

export function __resetSidecarSpawnCount() {
  spawnCount = 0;
}

function spawnSidecarChild(binPath, args, options) {
  spawnCount++;
  if (testSpawnFn) {
    const hooked = testSpawnFn(binPath, args, options);
    if (hooked) return hooked;
  }
  return spawn(binPath, args, options);
}

async function fetchHealth(url) {
  if (testHealthFetchFn) {
    return testHealthFetchFn(url);
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function startWatchdog(state) {
  if (state.watchdog) {
    clearInterval(state.watchdog);
    state.watchdog = null;
  }
  const intervalMs = parseInt(process.env.OPENCODE2API_HEALTH_INTERVAL_MS, 10) || 15000;
  const timer = setInterval(async () => {
    if (state.state !== "ready" || state.intentionalStop || state.crashLoopFailed) {
      clearInterval(timer);
      state.watchdog = null;
      return;
    }
    try {
      const health = await fetchHealth(`http://127.0.0.1:${state.port}/healthz`);
      if (!health || health.ready !== true) {
        console.warn(`[opencode2api] Pool ${state.id} watchdog reported unhealthy state:`, health?.warp?.status || "not ready");
        state.health = health;
        scheduleBackgroundRestart(state);
      } else {
        state.health = health;
      }
    } catch (err) {
      console.warn(`[opencode2api] Pool ${state.id} watchdog health check error:`, err.message);
      scheduleBackgroundRestart(state);
    }
  }, intervalMs);

  if (timer.unref) timer.unref();
  state.watchdog = timer;
}

function scheduleBackgroundRestart(state) {
  if (state.intentionalStop || state.crashLoopFailed) return;
  if (state.inFlightPromise) return;

  if (state.watchdog) {
    clearInterval(state.watchdog);
    state.watchdog = null;
  }

  state.inFlightPromise = (async () => {
    try {
      console.log(`[opencode2api] Pool ${state.id} restarting in background`);
      if (state.child) {
        const oldChild = state.child;
        state.child = null;
        await terminateProcess(oldChild, 1500);
      }
      if (state.configFile) {
        cleanSidecarConfigFile(state.configFile);
        state.configFile = null;
      }
      await launchAndAwaitReady(state);
    } catch (err) {
      console.warn(`[opencode2api] Pool ${state.id} background restart failed:`, err.message);
      state.state = "failed";
      state.lastError = err;
    } finally {
      state.inFlightPromise = null;
    }
  })();
}

function handleChildExit(state, child, code, signal) {
  if (state.child !== child) return;

  state.exitedAt = Date.now();
  state.child = null;

  if (state.intentionalStop) {
    state.state = "stopped";
    return;
  }

  const now = Date.now();
  state.exitTimestamps.push(now);
  state.exitTimestamps = state.exitTimestamps.filter((t) => now - t <= 30000);

  if (state.exitTimestamps.length >= 3) {
    state.crashLoopFailed = true;
    state.state = "failed";
    state.lastError = new OpencodeSidecarUnavailableError("Daemon crash-loop detected: 3 exits within 30 seconds");
    console.warn(`[opencode2api] Pool ${state.id} crash-loop detected (3 exits in 30s). Giving up.`);
    if (state.watchdog) {
      clearInterval(state.watchdog);
      state.watchdog = null;
    }
    return;
  }

  console.log(`[opencode2api] Pool ${state.id} child exited unexpectedly (code ${code}, signal ${signal}). Scheduling restart.`);
  scheduleBackgroundRestart(state);
}

function attachOutputPumping(state, child) {
  state.stdoutLines = [];
  state.stderrLines = [];

  let stdoutBuf = "";
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const l of lines) {
      if (!l.trim()) continue;
      state.stdoutLines.push(l);
      if (state.stdoutLines.length > 200) state.stdoutLines.shift();
    }
  });

  let stderrBuf = "";
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() || "";
    for (const l of lines) {
      if (!l.trim()) continue;
      state.stderrLines.push(l);
      if (state.stderrLines.length > 200) state.stderrLines.shift();
    }
  });
}

// The daemon aborts startup when WARP registration fails, with its one network
// step named in the error. Anything else (bad config, bad binary) is a real
// failure that must not be retried without WARP.
function isWarpInitFailure(text) {
  return /initialize WARP egress|create WARP device/i.test(String(text || ""));
}

async function launchAndAwaitReady(state, { warpEnabled = state.warpEnabled !== false } = {}) {
  state.intentionalStop = false;
  state.state = "starting";
  state.lastError = null;
  state.warpEnabled = warpEnabled;

  const port = await allocatePort();
  const apiKey = crypto.randomBytes(24).toString("hex");

  state.port = port;
  state.apiKey = apiKey;

  const configFile = createSidecarConfigFile({
    poolId: state.id,
    config: state.config,
    apiKey,
    port,
    dataDir: state.dataDir,
    warpEnabled,
  });
  state.configFile = configFile;

  // Falls back to the pinned release for installs that are not the Docker image
// (which ships the binary). Returns the configured path when the download
// fails so the spawn error still names what was expected.
  const binPath = await ensureSidecarBinary({
    log: { info: (tag, msg) => console.log(`[${tag}] ${msg}`), warn: (tag, msg) => console.warn(`[${tag}] ${msg}`) },
  });
  const env = buildScrubbedEnv();
  env.CONFIG_PATH = configFile;
  env.STATE_DIR = path.dirname(configFile);
  env.LISTEN_ADDRESS = `127.0.0.1:${port}`;

  let child;
  try {
    child = spawnSidecarChild(binPath, ["-config", configFile], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    cleanSidecarConfigFile(configFile);
    state.configFile = null;
    throw new OpencodeSidecarUnavailableError(`Failed to spawn opencode2api: ${err.message}`, { cause: err });
  }

  if (!child) {
    cleanSidecarConfigFile(configFile);
    state.configFile = null;
    throw new OpencodeSidecarUnavailableError("Failed to spawn opencode2api (null child process)");
  }

  state.child = child;
  attachOutputPumping(state, child);

  // A binary that cannot be launched (ENOENT, EACCES, ENOMEM) emits `error`
  // and never an `exit`, so exitCode stays null. Without this the readiness
  // loop would burn the whole ready timeout before reporting a missing binary.
  let spawnError = null;

  child.on("exit", (code, signal) => {
    handleChildExit(state, child, code, signal);
  });
  child.on("error", (err) => {
    spawnError = err;
    state.lastError = err;
    console.warn(`[opencode2api] Pool ${state.id} child process error:`, err.message);
  });

  const readyTimeoutMs = parseInt(process.env.OPENCODE2API_READY_TIMEOUT_MS, 10) || 90000;
  const startTime = Date.now();

  while (Date.now() - startTime < readyTimeoutMs) {
    if (state.intentionalStop) {
      throw new OpencodeSidecarUnavailableError("Sidecar start was cancelled");
    }

    if (spawnError) {
      await terminateProcess(child, 500);
      if (state.child === child) state.child = null;
      cleanSidecarConfigFile(configFile);
      if (state.configFile === configFile) state.configFile = null;
      state.state = "failed";
      state.lastError = new OpencodeSidecarUnavailableError(
        `Failed to launch opencode2api (${binPath}): ${spawnError.message}`,
        { cause: spawnError }
      );
      throw state.lastError;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      // The daemon logs its fatal error as JSON, so both streams are checked.
      const errTail = [...state.stderrLines, ...state.stdoutLines].slice(-10).join("\n");
      // WARP registration is the one startup step that needs outbound network.
      // A filtered uplink (cf `/reg` EOF) kills the process even though the
      // daemon would serve fine over the host IP. Degrade once instead of
      // reporting the whole pool unusable.
      if (warpEnabled && isWarpInitFailure(errTail)) {
        console.warn(
          `[opencode2api] Pool ${state.id} WARP init failed; relaunching without WARP (host IP egress, no quota spread)`
        );
        await terminateProcess(child, 500);
        if (state.child === child) state.child = null;
        cleanSidecarConfigFile(configFile);
        if (state.configFile === configFile) state.configFile = null;
        return await launchAndAwaitReady(state, { warpEnabled: false });
      }
      throw new OpencodeSidecarUnavailableError(
        `opencode2api exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})${errTail ? `: ${errTail}` : ""}`
      );
    }

    const health = await fetchHealth(`http://127.0.0.1:${port}/healthz`);
    if (health && health.ready === true) {
      state.health = health;
      state.generation++;
      state.state = "ready";
      startWatchdog(state);
      return {
        proxyUrl: `http://127.0.0.1:${port}`,
        apiKey: state.apiKey,
        generation: state.generation,
        health: state.health,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Timed out waiting for readiness
  await terminateProcess(child, 1500);
  cleanSidecarConfigFile(configFile);
  state.child = null;
  state.configFile = null;
  state.state = "failed";
  state.lastError = new OpencodeSidecarUnavailableError(
    `opencode2api readiness timed out after ${readyTimeoutMs}ms`
  );
  throw state.lastError;
}

/**
 * Ensures a sidecar daemon is running and ready for the given pool.
 * Single-flight via inFlightPromise.
 * @param {object|string} pool
 * @returns {Promise<{ proxyUrl: string, apiKey: string, generation: number, health: object }>}
 */
export async function ensureSidecar(pool) {
  const poolId = typeof pool === "string" ? pool : (pool?.id || pool?.data?.id || "default");
  const state = getOrCreatePoolState(poolId);

  if (state.crashLoopFailed) {
    const err = state.lastError || new OpencodeSidecarUnavailableError(
      `Pool ${poolId} sidecar in crash-loop failed state`
    );
    state.state = "failed";
    throw err;
  }

  if (state.state === "ready" && state.child && state.child.exitCode === null && state.port) {
    if (state.health?.ready === true) {
      return {
        proxyUrl: `http://127.0.0.1:${state.port}`,
        apiKey: state.apiKey,
        generation: state.generation,
        health: state.health,
      };
    }
  }

  if (state.inFlightPromise) {
    return state.inFlightPromise;
  }

  const rawConfig = typeof pool === "object"
    ? (
      pool.opencode2api // persisted pool option block (rowToPool spreads `data` onto the row)
      || pool.data?.opencode2api
      || pool.config
      || pool.sidecarConfig
      || pool
    )
    : {};
  state.config = normalizeSidecarConfig(rawConfig);

  state.inFlightPromise = (async () => {
    try {
      if (state.child) {
        const oldChild = state.child;
        state.child = null;
        await terminateProcess(oldChild, 1500);
      }
      if (state.configFile) {
        cleanSidecarConfigFile(state.configFile);
        state.configFile = null;
      }
      return await launchAndAwaitReady(state);
    } catch (err) {
      state.state = "failed";
      state.lastError = err;
      throw err;
    } finally {
      state.inFlightPromise = null;
    }
  })();

  return await state.inFlightPromise;
}

/**
 * Stops the sidecar daemon for a given pool.
 * @param {string} poolId
 */
export async function stopSidecar(poolId) {
  const state = poolsState.get(poolId);
  if (!state) return;

  state.intentionalStop = true;
  state.crashLoopFailed = false;
  state.exitTimestamps = [];

  if (state.watchdog) {
    clearInterval(state.watchdog);
    state.watchdog = null;
  }

  if (state.inFlightPromise) {
    try {
      await state.inFlightPromise;
    } catch {}
  }

  if (state.child) {
    const child = state.child;
    state.child = null;
    await terminateProcess(child, 1500);
  }

  if (state.configFile) {
    cleanSidecarConfigFile(state.configFile);
    state.configFile = null;
  }

  state.state = "stopped";
  state.port = null;
  state.apiKey = null;
  state.health = null;
}

/**
 * Returns current status of the sidecar pool.
 * @param {string} poolId
 * @returns {object}
 */
export function getStatus(poolId) {
  const state = poolsState.get(poolId);
  if (!state) {
    return {
      state: "idle",
      generation: 0,
      proxyUrl: null,
      apiKey: null,
      activeExits: 0,
      standbyExits: 0,
      coolingExits: 0,
      exitedAt: null,
      lastError: null,
    };
  }

  const warp = state.health?.warp;
  return {
    state: state.state,
    generation: state.generation,
    proxyUrl: state.state === "ready" && state.port ? `http://127.0.0.1:${state.port}` : null,
    apiKey: state.apiKey || null,
    activeExits: typeof warp?.active === "number" ? warp.active : 0,
    standbyExits: typeof warp?.standby === "number" ? warp.standby : 0,
    coolingExits: typeof warp?.cooling === "number" ? warp.cooling : 0,
    exitedAt: state.exitedAt || null,
    lastError: state.lastError ? (state.lastError.message || String(state.lastError)) : null,
  };
}

/**
 * Checks health of running sidecar.
 * @param {string} poolId
 * @returns {Promise<{ ready: boolean, warp: object }|null>}
 */
export async function checkHealth(poolId) {
  const state = poolsState.get(poolId);
  if (!state || !state.port || state.state !== "ready") return null;

  try {
    const json = await fetchHealth(`http://127.0.0.1:${state.port}/healthz`);
    if (json) {
      state.health = json;
      return {
        ready: Boolean(json.ready),
        warp: json.warp || null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

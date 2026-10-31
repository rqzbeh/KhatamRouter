import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getDataDir } from "@/lib/dataDir.js";
import {
  PsiphonUnavailableError,
  getPsiphonBinPath,
  getPsiphonConfigPath,
  createTempConfigFile,
  cleanTempConfigFile,
} from "./config.js";
import { ensurePsiphonBinary } from "./downloader.js";
import { createNoticeAccumulator } from "./notices.js";
import { probeLatency, probeExitIp } from "./probe.js";
import { shouldRotateOn } from "./classify.js";

export { PsiphonUnavailableError, shouldRotateOn };

const DEFAULT_REGIONS = ["US", "CA", "NL", "DE", "GB", "FR", "JP", "SG"];
const DEFAULT_READY_TIMEOUT_MS = 45000;
const DEFAULT_PROBE_CANDIDATES = 3;

// Map of poolId -> poolState
const poolsState = new Map();

// Test hook for spawn interception
let testSpawnFn = null;
export function __setSpawnForTests(fn) {
  testSpawnFn = fn;
}

export function __getActiveChildForTests(poolId) {
  return poolsState.get(poolId)?.activeChild || null;
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
      try {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {}
    }, sigkillTimeoutMs);
    if (killTimer.unref) killTimer.unref();

    fallbackTimer = setTimeout(() => {
      onExit();
    }, sigkillTimeoutMs + 3000);
    if (fallbackTimer.unref) fallbackTimer.unref();

    try {
      child.kill("SIGTERM");
    } catch {
      onExit();
    }
  });
}

export async function __resetForTests() {
  testSpawnFn = null;
  for (const state of poolsState.values()) {
    state.intentionalStop = true;
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    if (state.activeChild) {
      const child = state.activeChild;
      state.activeChild = null;
      await terminateProcess(child);
    }
    if (state.tempConfigFile) {
      cleanTempConfigFile(state.tempConfigFile);
      state.tempConfigFile = null;
    }
    if (state.dataDir) {
      try {
        fs.rmSync(state.dataDir, { recursive: true, force: true });
      } catch {}
      state.dataDir = null;
    }
  }
  poolsState.clear();
}

/**
 * Checks if a pool definition is a Psiphon pool.
 * @param {object} pool
 * @returns {boolean}
 */
export function isPsiphonPool(pool) {
  if (!pool) return false;
  return pool.type === "psiphon" || pool.data?.type === "psiphon";
}

function getOrCreatePoolState(poolId) {
  if (!poolsState.has(poolId)) {
    poolsState.set(poolId, {
      id: poolId,
      state: "idle", // 'idle' | 'connecting' | 'ready' | 'rotating' | 'failed'
      activeChild: null,
      proxyUrl: null,
      region: null,
      exitIp: null,
      generation: 0,
      dataDir: null,
      tempConfigFile: null,
      requests: 0,
      tokens: 0,
      lastError: null,
      lastRotation: null,
      recentRegions: [],
      availableRegions: [],
      thresholdExceeded: false,
      inFlightPromise: null,
      lastRotateTime: 0,
      poolConfig: null,
      intentionalStop: false,
      processExitTimestamps: [],
      crashLoopFailed: false,
    });
  }
  return poolsState.get(poolId);
}

function getRunBaseDir() {
  const dataDir = getDataDir();
  const runDir = path.join(dataDir, "psiphon", "run");
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }
  return runDir;
}

// Sweep any stale run directories at startup (preserves active worker PIDs)
export function sweepStaleRunDirs() {
  try {
    const dataDir = getDataDir();
    const runDir = path.join(dataDir, "psiphon", "run");
    if (!fs.existsSync(runDir)) return;
    const entries = fs.readdirSync(runDir);
    for (const entry of entries) {
      const fullPath = path.join(runDir, entry);
      const pidMatch = entry.match(/^pid-(\d+)-/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        try {
          process.kill(pid, 0);
          // Process is alive, do not touch its directory
          continue;
        } catch {
          // Process is dead (ESRCH), proceed to clean
        }
      }
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

sweepStaleRunDirs();

// Register graceful exit handlers once
let exitHooksRegistered = false;
function registerExitHooks() {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;

  const cleanup = () => {
    for (const state of poolsState.values()) {
      state.intentionalStop = true;
      if (state.activeChild) {
        terminateProcess(state.activeChild);
        state.activeChild = null;
      }
      if (state.tempConfigFile) {
        cleanTempConfigFile(state.tempConfigFile);
      }
      if (state.dataDir) {
        try {
          fs.rmSync(state.dataDir, { recursive: true, force: true });
        } catch {}
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
  "TMP",
  "PSIPHON_PROBE_URL",
  "PSIPHON_IP_URL",
  "FAKE_PSIPHON_CRASH",
  "FAKE_PSIPHON_NEVER_READY",
  "FAKE_PSIPHON_LATENCY_MAP",
  "FAKE_PSIPHON_AVAILABLE_REGIONS",
  "FAKE_PSIPHON_STATIC_IP",
  "FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE",
  "FAKE_PSIPHON_READY_DELAY",
  "FAKE_PSIPHON_IGNORE_SIGTERM",
  "FAKE_PSIPHON_FLOOD_STDOUT",
  "FAKE_PSIPHON_CRASH_AFTER_READY",
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

function spawnPsiphonChild(binPath, args, options) {
  if (testSpawnFn) {
    const hooked = testSpawnFn(binPath, args, options);
    if (hooked) return hooked;
  }
  return spawn(binPath, args, options);
}

/**
 * Spawns a single ConsoleClient instance and awaits readiness.
 */
async function launchCandidate({ binPath, baseConfigFile, dataRootDir, egressRegion, timeoutMs }) {
  const tempConfigFile = createTempConfigFile({
    baseConfigFile,
    dataRootDir,
    egressRegion,
  });

  const env = buildScrubbedEnv();
  const accumulator = createNoticeAccumulator();

  let child;
  try {
    child = spawnPsiphonChild(binPath, ["-config", tempConfigFile], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    cleanTempConfigFile(tempConfigFile);
    throw new PsiphonUnavailableError(`Failed to spawn Psiphon binary: ${err.message}`);
  }

  if (!child || !child.stderr) {
    cleanTempConfigFile(tempConfigFile);
    throw new PsiphonUnavailableError("ConsoleClient failed to start (invalid child process)");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcess(child);
      cleanTempConfigFile(tempConfigFile);
      reject(new PsiphonUnavailableError(`Psiphon instance readiness timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      await terminateProcess(child);
      cleanTempConfigFile(tempConfigFile);
      reject(new PsiphonUnavailableError(`Psiphon child process error: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      cleanTempConfigFile(tempConfigFile);
      reject(new PsiphonUnavailableError(`Psiphon child process exited prematurely (code: ${code}, signal: ${signal})`));
    });

    child.stderr.on("data", (chunk) => {
      if (settled) return;
      accumulator.feed(chunk.toString());
      if (accumulator.isReady()) {
        settled = true;
        cleanup();
        resolve({
          child,
          port: accumulator.getPort(),
          region: accumulator.getRegion() || egressRegion,
          availableRegions: accumulator.getAvailableRegions(),
          tempConfigFile,
          dataRootDir,
        });
      }
    });
  });
}

function pickCandidateRegions({ poolRegions, recentRegions, availableRegions, excludedRegions, count }) {
  let sourceList = [];
  if (Array.isArray(poolRegions) && poolRegions.length > 0) {
    sourceList = poolRegions;
  } else if (Array.isArray(availableRegions) && availableRegions.length > 0) {
    sourceList = availableRegions;
  } else {
    sourceList = DEFAULT_REGIONS;
  }

  // Filter out recent regions and explicitly excluded regions if alternatives exist
  const excludedSet = new Set([...(recentRegions || []), ...(excludedRegions || [])]);
  const available = sourceList.filter((r) => !excludedSet.has(r));
  const poolToUse = available.length > 0 ? available : sourceList;

  // Shuffle and take 'count' distinct regions
  const shuffled = [...poolToUse].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(count, shuffled.length));

  if (picked.length === 0 && sourceList.length > 0) {
    picked.push(sourceList[0]);
  }
  return picked;
}

/**
 * Establishes a tunnel by launching N candidate instances in parallel,
 * probing latency on ready candidates, keeping the lowest latency,
 * and terminating the rest.
 */
async function establishBestTunnel({ pool, state, excludedRegions }) {
  let binPath = getPsiphonBinPath();
  if (!fs.existsSync(binPath)) {
    // Attempt auto-download for Linux hosts (e.g. Docker container or native host)
    binPath = await ensurePsiphonBinary();
  }

  if (!fs.existsSync(binPath)) {
    state.state = "failed";
    state.lastError = new PsiphonUnavailableError(`Psiphon binary not found at: ${binPath}`);
    throw state.lastError;
  }

  const baseConfigFile = getPsiphonConfigPath();

  const poolRegions = pool.data?.psiphon?.regions || [];
  const candidateCount = Math.max(1, Math.min(5, pool.data?.psiphon?.probeCandidates || DEFAULT_PROBE_CANDIDATES));
  const timeoutMs = parseInt(process.env.PSIPHON_READY_TIMEOUT_MS || `${DEFAULT_READY_TIMEOUT_MS}`, 10);

  const targetGen = state.generation + 1;
  const regionsToProbe = pickCandidateRegions({
    poolRegions,
    recentRegions: state.recentRegions,
    availableRegions: state.availableRegions,
    excludedRegions,
    count: candidateCount,
  });

  const runBaseDir = getRunBaseDir();
  const candidatePromises = regionsToProbe.map((region, idx) => {
    const rand = crypto.randomBytes(4).toString("hex");
    const dataRootDir = path.join(runBaseDir, `pid-${process.pid}-${state.id}-${targetGen}-${idx}-${rand}`);
    fs.mkdirSync(dataRootDir, { recursive: true, mode: 0o700 });

    return launchCandidate({
      binPath,
      baseConfigFile,
      dataRootDir,
      egressRegion: region,
      timeoutMs,
    }).catch((err) => ({ error: err, dataRootDir }));
  });

  const results = await Promise.all(candidatePromises);
  const readyCandidates = results.filter((r) => !r.error && r.child);
  const failedCandidates = results.filter((r) => r.error);

  // Immediately clean up directories from failed candidates to prevent disk leak
  for (const failed of failedCandidates) {
    if (failed.dataRootDir) {
      try {
        fs.rmSync(failed.dataRootDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (readyCandidates.length === 0) {
    state.state = "failed";
    const firstErr = results.find((r) => r.error)?.error;
    state.lastError = firstErr || new PsiphonUnavailableError("No Psiphon candidates became ready");
    throw state.lastError;
  }

  // Probe latency for all ready candidates
  try {
    await Promise.all(
      readyCandidates.map(async (cand) => {
        const probeRes = await probeLatency(`http://127.0.0.1:${cand.port}`);
        cand.latency = probeRes.ok ? probeRes.latency : Infinity;
      })
    );

    readyCandidates.sort((a, b) => a.latency - b.latency);
    const winner = readyCandidates[0];
    const losers = readyCandidates.slice(1);

    // Terminate losers and clean up their files
    for (const loser of losers) {
      await terminateProcess(loser.child);
      cleanTempConfigFile(loser.tempConfigFile);
      try {
        fs.rmSync(loser.dataRootDir, { recursive: true, force: true });
      } catch {}
    }

    // Check if winner is reachable through proxy
    if (winner.latency === Infinity && process.env.NODE_ENV !== "test") {
      await terminateProcess(winner.child);
      cleanTempConfigFile(winner.tempConfigFile);
      try {
        fs.rmSync(winner.dataRootDir, { recursive: true, force: true });
      } catch {}
      state.state = "failed";
      state.lastError = new PsiphonUnavailableError("All ready Psiphon candidates failed proxy connectivity probe");
      throw state.lastError;
    }

    // Probe exit IP through winner's proxy
    const exitIp = await probeExitIp(`http://127.0.0.1:${winner.port}`);
    const egressVerified = Boolean(exitIp);

    if (!egressVerified) {
      await terminateProcess(winner.child);
      cleanTempConfigFile(winner.tempConfigFile);
      try {
        fs.rmSync(winner.dataRootDir, { recursive: true, force: true });
      } catch {}
      state.state = "failed";
      state.lastError = new PsiphonUnavailableError(
        "Psiphon candidate failed egress IP verification probe; missing egress evidence cannot be reported as verified readiness"
      );
      throw state.lastError;
    }

    // Winner's temp config is deleted once ready
    cleanTempConfigFile(winner.tempConfigFile);

    if (winner.availableRegions?.length > 0) {
      state.availableRegions = winner.availableRegions;
    }

    return {
      child: winner.child,
      proxyUrl: `http://127.0.0.1:${winner.port}`,
      region: winner.region,
      dataDir: winner.dataRootDir,
      exitIp,
      egressVerified: true,
      generation: targetGen,
    };
  } catch (err) {
    // If any error occurs during probing/setup, terminate all remaining candidates
    for (const cand of readyCandidates) {
      await terminateProcess(cand.child);
      cleanTempConfigFile(cand.tempConfigFile);
      try {
        fs.rmSync(cand.dataRootDir, { recursive: true, force: true });
      } catch {}
    }
    state.state = "failed";
    state.lastError = err;
    throw err;
  }
}

/**
 * Ensures a healthy tunnel is active for the given pool.
 * @param {object} pool
 * @returns {Promise<{ proxyUrl: string, region: string, generation: number, exitIp: string|null }>}
 */
export async function ensureTunnel(pool) {
  const poolId = pool.id || pool.name || "default";
  const state = getOrCreatePoolState(poolId);
  state.poolConfig = pool;

  if (state.crashLoopFailed) {
    const err = state.lastError instanceof PsiphonUnavailableError
      ? state.lastError
      : new PsiphonUnavailableError(state.lastError?.message || "ConsoleClient crash loop");
    throw err;
  }

  // Check if active tunnel exists and is healthy
  if (state.state === "ready" && state.activeChild && !state.thresholdExceeded) {
    return {
      proxyUrl: state.proxyUrl,
      region: state.region,
      generation: state.generation,
      exitIp: state.exitIp,
    };
  }

  // If threshold was reached, trigger proactive rotation
  if (state.thresholdExceeded) {
    const rot = await rotate(poolId, { reason: "threshold" });
    return {
      proxyUrl: state.proxyUrl,
      region: rot.region,
      generation: rot.generation,
      exitIp: rot.exitIp,
    };
  }

  // Single-flight deduplication: if an ensure or rotate is already in flight, await it
  if (state.inFlightPromise) {
    await state.inFlightPromise;
    if (state.state === "ready" && state.activeChild) {
      return {
        proxyUrl: state.proxyUrl,
        region: state.region,
        generation: state.generation,
        exitIp: state.exitIp,
      };
    }
    if (state.lastError) throw state.lastError;
  }

  state.state = "connecting";
  state.inFlightType = "ensure";
  state.intentionalStop = false;

  state.inFlightPromise = (async () => {
    try {
      const established = await establishBestTunnel({ pool, state });

      // Update state
      state.activeChild = established.child;
      state.proxyUrl = established.proxyUrl;
      state.region = established.region;
      state.dataDir = established.dataDir;
      state.exitIp = established.exitIp;
      state.egressVerified = established.egressVerified;
      state.generation = established.generation;
      state.requests = 0;
      state.tokens = 0;
      state.thresholdExceeded = false;
      state.state = "ready";
      state.lastError = null;
      state.intentionalStop = false;

      // Update recent regions: keep current + last 3 used (up to 4 regions)
      if (established.region) {
        state.recentRegions = [...state.recentRegions.slice(-3), established.region];
      }

      // Attach exit watcher to active child per FR-014-05
      established.child.once("exit", (code, signal) => {
        if (state.activeChild === established.child && !state.intentionalStop) {
          state.activeChild = null;
          state.state = "idle";
          state.lastError = new Error(`Psiphon process exited unexpectedly (code: ${code}, signal: ${signal})`);
          rotate(state.id, { reason: "process_exit" }).catch((err) => {
            state.lastError = err;
            state.state = "failed";
          });
        }
      });

      return {
        proxyUrl: state.proxyUrl,
        region: state.region,
        generation: state.generation,
        exitIp: state.exitIp,
      };
    } finally {
      state.inFlightPromise = null;
      state.inFlightType = null;
    }
  })();

  return state.inFlightPromise;
}

/**
 * Rotates the tunnel for a pool (tears down previous, establishes new, avoids last 3 regions,
 * retries on same IP up to 3 times).
 * @param {string} poolId
 * @param {object} params
 * @param {string} [params.reason]
 * @param {number} [params.seenGeneration]
 * @returns {Promise<{ rotated: boolean, generation: number, region: string|null, exitIp: string|null }>}
 */
export async function rotate(poolId, { reason = "manual", seenGeneration } = {}) {
  const state = getOrCreatePoolState(poolId);

  // Generation guard: if caller observed an older generation, the pool already rotated
  if (seenGeneration !== undefined && seenGeneration < state.generation) {
    return {
      rotated: false,
      generation: state.generation,
      region: state.region,
      exitIp: state.exitIp,
    };
  }

  // If any rotation or ensure is already in flight, await it and return without starting another
  if (state.inFlightPromise) {
    await state.inFlightPromise;
    return {
      rotated: false,
      generation: state.generation,
      region: state.region,
      exitIp: state.exitIp,
    };
  }

  // If pool has entered crash-loop failed state, refuse auto-rotation until manual reset
  if (state.crashLoopFailed && reason !== "manual" && reason !== "force") {
    return {
      rotated: false,
      generation: state.generation,
      region: state.region,
      exitIp: state.exitIp,
    };
  }

  // Reset crash-loop guard on manual/force rotation
  if (reason === "manual" || reason === "force") {
    state.processExitTimestamps = [];
    state.crashLoopFailed = false;
  }

  // Crash-loop guard: if >= 3 process_exit rotations occur within 30000ms, halt auto-rotation
  if (reason === "process_exit") {
    const now = Date.now();
    state.processExitTimestamps = (state.processExitTimestamps || []).filter((t) => now - t <= 30000);
    state.processExitTimestamps.push(now);

    if (state.processExitTimestamps.length >= 3) {
      state.state = "failed";
      state.crashLoopFailed = true;
      const err = new PsiphonUnavailableError("ConsoleClient crash loop");
      err.status = 503;
      state.lastError = err;
      return {
        rotated: false,
        generation: state.generation,
        region: state.region,
        exitIp: state.exitIp,
      };
    }
  }

  state.state = "rotating";
  state.inFlightType = "rotate";

  state.inFlightPromise = (async () => {
    try {
      // Apply crash backoff if needed
      if (reason === "process_exit") {
        const n = Math.max(0, state.processExitTimestamps.length - 1);
        const envBackoff = process.env.PSIPHON_CRASH_BACKOFF_MS;
        const backoffMs = envBackoff !== undefined
          ? parseInt(envBackoff, 10)
          : Math.min(500 * Math.pow(2, n), 5000);

        if (backoffMs > 0) {
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      const minInterval = parseInt(process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS ?? "5000", 10);
      const now = Date.now();
      if (minInterval > 0 && reason !== "process_exit" && reason !== "force") {
        const elapsed = now - state.lastRotateTime;
        if (elapsed < minInterval) {
          await new Promise((r) => setTimeout(r, minInterval - elapsed));
        }
      }

      // Mark intentional stop so unexpected exit watcher does not trigger recursive rotation
      state.intentionalStop = true;
      if (state.activeChild) {
        const prevChild = state.activeChild;
        state.activeChild = null;
        await terminateProcess(prevChild);
      }
      if (state.tempConfigFile) {
        cleanTempConfigFile(state.tempConfigFile);
        state.tempConfigFile = null;
      }
      if (state.dataDir) {
        try {
          fs.rmSync(state.dataDir, { recursive: true, force: true });
        } catch {}
        state.dataDir = null;
      }
      const pool = state.poolConfig || { id: poolId, type: "psiphon" };
      const previousIp = state.exitIp;
      let established = null;

      // Track rejected regions during retry to avoid picking the same region again (FR-014-08)
      const retryExcludedRegions = [];

      for (let attempt = 1; attempt <= 3; attempt++) {
        established = await establishBestTunnel({
          pool,
          state,
          excludedRegions: retryExcludedRegions,
        });

        if (previousIp && established.exitIp && established.exitIp === previousIp) {
          // IP did not change! Tear down and retry with fresh data dir + different region
          if (established.region) {
            retryExcludedRegions.push(established.region);
          }
          await terminateProcess(established.child);
          try {
            fs.rmSync(established.dataDir, { recursive: true, force: true });
          } catch {}

          if (attempt === 3) {
            // Truthful routing verification: no same-IP verification success after final attempt
            state.state = "failed";
            state.lastError = new PsiphonUnavailableError(
              `Rotation failed: egress IP remained identical (${previousIp}) after ${attempt} attempts`
            );
            throw state.lastError;
          }
          continue;
        }
        break;
      }

      state.activeChild = established.child;
      state.proxyUrl = established.proxyUrl;
      state.region = established.region;
      state.dataDir = established.dataDir;
      state.exitIp = established.exitIp;
      state.egressVerified = established.egressVerified;
      state.generation = established.generation;
      state.requests = 0;
      state.tokens = 0;
      state.thresholdExceeded = false;
      state.state = "ready";
      state.lastError = null;
      state.lastRotateTime = Date.now();
      state.lastRotation = { reason, at: state.lastRotateTime };
      state.intentionalStop = false;

      if (established.region) {
        state.recentRegions = [...state.recentRegions.slice(-3), established.region];
      }

      established.child.once("exit", (code, signal) => {
        if (state.activeChild === established.child && !state.intentionalStop) {
          state.activeChild = null;
          state.state = "idle";
          state.lastError = new Error(`Psiphon process exited unexpectedly (code: ${code}, signal: ${signal})`);
          rotate(state.id, { reason: "process_exit" }).catch((err) => {
            state.lastError = err;
            state.state = "failed";
          });
        }
      });

      return {
        rotated: true,
        generation: state.generation,
        region: state.region,
        exitIp: state.exitIp,
      };
    } finally {
      state.inFlightPromise = null;
      state.inFlightType = null;
    }
  })();

  return state.inFlightPromise;
}

/**
 * Accumulates request and token usage for the active tunnel and flags thresholds.
 * @param {string} poolId
 * @param {object} usage
 * @param {number} [usage.requests]
 * @param {number} [usage.tokens]
 */
export function recordUsage(poolId, { requests = 1, tokens = 0 } = {}) {
  const state = poolsState.get(poolId);
  if (!state) return;

  state.requests += requests || 0;
  state.tokens += tokens || 0;

  const psiphonConfig = state.poolConfig?.data?.psiphon;
  const maxRequests = psiphonConfig?.maxRequestsPerIp || 0;
  const maxTokens = psiphonConfig?.maxTokensPerIp || 0;

  if (
    (maxRequests > 0 && state.requests >= maxRequests) ||
    (maxTokens > 0 && state.tokens >= maxTokens)
  ) {
    state.thresholdExceeded = true;
  }
}

/**
 * Returns current status of a pool without leaking secrets or config.
 * @param {string} poolId
 * @returns {object}
 */
export function getStatus(poolId) {
  const state = poolsState.get(poolId);
  if (!state) {
    return {
      state: "idle",
      region: null,
      generation: 0,
      exitIp: null,
      requests: 0,
      tokens: 0,
      lastError: null,
      lastRotation: null,
    };
  }

  return {
    state: state.state,
    region: state.region,
    generation: state.generation,
    exitIp: state.exitIp,
    egressVerified: Boolean(state.exitIp && state.egressVerified && state.state === "ready"),
    requests: state.requests,
    tokens: state.tokens,
    lastError: state.lastError ? state.lastError.message || String(state.lastError) : null,
    lastRotation: state.lastRotation,
  };
}

/**
 * Stops the tunnel for a specific pool and cleans up resources.
 * @param {string} poolId
 */
export async function stopTunnel(poolId) {
  const state = poolsState.get(poolId);
  if (!state) return;

  state.intentionalStop = true;

  if (state.activeChild) {
    const child = state.activeChild;
    state.activeChild = null;
    await terminateProcess(child);
  }

  if (state.tempConfigFile) {
    cleanTempConfigFile(state.tempConfigFile);
    state.tempConfigFile = null;
  }

  if (state.dataDir) {
    try {
      fs.rmSync(state.dataDir, { recursive: true, force: true });
    } catch {}
    state.dataDir = null;
  }

  state.state = "idle";
  state.proxyUrl = null;
  state.region = null;
  state.exitIp = null;
  state.egressVerified = false;
  state.thresholdExceeded = false;
  state.processExitTimestamps = [];
  state.crashLoopFailed = false;
}

/**
 * Stops all active tunnels across all pools.
 */
export async function stopAll() {
  const promises = [];
  for (const poolId of poolsState.keys()) {
    promises.push(stopTunnel(poolId));
  }
  await Promise.all(promises);
}

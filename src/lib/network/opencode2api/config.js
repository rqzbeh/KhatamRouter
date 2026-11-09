import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { getDataDir } from "@/lib/dataDir.js";

export const MANAGED_SIDECAR_URL = "opencode2api://managed";

export class OpencodeSidecarUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OpencodeSidecarUnavailableError";
    this.status = 503;
  }
}

export const DEFAULT_SIDECAR_CONFIG = Object.freeze({
  poolSize: 3,
  warmStandby: 2,
  retryAttempts: 4,
});

export const SIDECAR_LIMITS = Object.freeze({
  minPoolSize: 1,
  maxPoolSize: 32,
  maxWarmStandby: 4,
  minRetry: 1,
  maxRetry: 6,
});

/**
 * Validates pool config options for type=opencode2api.
 * Integers only; out-of-range is rejected with a message naming the field and range.
 * @param {object} raw
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSidecarConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, error: "Config must be an object" };
  }

  if (raw.poolSize !== undefined) {
    if (
      !Number.isInteger(raw.poolSize) ||
      raw.poolSize < SIDECAR_LIMITS.minPoolSize ||
      raw.poolSize > SIDECAR_LIMITS.maxPoolSize
    ) {
      return {
        valid: false,
        error: `poolSize must be an integer between ${SIDECAR_LIMITS.minPoolSize} and ${SIDECAR_LIMITS.maxPoolSize}`,
      };
    }
  }

  if (raw.warmStandby !== undefined) {
    if (
      !Number.isInteger(raw.warmStandby) ||
      raw.warmStandby < 0 ||
      raw.warmStandby > SIDECAR_LIMITS.maxWarmStandby
    ) {
      return {
        valid: false,
        error: `warmStandby must be an integer between 0 and ${SIDECAR_LIMITS.maxWarmStandby}`,
      };
    }
  }

  if (raw.retryAttempts !== undefined) {
    if (
      !Number.isInteger(raw.retryAttempts) ||
      raw.retryAttempts < SIDECAR_LIMITS.minRetry ||
      raw.retryAttempts > SIDECAR_LIMITS.maxRetry
    ) {
      return {
        valid: false,
        error: `retryAttempts must be an integer between ${SIDECAR_LIMITS.minRetry} and ${SIDECAR_LIMITS.maxRetry}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Normalizes pool config: clamps into limits, fills defaults, ignores garbage.
 * @param {object} raw
 * @returns {{ poolSize: number, warmStandby: number, retryAttempts: number }}
 */
export function normalizeSidecarConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SIDECAR_CONFIG };
  }

  let poolSize = DEFAULT_SIDECAR_CONFIG.poolSize;
  if (typeof raw.poolSize === "number" && !Number.isNaN(raw.poolSize)) {
    poolSize = Math.max(
      SIDECAR_LIMITS.minPoolSize,
      Math.min(SIDECAR_LIMITS.maxPoolSize, Math.round(raw.poolSize))
    );
  }

  let warmStandby = DEFAULT_SIDECAR_CONFIG.warmStandby;
  if (typeof raw.warmStandby === "number" && !Number.isNaN(raw.warmStandby)) {
    warmStandby = Math.max(
      0,
      Math.min(SIDECAR_LIMITS.maxWarmStandby, Math.round(raw.warmStandby))
    );
  }

  let retryAttempts = DEFAULT_SIDECAR_CONFIG.retryAttempts;
  if (typeof raw.retryAttempts === "number" && !Number.isNaN(raw.retryAttempts)) {
    retryAttempts = Math.max(
      SIDECAR_LIMITS.minRetry,
      Math.min(SIDECAR_LIMITS.maxRetry, Math.round(raw.retryAttempts))
    );
  }

  return { poolSize, warmStandby, retryAttempts };
}

/**
 * Resolves binary location: OPENCODE2API_BIN env if set, else /usr/local/bin/opencode2api.
 * @returns {string}
 */
export function getSidecarBinPath() {
  if (process.env.OPENCODE2API_BIN) {
    return process.env.OPENCODE2API_BIN;
  }
  return "/usr/local/bin/opencode2api";
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Allocates a free loopback port.
 * Honours OPENCODE2API_PORT_BASE env offset when set, retrying on EADDRINUSE up to 20 times.
 * @returns {Promise<number>}
 */
export async function allocatePort() {
  const baseEnv = process.env.OPENCODE2API_PORT_BASE;
  if (baseEnv) {
    const basePort = parseInt(baseEnv, 10);
    if (!Number.isNaN(basePort) && basePort > 0) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidatePort = basePort + attempt;
        const isFree = await checkPortFree(candidatePort);
        if (isFree) {
          return candidatePort;
        }
      }
      throw new Error(`Failed to allocate port starting at base ${basePort} after 20 attempts`);
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  });
}

/**
 * Creates and returns <DATA_DIR>/opencode2api/run mode 0o700.
 * @returns {string}
 */
export function getSidecarRunDir() {
  const dataDir = getDataDir();
  const runDir = path.join(dataDir, "opencode2api", "run");
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }
  return runDir;
}

/**
 * Creates a mode 0600 config JSON file for the opencode2api daemon.
 * @param {object} params
 * @param {string} params.poolId
 * @param {object} params.config
 * @param {string} params.apiKey
 * @param {number} params.port
 * @param {string} [params.dataDir]
 * @returns {string} Path to created config file
 */
export function createSidecarConfigFile({ poolId, config = {}, apiKey, port, dataDir, warpEnabled = true }) {
  const runDir = dataDir ? path.join(dataDir, "opencode2api", "run") : getSidecarRunDir();
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }

  const rand = crypto.randomBytes(6).toString("hex");
  // The owning gateway's pid is part of the name so the startup sweep can tell
  // a live file from a stale one when two instances share DATA_DIR.
  const filePath = path.join(runDir, `${poolId}-pid-${process.pid}-${rand}.json`);

  const poolSize = typeof config.poolSize === "number"
    ? Math.min(32, config.poolSize + (typeof config.warmStandby === "number" ? config.warmStandby : 0))
    : DEFAULT_SIDECAR_CONFIG.poolSize;

  const body = {
    listen: `127.0.0.1:${port}`,
    server_keys: [apiKey],
    zen_keys: [],
    go_keys: [],
    anonymous: true,
    warp: {
      // WARP registration is the only startup step that reaches the network,
      // and it is the only one that can fail (cf /reg EOF behind a filtered
      // uplink). With it off the daemon still serves — over the host IP, so no
      // quota spread — which beats a pool that cannot be used at all.
      enabled: warpEnabled !== false,
      pool_size: poolSize,
      stack: "ipv6",
      source_ipv6: "",
    },
    proxies: ["direct"],
    proxyfile: "",
    upstream: {
      zen: "https://opencode.ai/zen",
      go: "https://opencode.ai/zen/go",
      anonymous: "https://opencode.ai/inference",
    },
    retry: {
      max_attempts: config.retryAttempts ?? DEFAULT_SIDECAR_CONFIG.retryAttempts,
      timeout_seconds: 300,
    },
    models: {
      refresh_seconds: 300,
      protocols: {},
      free_only: true,
    },
    performance: {
      failure_cooldown_seconds: 15,
      // A retired WARP /64 is replaced by a pre-registered exit, so it must not
      // be handed out again while the upstream still considers it burned.
      free_tier_block_seconds: 900,
    },
    webui: {
      enabled: false,
    },
    logging: {
      level: "info",
      ring_size: 400,
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

/**
 * Best-effort unlink of config file.
 * @param {string} file
 */
export function cleanSidecarConfigFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {}
}

/**
 * Sweeps run files whose embedded PID is dead.
 */
export function sweepStaleSidecarDirs() {
  try {
    const dataDir = getDataDir();
    const runDir = path.join(dataDir, "opencode2api", "run");
    if (!fs.existsSync(runDir)) return;
    const entries = fs.readdirSync(runDir);
    for (const entry of entries) {
      // Ignore anything that is not one of our own config files.
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(runDir, entry);
      const pidMatch = entry.match(/-pid-(\d+)-[A-Za-z0-9]+\.json$/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        try {
          process.kill(pid, 0);
          // Process is alive, do not touch
          continue;
        } catch {
          // Process is dead
        }
      }
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

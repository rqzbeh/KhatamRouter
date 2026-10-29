// Auth-lease client for the MiniMax Code desktop broker, plus the in-process
// and multi-worker Redis lease cache. Adapted from MiniMax-AI/minimax-code,
// packages/oauth-lease-protocol (MIT License) with security hardening and
// Redis distributed coordination.
//
// Wire protocol: each request/response is a JSON payload prefixed with a 4-byte
// big-endian length, carried over a local named pipe (Windows) or a unix domain
// socket next to the desktop app's data dir. The broker is the running desktop
// app; it owns token refresh. We never read or write credential files — only
// the broker-published capability file and the pipe itself.
//
// Security invariants:
// - Leased tokens are kept only in volatile memory or Redis cache; never
//   persisted to disk DB or emitted to logs.
// - dataDir inputs are strictly validated against null bytes, traversal, and
//   symlink escapes.
// - Socket files on POSIX must be owned by the current user and not world-writable.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getRedisClient, isRedisConfigured, withRedisKey } from "@/lib/redis/client.js";

export const AUTH_LEASE_PROTOCOL_VERSION = 1;
export const AUTH_LEASE_MAX_FRAME_BYTES = 64 * 1024;
export const AUTH_LEASE_MAX_MIN_VALIDITY_MS = 5 * 60 * 1000;

const SOCKET_FILE = "mcode-auth-lease-v1.sock";
const CAPABILITY_FILE = "mcode-auth-lease-v1.cap";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\mcode-auth-lease-";

export const DEFAULT_MCODE_DATA_DIR = path.join(os.homedir(), ".minimax");

const REFRESH_MARGIN_MS = 60 * 1000;
const LOCK_TIMEOUT_MS = 5000;
const CONTENDER_POLL_TIMEOUT_MS = 3000;
const CONTENDER_POLL_INTERVAL_MS = 100;

const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Desktop authentication is required.",
  BROKER_UNAVAILABLE: "Desktop authentication integration is unavailable.",
  CAPABILITY_REJECTED: "Desktop authentication capability was rejected.",
  PROTOCOL_MISMATCH: "Desktop authentication protocol is incompatible.",
  INVALID_REQUEST: "Desktop authentication request is invalid.",
  INTERNAL_ERROR: "Desktop authentication request failed.",
});

export class AuthLeaseError extends Error {
  constructor(code, message, cause) {
    super(message ?? ERROR_MESSAGES[code] ?? "auth lease failed");
    this.name = "AuthLeaseError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// A connection uses lease auth when it was created from the desktop app
// (authType "mcode-lease") instead of the router's own OAuth device flow.
export function isLeaseConnection(credentials) {
  return credentials?.authType === "mcode-lease";
}

// The desktop app's data dir hosts the capability file and names the pipe.
// Order: per-connection override → env → the default install location.
export function resolveMcodeDataDir(credentials) {
  const override = credentials?.providerSpecificData?.mcodeDataDir;
  if (typeof override === "string" && override.trim()) return path.resolve(override.trim());
  const env = process.env.MINIMAX_DESKTOP_DATA_DIR;
  if (typeof env === "string" && env.trim()) return path.resolve(env.trim());
  return DEFAULT_MCODE_DATA_DIR;
}

export function validateAndCanonicalizeDataDir(dataDir, platform = process.platform) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new AuthLeaseError("INVALID_REQUEST", "dataDir is required.");
  }
  if (dataDir.includes("\0")) {
    throw new AuthLeaseError("INVALID_REQUEST", "dataDir contains invalid null bytes.");
  }
  if (dataDir.split(/[\\/]/).includes("..")) {
    throw new AuthLeaseError("INVALID_REQUEST", "dataDir traversal not allowed.");
  }

  if (platform === "win32") {
    if (!path.win32.isAbsolute(dataDir)) {
      throw new AuthLeaseError("INVALID_REQUEST", "dataDir must be an absolute path on Windows.");
    }
    return path.win32.normalize(dataDir).replace(/[\\/]+$/u, "");
  }

  if (!path.isAbsolute(dataDir)) {
    throw new AuthLeaseError("INVALID_REQUEST", "dataDir must be an absolute path.");
  }
  const resolved = path.resolve(dataDir);
  let canonical = resolved;
  try {
    if (fs.existsSync(resolved)) {
      canonical = fs.realpathSync(resolved);
    }
  } catch {}
  return canonical.replace(/\/+$/u, "");
}

export function resolveLeaseEndpoint(dataDir, platform = process.platform) {
  const canonical = validateAndCanonicalizeDataDir(dataDir, platform);

  if (platform === "win32") {
    const digest = crypto
      .createHash("sha256")
      .update(canonical.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return {
      transport: "pipe",
      endpoint: `${WINDOWS_PIPE_PREFIX}${digest}`,
      capabilityFile: path.win32.join(canonical, "run", CAPABILITY_FILE),
    };
  }

  const endpoint = path.join(canonical, "run", SOCKET_FILE);
  const capabilityFile = path.join(canonical, "run", CAPABILITY_FILE);

  const relEp = path.relative(canonical, endpoint);
  const relCap = path.relative(canonical, capabilityFile);
  if (relEp.startsWith("..") || path.isAbsolute(relEp) || relCap.startsWith("..") || path.isAbsolute(relCap)) {
    throw new AuthLeaseError("INVALID_REQUEST", "Endpoint or capability path escapes dataDir.");
  }

  return {
    transport: "unix",
    endpoint,
    capabilityFile,
  };
}

export function verifySocketPermissions(socketPath) {
  if (process.platform === "win32") return;
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSymbolicLink()) {
      throw new AuthLeaseError("BROKER_UNAVAILABLE", "Socket file cannot be a symbolic link.");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new AuthLeaseError("BROKER_UNAVAILABLE", "Socket file is not owned by current user.");
    }
    if ((stat.mode & 0o002) !== 0) {
      throw new AuthLeaseError("BROKER_UNAVAILABLE", "Socket file must not be world-writable.");
    }
  } catch (err) {
    if (err instanceof AuthLeaseError) throw err;
  }
}

export function readCapability(dataDir) {
  const { capabilityFile } = resolveLeaseEndpoint(dataDir);
  let cap;
  try {
    const stat = fs.statSync(capabilityFile);
    if (stat.size > 1024) {
      throw new AuthLeaseError("BROKER_UNAVAILABLE", "Capability file exceeds maximum allowed size.");
    }
    cap = fs.readFileSync(capabilityFile, "utf8").trim();
  } catch (error) {
    if (error instanceof AuthLeaseError) throw error;
    throw new AuthLeaseError(
      "BROKER_UNAVAILABLE",
      `Cannot read capability file ${capabilityFile}. ` +
        `Is the MiniMax Code desktop app installed and logged in on this machine? (${error?.code ?? error?.message})`,
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(cap)) {
    throw new AuthLeaseError("BROKER_UNAVAILABLE", "Capability file has unexpected content.");
  }
  return cap;
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > AUTH_LEASE_MAX_FRAME_BYTES) {
    throw new AuthLeaseError("INVALID_REQUEST", "Frame payload out of bounds.");
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > AUTH_LEASE_MAX_FRAME_BYTES + 4) {
      throw new AuthLeaseError("PROTOCOL_MISMATCH", "Buffer exceeded maximum frame limit.");
    }
    const frames = [];
    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength === 0 || payloadLength > AUTH_LEASE_MAX_FRAME_BYTES) {
        throw new AuthLeaseError("PROTOCOL_MISMATCH", "Broker sent an invalid frame length.");
      }
      const frameLength = 4 + payloadLength;
      if (this.buffer.length < frameLength) return frames;
      const payload = this.buffer.subarray(4, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      try {
        frames.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new AuthLeaseError("PROTOCOL_MISMATCH", "Broker sent a non-JSON frame.");
      }
    }
    return frames;
  }
}

function assertOk(response) {
  if (response && response.ok === true) return response;
  const code =
    response && response.ok === false && response.error && ERROR_MESSAGES[response.error.code]
      ? response.error.code
      : "INTERNAL_ERROR";
  throw new AuthLeaseError(code);
}

function sendRequest(endpoint, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (endpoint.transport === "unix") {
      try {
        verifySocketPermissions(endpoint.endpoint);
      } catch (err) {
        return reject(err);
      }
    }

    const socket = net.connect(endpoint.endpoint);
    const decoder = new FrameDecoder();
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      settle(
        new AuthLeaseError("BROKER_UNAVAILABLE", `Broker did not respond within ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      try {
        socket.write(encodeFrame(request));
      } catch (err) {
        settle(err);
      }
    });
    socket.on("data", (chunk) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) settle(undefined, frames[0]);
      } catch (error) {
        settle(error);
      }
    });
    socket.on("error", (error) => {
      settle(
        new AuthLeaseError(
          "BROKER_UNAVAILABLE",
          `Cannot reach auth broker at ${endpoint.endpoint}: ${error.message}. ` +
            "Is the MiniMax Code desktop app running?",
        ),
      );
    });
    socket.on("close", () => {
      settle(new AuthLeaseError("BROKER_UNAVAILABLE", "Broker closed the connection early."));
    });
  });
}

export async function requestStatus(dataDir, timeoutMs = 5000) {
  const endpoint = resolveLeaseEndpoint(dataDir);
  const capability = readCapability(dataDir);
  const response = await sendRequest(
    endpoint,
    {
      version: AUTH_LEASE_PROTOCOL_VERSION,
      requestId: `9r-status-${Date.now().toString(36)}`,
      capability,
      method: "status",
    },
    timeoutMs,
  );
  const result = assertOk(response).result;
  return { status: result.status, generation: result.generation, expiresAtMs: result.expiresAtMs };
}

export async function requestLease(dataDir, minValidityMs = AUTH_LEASE_MAX_MIN_VALIDITY_MS, timeoutMs = 10000) {
  const endpoint = resolveLeaseEndpoint(dataDir);
  const capability = readCapability(dataDir);
  const clamped = Math.max(0, Math.min(Math.floor(minValidityMs), AUTH_LEASE_MAX_MIN_VALIDITY_MS));
  const response = await sendRequest(
    endpoint,
    {
      version: AUTH_LEASE_PROTOCOL_VERSION,
      requestId: `9r-lease-${Date.now().toString(36)}`,
      capability,
      method: "lease",
      minValidityMs: clamped,
    },
    timeoutMs,
  );
  const result = assertOk(response).result;
  return {
    accessToken: result.accessToken,
    expiresAtMs: result.expiresAtMs,
    generation: result.generation,
  };
}

// ─── Lease Cache & Single-Flight Coordination ─────────────────────────────────

function computeDirDigest(canonicalDir) {
  if (!canonicalDir) return "default";
  return crypto.createHash("sha256").update(canonicalDir).digest("hex").slice(0, 16);
}

export function createTokenManager({ requestLease: leaseFn, log, dataDir, getRedis } = {}) {
  const lease = leaseFn || requestLease;
  let canonicalDir = dataDir ? validateAndCanonicalizeDataDir(dataDir) : null;
  let dirDigest = canonicalDir ? computeDirDigest(canonicalDir) : null;

  return {
    cached: null,
    inflight: null,
    dataDir: canonicalDir,
    digest: dirDigest,

    async getToken(targetDataDir = this.dataDir) {
      const now = Date.now();
      const activeDataDir = targetDataDir || this.dataDir;
      const targetCanonical = activeDataDir ? validateAndCanonicalizeDataDir(activeDataDir) : this.dataDir;

      // 1. Layer 1 In-Process Memory Cache: only when target matches manager's dataDir
      if (
        this.cached &&
        targetCanonical === this.dataDir &&
        this.cached.expiresAtMs - now > REFRESH_MARGIN_MS
      ) {
        return this.cached;
      }

      if (targetCanonical) {
        if (targetCanonical !== this.dataDir) {
          this.cached = null;
        }
        canonicalDir = targetCanonical;
        dirDigest = computeDirDigest(canonicalDir);
        this.dataDir = canonicalDir;
        this.digest = dirDigest;
      }
      const digest = dirDigest || "default";

      // 2. Layer 2 Redis Cache Lookup
      let redisClient = null;
      const getClient = getRedis || (() => (isRedisConfigured() ? getRedisClient() : null));
      try {
        redisClient = getClient();
        if (redisClient) {
          const cacheKey = withRedisKey(`mcode:lease:${digest}`);
          const cachedVal = await redisClient.get(cacheKey);
          if (cachedVal) {
            try {
              const parsed = JSON.parse(cachedVal);
              if (parsed?.expiresAtMs && parsed.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
                this.cached = parsed;
                log?.debug?.(
                  "MCODE_LEASE",
                  `leased access token from Redis (generation ${parsed.generation}, expires in ${Math.max(0, Math.round((parsed.expiresAtMs - Date.now()) / 1000))}s)`,
                );
                return parsed;
              }
            } catch {}
          }
        }
      } catch (redisErr) {
        log?.warn?.("MCODE_LEASE", `Redis lease cache lookup failed: ${redisErr?.message ?? redisErr}`);
      }

      // 3. Single-Flight In-Process + Distributed Lock
      if (!this.inflight) {
        this.inflight = (async () => {
          let lockAcquired = false;
          let lockKey = null;
          let cacheKey = null;
          const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

          try {
            if (redisClient) {
              lockKey = withRedisKey(`lock:mcode:lease:${digest}`);
              cacheKey = withRedisKey(`mcode:lease:${digest}`);

              const lockRes = await redisClient.set(lockKey, workerId, "PX", LOCK_TIMEOUT_MS, "NX");
              if (lockRes === "OK") {
                lockAcquired = true;
              } else {
                // Contender: poll Redis cache for up to 3 seconds
                const startWait = Date.now();
                while (Date.now() - startWait < CONTENDER_POLL_TIMEOUT_MS) {
                  await new Promise((r) => setTimeout(r, CONTENDER_POLL_INTERVAL_MS));
                  const clusterCached = await redisClient.get(cacheKey);
                  if (clusterCached) {
                    try {
                      const parsed = JSON.parse(clusterCached);
                      if (parsed?.expiresAtMs && parsed.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
                        this.cached = parsed;
                        return parsed;
                      }
                    } catch {}
                  }
                  const currentLock = await redisClient.get(lockKey);
                  if (!currentLock) break;
                }
              }
            }
          } catch (lockErr) {
            log?.warn?.("MCODE_LEASE", `Redis distributed lock failed: ${lockErr?.message ?? lockErr}`);
          }

          try {
            const token = await lease(activeDataDir, AUTH_LEASE_MAX_MIN_VALIDITY_MS);
            this.cached = token;
            log?.debug?.(
              "MCODE_LEASE",
              `leased access token (generation ${token.generation}, expires in ${Math.max(0, Math.round((token.expiresAtMs - Date.now()) / 1000))}s)`,
            );

            if (redisClient && cacheKey) {
              try {
                const ttl = Math.max(1, Math.floor((token.expiresAtMs - Date.now() - REFRESH_MARGIN_MS) / 1000));
                await redisClient.set(cacheKey, JSON.stringify(token), "EX", ttl);
              } catch (setErr) {
                log?.warn?.("MCODE_LEASE", `Redis lease cache save failed: ${setErr?.message ?? setErr}`);
              }
            }
            return token;
          } finally {
            if (lockAcquired && redisClient && lockKey) {
              try {
                const currentHolder = await redisClient.get(lockKey);
                if (currentHolder === workerId) {
                  await redisClient.del(lockKey);
                }
              } catch {}
            }
          }
        })().finally(() => {
          this.inflight = null;
        });
      }
      return this.inflight;
    },

    invalidate(reason) {
      if (this.cached) {
        log?.debug?.("MCODE_LEASE", `invalidating leased token: ${reason}`);
        this.cached = null;
      }
      const digest = this.digest || (this.dataDir ? computeDirDigest(this.dataDir) : null);
      if (digest) {
        try {
          const getClient = getRedis || (() => (isRedisConfigured() ? getRedisClient() : null));
          const client = getClient();
          if (client) {
            const cacheKey = withRedisKey(`mcode:lease:${digest}`);
            client.del(cacheKey).catch(() => {});
          }
        } catch {}
      }
    },
  };
}

const managers = new Map();

export function getLeaseManager(dataDir, log) {
  let manager = managers.get(dataDir);
  if (!manager) {
    manager = createTokenManager({ log, dataDir });
    managers.set(dataDir, manager);
  }
  return manager;
}

export async function getLeaseToken(credentials, log) {
  const dataDir = resolveMcodeDataDir(credentials);
  return getLeaseManager(dataDir, log).getToken(dataDir);
}

export function invalidateLeaseToken(credentials, reason, log) {
  const dataDir = resolveMcodeDataDir(credentials);
  getLeaseManager(dataDir, log).invalidate(reason);
}

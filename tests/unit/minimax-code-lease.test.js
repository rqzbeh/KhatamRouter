// MiniMax Code lease auth mode — named-pipe/unix socket broker protocol,
// frame codec, endpoint resolution, dataDir hardening, capability verification,
// in-process and Redis multi-worker lease caching, and executor/usage wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ── Pure protocol module ─────────────────────────────────────────────────────
import {
  AUTH_LEASE_MAX_FRAME_BYTES,
  AUTH_LEASE_PROTOCOL_VERSION,
  AuthLeaseError,
  DEFAULT_MCODE_DATA_DIR,
  FrameDecoder,
  createTokenManager,
  encodeFrame,
  isLeaseConnection,
  readCapability,
  requestLease,
  requestStatus,
  resolveLeaseEndpoint,
  resolveMcodeDataDir,
  validateAndCanonicalizeDataDir,
  verifySocketPermissions,
} from "open-sse/services/minimaxCodeLease.js";

// ── Executor under test ──────────────────────────────────────────────────────
class StubBase {
  constructor(provider) {
    this.provider = provider;
  }
  async execute(args) {
    StubBase.lastArgs = args;
    return { response: new Response("{}", { status: 200 }) };
  }
}
vi.mock("open-sse/executors/default.js", () => ({ DefaultExecutor: StubBase }));

const refreshMiniMaxMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshMiniMaxCodeToken: refreshMiniMaxMock,
}));

// Partial mock for executor testing
const getLeaseTokenMock = vi.hoisted(() => vi.fn());
const invalidateLeaseTokenMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/services/minimaxCodeLease.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getLeaseToken: getLeaseTokenMock,
  invalidateLeaseToken: invalidateLeaseTokenMock,
}));

const { MinimaxCodeExecutor } = await import("open-sse/executors/minimax-code.js");
const { getMiniMaxCodeUsage } = await import("open-sse/services/minimaxCodeUsage.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("lease wire protocol: frame codec", () => {
  it("round-trips a JSON payload through the 4-byte length prefix", () => {
    const frame = encodeFrame({ version: 1, method: "lease", minValidityMs: 300000 });
    expect(frame.length).toBe(4 + frame.length - 4);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);

    const decoder = new FrameDecoder();
    expect(decoder.push(frame)).toEqual([{ version: 1, method: "lease", minValidityMs: 300000 }]);
  });

  it("reassembles frames split across chunks and concatenates siblings", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame({ ok: true });
    const b = encodeFrame({ ok: false, error: { code: "AUTH_REQUIRED" } });

    expect(decoder.push(a.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([a.subarray(2), b.subarray(0, 5)]))).toEqual([{ ok: true }]);
    expect(decoder.push(b.subarray(5))).toEqual([{ ok: false, error: { code: "AUTH_REQUIRED" } }]);
  });

  it("rejects out-of-bounds payloads, zero-length, and non-JSON frames", () => {
    expect(() => encodeFrame({ big: "x".repeat(AUTH_LEASE_MAX_FRAME_BYTES) })).toThrow(AuthLeaseError);

    // Zero-length payload in header
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(0, 0);
    expect(() => new FrameDecoder().push(bad)).toThrow(/invalid frame length/);

    // Oversized payload length declared in header (> 64KB)
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(AUTH_LEASE_MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(oversized)).toThrow(/invalid frame length/);

    // Corrupted/non-JSON payload
    const notJson = Buffer.alloc(4 + 4);
    notJson.writeUInt32BE(4, 0);
    notJson.write("nope", 4);
    expect(() => new FrameDecoder().push(notJson)).toThrow(/non-JSON/);
  });
});

describe("lease endpoint resolution & dataDir hardening", () => {
  it("hashes the normalized, lowercased win32 data dir into the pipe name", () => {
    const forward = resolveLeaseEndpoint("C:/Users/u/.MiniMax", "win32");
    const backward = resolveLeaseEndpoint("C:\\Users\\u\\.MiniMax\\", "win32");
    expect(forward).toEqual(backward);

    const digest = createHash("sha256").update("c:\\users\\u\\.minimax").digest("hex").slice(0, 16);
    expect(forward.endpoint).toBe(`\\\\.\\pipe\\mcode-auth-lease-${digest}`);
    expect(forward.capabilityFile).toBe("C:\\Users\\u\\.MiniMax\\run\\mcode-auth-lease-v1.cap");
    expect(forward.transport).toBe("pipe");
  });

  it("puts the unix socket and capability file under <dataDir>/run on POSIX", () => {
    const ep = resolveLeaseEndpoint("/home/u/.minimax", "linux");
    expect(ep.transport).toBe("unix");
    expect(ep.endpoint).toBe(path.join("/home/u/.minimax", "run", "mcode-auth-lease-v1.sock"));
    expect(ep.capabilityFile).toBe(path.join("/home/u/.minimax", "run", "mcode-auth-lease-v1.cap"));
  });

  it("refuses relative data dirs", () => {
    expect(() => resolveLeaseEndpoint("relative/path", "win32")).toThrow(AuthLeaseError);
    expect(() => resolveLeaseEndpoint("relative/path", "linux")).toThrow(AuthLeaseError);
  });

  it("refuses data dirs with null bytes or traversal", () => {
    expect(() => validateAndCanonicalizeDataDir("/home/user/\0evil", "linux")).toThrow(AuthLeaseError);
    expect(() => validateAndCanonicalizeDataDir("/home/user/../../etc", "linux")).toThrow(AuthLeaseError);
    expect(() => validateAndCanonicalizeDataDir("C:\\Users\\..\\Windows", "win32")).toThrow(AuthLeaseError);
  });
});

describe("capability token reading & socket verification", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads a valid 43-character base64url capability token", () => {
    const runDir = path.join(tempDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const capPath = path.join(runDir, "mcode-auth-lease-v1.cap");
    const validCap = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_1"; // exactly 43 chars
    fs.writeFileSync(capPath, validCap, "utf8");

    const cap = readCapability(tempDir);
    expect(cap).toBe(validCap);
  });

  it("rejects capability files exceeding 1024 bytes or invalid character sets", () => {
    const runDir = path.join(tempDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const capPath = path.join(runDir, "mcode-auth-lease-v1.cap");

    // Over 1024 bytes
    fs.writeFileSync(capPath, "a".repeat(1025), "utf8");
    expect(() => readCapability(tempDir)).toThrow(/exceeds maximum allowed size/);

    // Invalid length / characters
    fs.writeFileSync(capPath, "short", "utf8");
    expect(() => readCapability(tempDir)).toThrow(/unexpected content/);
  });

  it("verifies POSIX socket permissions (rejects world-writable)", () => {
    if (process.platform === "win32") return;
    const sockPath = path.join(tempDir, "test.sock");
    // Create dummy socket-like file and chmod to 0o777 (world-writable)
    fs.writeFileSync(sockPath, "test");
    fs.chmodSync(sockPath, 0o777);

    expect(() => verifySocketPermissions(sockPath)).toThrow(/world-writable/);
  });
});

describe("in-test net broker server protocol communication", () => {
  let server;
  let tempDir;
  let socketPath;
  let capValue;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-broker-"));
    const runDir = path.join(tempDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    socketPath = path.join(runDir, "mcode-auth-lease-v1.sock");
    capValue = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_1"; // 43 chars
    fs.writeFileSync(path.join(runDir, "mcode-auth-lease-v1.cap"), capValue);
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("speaks requestStatus protocol over Unix socket", async () => {
    server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.method === "status") {
            const resp = encodeFrame({
              ok: true,
              requestId: frame.requestId,
              result: { status: "active", generation: 5, expiresAtMs: 1730000000000 },
            });
            socket.write(resp);
          }
        }
      });
    });

    await new Promise((resolve) => server.listen(socketPath, resolve));

    const status = await requestStatus(tempDir, 2000);
    expect(status).toEqual({
      status: "active",
      generation: 5,
      expiresAtMs: 1730000000000,
    });
  });

  it("speaks requestLease protocol and parses active token", async () => {
    server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.method === "lease") {
            expect(frame.capability).toBe(capValue);
            expect(frame.minValidityMs).toBe(300000);
            const resp = encodeFrame({
              ok: true,
              requestId: frame.requestId,
              result: { accessToken: "leased-jwt-123", generation: 1, expiresAtMs: 1730000000000 },
            });
            socket.write(resp);
          }
        }
      });
    });

    await new Promise((resolve) => server.listen(socketPath, resolve));

    const lease = await requestLease(tempDir, 300000, 2000);
    expect(lease.accessToken).toBe("leased-jwt-123");
    expect(lease.generation).toBe(1);
    expect(lease.expiresAtMs).toBe(1730000000000);
  });

  it("propagates broker error responses as AuthLeaseError", async () => {
    server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          socket.write(
            encodeFrame({
              ok: false,
              requestId: frames[0].requestId,
              error: { code: "AUTH_REQUIRED", message: "User not logged in." },
            }),
          );
        }
      });
    });

    await new Promise((resolve) => server.listen(socketPath, resolve));

    await expect(requestLease(tempDir, 300000, 2000)).rejects.toThrow(AuthLeaseError);
  });
});

describe("lease token manager: caching & single-flight", () => {
  beforeEach(() => vi.clearAllMocks());

  function managerWith(tokens, delayMs = 0) {
    let calls = 0;
    const leaseFn = vi.fn(async () => {
      calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return tokens[Math.min(calls - 1, tokens.length - 1)];
    });
    return { manager: createTokenManager({ requestLease: leaseFn }), leaseFn };
  }

  const fresh = (token) => ({ accessToken: token, expiresAtMs: Date.now() + 5 * 60 * 1000, generation: 1 });

  it("caches a lease while it stays fresh (60s margin)", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1")]);
    await manager.getToken("/data");
    await manager.getToken("/data");
    expect(leaseFn).toHaveBeenCalledTimes(1);
  });

  it("re-leases once the remaining validity drops under the margin", async () => {
    const { manager, leaseFn } = managerWith([
      { accessToken: "t1", expiresAtMs: Date.now() + 30 * 1000, generation: 1 },
      fresh("t2"),
    ]);
    await manager.getToken("/data");
    await manager.getToken("/data");
    expect(leaseFn).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests into a single lease across 5 callers (single-flight)", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1")], 30);
    const results = await Promise.all([
      manager.getToken("/data"),
      manager.getToken("/data"),
      manager.getToken("/data"),
      manager.getToken("/data"),
      manager.getToken("/data"),
    ]);
    for (const r of results) {
      expect(r.accessToken).toBe("t1");
    }
    expect(leaseFn).toHaveBeenCalledTimes(1);
  });

  it("drops the cache on invalidate and leases anew", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1"), fresh("t2")]);
    await manager.getToken("/data");
    manager.invalidate("upstream 401");
    const next = await manager.getToken("/data");
    expect(next.accessToken).toBe("t2");
    expect(leaseFn).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached token across different data directories", async () => {
    const { manager, leaseFn } = managerWith([fresh("t-dir1"), fresh("t-dir2")]);
    const t1 = await manager.getToken("/data1");
    expect(t1.accessToken).toBe("t-dir1");

    const t2 = await manager.getToken("/data2");
    expect(t2.accessToken).toBe("t-dir2");
    expect(leaseFn).toHaveBeenCalledTimes(2);
  });
});

describe("lease token manager: Redis cross-worker cache & single-flight lock", () => {
  it("hits Redis cache when available and skips IPC", async () => {
    const leaseFn = vi.fn();
    const mockToken = { accessToken: "redis-cached-token", expiresAtMs: Date.now() + 180000, generation: 7 };

    const mockRedis = {
      get: vi.fn(async (key) => (key.includes("mcode:lease:") ? JSON.stringify(mockToken) : null)),
      set: vi.fn(),
      del: vi.fn(),
    };

    const manager = createTokenManager({
      requestLease: leaseFn,
      dataDir: "/tmp/data",
      getRedis: () => mockRedis,
    });

    const token = await manager.getToken("/tmp/data");
    expect(token.accessToken).toBe("redis-cached-token");
    expect(leaseFn).not.toHaveBeenCalled();
    expect(mockRedis.get).toHaveBeenCalled();
  });

  it("acquires distributed lock, leases, sets Redis cache with TTL, and unlocks", async () => {
    const freshToken = { accessToken: "new-leased-token", expiresAtMs: Date.now() + 300000, generation: 1 };
    const leaseFn = vi.fn(async () => freshToken);

    let lockHolder = null;
    let cachedVal = null;

    const mockRedis = {
      get: vi.fn(async (key) => {
        if (key.includes("lock:mcode:lease:")) return lockHolder;
        if (key.includes("mcode:lease:")) return cachedVal;
        return null;
      }),
      set: vi.fn(async (key, val, mode, duration, flag) => {
        if (flag === "NX") {
          if (lockHolder) return null;
          lockHolder = val;
          return "OK";
        }
        if (mode === "EX") {
          cachedVal = val;
          return "OK";
        }
        return "OK";
      }),
      del: vi.fn(async (key) => {
        if (key.includes("lock:mcode:lease:")) lockHolder = null;
        if (key.includes("mcode:lease:")) cachedVal = null;
      }),
    };

    const manager = createTokenManager({
      requestLease: leaseFn,
      dataDir: "/tmp/data",
      getRedis: () => mockRedis,
    });

    const token = await manager.getToken("/tmp/data");
    expect(token.accessToken).toBe("new-leased-token");
    expect(leaseFn).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("lock:mcode:lease:"),
      expect.any(String),
      "PX",
      5000,
      "NX",
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("mcode:lease:"),
      JSON.stringify(freshToken),
      "EX",
      expect.any(Number),
    );
  });

  it("fails open to in-memory caching when Redis throws or is disconnected", async () => {
    const freshToken = { accessToken: "failopen-token", expiresAtMs: Date.now() + 300000, generation: 2 };
    const leaseFn = vi.fn(async () => freshToken);

    const brokenRedis = {
      get: vi.fn(async () => {
        throw new Error("Redis ECONNREFUSED");
      }),
      set: vi.fn(async () => {
        throw new Error("Redis ECONNREFUSED");
      }),
    };

    const manager = createTokenManager({
      requestLease: leaseFn,
      dataDir: "/tmp/data",
      getRedis: () => brokenRedis,
    });

    // Does not throw despite Redis errors
    const token = await manager.getToken("/tmp/data");
    expect(token.accessToken).toBe("failopen-token");
    expect(leaseFn).toHaveBeenCalledTimes(1);
  });
});

describe("mcode data dir + mode helpers", () => {
  const ORIGINAL_ENV = process.env.MINIMAX_DESKTOP_DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MINIMAX_DESKTOP_DATA_DIR;
    else process.env.MINIMAX_DESKTOP_DATA_DIR = ORIGINAL_ENV;
  });

  it("isLeaseConnection keys on the mcode-lease authType", () => {
    expect(isLeaseConnection({ authType: "mcode-lease" })).toBe(true);
    expect(isLeaseConnection({ authType: "oauth", refreshToken: "r" })).toBe(false);
    expect(isLeaseConnection(null)).toBe(false);
  });

  it("resolves the data dir: connection override > env > default", () => {
    process.env.MINIMAX_DESKTOP_DATA_DIR = "/env/dir";
    expect(resolveMcodeDataDir({ providerSpecificData: { mcodeDataDir: "/conn/dir" } })).toBe(path.resolve("/conn/dir"));
    expect(resolveMcodeDataDir({ providerSpecificData: {} })).toBe(path.resolve("/env/dir"));
    delete process.env.MINIMAX_DESKTOP_DATA_DIR;
    expect(resolveMcodeDataDir({})).toBe(DEFAULT_MCODE_DATA_DIR);
  });
});

describe("minimax-code executor lease wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StubBase.lastArgs = null;
  });

  it("borrows a leased token for lease connections before calling upstream", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "leased-1", expiresAtMs: Date.now() + 300000, generation: 3 });
    const ex = new MinimaxCodeExecutor("minimax-code");

    await ex.execute({ model: "MiniMax-M3", body: {}, credentials: { authType: "mcode-lease" } });

    expect(getLeaseTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ authType: "mcode-lease" }),
      undefined,
    );
    expect(StubBase.lastArgs.credentials.accessToken).toBe("leased-1");
  });

  it("leaves stored-token (oauth) credentials untouched", async () => {
    const ex = new MinimaxCodeExecutor("minimax-code");
    const creds = { authType: "oauth", accessToken: "stored-1", refreshToken: "r1" };

    await ex.execute({ model: "MiniMax-M3", body: {}, credentials: creds });

    expect(getLeaseTokenMock).not.toHaveBeenCalled();
    expect(StubBase.lastArgs.credentials.accessToken).toBe("stored-1");
  });

  it("refreshes a lease connection by invalidating and re-leasing (no refresh token)", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "leased-2", expiresAtMs: Date.now() + 300000, generation: 4 });
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "mcode-lease" });

    expect(invalidateLeaseTokenMock).toHaveBeenCalled();
    expect(out).toEqual({ accessToken: "leased-2", ephemeral: true });
    expect(refreshMiniMaxMock).not.toHaveBeenCalled();
  });

  it("returns null (fail over) when the desktop broker is unreachable", async () => {
    getLeaseTokenMock.mockRejectedValue(new AuthLeaseError("BROKER_UNAVAILABLE"));
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "mcode-lease" });

    expect(out).toBeNull();
  });

  it("keeps the single-use refresh-token handler for oauth connections", async () => {
    refreshMiniMaxMock.mockResolvedValue({ accessToken: "a", refreshToken: "r2" });
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "oauth", refreshToken: "r1" });

    expect(out).toEqual({ accessToken: "a", refreshToken: "r2" });
    expect(refreshMiniMaxMock).toHaveBeenCalledWith("minimax-code", "r1", undefined);
    expect(getLeaseTokenMock).not.toHaveBeenCalled();
  });
});

describe("minimax-code usage service lease wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("borrows a leased token when accessToken is unset and authType is mcode-lease", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "usage-leased-token" });

    // The function will try to fetch identity using usage-leased-token and fail on network/mock
    const conn = { provider: "minimax-code", authType: "mcode-lease" };
    const res = await getMiniMaxCodeUsage(conn);

    expect(getLeaseTokenMock).toHaveBeenCalledWith(conn);
    expect(res).toBeDefined();
  });

  it("falls back gracefully when broker is unreachable for usage call", async () => {
    getLeaseTokenMock.mockRejectedValue(new AuthLeaseError("BROKER_UNAVAILABLE"));

    const conn = { provider: "minimax-code", authType: "mcode-lease" };
    const res = await getMiniMaxCodeUsage(conn);

    expect(res).toEqual({ message: "Usage API not implemented for minimax-code" });
  });

  it("always resolves via getLeaseToken for lease connections ignoring any stored connection.accessToken", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "fresh-leased-token" });
    const conn = {
      provider: "minimax-code",
      authType: "mcode-lease",
      accessToken: "stale-polluted-token",
    };
    await getMiniMaxCodeUsage(conn);
    expect(getLeaseTokenMock).toHaveBeenCalledWith(conn);
  });

  it("falls back to not implemented message on lease failure even if connection.accessToken is set", async () => {
    getLeaseTokenMock.mockRejectedValue(new AuthLeaseError("BROKER_UNAVAILABLE"));
    const conn = {
      provider: "minimax-code",
      authType: "mcode-lease",
      accessToken: "stale-polluted-token",
    };
    const res = await getMiniMaxCodeUsage(conn);
    expect(res).toEqual({ message: "Usage API not implemented for minimax-code" });
  });
});

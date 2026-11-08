import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks for dashboardGuard testing
const guardMocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    headers: new Headers(init?.headers || {}),
    body,
    json: async () => body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => guardMocks.nextResponse),
    json: guardMocks.jsonResponse,
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: guardMocks.getSettings,
  validateApiKey: guardMocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: guardMocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: guardMocks.verifyDashboardAuthToken,
}));

// Mock fs/promises with truthful open/stat/read/close descriptors
const mockFs = vi.hoisted(() => ({
  open: vi.fn(),
  constants: { O_RDONLY: 0, O_NONBLOCK: 2048, O_NOFOLLOW: 131072 },
}));

vi.mock("fs/promises", () => ({
  open: mockFs.open,
  constants: mockFs.constants,
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/home/user") },
  homedir: vi.fn(() => "/home/user"),
}));

function createMockHandle(content, { isFile = true, size, failRead = false } = {}) {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "", "utf-8");
  const actualSize = size !== undefined ? size : contentBuf.length;
  let pos = 0;
  let closed = false;

  return {
    stat: vi.fn(async () => ({
      isFile: () => isFile,
      size: actualSize,
    })),
    read: vi.fn(async (buffer, offset, length) => {
      if (failRead) throw new Error("EIO: disk read failure");
      if (pos >= contentBuf.length) {
        return { bytesRead: 0 };
      }
      const bytesToRead = Math.min(length, contentBuf.length - pos);
      contentBuf.copy(buffer, offset, pos, pos + bytesToRead);
      pos += bytesToRead;
      return { bytesRead: bytesToRead };
    }),
    close: vi.fn(async () => {
      closed = true;
    }),
    get isClosed() {
      return closed;
    },
  };
}

const { proxy } = await import("../../src/dashboardGuard.js");
const { GET } = await import("../../src/app/api/oauth/commandcode/auto-import/route.js");

const PEER_TOKEN = "peer-token-guard-fixture";

function makeProxyRequest(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: {
      pathname,
      searchParams: new URL(`http://localhost${pathname}`).searchParams,
    },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
    json: async () => ({}),
  };
}

function makeRouteRequest({ isLoopback = true, hasValidJwt = true, tokenValue = "valid-jwt" } = {}) {
  const headers = new Headers();
  if (isLoopback) {
    headers.set("x-9r-peer-token", PEER_TOKEN);
    headers.set("x-9r-real-ip", "127.0.0.1");
  } else {
    headers.set("x-9r-peer-token", PEER_TOKEN);
    headers.set("x-9r-real-ip", "198.51.100.12");
  }

  return {
    headers,
    cookies: {
      get: vi.fn((name) => (name === "auth_token" && hasValidJwt ? { value: tokenValue } : undefined)),
    },
  };
}

describe("CommandCode Import Guard — proxy middleware layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    guardMocks.getSettings.mockResolvedValue({ requireLogin: false });
    guardMocks.validateApiKey.mockResolvedValue(false);
    guardMocks.getConsistentMachineId.mockResolvedValue("machine-cli-token");
    guardMocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("denies remote caller with 403 before route execution", async () => {
    const remoteReq = makeProxyRequest("/api/oauth/commandcode/auto-import", {
      "x-9r-peer-token": PEER_TOKEN,
      "x-9r-real-ip": "203.0.113.5",
    });
    const res = await proxy(remoteReq);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Local only/i);
  });

  it("denies unauthenticated caller with 401 even when requireLogin=false", async () => {
    guardMocks.getSettings.mockResolvedValue({ requireLogin: false });
    guardMocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const localReq = makeProxyRequest("/api/oauth/commandcode/auto-import", {
      "x-9r-peer-token": PEER_TOKEN,
      "x-9r-real-ip": "127.0.0.1",
    });
    const res = await proxy(localReq);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unauthorized/i);
  });
});

describe("CommandCode Import Guard — route handler defense-in-depth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    guardMocks.verifyDashboardAuthToken.mockResolvedValue(true);
  });

  it("denies unauthenticated callers before any filesystem reads (no fs.open)", async () => {
    guardMocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const unauthedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: false });
    const res = await GET(unauthedReq);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.found).toBe(false);
    expect(mockFs.open).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("denies non-loopback callers before any filesystem reads (no fs.open)", async () => {
    const remoteReq = makeRouteRequest({ isLoopback: false, hasValidJwt: true });
    const res = await GET(remoteReq);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.found).toBe(false);
    expect(mockFs.open).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("rejects non-regular files (FIFO, socket, directory) and closes handle", async () => {
    const handle = createMockHandle(JSON.stringify({ apiKey: "key" }), { isFile: false });
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.found).toBe(false);
    expect(data.error).toContain("not a regular file");
    expect(handle.isClosed).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("bounds credential read and rejects files exceeding 64 KiB via stat size", async () => {
    const handle = createMockHandle(Buffer.alloc(65537), { size: 65537 });
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.found).toBe(false);
    expect(data.error).toContain("exceeds size limit");
    expect(handle.isClosed).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("bounds credential read when stat size lies (e.g. 0 on special stream) without unbounded memory read", async () => {
    // 100 KiB content, but stat reports size 0 (like procfs or lying descriptor)
    const largeBuf = Buffer.alloc(100 * 1024, "a");
    const handle = createMockHandle(largeBuf, { size: 0 });
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.found).toBe(false);
    expect(data.error).toContain("exceeds size limit");
    expect(handle.isClosed).toBe(true);
  });

  it("rejects invalid JSON shape (array or primitive) without leaking raw exception", async () => {
    const handle = createMockHandle(JSON.stringify(["not", "an", "object"]));
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(data.found).toBe(false);
    expect(data.error).toContain("invalid format");
    expect(handle.isClosed).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("avoids leaking absolute candidate paths or raw exceptions in not-found response", async () => {
    mockFs.open.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(data.found).toBe(false);
    expect(data.error).not.toContain("/home/user");
    expect(data.error).not.toContain("ENOENT");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("handles read error gracefully and closes handle in finally", async () => {
    const handle = createMockHandle(Buffer.from("some content"), { failRead: true });
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.found).toBe(false);
    expect(data.error).toBe("Failed to read Command Code credentials");
    expect(handle.isClosed).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns no-store on successful credential read and closes handle", async () => {
    const handle = createMockHandle(JSON.stringify({ apiKey: "user_valid_key_123" }));
    mockFs.open.mockResolvedValue(handle);

    const authedReq = makeRouteRequest({ isLoopback: true, hasValidJwt: true });
    const res = await GET(authedReq);
    const data = await res.json();

    expect(data.found).toBe(true);
    expect(data.apiKey).toBe("user_valid_key_123");
    expect(handle.isClosed).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

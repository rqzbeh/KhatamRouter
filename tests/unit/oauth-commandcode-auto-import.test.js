import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      headers: new Headers(init?.headers || {}),
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock dashboardGuard and auth
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: vi.fn(() => true),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async () => true),
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

function createMockHandle(content, { isFile = true, size, shortRead = false } = {}) {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "", "utf-8");
  const actualSize = size ?? contentBuf.length;
  let pos = 0;
  let closed = false;

  return {
    stat: vi.fn(async () => ({
      isFile: () => isFile,
      size: actualSize,
    })),
    read: vi.fn(async (buffer, offset, length) => {
      if (pos >= contentBuf.length) {
        return { bytesRead: 0 };
      }
      const chunkLen = shortRead ? Math.min(16, length) : length;
      const bytesToRead = Math.min(chunkLen, contentBuf.length - pos);
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

const { GET } = await import("../../src/app/api/oauth/commandcode/auto-import/route.js");

function makeAuthenticatedLocalRequest() {
  return {
    headers: new Headers({
      "x-9r-peer-token": "valid-peer-token",
      "x-9r-real-ip": "127.0.0.1",
    }),
    cookies: {
      get: vi.fn((name) => (name === "auth_token" ? { value: "valid-jwt-token" } : undefined)),
    },
  };
}

describe("GET /api/oauth/commandcode/auto-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns found: false when auth.json does not exist", async () => {
    mockFs.open.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const response = await GET(makeAuthenticatedLocalRequest());
    const data = await response.json();

    expect(data.found).toBe(false);
    expect(data.error).toContain("Command Code auth file not found");
    expect(data.error).not.toContain("/mock/home");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns credentials when auth.json exists with valid apiKey", async () => {
    const handle = createMockHandle(
      JSON.stringify({
        apiKey: "user_abc123xyz",
        userId: "usr_456",
        userName: "Alwa Dev",
        keyName: "default",
        authenticatedAt: "2026-11-08T15:30:00.000Z",
      })
    );
    mockFs.open.mockResolvedValue(handle);

    const response = await GET(makeAuthenticatedLocalRequest());
    const data = await response.json();

    expect(data.found).toBe(true);
    expect(data.apiKey).toBe("user_abc123xyz");
    expect(data.userId).toBe("usr_456");
    expect(data.userName).toBe("Alwa Dev");
    expect(data.keyName).toBe("default");
    expect(handle.isClosed).toBe(true);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("handles short reads in a loop until EOF", async () => {
    const handle = createMockHandle(
      JSON.stringify({
        apiKey: "user_short_read_key",
        userId: "usr_789",
      }),
      { shortRead: true }
    );
    mockFs.open.mockResolvedValue(handle);

    const response = await GET(makeAuthenticatedLocalRequest());
    const data = await response.json();

    expect(data.found).toBe(true);
    expect(data.apiKey).toBe("user_short_read_key");
    expect(handle.read.mock.calls.length).toBeGreaterThan(1);
    expect(handle.isClosed).toBe(true);
  });

  it("returns found: false when apiKey is missing", async () => {
    const handle = createMockHandle(
      JSON.stringify({
        userId: "usr_456",
      })
    );
    mockFs.open.mockResolvedValue(handle);

    const response = await GET(makeAuthenticatedLocalRequest());
    const data = await response.json();

    expect(data.found).toBe(false);
    expect(data.error).toContain("No apiKey found");
    expect(handle.isClosed).toBe(true);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});

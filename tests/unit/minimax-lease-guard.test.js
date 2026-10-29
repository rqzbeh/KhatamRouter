import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  createProviderConnection: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  requestLease: vi.fn(),
  requestStatus: vi.fn(),
  resolveLeaseEndpoint: vi.fn(),
  resolveMcodeDataDir: vi.fn(),
  validateAndCanonicalizeDataDir: vi.fn((dir) => (typeof dir === "string" ? dir.replace(/\/+$/, "") : dir)),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
  getProviderConnections: mocks.getProviderConnections,
  createProviderConnection: mocks.createProviderConnection,
  updateProviderConnection: mocks.updateProviderConnection,
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("open-sse/services/minimaxCodeLease.js", () => {
  class AuthLeaseError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = "AuthLeaseError";
      this.code = code;
    }
  }
  return {
    AuthLeaseError,
    requestLease: mocks.requestLease,
    requestStatus: mocks.requestStatus,
    resolveLeaseEndpoint: mocks.resolveLeaseEndpoint,
    resolveMcodeDataDir: mocks.resolveMcodeDataDir,
    validateAndCanonicalizeDataDir: mocks.validateAndCanonicalizeDataDir,
    isLeaseConnection: (c) => c?.authType === "mcode-lease",
  };
});

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture-lease";

function makeRequest(pathname, headers = {}, method = "GET", body = null) {
  const normalizedHeaders = new Headers(headers);
  return {
    method,
    nextUrl: {
      pathname,
      searchParams: new URL(`http://localhost${pathname}`).searchParams,
    },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
    json: async () => (body !== null ? body : {}),
  };
}

function localRequest(pathname, headers = {}, method = "GET", body = null) {
  return makeRequest(
    pathname,
    {
      "x-9r-peer-token": PEER_TOKEN,
      "x-9r-real-ip": "127.0.0.1",
      ...headers,
    },
    method,
    body,
  );
}

function remoteRequest(pathname, headers = {}, method = "GET", body = null) {
  return makeRequest(
    pathname,
    {
      "x-9r-peer-token": PEER_TOKEN,
      "x-9r-real-ip": "203.0.113.195",
      ...headers,
    },
    method,
    body,
  );
}

describe("minimax-lease-guard: loopback and host hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token-val");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("recognizes all standard loopback host formats", () => {
    expect(__test__.isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(__test__.isLoopbackHostname("127.0.0.1:20128")).toBe(true);
    expect(__test__.isLoopbackHostname("127.0.0.2")).toBe(true);
    expect(__test__.isLoopbackHostname("localhost")).toBe(true);
    expect(__test__.isLoopbackHostname("localhost:20128")).toBe(true);
    expect(__test__.isLoopbackHostname("localhost.")).toBe(true);
    expect(__test__.isLoopbackHostname("::1")).toBe(true);
    expect(__test__.isLoopbackHostname("[::1]:20128")).toBe(true);
  });

  it("correctly parses and recognizes IPv4-mapped IPv6 loopback addresses (::ffff:127.0.0.1)", () => {
    expect(__test__.isLoopbackHostname("::ffff:127.0.0.1")).toBe(true);
    expect(__test__.isLoopbackHostname("[::ffff:127.0.0.1]:20128")).toBe(true);
    expect(__test__.isLoopbackHostname("::ffff:127.0.0.1:20128")).toBe(true);
    expect(__test__.isLoopbackHostname("::ffff:127.0.0.2")).toBe(true);
  });

  it("rejects non-loopback and public IPs", () => {
    expect(__test__.isLoopbackHostname("203.0.113.195")).toBe(false);
    expect(__test__.isLoopbackHostname("192.168.1.1")).toBe(false);
    expect(__test__.isLoopbackHostname("10.0.0.1")).toBe(false);
    expect(__test__.isLoopbackHostname("evil.com")).toBe(false);
    expect(__test__.isLoopbackHostname("")).toBe(false);
    expect(__test__.isLoopbackHostname(null)).toBe(false);
  });
});

describe("minimax-lease-guard: bypass attempt resistance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token-val");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects remote request to lease endpoints with 403", async () => {
    const res = await proxy(remoteRequest("/api/oauth/minimax-code/lease-connect", { host: "example.com" }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Local only/i);
  });

  it("blocks spoofed X-Forwarded-For from non-loopback peer", async () => {
    const spoofed1 = remoteRequest("/api/oauth/minimax-code/lease-connect", {
      "x-forwarded-for": "127.0.0.1",
      host: "localhost",
    });
    const res1 = await proxy(spoofed1);
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    // Without trusted peer token (direct socket connection from external client)
    const spoofed2 = makeRequest("/api/oauth/minimax-code/lease-connect", {
      "x-forwarded-for": "127.0.0.1",
      host: "localhost",
    });
    const res2 = await proxy(spoofed2);
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);
  });

  it("blocks trailing slash bypass attempts", async () => {
    const res1 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-connect/"));
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    const res2 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-status/"));
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);
  });

  it("blocks case variation bypass attempts", async () => {
    const res1 = await proxy(remoteRequest("/API/oauth/minimax-code/lease-connect"));
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    const res2 = await proxy(remoteRequest("/api/OAUTH/MINIMAX-CODE/lease-connect"));
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);

    const res3 = await proxy(remoteRequest("/api/oauth/minimax-code/LEASE-status"));
    expect(res3.status).toBe(403);
    expect(res3.body.error).toMatch(/Local only/i);

    const res4 = await proxy(remoteRequest("/api/oauth/minimax-code-global/LEASE-connect"));
    expect(res4.status).toBe(403);
    expect(res4.body.error).toMatch(/Local only/i);
  });

  it("blocks double-encoding and URI encoding bypass attempts", async () => {
    const res1 = await proxy(remoteRequest("/api/oauth/minimax%2dcode/lease%2dconnect"));
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    const res2 = await proxy(remoteRequest("/api%2foauth%2fminimax-code%2flease-connect"));
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);

    const res3 = await proxy(remoteRequest("/api%252foauth%252fminimax-code%252flease-connect"));
    expect(res3.status).toBe(403);
    expect(res3.body.error).toMatch(/Local only/i);
  });

  it("blocks query string bypass attempts", async () => {
    const res1 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-connect?token=leak&bypass=1"));
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    const res2 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-status?data_dir=/etc&bypass=1"));
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);
  });

  it("blocks subpath and prefix variants (e.g. lease-evil)", async () => {
    const res1 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-connect/subpath"));
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/Local only/i);

    const res2 = await proxy(remoteRequest("/api/oauth/minimax-code/lease-evil"));
    expect(res2.status).toBe(403);
    expect(res2.body.error).toMatch(/Local only/i);

    const res3 = await proxy(remoteRequest("/api/oauth/minimax-code-global/lease-evil"));
    expect(res3.status).toBe(403);
    expect(res3.body.error).toMatch(/Local only/i);
  });

  it("allows loopback peer with ::ffff:127.0.0.1 when authenticated", async () => {
    // Authenticated with CLI token
    const res = await proxy(
      makeRequest("/api/oauth/minimax-code/lease-connect", {
        "x-9r-peer-token": PEER_TOKEN,
        "x-9r-real-ip": "::ffff:127.0.0.1",
        "x-9r-cli-token": "cli-token-val",
      }),
    );
    expect(res).toBe(mocks.nextResponse);
  });

  it("blocks unauthenticated loopback request when requireLogin=true with 403", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    const res = await proxy(localRequest("/api/oauth/minimax-code/lease-connect"));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Local only/i);
  });

  it("requires authentication even when requireLogin=false (ALWAYS_PROTECTED returns 401)", async () => {
    // When requireLogin is disabled, local check passes, but ALWAYS_PROTECTED demands valid token/CLI
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    const res = await proxy(localRequest("/api/oauth/minimax-code/lease-connect"));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unauthorized/i);
  });

  it("allows loopback peer with valid JWT cookie", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const req = localRequest("/api/oauth/minimax-code/lease-connect");
    req.cookies.get = vi.fn((name) => (name === "auth_token" ? { value: "valid-jwt" } : undefined));

    const res = await proxy(req);
    expect(res).toBe(mocks.nextResponse);
  });
});

describe("minimax-lease route: response shape and no token leak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLeaseEndpoint.mockImplementation((dataDir) => ({
      transport: "unix",
      endpoint: `${dataDir}/run/mcode-auth-lease-v1.sock`,
      capabilityFile: `${dataDir}/run/mcode-auth-lease-v1.cap`,
    }));
    mocks.resolveMcodeDataDir.mockReturnValue("/home/user/.minimax");
  });

  it("GET lease-status returns probe status and NEVER leaks access token or capability", async () => {
    const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

    mocks.requestStatus.mockResolvedValue({
      status: "ready",
      generation: 42,
      expiresAtMs: Date.now() + 300000,
    });

    const req = localRequest("/api/oauth/minimax-code/lease-status");
    const res = await GET(req, {
      params: Promise.resolve({ provider: "minimax-code", action: "lease-status" }),
    });

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.status).toBe("ready");
    expect(res.body.generation).toBe(42);
    expect(res.body).not.toHaveProperty("accessToken");
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("capability");
    expect(res.body).not.toHaveProperty("secret");
  });

  it("POST lease-connect connects and NEVER leaks leased token in response or DB record", async () => {
    const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

    const SECRET_LEASABLE_TOKEN = "secret_minimax_access_token_xyz987";
    mocks.requestLease.mockResolvedValue({
      accessToken: SECRET_LEASABLE_TOKEN,
      expiresAtMs: Date.now() + 3600000,
      generation: 1,
    });

    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.createProviderConnection.mockResolvedValue({
      id: "conn-mcode-lease-1",
      provider: "minimax-code",
      authType: "mcode-lease",
      name: "MiniMax Desktop (Lease)",
    });

    const req = localRequest("/api/oauth/minimax-code/lease-connect", {}, "POST", {});
    const res = await POST(req, {
      params: Promise.resolve({ provider: "minimax-code", action: "lease-connect" }),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.connection).toEqual({
      id: "conn-mcode-lease-1",
      provider: "minimax-code",
    });

    // Verify token is NOT leaked in response
    expect(res.body).not.toHaveProperty("accessToken");
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("capability");
    expect(JSON.stringify(res.body)).not.toContain(SECRET_LEASABLE_TOKEN);

    // Verify connection stored in DB does NOT contain token
    expect(mocks.createProviderConnection).toHaveBeenCalledTimes(1);
    const saved = mocks.createProviderConnection.mock.calls[0][0];
    expect(saved.authType).toBe("mcode-lease");
    expect(saved).not.toHaveProperty("accessToken");
    expect(saved).not.toHaveProperty("token");
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("refreshToken");
    expect(saved.providerSpecificData).toEqual({
      mcodeDataDir: "/home/user/.minimax",
    });
  });

  it("POST lease-connect is idempotent for same provider and dataDir", async () => {
    const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

    mocks.requestLease.mockResolvedValue({
      accessToken: "ephemeral-token",
      expiresAtMs: Date.now() + 3600000,
      generation: 1,
    });

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "existing-conn-1",
        provider: "minimax-code",
        authType: "mcode-lease",
        providerSpecificData: { mcodeDataDir: "/home/user/.minimax" },
      },
    ]);

    const req = localRequest("/api/oauth/minimax-code/lease-connect", {}, "POST", {});
    const res = await POST(req, {
      params: Promise.resolve({ provider: "minimax-code", action: "lease-connect" }),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reused).toBe(true);
    expect(res.body.connection.id).toBe("existing-conn-1");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("POST lease-connect canonicalizes dataDir so trailing slashes yield same connection", async () => {
    const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

    mocks.requestLease.mockResolvedValue({
      accessToken: "ephemeral-token",
      expiresAtMs: Date.now() + 3600000,
      generation: 1,
    });

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "existing-conn-1",
        provider: "minimax-code",
        authType: "mcode-lease",
        providerSpecificData: { mcodeDataDir: "/home/user/.minimax" },
      },
    ]);

    const req = localRequest("/api/oauth/minimax-code/lease-connect", {}, "POST", {
      dataDir: "/home/user/.minimax/",
    });
    const res = await POST(req, {
      params: Promise.resolve({ provider: "minimax-code", action: "lease-connect" }),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reused).toBe(true);
    expect(res.body.connection.id).toBe("existing-conn-1");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
});

describe("minimax-lease: 401 refresh persistence boundary (SECURITY)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never persists leased access token to SQLite on 401 refresh flow", async () => {
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");

    const LEASE_CONN_ID = "mcode-lease-conn-sec";
    const LEASED_TOKEN = "leaked_minimax_leased_token_abc123";

    mocks.getProviderConnectionById.mockResolvedValue({
      id: LEASE_CONN_ID,
      provider: "minimax-code",
      authType: "mcode-lease",
      accessToken: null,
      providerSpecificData: { mcodeDataDir: "/home/user/.minimax" },
    });

    // Simulate 401 refresh result being passed to updateProviderCredentials
    await updateProviderCredentials(LEASE_CONN_ID, {
      accessToken: LEASED_TOKEN,
      testStatus: "active",
    });

    // Assert that the lease token was NEVER written to the database
    expect(mocks.updateProviderConnection).not.toHaveBeenCalledWith(
      LEASE_CONN_ID,
      expect.objectContaining({ accessToken: LEASED_TOKEN }),
    );
    for (const call of mocks.updateProviderConnection.mock.calls) {
      expect(call[1]).not.toHaveProperty("accessToken");
      expect(JSON.stringify(call)).not.toContain(LEASED_TOKEN);
    }
  });

  it("drops ephemeral tokens passed with ephemeral:true flag", async () => {
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");

    const CONN_ID = "generic-conn-id";
    const EPHEMERAL_TOKEN = "ephemeral_token_xyz999";

    mocks.getProviderConnectionById.mockResolvedValue({
      id: CONN_ID,
      provider: "minimax-code",
      accessToken: null,
    });

    await updateProviderCredentials(CONN_ID, {
      accessToken: EPHEMERAL_TOKEN,
      ephemeral: true,
      testStatus: "active",
    });

    expect(mocks.updateProviderConnection).not.toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ accessToken: EPHEMERAL_TOKEN }),
    );
    for (const call of mocks.updateProviderConnection.mock.calls) {
      expect(call[1]).not.toHaveProperty("accessToken");
      expect(JSON.stringify(call)).not.toContain(EPHEMERAL_TOKEN);
    }
  });

  it("simulates full 401 refresh flow for a lease connection ensuring DB row has null accessToken", async () => {
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");
    const LEASE_CONN_ID = "mcode-lease-conn-full";
    const LEASED_TOKEN = "leaked_minimax_leased_token_full_401";

    let dbRow = {
      id: LEASE_CONN_ID,
      provider: "minimax-code",
      authType: "mcode-lease",
      accessToken: null,
      providerSpecificData: { mcodeDataDir: "/home/user/.minimax" },
    };

    mocks.getProviderConnectionById.mockImplementation(async (id) => (id === LEASE_CONN_ID ? { ...dbRow } : null));
    mocks.updateProviderConnection.mockImplementation(async (id, data) => {
      if (id === LEASE_CONN_ID) {
        dbRow = { ...dbRow, ...data };
        return dbRow;
      }
      return null;
    });

    // Simulate 401 refresh returning from executor:
    const refreshed = { accessToken: LEASED_TOKEN, ephemeral: true };

    // Chat onCredentialsRefreshed handler:
    const isLease = refreshed?.ephemeral || dbRow.authType === "mcode-lease";
    const credsToPersist = isLease
      ? {
          testStatus: "active",
          authType: dbRow.authType,
          existingProviderSpecificData: dbRow.providerSpecificData,
          ephemeral: true,
        }
      : {
          ...refreshed,
          existingProviderSpecificData: dbRow.providerSpecificData,
          testStatus: "active",
        };

    await updateProviderCredentials(LEASE_CONN_ID, credsToPersist);

    // Verify DB row: accessToken stays null/empty
    expect(dbRow.accessToken).toBeNull();
    expect(JSON.stringify(dbRow)).not.toContain(LEASED_TOKEN);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalledWith(
      LEASE_CONN_ID,
      expect.objectContaining({ accessToken: LEASED_TOKEN }),
    );
  });
});

// Regression: the guard decodes/lowercases paths to WIDEN deny matches (LOCAL_ONLY / ALWAYS_PROTECTED).
// That normalized form must never be used for ALLOW decisions, or an encoded path such as
// /api/auth/login%2f..%2fsettings would match the public prefix /api/auth/login and skip auth.
import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => "NEXT"),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireLogin: true }),
  validateApiKey: async () => false,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "machine-id" }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async () => null }));

const { proxy } = await import("@/dashboardGuard.js");

const request = (pathname, headers = {}) => ({
  nextUrl: { pathname },
  headers: new Headers(headers),
  cookies: { get: () => undefined },
  url: `http://example.test${pathname}`,
  method: "GET",
});

describe("dashboardGuard: encoded paths never turn into public allows", () => {
  const bypassAttempts = [
    "/api/auth/login%2f..%2fsettings",
    "/api/auth/status%2f..%2fkeys",
    "/API/AUTH/LOGIN/x%2f..%2f..%2fkeys",
    "/api/version%2f..%2fproviders",
    "/api/health%2f..%2fproxy-pools",
  ];

  for (const path of bypassAttempts) {
    it(`unauthenticated request to ${path} is rejected`, async () => {
      const res = await proxy(request(path));
      expect(res).not.toBe("NEXT");
      expect(res.status).toBe(401);
    });
  }

  it("a genuinely public path is still allowed", async () => {
    const res = await proxy(request("/api/auth/status"));
    expect(res).toBe("NEXT");
  });

  it("the lease routes stay denied from a non-loopback peer, including encoded and cased forms", async () => {
    for (const path of [
      "/api/oauth/minimax-code/lease",
      "/api/oauth/minimax-code/lease-connect",
      "/api/oauth/MINIMAX-CODE/Lease",
      "/api/oauth/minimax-code%2flease-connect",
    ]) {
      const res = await proxy(request(path, { "x-forwarded-for": "203.0.113.9" }));
      expect(res).not.toBe("NEXT");
      expect([401, 403]).toContain(res.status);
    }
  });
});

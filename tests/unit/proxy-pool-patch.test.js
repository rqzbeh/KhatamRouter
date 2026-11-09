// tests/unit/proxy-pool-patch.test.js
//
// Activation is a partial concern, so clients reach for PATCH. The route only
// ever exported GET/PUT/DELETE and answered 405. PATCH is now an alias of PUT
// so both verbs run the same normalize path instead of drifting apart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function jsonRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/proxy-pools/[id]", () => {
  let route;
  let repo;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pool-patch-test-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();

    route = await import("../../src/app/api/proxy-pools/[id]/route.js");
    repo = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
  });

  afterEach(() => {
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
    delete global._dbAdapter;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("is exported alongside PUT", () => {
    expect(typeof route.PATCH).toBe("function");
    expect(typeof route.PUT).toBe("function");
  });

  it("activates a pool through PATCH", async () => {
    const created = await repo.createProxyPool({
      name: "free-1",
      proxyUrl: "http://10.1.2.3:8080",
      type: "http",
      isActive: false,
    });

    const res = await route.PATCH(
      jsonRequest(`http://x/api/proxy-pools/${created.id}`, "PATCH", { isActive: true }),
      { params: Promise.resolve({ id: created.id }) }
    );

    expect(res.status).toBe(200);
    const reRead = await repo.getProxyPoolById(created.id);
    expect(reRead.isActive).toBe(true);
  });

  it("still 404s an unknown pool", async () => {
    const res = await route.PATCH(
      jsonRequest("http://x/api/proxy-pools/nope", "PATCH", { isActive: true }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(res.status).toBe(404);
  });
});
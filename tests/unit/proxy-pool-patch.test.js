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

  it("records explicit disable intent for feed imports and clears it on enable", async () => {
    const { createFreeProxyPool } = await import("../../src/lib/freeProxyProviders/index.js");
    const created = await createFreeProxyPool({
      id: "test-import-intent",
      name: "feed import", proxyUrl: "http://185.220.106.10:8080", type: "http", isActive: true,
      provenance: { source: "free:oneproxy", untrusted: true },
    });
    for (const isActive of [false, true]) {
      const res = await route.PATCH(
        jsonRequest(`http://x/api/proxy-pools/${created.id}`, "PATCH", { isActive }),
        { params: Promise.resolve({ id: created.id }) }
      );
      expect(res.status).toBe(200);
      const saved = await repo.getProxyPoolById(created.id);
      expect(saved.isActive).toBe(isActive);
      expect(saved.provenance.operatorDisabled).toBe(!isActive);
      expect(saved.provenance.source).toBe("free:oneproxy");
    }
  });

  it("still 404s an unknown pool", async () => {
    const res = await route.PATCH(
      jsonRequest("http://x/api/proxy-pools/nope", "PATCH", { isActive: true }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(res.status).toBe(404);
  });
});
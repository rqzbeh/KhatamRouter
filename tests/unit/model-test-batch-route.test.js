import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-batch-route-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.restoreAllMocks();
});

describe("POST & GET /api/models/test-batch (Spec 017)", () => {
  async function seedTestConnection({ provider = "openai", isActive = true } = {}) {
    const { createProviderConnection, updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const conn = await createProviderConnection({
      provider,
      authType: "apikey",
      name: `conn-${Date.now()}-${Math.random()}`,
      isActive: true,
    });
    if (!isActive) {
      await updateProviderConnection(conn.id, { isActive: false });
    }
    return conn.id;
  }

  it("pre-validates request types, bounds, duplicates, and control characters with 400 before taking any lease", async () => {
    const { POST } = await import("@/app/api/models/test-batch/route.js");

    // Invalid JSON body
    const resBadBody = await POST(new Request("http://localhost/api/models/test-batch", { method: "POST", body: "invalid json" }));
    expect(resBadBody.status).toBe(400);

    // Empty modelIds
    const resEmptyModels = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: "c1", modelIds: [] }),
      })
    );
    expect(resEmptyModels.status).toBe(400);

    // Duplicate modelIds
    const resDup = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: "c1", modelIds: ["m1", " m1 "] }),
      })
    );
    expect(resDup.status).toBe(400);
    expect((await resDup.json()).error).toMatch(/duplicate/);

    // NUL byte in modelId
    const resNul = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: "c1", modelIds: ["model\0bad"] }),
      })
    );
    expect(resNul.status).toBe(400);
    expect((await resNul.json()).error).toMatch(/forbidden/);

    // Non-boolean autoDisable
    const resBadBool = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: "c1", modelIds: ["m1"], autoDisable: "yes" }),
      })
    );
    expect(resBadBool.status).toBe(400);
  });

  it("rejects request if connection does not exist, provider mismatches, or connection is inactive", async () => {
    const { POST } = await import("@/app/api/models/test-batch/route.js");
    const activeConnId = await seedTestConnection({ provider: "openai", isActive: true });
    const inactiveConnId = await seedTestConnection({ provider: "openai", isActive: false });

    // 1. Connection not found
    const resNotFound = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: "nonexistent", modelIds: ["gpt-4"] }),
      })
    );
    expect(resNotFound.status).toBe(404);

    // 2. Provider mismatch
    const resMismatch = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic", connectionId: activeConnId, modelIds: ["claude-3"] }),
      })
    );
    expect(resMismatch.status).toBe(400);
    const mismatchBody = await resMismatch.json();
    expect(mismatchBody.error).toMatch(/does not match/);

    // 3. Inactive connection
    const resInactive = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: inactiveConnId, modelIds: ["gpt-4"] }),
      })
    );
    expect(resInactive.status).toBe(400);
    const inactiveBody = await resInactive.json();
    expect(inactiveBody.error).toMatch(/inactive/);
  });

  it("preserves legitimate vendor-prefixed IDs (e.g. anthropic/claude-3-5 on openrouter) without cross-provider escape", async () => {
    const pingMod = await import("@/app/api/models/test/ping.js");
    const { POST } = await import("@/app/api/models/test-batch/route.js");
    const openrouterConnId = await seedTestConnection({ provider: "openrouter", isActive: true });

    let probedModel = null;
    vi.spyOn(pingMod, "pingModelByKind").mockImplementation(async (model) => {
      probedModel = model;
      return { ok: true, status: 200, latencyMs: 20 };
    });

    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({
          providerId: "openrouter",
          connectionId: openrouterConnId,
          modelIds: ["anthropic/claude-3-5-sonnet"],
        }),
      })
    );

    expect(res.status).toBe(200);
    // Verifies server prepends openrouter alias and routes through openrouter, not anthropic
    expect(probedModel).toBe("openrouter/anthropic/claude-3-5-sonnet");
  });

  it("enforces in-process and cross-worker SQLite concurrency lease per provider and global maximum 2 batches", async () => {
    const pingMod = await import("@/app/api/models/test/ping.js");
    const { POST } = await import("@/app/api/models/test-batch/route.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const p1ConnId = await seedTestConnection({ provider: "openai", isActive: true });

    let releaseP1;
    const p1Gate = new Promise((resolve) => {
      releaseP1 = resolve;
    });

    vi.spyOn(pingMod, "pingModelByKind").mockImplementation(async (model) => {
      if (model.includes("openai")) {
        await p1Gate;
      }
      return { ok: true, status: 200, latencyMs: 10 };
    });

    // Start batch 1 for openai
    const batch1Promise = POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: p1ConnId, modelIds: ["gpt-4"] }),
      })
    );

    await new Promise((r) => setTimeout(r, 20));

    // Simultaneous batch for openai should fail with 409
    const dupRes = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: p1ConnId, modelIds: ["gpt-4"] }),
      })
    );
    expect(dupRes.status).toBe(409);

    // Release batch 1
    releaseP1();
    const res1 = await batch1Promise;
    expect(res1.status).toBe(200);

    // Test cross-worker global cap of 2: simulate 2 existing leases in SQLite from another worker
    const db = await getAdapter();
    const futureExpiry = Date.now() + 60000;
    db.run(
      "INSERT INTO kv(scope, key, value) VALUES('modelTestBatchLease', 'worker-p1', ?)",
      [JSON.stringify({ token: "t1", expiresAt: futureExpiry })]
    );
    db.run(
      "INSERT INTO kv(scope, key, value) VALUES('modelTestBatchLease', 'worker-p2', ?)",
      [JSON.stringify({ token: "t2", expiresAt: futureExpiry })]
    );

    const cappedRes = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", connectionId: p1ConnId, modelIds: ["gpt-4"] }),
      })
    );
    expect(cappedRes.status).toBe(429);
    expect((await cappedRes.json()).error).toMatch(/maximum concurrent test batches/);
  });

  it("propagates request.signal cancellation and aborts in-flight batch execution", async () => {
    const pingMod = await import("@/app/api/models/test/ping.js");
    const { POST } = await import("@/app/api/models/test-batch/route.js");
    const connId = await seedTestConnection({ provider: "openai", isActive: true });

    const controller = new AbortController();
    vi.spyOn(pingMod, "pingModelByKind").mockImplementation(async (model, kind, base, opts) => {
      // Abort when first probe is called
      controller.abort();
      if (opts?.signal?.aborted) {
        return { ok: false, status: 0, error: "Aborted" };
      }
      return { ok: true, status: 200, latencyMs: 5 };
    });

    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({
          providerId: "openai",
          connectionId: connId,
          modelIds: ["m1", "m2", "m3"],
          respectRateLimit: false,
        }),
        signal: controller.signal,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stoppedEarly).toBe(true);
    expect(body.stopReason).toBe("aborted");
    expect(body.summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("dispatches tests through pingModelByKind with honest provider executionScope and auto-disables hard failure", async () => {
    const pingMod = await import("@/app/api/models/test/ping.js");
    const { POST, GET } = await import("@/app/api/models/test-batch/route.js");
    const { getDisabledByProvider } = await import("@/lib/db/repos/disabledModelsRepo.js");

    const connId = await seedTestConnection({ provider: "openai", isActive: true });

    vi.spyOn(pingMod, "pingModelByKind").mockImplementation(async (model) => {
      if (model.includes("missing-model")) {
        return {
          ok: false,
          status: 404,
          code: "model_not_found",
          error: "HTTP 404: The model missing-model does not exist",
          latencyMs: 15,
        };
      }
      return { ok: true, status: 200, latencyMs: 25 };
    });

    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({
          providerId: "openai",
          connectionId: connId,
          modelIds: ["gpt-4", "missing-model", "__proto__"],
          autoDisable: true,
          respectRateLimit: false,
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.executionScope).toBe("provider");
    expect(body.executionNote).toMatch(/provider routing aggregate/);
    expect(body.summary.total).toBe(3);
    expect(body.summary.tested).toBe(3);
    expect(body.summary.disabled).toBe(1);

    expect(body.results["gpt-4"].tested).toBe(true);
    expect(body.results["gpt-4"].classification).toBe("success");

    expect(body.results["missing-model"].tested).toBe(true);
    expect(body.results["missing-model"].classification).toBe("hard_model_failure");
    expect(body.results["missing-model"].disabled).toBe(true);

    // Verify __proto__ serialized safely
    expect(Object.hasOwn(body.results, "__proto__")).toBe(true);

    // Verify DB disabled models
    const disabledInDb = await getDisabledByProvider("openai");
    expect(disabledInDb).toContain("missing-model");
    expect(disabledInDb).not.toContain("gpt-4");

    // Verify GET /api/models/test-batch?providerId=openai returns audit
    const auditRes = await GET(new Request("http://localhost/api/models/test-batch?providerId=openai"));
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.providerId).toBe("openai");
    expect(auditBody.audit).toHaveLength(1);
    expect(auditBody.audit[0].id).toBe("missing-model");

    // Verify GET rejects unknown arbitrary provider keys
    const unknownRes = await GET(new Request("http://localhost/api/models/test-batch?providerId=unknown_random_provider"));
    expect(unknownRes.status).toBe(400);
    expect((await unknownRes.json()).error).toMatch(/Unknown provider/);
  });
});

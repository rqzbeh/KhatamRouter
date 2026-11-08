import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-test-"));
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
});

describe("Model Overrides API Endpoint (Spec 017)", () => {
  it("rejects unauthenticated requests when requireLogin is true, and accepts valid token", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: true });

    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const validToken = await createDashboardAuthToken();

    const { GET, POST, DELETE } = await import("@/app/api/models/overrides/route.js");

    // Unauthenticated -> 401
    const reqGetUnauth = new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o");
    const resGetUnauth = await GET(reqGetUnauth);
    expect(resGetUnauth.status).toBe(401);

    const reqPostUnauth = new Request("http://localhost/api/models/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", modelId: "gpt-4o", capabilities: {} }),
    });
    const resPostUnauth = await POST(reqPostUnauth);
    expect(resPostUnauth.status).toBe(401);

    const reqDelUnauth = new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o", {
      method: "DELETE",
    });
    const resDelUnauth = await DELETE(reqDelUnauth);
    expect(resDelUnauth.status).toBe(401);

    // Authenticated with valid cookie -> proceeds past auth check (200)
    const reqGetAuth = new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o", {
      headers: { Cookie: `auth_token=${validToken}` },
    });
    const resGetAuth = await GET(reqGetAuth);
    expect(resGetAuth.status).toBe(200);
  });

  it("GET validates target, rejects unknown provider, and returns merged capabilities with provenance", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { GET } = await import("@/app/api/models/overrides/route.js");

    // 1. Missing parameters
    const resMissing = await GET(new Request("http://localhost/api/models/overrides"));
    expect(resMissing.status).toBe(400);
    const jsonMissing = await resMissing.json();
    expect(jsonMissing.error).toMatch(/Invalid provider/);

    // 2. Unknown provider
    const resUnknown = await GET(
      new Request("http://localhost/api/models/overrides?provider=nonexistent-provider-xyz&modelId=gpt-4o")
    );
    expect(resUnknown.status).toBe(400);
    const jsonUnknown = await resUnknown.json();
    expect(jsonUnknown.error).toBe("Unknown provider");

    // 3. Known provider and model: returns merged capabilities
    const resValid = await GET(
      new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o")
    );
    expect(resValid.status).toBe(200);
    const jsonValid = await resValid.json();
    expect(jsonValid.provider).toBe("openai");
    expect(jsonValid.modelId).toBe("gpt-4o");
    expect(jsonValid.capabilities).toBeDefined();
    expect(jsonValid.provenance).toBeDefined();
    expect(jsonValid.manual).toBeNull();
  });

  it("POST validates field schema, rejects unknown fields, and performs idempotent partial merge", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { POST, GET } = await import("@/app/api/models/overrides/route.js");

    // 1. Unknown field rejection
    const resUnknownField = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { maliciousUnknownField: true },
        }),
      })
    );
    expect(resUnknownField.status).toBe(400);
    const jsonUnknownField = await resUnknownField.json();
    expect(jsonUnknownField.error).toContain("Unknown field: maliciousUnknownField");

    // 2. Invalid limit value (exceeds 10M or not positive integer)
    const resInvalidLimit = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { contextWindow: 99_000_000 },
        }),
      })
    );
    expect(resInvalidLimit.status).toBe(400);
    expect((await resInvalidLimit.json()).error).toContain("positive integer <= 10,000,000");

    // 3. Valid POST partial write: supportsVision = false
    const resPost1 = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { supportsVision: false },
        }),
      })
    );
    expect(resPost1.status).toBe(200);
    const jsonPost1 = await resPost1.json();
    expect(jsonPost1.capabilities.supportsVision).toBe(false);

    // 4. Second partial POST adds contextWindow: previous supportsVision is preserved unchanged
    const resPost2 = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { contextWindow: 64000 },
        }),
      })
    );
    expect(resPost2.status).toBe(200);
    const jsonPost2 = await resPost2.json();
    expect(jsonPost2.capabilities.supportsVision).toBe(false);
    expect(jsonPost2.capabilities.contextWindow).toBe(64000);

    // 5. GET confirms the merged manual override
    const resGet = await GET(
      new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o")
    );
    const jsonGet = await resGet.json();
    expect(jsonGet.capabilities.supportsVision).toBe(false);
    expect(jsonGet.capabilities.contextWindow).toBe(64000);
    expect(jsonGet.provenance.supportsVision).toBe("manual");
    expect(jsonGet.provenance.contextWindow).toBe("manual");
    expect(jsonGet.manual).toEqual({ supportsVision: false, contextWindow: 64000 });
  });

  it("PUT atomically replaces the entire manual row fields", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { POST, PUT, GET } = await import("@/app/api/models/overrides/route.js");

    // First POST establishes supportsVision: false and contextWindow: 64000
    await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { supportsVision: false, contextWindow: 64000 },
        }),
      })
    );

    // PUT replaces manual fields with ONLY contextWindow: 256000 (clearing supportsVision override)
    const resPut = await PUT(
      new Request("http://localhost/api/models/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { contextWindow: 256000 },
        }),
      })
    );
    expect(resPut.status).toBe(200);
    const jsonPut = await resPut.json();
    expect(jsonPut.capabilities.contextWindow).toBe(256000);
    expect(jsonPut.capabilities.supportsVision).toBeUndefined();

    // GET confirms supportsVision returned to catalog floor (true for gpt-4o) and contextWindow is 256000
    const resGet = await GET(
      new Request("http://localhost/api/models/overrides?provider=openai&modelId=gpt-4o")
    );
    const jsonGet = await resGet.json();
    expect(jsonGet.capabilities.contextWindow).toBe(256000);
    expect(jsonGet.provenance.contextWindow).toBe("manual");
    expect(jsonGet.capabilities.supportsVision).toBe(true); // revealed catalog floor
    expect(jsonGet.provenance.supportsVision).not.toBe("manual");
    expect(jsonGet.manual).toEqual({ contextWindow: 256000 });
  });

  it("DELETE isolates providers: deleting provider A does not affect provider B on the same model ID", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { POST, DELETE, GET } = await import("@/app/api/models/overrides/route.js");

    // Set overrides for the same model name on two different providers
    await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "custom-model",
          capabilities: { contextWindow: 11111 },
        }),
      })
    );

    await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openrouter",
          modelId: "custom-model",
          capabilities: { contextWindow: 22222 },
        }),
      })
    );

    // Delete openai's override
    const resDel = await DELETE(
      new Request("http://localhost/api/models/overrides?provider=openai&modelId=custom-model", {
        method: "DELETE",
      })
    );
    expect(resDel.status).toBe(200);
    expect((await resDel.json()).deleted).toBe(true);

    // Openrouter's override for the same model is completely untouched
    const resGetOpenRouter = await GET(
      new Request("http://localhost/api/models/overrides?provider=openrouter&modelId=custom-model")
    );
    const jsonOpenRouter = await resGetOpenRouter.json();
    expect(jsonOpenRouter.capabilities.contextWindow).toBe(22222);
    expect(jsonOpenRouter.manual).toEqual({ contextWindow: 22222 });

    // Openai's override is gone
    const resGetOpenAI = await GET(
      new Request("http://localhost/api/models/overrides?provider=openai&modelId=custom-model")
    );
    const jsonOpenAI = await resGetOpenAI.json();
    expect(jsonOpenAI.manual).toBeNull();
  });

  it("canonicalizes built-in alias nv -> nvidia and rejects noncanonical node name", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    await createProviderNode({
      id: "my-exact-node-id",
      name: "My Mutable Custom Node Name",
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080",
      apiKey: "sk-test",
    });

    const { POST, GET } = await import("@/app/api/models/overrides/route.js");

    // 1. Alias "nv" is canonicalized to "nvidia"
    const resNv = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "nv",
          modelId: "meta/llama-3.1-405b",
          capabilities: { contextWindow: 128000 },
        }),
      })
    );
    expect(resNv.status).toBe(200);
    const jsonNv = await resNv.json();
    expect(jsonNv.provider).toBe("nvidia"); // Canonical provider stored & returned

    // 2. Querying by canonical "nvidia" sees the override
    const resGetNvidia = await GET(
      new Request("http://localhost/api/models/overrides?provider=nvidia&modelId=meta/llama-3.1-405b")
    );
    expect(resGetNvidia.status).toBe(200);
    expect((await resGetNvidia.json()).capabilities.contextWindow).toBe(128000);

    // 3. Exact custom node ID is accepted
    const resNodeId = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "my-exact-node-id",
          modelId: "node-model",
          capabilities: { contextWindow: 32000 },
        }),
      })
    );
    expect(resNodeId.status).toBe(200);
    expect((await resNodeId.json()).provider).toBe("my-exact-node-id");

    // 4. Mutable custom node name is REJECTED
    const resNodeName = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "My Mutable Custom Node Name",
          modelId: "node-model",
          capabilities: { contextWindow: 32000 },
        }),
      })
    );
    expect(resNodeName.status).toBe(400);
    expect((await resNodeName.json()).error).toBe("Unknown provider");
  });

  it("strictly validates boolean limits and nested reasoning object keys", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { POST } = await import("@/app/api/models/overrides/route.js");

    // Boolean passed for numeric limit -> 400
    const resBoolLimit = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { contextWindow: true },
        }),
      })
    );
    expect(resBoolLimit.status).toBe(400);
    expect((await resBoolLimit.json()).error).toContain("positive integer <= 10,000,000");

    // Array passed for numeric limit -> 400
    const resArrLimit = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: { maxOutputTokens: [1000] },
        }),
      })
    );
    expect(resArrLimit.status).toBe(400);
    expect((await resArrLimit.json()).error).toContain("positive integer <= 10,000,000");

    // Unknown field in nested reasoning object -> 400
    const resUnknownReasoning = await POST(
      new Request("http://localhost/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4o",
          capabilities: {
            reasoning: {
              supported: true,
              unknownNestedField: "exploit",
            },
          },
        }),
      })
    );
    expect(resUnknownReasoning.status).toBe(400);
    expect((await resUnknownReasoning.json()).error).toContain("Unknown field in reasoning: unknownNestedField");
  });
});

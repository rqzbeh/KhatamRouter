import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let apiKeysQueries = [];
let providerNodesQueries = [];
let combosQueries = [];

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-request-scoped-test-"));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = null;

  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();

  // Instrument adapter to spy on specific queries
  const originalGet = db.get.bind(db);
  const originalAll = db.all.bind(db);
  const originalRun = db.run.bind(db);

  function spyQuery(sql, args) {
    const s = String(sql || "");
    if (s.includes("apiKeys")) {
      apiKeysQueries.push({ sql: s, args });
    }
    if (s.includes("providerNodes")) {
      providerNodesQueries.push({ sql: s, args });
    }
    if (s.includes("combos")) {
      combosQueries.push({ sql: s, args });
    }
  }

  db.get = (sql, ...args) => {
    spyQuery(sql, args);
    return originalGet(sql, ...args);
  };
  db.all = (sql, ...args) => {
    spyQuery(sql, args);
    return originalAll(sql, ...args);
  };
  db.run = (sql, ...args) => {
    spyQuery(sql, args);
    return originalRun(sql, ...args);
  };

  // Mock BaseExecutor so handleChat completes without network calls
  const { BaseExecutor } = await import("open-sse/executors/base.js");
  BaseExecutor.prototype.execute = async function({ model, body }) {
    const sseData = "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Mock response\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n";
    return {
      response: new Response(sseData, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "content-type": "text/event-stream" },
      transformedBody: body,
    };
  };

  // Seed provider connections
  const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
  await createProviderConnection({
    id: "conn-test-openai",
    provider: "openai",
    authType: "apikey",
    name: "OpenAI Mock Connection",
    apiKey: "sk-mock-openai-key",
    isActive: true,
    priority: 1,
  });
  await createProviderConnection({
    id: "conn-test-anthropic",
    provider: "anthropic",
    authType: "apikey",
    name: "Anthropic Mock Connection",
    apiKey: "sk-mock-anthropic-key",
    isActive: true,
    priority: 1,
  });

  // Seed a combo
  const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
  await createCombo({
    name: "fast-combo",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3-5-sonnet"],
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  global._dbAdapter = null;
});

beforeEach(() => {
  apiKeysQueries = [];
  providerNodesQueries = [];
  combosQueries = [];
});

describe("T012: Provider node prefix optimization in getModelInfo", () => {
  it("skips providerNodes queries when provider prefix is a known built-in", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");

    providerNodesQueries = [];
    const infoOpenAI = await getModelInfo("openai/gpt-4o-mini");
    expect(infoOpenAI).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(providerNodesQueries.length).toBe(0);

    const infoAnthropic = await getModelInfo("anthropic/claude-3-5-sonnet");
    expect(infoAnthropic).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });
    expect(providerNodesQueries.length).toBe(0);
  });

  it("queries providerNodes when provider prefix is NOT a known built-in", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");

    providerNodesQueries = [];
    const infoCustom = await getModelInfo("my-custom-prefix/custom-llama");
    expect(infoCustom.provider).toBe("my-custom-prefix");
    expect(providerNodesQueries.length).toBeGreaterThan(0);
  });

  it("reuses pre-resolved combo in getModelInfo and getComboModels without re-querying", async () => {
    const { getModelInfo, getComboModels } = await import("@/sse/services/model.js");

    const preCombo = { id: "c1", name: "fast-combo", models: ["openai/gpt-4o-mini"] };
    combosQueries = [];

    const models = await getComboModels("fast-combo", preCombo);
    expect(models).toEqual(["openai/gpt-4o-mini"]);
    expect(combosQueries.length).toBe(0);

    const info = await getModelInfo("fast-combo", preCombo);
    expect(info).toEqual({ provider: null, model: "fast-combo" });
    expect(combosQueries.length).toBe(0);
  });
});

describe("T012: Request-scoped keyRecord and combo reuse in handleChat", () => {
  it("queries apiKeys exactly ONCE per direct request", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");

    await updateSettings({ requireApiKey: true });
    const key = await createApiKey("Single Query Key", "machine-sq-01");

    apiKeysQueries = [];
    const req = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);

    // Filter to SELECT queries on apiKeys
    const selectKeyQueries = apiKeysQueries.filter((q) => q.sql.includes("SELECT") && q.sql.includes("apiKeys"));
    expect(selectKeyQueries.length).toBe(1);
  });

  it("queries apiKeys exactly ONCE for combo requests (not multiplied across combo members)", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");

    await updateSettings({ requireApiKey: true });
    const key = await createApiKey("Combo Single Query Key", "machine-csq-01");

    apiKeysQueries = [];
    const req = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "fast-combo",
        messages: [{ role: "user", content: "combo test" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);

    const selectKeyQueries = apiKeysQueries.filter((q) => q.sql.includes("SELECT") && q.sql.includes("apiKeys"));
    expect(selectKeyQueries.length).toBe(1);
  });

  it("fails closed immediately on revoked key without cross-request caching", async () => {
    const { createApiKey, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");

    await updateSettings({ requireApiKey: true });
    const key = await createApiKey("Revoke Test Key", "machine-rev-01");

    // 1. First request with active key succeeds
    const req1 = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const res1 = await handleChat(req1);
    expect(res1.status).toBe(200);

    // 2. Revoke the key in SQLite directly
    await updateApiKey(key.id, { isActive: false });

    // 3. Next request MUST fail immediately with 401 (never cached across requests)
    const req2 = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello again" }],
      }),
    });
    const res2 = await handleChat(req2);
    expect(res2.status).toBe(401);
  });
});

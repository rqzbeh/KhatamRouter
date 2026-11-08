import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalPeerToken = process.env.NINEROUTER_PEER_TOKEN;
let activeServer = null;

const TEST_PEER_TOKEN = "test-route-completeness-peer-token";

function localHeaders() {
  return {
    host: "localhost:20128",
    "x-9r-peer-token": TEST_PEER_TOKEN,
    "x-9r-real-ip": "127.0.0.1",
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-route-completeness-"));
  process.env.DATA_DIR = tempDir;
  process.env.NINEROUTER_PEER_TOKEN = TEST_PEER_TOKEN;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  if (activeServer) {
    try { activeServer.stop(true); } catch {}
    activeServer = null;
  }
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;

  if (originalPeerToken === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
  else process.env.NINEROUTER_PEER_TOKEN = originalPeerToken;
});

async function setupDatabase() {
  const { createProviderNode, createProviderConnection } = await import("@/models/index.js");
  const { getCustomModels, addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");
  const { listImportedModels, batchUpsertImportedModels } = await import("@/lib/db/repos/modelMetadataRepo.js");
  const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
  const { POST: importModelsPOST } = await import("@/app/api/providers/[id]/import-models/route.js");

  return {
    createProviderNode,
    createProviderConnection,
    getCustomModels,
    addCustomModel,
    listImportedModels,
    batchUpsertImportedModels,
    resolveProviderModels,
    importModelsPOST,
  };
}

describe("import-route-completeness with loopback Bun.serve", () => {
  it("OpenAI unpaginated: complete:true and import prunes obsolete models", async () => {
    let callCount = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        if (callCount === 1) {
          // Initial snapshot with old-model and keep-model
          return new Response(JSON.stringify({
            object: "list",
            data: [
              { id: "old-model", object: "model" },
              { id: "keep-model", object: "model" },
            ],
          }), { headers: { "Content-Type": "application/json" } });
        }
        // Second snapshot: old-model dropped, new-model added
        return new Response(JSON.stringify({
          object: "list",
          data: [
            { id: "keep-model", object: "model" },
            { id: "new-model", object: "model" },
          ],
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "openai-compatible-test1";
    await db.createProviderNode({
      id: nodeId,
      name: "OpenAI Gateway",
      prefix: "openai-compatible-test1",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}/v1`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn",
      apiKey: "test-key-123",
      authType: "apikey",
    });

    const req1 = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res1 = await db.importModelsPOST(req1, { params: Promise.resolve({ id: connection.id }) });
    const json1 = await res1.json();
    expect(json1.ok).toBe(true);
    expect(json1.authoritative).toBe(true);
    expect(json1.added).toEqual(["keep-model", "old-model"]);

    const req2 = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res2 = await db.importModelsPOST(req2, { params: Promise.resolve({ id: connection.id }) });
    const json2 = await res2.json();
    expect(json2.ok).toBe(true);
    expect(json2.authoritative).toBe(true);
    expect(json2.removed).toEqual(["old-model"]);
    expect(json2.added).toEqual(["new-model"]);

    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toEqual(["keep-model", "new-model"]);
  });

  it("OpenAI paginated (has_more: true): complete:false and import does NOT prune", async () => {
    let callCount = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        if (callCount === 1) {
          // Initial unpaginated setup
          return new Response(JSON.stringify({
            object: "list",
            data: [{ id: "initial-model" }],
          }), { headers: { "Content-Type": "application/json" } });
        }
        // Second fetch has has_more: true
        return new Response(JSON.stringify({
          object: "list",
          data: [{ id: "paged-model" }],
          has_more: true,
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "openai-compatible-test2";
    await db.createProviderNode({
      id: nodeId,
      name: "OpenAI Gateway Paginated",
      prefix: "openai-compatible-test2",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}/v1`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn 2",
      apiKey: "test-key-2",
      authType: "apikey",
    });

    // Initial import
    const res1 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    expect((await res1.json()).added).toEqual(["initial-model"]);

    // Second import with has_more: true
    const res2 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const json2 = await res2.json();
    expect(json2.authoritative).toBe(false);
    expect(json2.removed).toEqual([]); // Did NOT prune!
    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toContain("initial-model");
    expect(custom).toContain("paged-model");
  });

  it("Anthropic 3-page chain: follows after_id, all models returned, complete:true, prunes obsolete", async () => {
    const requestedUrls = [];
    activeServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestedUrls.push(url.pathname + url.search);
        const afterId = url.searchParams.get("after_id");

        if (!afterId) {
          // Page 1
          return new Response(JSON.stringify({
            data: [{ id: "anthropic-1" }],
            has_more: true,
            last_id: "anthropic-1",
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (afterId === "anthropic-1") {
          // Page 2
          return new Response(JSON.stringify({
            data: [{ id: "anthropic-2" }],
            has_more: true,
            last_id: "anthropic-2",
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (afterId === "anthropic-2") {
          // Page 3 (final)
          return new Response(JSON.stringify({
            data: [{ id: "anthropic-3" }],
            has_more: false,
          }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const db = await setupDatabase();
    const nodeId = "anthropic-compatible-test3";
    await db.createProviderNode({
      id: nodeId,
      name: "Anthropic Gateway 3-page",
      prefix: "anthropic-compatible-test3",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn 3",
      apiKey: "test-key-3",
      authType: "apikey",
    });

    // Seed an obsolete model in customModels and metadata
    await db.addCustomModel({ providerAlias: nodeId, id: "obsolete-anthropic", type: "llm", source: "import" });
    await db.batchUpsertImportedModels({
      provider: nodeId,
      connectionId: connection.id,
      models: [{ modelId: "obsolete-anthropic", capabilities: {} }],
    });

    const req = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res = await db.importModelsPOST(req, { params: Promise.resolve({ id: connection.id }) });
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.authoritative).toBe(true);
    expect(json.added).toEqual(["anthropic-1", "anthropic-2", "anthropic-3"]);
    expect(json.removed).toEqual(["obsolete-anthropic"]);

    expect(requestedUrls).toEqual([
      "/models?limit=1000",
      "/models?limit=1000&after_id=anthropic-1",
      "/models?limit=1000&after_id=anthropic-2",
    ]);

    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toEqual(["anthropic-1", "anthropic-2", "anthropic-3"]);
  });

  it("Anthropic page cap reached: complete:false, warning present, does NOT prune", async () => {
    let count = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch(req) {
        count++;
        const url = new URL(req.url);
        const afterId = url.searchParams.get("after_id") || "0";
        const nextId = String(Number(afterId) + 1);
        return new Response(JSON.stringify({
          data: [{ id: `page-model-${nextId}` }],
          has_more: true,
          last_id: nextId,
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "anthropic-compatible-test4";
    await db.createProviderNode({
      id: nodeId,
      name: "Anthropic Infinite Pages",
      prefix: "anthropic-compatible-test4",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn 4",
      apiKey: "test-key-4",
      authType: "apikey",
    });

    // Seed prior model
    await db.addCustomModel({ providerAlias: nodeId, id: "prior-model", type: "llm", source: "import" });
    await db.batchUpsertImportedModels({
      provider: nodeId,
      connectionId: connection.id,
      models: [{ modelId: "prior-model", capabilities: {} }],
    });

    const req = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res = await db.importModelsPOST(req, { params: Promise.resolve({ id: connection.id }) });
    const json = await res.json();

    expect(count).toBe(20); // capped at 20 pages
    expect(json.authoritative).toBe(false);
    expect(json.warning).toMatch(/maximum limit of 20 pages/i);
    expect(json.removed).toEqual([]); // prior model NOT pruned

    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toContain("prior-model");
  });

  it("Anthropic mid-chain 500 error: returns partial with warning, complete:false, does NOT prune", async () => {
    let count = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        count++;
        if (count === 1) {
          return new Response(JSON.stringify({
            data: [{ id: "anthropic-p1" }],
            has_more: true,
            last_id: "anthropic-p1",
          }), { headers: { "Content-Type": "application/json" } });
        }
        // Page 2 fails with 500
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    const db = await setupDatabase();
    const nodeId = "anthropic-compatible-test5";
    await db.createProviderNode({
      id: nodeId,
      name: "Anthropic Mid Error",
      prefix: "anthropic-compatible-test5",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn 5",
      apiKey: "test-key-5",
      authType: "apikey",
    });

    // Seed prior model
    await db.addCustomModel({ providerAlias: nodeId, id: "prior-keep", type: "llm", source: "import" });
    await db.batchUpsertImportedModels({
      provider: nodeId,
      connectionId: connection.id,
      models: [{ modelId: "prior-keep", capabilities: {} }],
    });

    const req = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res = await db.importModelsPOST(req, { params: Promise.resolve({ id: connection.id }) });
    const json = await res.json();

    expect(json.authoritative).toBe(false);
    expect(json.warning).toMatch(/HTTP 500/i);
    expect(json.added).toEqual(["anthropic-p1"]);
    expect(json.removed).toEqual([]); // prior-keep NOT pruned

    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toContain("prior-keep");
    expect(custom).toContain("anthropic-p1");
  });

  it("OpenAI numeric next_page or object next: complete:false and does NOT prune", async () => {
    let callCount = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        if (callCount === 1) {
          // Response with numeric next_page: 2
          return new Response(JSON.stringify({
            data: [{ id: "model-p1" }],
            next_page: 2,
          }), { headers: { "Content-Type": "application/json" } });
        }
        // Response with object next: { href: "/v1/models?cursor=abc" }
        return new Response(JSON.stringify({
          data: [{ id: "model-p2" }],
          next: { href: "/v1/models?cursor=abc" },
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "openai-compatible-numeric-next";
    await db.createProviderNode({
      id: nodeId,
      name: "OpenAI Numeric Next",
      prefix: "openai-compatible-numeric-next",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}/v1`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn Numeric",
      apiKey: "test-key-numeric",
      authType: "apikey",
    });

    // Seed prior model
    await db.addCustomModel({ providerAlias: nodeId, id: "prior-numeric", type: "llm", source: "import" });
    await db.batchUpsertImportedModels({
      provider: nodeId,
      connectionId: connection.id,
      models: [{ modelId: "prior-numeric", capabilities: {} }],
    });

    // First call: numeric next_page
    const res1 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const json1 = await res1.json();
    expect(json1.authoritative).toBe(false);
    expect(json1.removed).toEqual([]);

    // Second call: object next
    const res2 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const json2 = await res2.json();
    expect(json2.authoritative).toBe(false);
    expect(json2.removed).toEqual([]);

    const custom = (await db.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toContain("prior-numeric");
  });

  it("Anthropic cursor repeat / cycle detection: stops chain with complete:false and warning", async () => {
    let callCount = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        // Both pages return identical last_id
        return new Response(JSON.stringify({
          data: [{ id: `model-${callCount}` }],
          has_more: true,
          last_id: "same-cursor-id",
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "anthropic-compatible-cursor-repeat";
    await db.createProviderNode({
      id: nodeId,
      name: "Anthropic Cursor Repeat",
      prefix: "anthropic-compatible-cursor-repeat",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn Repeat",
      apiKey: "test-key-repeat",
      authType: "apikey",
    });

    const req = new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
      method: "POST",
      headers: localHeaders(),
    });
    const res = await db.importModelsPOST(req, { params: Promise.resolve({ id: connection.id }) });
    const json = await res.json();

    expect(callCount).toBe(2); // Stopped on page 2 when cycle detected
    expect(json.authoritative).toBe(false);
    expect(json.warning).toMatch(/cycle detected/i);
    expect(json.removed).toEqual([]);
  });

  it("Anthropic string has_more or alternate pagination marker: complete:false with warning", async () => {
    let callCount = 0;
    activeServer = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        if (callCount === 1) {
          // string has_more: "true"
          return new Response(JSON.stringify({
            data: [{ id: "m-string-hasmore" }],
            has_more: "true",
            last_id: "m-string-hasmore",
          }), { headers: { "Content-Type": "application/json" } });
        }
        // alternate next_cursor signal present
        return new Response(JSON.stringify({
          data: [{ id: "m-alt-marker" }],
          next_cursor: "cursor-12345",
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    const db = await setupDatabase();
    const nodeId = "anthropic-compatible-alt-signals";
    await db.createProviderNode({
      id: nodeId,
      name: "Anthropic Alt Signals",
      prefix: "anthropic-compatible-alt-signals",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${activeServer.port}`,
      isSelfHosted: true,
    });
    const connection = await db.createProviderConnection({
      provider: nodeId,
      name: "Test Conn Alt",
      apiKey: "test-key-alt",
      authType: "apikey",
    });

    // Call 1: non-boolean has_more
    const res1 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const json1 = await res1.json();
    expect(json1.authoritative).toBe(false);
    expect(json1.warning).toMatch(/non-boolean has_more/i);

    // Call 2: alternate next_cursor signal
    const res2 = await db.importModelsPOST(
      new Request(`http://localhost:20128/api/providers/${connection.id}/import-models`, {
        method: "POST",
        headers: localHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const json2 = await res2.json();
    expect(json2.authoritative).toBe(false);
    expect(json2.warning).toMatch(/alternate pagination signal/i);
  });
});

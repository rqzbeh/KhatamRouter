import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let directory, server;
const originalDir = process.env.DATA_DIR;
const originalPeer = process.env.NINEROUTER_PEER_TOKEN;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-parent-page-"));
  process.env.DATA_DIR = directory;
  process.env.NINEROUTER_PEER_TOKEN = "parent-page-peer";
  delete global._dbAdapter;
  vi.resetModules();
});
afterEach(() => {
  server?.stop(true);
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDir;
  if (originalPeer === undefined) delete process.env.NINEROUTER_PEER_TOKEN; else process.env.NINEROUTER_PEER_TOKEN = originalPeer;
});
it("never calls an Anthropic chain complete if final HTTP200 page lacks a model array", async () => {
  let calls = 0;
  server = Bun.serve({ port: 0, fetch() {
    calls++;
    return Response.json(calls === 1 ? { data: [{ id: "keep" }], has_more: true, last_id: "keep" } : { error: "temporarily unavailable" });
  } });
  const { createProviderNode, createProviderConnection } = await import("@/models/index.js");
  const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
  const nodeId = "anthropic-compatible-parent-page";
  await createProviderNode({ id: nodeId, name: "Parent", prefix: nodeId, apiType: "anthropic", baseUrl: `http://127.0.0.1:${server.port}/v1`, isSelfHosted: true });
  const connection = await createProviderConnection({ provider: nodeId, name: "Parent", apiKey: "fixture", authType: "apikey" });
  const request = new Request("http://localhost:20128/api/providers/fixture/models", { headers: { host: "localhost:20128", "x-9r-peer-token": "parent-page-peer", "x-9r-real-ip": "127.0.0.1" } });
  const result = await resolveProviderModels(request, connection.id);
  expect(result.body.models.map((m) => m.id)).toEqual(["keep"]);
  expect(result.body.complete).toBe(false);
  expect(result.body.warning).toBeTruthy();
});

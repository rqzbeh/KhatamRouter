import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Bun SQLite + the real repositories. Only discovery is faked, because it
// is the network boundary; everything after it runs the production code.
let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-import-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function setup() {
  const repo = await import("@/lib/db/repos/modelMetadataRepo.js");
  const models = await import("@/models");
  const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
  const deps = {
    listImportedModels: repo.listImportedModels,
    batchUpsertImportedModels: repo.batchUpsertImportedModels,
    pruneImportedSnapshot: repo.pruneImportedSnapshot,
    listCapabilityOverrides: repo.listCapabilityOverrides,
    getCustomModels: models.getCustomModels,
    addCustomModel: models.addCustomModel,
    deleteCustomModel: models.deleteCustomModel,
  };
  const run = (discovery, extra = {}) => importProviderModels({
    provider: "openrouter",
    providerAlias: "openrouter",
    connectionId: "conn-1",
    discover: async () => discovery,
    repo: deps,
    ...extra,
  });
  const customIds = async () => (await models.getCustomModels())
    .filter((m) => m.providerAlias === "openrouter").map((m) => m.id).sort();
  return { run, repo, models, customIds };
}

const live = (...ids) => ({ models: ids.map((id) => ({ id, name: id, context_length: 128000 })) });

describe("importProviderModels against real storage", () => {
  it("adds every model from a live listing to the catalog the router reads", async () => {
    const { run, customIds } = await setup();
    const r = await run(live("a/one", "b/two"));
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(["a/one", "b/two"]);
    expect(await customIds()).toEqual(["a/one", "b/two"]);
  });

  it("removes a model the provider stopped listing (obsolete) on the next import", async () => {
    const { run, customIds, repo } = await setup();
    await run(live("a/one", "b/old"));
    const r = await run(live("a/one", "c/new"));
    expect(r.removed).toEqual(["b/old"]);
    expect(r.added).toEqual(["c/new"]);
    expect(await customIds()).toEqual(["a/one", "c/new"]);
    const active = (await repo.listImportedModels({ provider: "openrouter", lifecycle: "active" })).map((x) => x.modelId).sort();
    expect(active).toEqual(["a/one", "c/new"]);
  });

  it("never removes anything when discovery fell back to the static catalog", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one", "b/two"));
    const r = await run({ models: [{ id: "a/one" }], warning: "upstream 503 (falling back to static)" });
    expect(r.authoritative).toBe(false);
    expect(r.removed).toEqual([]);
    expect(await customIds()).toEqual(["a/one", "b/two"]);
  });

  it("never wipes the catalog on an empty live listing", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one", "b/two"));
    const r = await run({ models: [] });
    expect(r.removed).toEqual([]);
    expect(await customIds()).toEqual(["a/one", "b/two"]);
  });

  it("returns an error and writes nothing when discovery fails", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one"));
    const r = await run({ error: "Failed to fetch models: 401", status: 401 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(await customIds()).toEqual(["a/one"]);
  });

  it("never deletes a model the user added by hand, even if the provider dropped it", async () => {
    const { run, customIds, models } = await setup();
    await models.addCustomModel({ providerAlias: "openrouter", id: "mine/handmade", type: "llm" });
    await run(live("a/one"));
    const r = await run(live("a/one"));
    expect(r.removed).toEqual([]);
    expect(await customIds()).toEqual(["a/one", "mine/handmade"]);
  });

  it("does not retag a hand-added model as imported when the listing also has it", async () => {
    const { run, customIds, models } = await setup();
    await models.addCustomModel({ providerAlias: "openrouter", id: "a/one", type: "llm", name: "My name" });
    await run(live("a/one", "b/two"));
    await run(live("b/two")); // provider drops a/one
    const rows = (await models.getCustomModels()).filter((m) => m.providerAlias === "openrouter");
    expect(await customIds()).toEqual(["a/one", "b/two"]);
    expect(rows.find((m) => m.id === "a/one").name).toBe("My name");
  });

  it("records listed capabilities and keeps unknown capabilities unset", async () => {
    const { run, models } = await setup();
    await run({ models: [
      { id: "v/vision", name: "v", architecture: { input_modalities: ["text", "image"] }, context_length: 200000 },
      { id: "t/text", name: "t", context_length: 8000 },
    ] });
    const rows = (await models.getCustomModels()).filter((m) => m.providerAlias === "openrouter");
    expect(rows.find((m) => m.id === "v/vision").caps).toEqual({ vision: true });
    expect(rows.find((m) => m.id === "t/text").caps).toBeUndefined();
  });

  it("is idempotent: importing the same listing twice changes nothing", async () => {
    const { run } = await setup();
    await run(live("a/one", "b/two"));
    const r = await run(live("a/one", "b/two"));
    expect(r.added).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("dry run reports the plan and writes nothing", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one", "b/old"));
    const r = await run(live("a/one", "c/new"), { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.added).toEqual(["c/new"]);
    expect(r.removed).toEqual(["b/old"]);
    expect(await customIds()).toEqual(["a/one", "b/old"]);
  });

  it("keeps a model with a manual override when the provider drops it", async () => {
    const { run, customIds, repo } = await setup();
    await run(live("a/one", "b/pinned"));
    await repo.upsertCapabilityOverride({ provider: "openrouter", modelId: "b/pinned", source: "manual", capabilities: { contextWindow: 1000000 } });
    const r = await run(live("a/one"));
    expect(r.removed).toEqual([]);
    expect(r.stale).toEqual(["b/pinned"]);
    expect(await customIds()).toEqual(["a/one", "b/pinned"]);
  });
});

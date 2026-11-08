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

const live = (...ids) => ({ complete: true, models: ids.map((id) => ({ id, name: id, context_length: 128000 })) });

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

  it("never prunes when discovery lacks explicit completeness evidence (complete !== true)", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one", "b/two"));
    // Upstream returns 200 with models, but without complete: true (unknown adapter)
    const r = await run({ models: [{ id: "a/one", name: "a/one", context_length: 128000 }] });
    expect(r.authoritative).toBe(false);
    expect(r.removed).toEqual([]);
    expect(await customIds()).toEqual(["a/one", "b/two"]);
  });

  it("inspects raw listing before normalization drops invalid records and refuses pruning", async () => {
    const { run, customIds } = await setup();
    await run(live("a/one", "b/two"));
    // Raw listing has complete: true, but includes null and nameless record
    const r = await run({
      complete: true,
      models: [
        { id: "a/one", context_length: 128000 },
        null,
        { context_length: 4000 }, // missing id/name/model
      ],
    });
    expect(r.removed).toEqual([]);
    expect(r.skipped.invalid).toBe(2);
    expect(r.skipped.prune).toBe("invalid_records");
    expect(await customIds()).toEqual(["a/one", "b/two"]);
  });

  it("preserves shared model in customModels when conn-1 drops it but conn-2 has active membership", async () => {
    const { repo, models } = await setup();
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
    const runConn = (connId, ids) => importProviderModels({
      provider: "openrouter",
      providerAlias: "openrouter",
      connectionId: connId,
      discover: async () => ({ complete: true, models: ids.map((id) => ({ id, context_length: 128000 })) }),
      repo: deps,
    });

    await runConn("conn-1", ["shared/model", "only-1"]);
    await runConn("conn-2", ["shared/model", "only-2"]);

    // conn-1 drops shared/model
    const r = await runConn("conn-1", ["only-1"]);
    expect(r.removed).toEqual(["shared/model"]);

    // shared/model must be preserved in customModels because conn-2 still advertises it!
    const custom = (await models.getCustomModels()).map((m) => m.id).sort();
    expect(custom).toContain("shared/model");
    expect(custom).toContain("only-1");
    expect(custom).toContain("only-2");

    // Once conn-2 also drops shared/model, it is finally removed from customModels
    await runConn("conn-2", ["only-2"]);
    const customAfter = (await models.getCustomModels()).map((m) => m.id).sort();
    expect(customAfter).not.toContain("shared/model");
  });

  it("pages through imported models without hardcoded limit 5000 truncation", async () => {
    const { run } = await setup();
    const pages = [];
    const fakeRepo = {
      listImportedModels: async ({ limit, offset }) => {
        pages.push({ limit, offset });
        if (offset === 0) {
          return Array.from({ length: 500 }, (_, i) => ({
            id: `row-${i}`,
            modelId: `m-${i}`,
            lifecycle: "active",
            provenance: "imported",
          }));
        }
        if (offset === 500) {
          return Array.from({ length: 10 }, (_, i) => ({
            id: `row-${500 + i}`,
            modelId: `m-${500 + i}`,
            lifecycle: "active",
            provenance: "imported",
          }));
        }
        return [];
      },
      listCapabilityOverrides: async () => [],
      getCustomModels: async () => [],
      addCustomModel: async () => {},
      deleteCustomModel: async () => {},
      batchUpsertImportedModels: async () => {},
      pruneImportedSnapshot: async () => {},
    };

    const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
    const r = await importProviderModels({
      provider: "test-page",
      providerAlias: "test-page",
      connectionId: "c1",
      discover: async () => ({ complete: true, models: [] }),
      repo: fakeRepo,
    });
    expect(r.ok).toBe(true);
    // Verified that it paged offset 0 and offset 500
    expect(pages).toEqual([
      { limit: 500, offset: 0 },
      { limit: 500, offset: 500 },
    ]);
  });

  it("throws upfront when repo is missing expected persistence methods", async () => {
    const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
    await expect(importProviderModels({
      provider: "test",
      providerAlias: "test",
      connectionId: "c1",
      discover: async () => ({ complete: true, models: [] }),
      repo: { listImportedModels: async () => [] },
    })).rejects.toThrow(/repo missing required persistence methods/);
  });

  it("refuses all mutations and fails safe when manual overrides query reaches safety cap", async () => {
    const fakeRepo = {
      listImportedModels: async () => [],
      listCapabilityOverrides: async () => {
        // Return 50,000 overrides to trigger cap
        return Array.from({ length: 50000 }, (_, i) => ({
          modelId: `m-${i}`,
          source: "manual",
          capabilities: { contextWindow: 8000 },
        }));
      },
      getCustomModels: async () => [],
      addCustomModel: async () => { throw new Error("must not write"); },
      deleteCustomModel: async () => { throw new Error("must not write"); },
      batchUpsertImportedModels: async () => { throw new Error("must not write"); },
      pruneImportedSnapshot: async () => { throw new Error("must not write"); },
    };

    const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
    const r = await importProviderModels({
      provider: "capped-overrides",
      providerAlias: "capped-overrides",
      connectionId: "c1",
      discover: async () => ({ complete: true, models: [{ id: "m-new" }] }),
      repo: fakeRepo,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toMatch(/Capability overrides query reached safety cap/);
  });

  it("never deletes customModel when remainingActive query across connections is capped", async () => {
    let customDeleted = false;
    const fakeRepo = {
      listImportedModels: async ({ connectionId }) => {
        if (connectionId === "c1") {
          // connection 1 previously had model-to-remove and model-kept
          return [
            { modelId: "model-to-remove", lifecycle: "active", provenance: "imported" },
            { modelId: "model-kept", lifecycle: "active", provenance: "imported" },
          ];
        }
        // Remaining active query across all connections returns 50,000 records to trigger capped
        return Array.from({ length: 50000 }, (_, i) => ({
          modelId: `other-${i}`,
          lifecycle: "active",
          provenance: "imported",
        }));
      },
      listCapabilityOverrides: async () => [],
      getCustomModels: async () => [
        { id: "model-to-remove", providerAlias: "test-active-capped", source: "import" },
        { id: "model-kept", providerAlias: "test-active-capped", source: "import" },
      ],
      addCustomModel: async () => {},
      deleteCustomModel: async () => { customDeleted = true; },
      batchUpsertImportedModels: async () => {},
      pruneImportedSnapshot: async () => {},
    };

    const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
    const r = await importProviderModels({
      provider: "test-active-capped",
      providerAlias: "test-active-capped",
      connectionId: "c1",
      discover: async () => ({ complete: true, models: [{ id: "model-kept", name: "model-kept" }] }),
      repo: fakeRepo,
    });
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(["model-to-remove"]);
    // customModel must NOT have been deleted because remainingActive was capped!
    expect(customDeleted).toBe(false);
  });
});

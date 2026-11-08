import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  storageAliasFor,
  getModelSyncScheduler,
  startModelSyncScheduler,
  stopModelSyncScheduler,
} from "../../src/lib/models/providerSyncRuntime.js";
import { importProviderModels } from "../../src/lib/models/importOrchestrator.js";

const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
const originalRole = process.env.KHATAM_WORKER_ROLE;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-model-sync-runtime-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  global._dbAdapter = null;

  const { getAdapter } = await import("../../src/lib/db/driver.js");
  db = await getAdapter();
});

afterAll(() => {
  stopModelSyncScheduler();
  delete globalThis.__modelSyncScheduler;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
  if (originalRole === undefined) delete process.env.KHATAM_WORKER_ROLE;
  else process.env.KHATAM_WORKER_ROLE = originalRole;
  global._dbAdapter = null;
});

beforeEach(() => {
  delete globalThis.__modelSyncScheduler;
});

afterEach(() => {
  stopModelSyncScheduler();
  delete globalThis.__modelSyncScheduler;
});

describe("storageAliasFor mapping", () => {
  it("preserves exact id for compatible providers", () => {
    expect(storageAliasFor("openai-compatible-mygateway")).toBe("openai-compatible-mygateway");
    expect(storageAliasFor("anthropic-compatible-endpoint")).toBe("anthropic-compatible-endpoint");
  });

  it("resolves alias for standard providers", () => {
    expect(storageAliasFor("openai")).toBe("openai");
    expect(storageAliasFor("anthropic")).toBe("anthropic");
  });
});

describe("ModelSync runtime singleton lifecycle", () => {
  it("maintains a single instance on globalThis and stops cleanly", () => {
    delete process.env.KHATAM_WORKER_ROLE;
    const s1 = getModelSyncScheduler();
    const s2 = getModelSyncScheduler();
    expect(s1).toBe(s2);
    expect(globalThis.__modelSyncScheduler).toBe(s1);

    const startRes = startModelSyncScheduler();
    expect(startRes.started).toBe(true);

    stopModelSyncScheduler();
    expect(s1.getStatus().running).toBe(false);
  });

  it("follower role skips startup in runtime singleton", () => {
    process.env.KHATAM_WORKER_ROLE = "worker";
    const res = startModelSyncScheduler();
    expect(res.started).toBe(false);
    expect(res.reason).toBe("follower-skip");
  });
});

describe("Shared importOrchestrator signal check & hand-created model preservation", () => {
  it("aborts cleanly before write when signal is aborted after discovery", async () => {
    const abortCtrl = new AbortController();
    const mockRepo = {
      listImportedModels: vi.fn(async () => []),
      listCapabilityOverrides: vi.fn(async () => []),
      batchUpsertImportedModels: vi.fn(async () => {}),
      getCustomModels: vi.fn(async () => []),
      addCustomModel: vi.fn(async () => {}),
      deleteCustomModel: vi.fn(async () => {}),
      pruneImportedSnapshot: vi.fn(async () => {}),
    };

    const res = await importProviderModels({
      provider: "openai",
      providerAlias: "openai",
      connectionId: "conn-abort-test",
      signal: abortCtrl.signal,
      discover: async () => {
        // Abort right before reconcile/writes
        abortCtrl.abort();
        return { models: [{ id: "model-1", name: "Model 1" }] };
      },
      repo: mockRepo,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(499);
    expect(mockRepo.batchUpsertImportedModels).not.toHaveBeenCalled();
    expect(mockRepo.addCustomModel).not.toHaveBeenCalled();
  });

  it("preserves hand-added custom models when new models are imported", async () => {
    const customModels = [
      { id: "manual-model", providerAlias: "openai", source: "manual", name: "Manual Custom Model" },
    ];

    const mockRepo = {
      listImportedModels: vi.fn(async () => []),
      listCapabilityOverrides: vi.fn(async () => []),
      batchUpsertImportedModels: vi.fn(async () => {}),
      getCustomModels: vi.fn(async () => customModels),
      addCustomModel: vi.fn(async (m) => customModels.push(m)),
      deleteCustomModel: vi.fn(async () => {}),
      pruneImportedSnapshot: vi.fn(async () => {}),
    };

    const res = await importProviderModels({
      provider: "openai",
      providerAlias: "openai",
      connectionId: "conn-1",
      discover: async () => ({
        models: [
          { id: "manual-model", name: "Overwriting Manual Attempt" },
          { id: "auto-model", name: "Auto Model" },
        ],
      }),
      repo: mockRepo,
    });

    expect(res.ok).toBe(true);
    // manual-model must be preserved with its manual source
    const manual = customModels.find((m) => m.id === "manual-model");
    expect(manual.source).toBe("manual");
    expect(manual.name).toBe("Manual Custom Model");

    // auto-model was added with source import
    const auto = customModels.find((m) => m.id === "auto-model");
    expect(auto).toBeDefined();
    expect(auto.source).toBe("import");
  });
});

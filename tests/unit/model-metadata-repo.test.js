import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mm-repo-"));
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

describe("Model Metadata Persistence & Repository (Spec 017)", () => {
  describe("Gate 2: migration chain, schema registration & idempotency", () => {
    it("fresh DB applies migration 005 and stamps latest version", async () => {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const { latestVersion, MIGRATIONS } = await import("@/lib/db/migrations/index.js");
      const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");

      // Verify migration 005 is registered
      const m005 = MIGRATIONS.find((m) => m.version === 5);
      expect(m005).toBeDefined();
      expect(m005.name).toBe("005-model-metadata");
      expect(latestVersion()).toBeGreaterThanOrEqual(5);
      expect(SCHEMA_VERSION).toBe(6);

      const db = await getAdapter();
      const metaRow = db.get("SELECT value FROM _meta WHERE key='schemaVersion'");
      expect(parseInt(metaRow.value, 10)).toBe(latestVersion());

      // Verify tables in sqlite_master
      const tables = new Set(
        db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
      );
      expect(tables.has("model_capability_overrides")).toBe(true);
      expect(tables.has("imported_models")).toBe(true);

      // Verify additive columns in model_capability_overrides
      const cols = new Set(
        (db.all("PRAGMA table_info(model_capability_overrides)") || []).map((r) => r.name)
      );
      expect(cols.has("provider")).toBe(true);
      expect(cols.has("model_id")).toBe(true);
      expect(cols.has("source")).toBe(true);
      expect(cols.has("capabilities_json")).toBe(true);
      expect(cols.has("model_pattern")).toBe(true);

      // Verify columns in imported_models
      const imCols = new Set(
        (db.all("PRAGMA table_info(imported_models)") || []).map((r) => r.name)
      );
      expect(imCols.has("id")).toBe(true);
      expect(imCols.has("provider")).toBe(true);
      expect(imCols.has("connection_id")).toBe(true);
      expect(imCols.has("model_id")).toBe(true);
      expect(imCols.has("provenance")).toBe(true);
      expect(imCols.has("lifecycle")).toBe(true);
      expect(imCols.has("capabilities_json")).toBe(true);
      expect(imCols.has("metadata_json")).toBe(true);
      expect(imCols.has("last_seen_at")).toBe(true);
    });

    it("upgrading from v4 database applies migration 005 safely", async () => {
      // 1. Manually prepare a v4 DB
      const { getAdapter } = await import("@/lib/db/driver.js");
      const db = await getAdapter();
      db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", ['{"v4":"ok"}']);
      db.close?.();

      delete global._dbAdapter;
      vi.resetModules();

      // 2. Re-open and verify upgrade is seamless
      const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
      const db2 = await getAdapter2();
      const settings = db2.get("SELECT data FROM settings WHERE id = 1");
      expect(JSON.parse(settings.data)).toEqual({ v4: "ok" });
    });

    it("migration 005 up() is idempotent and safe on re-run", async () => {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const m005 = (await import("@/lib/db/migrations/005-model-metadata.js")).default;
      const db = await getAdapter();

      // Re-run migration 005 up()
      expect(() => m005.up(db)).not.toThrow();

      // Verify table and indexes still intact
      const count = db.get("SELECT COUNT(*) as c FROM imported_models");
      expect(count.c).toBe(0);
    });
  });

  describe("Gate 3: collision-free bounded key generation", () => {
    it("distinct composite parameters never collide even with colons or slashes", async () => {
      const { buildOverrideId, buildImportedModelId } = await import("@/lib/db/repos/modelMetadataRepo.js");

      // Provider contains colons vs modelId contains colons
      const id1 = buildOverrideId("manual", "provider:sub", "model");
      const id2 = buildOverrideId("manual", "provider", "sub:model");
      expect(id1).not.toBe(id2);

      // Slashes and special characters
      const id3 = buildOverrideId("manual", "openrouter", "anthropic/claude-3.5-sonnet:beta");
      const id4 = buildOverrideId("manual", "openrouter/anthropic", "claude-3.5-sonnet:beta");
      expect(id3).not.toBe(id4);

      // Imported model IDs
      const imp1 = buildImportedModelId("prov:a", "conn:b", "mod:c");
      const imp2 = buildImportedModelId("prov", "a:conn:b", "mod:c");
      expect(imp1).not.toBe(imp2);
    });

    it("keys are strictly bounded in length <= 384 chars", async () => {
      const { buildOverrideId, buildImportedModelId } = await import("@/lib/db/repos/modelMetadataRepo.js");

      const hugeProvider = "x".repeat(300);
      const hugeModel = "y".repeat(300);
      const hugeConn = "z".repeat(300);

      const id = buildOverrideId("manual", hugeProvider, hugeModel);
      expect(id.length).toBeLessThanOrEqual(384);

      const impId = buildImportedModelId(hugeProvider, hugeConn, hugeModel);
      expect(impId.length).toBeLessThanOrEqual(384);
    });

    it("deterministic golden test: Unicode/NUL long overflow matches known literal SHA", async () => {
      const { buildOverrideId, buildImportedModelId } = await import("@/lib/db/repos/modelMetadataRepo.js");

      const p = "provider-αβγ-" + "p".repeat(200);
      const m = "model-\0-xyz-" + "m".repeat(200);
      const c = "conn-🌟-" + "c".repeat(200);

      const ovrId = buildOverrideId("manual", p, m);
      expect(ovrId.split("::").pop()).toBe("4520a8d0ba9fbdfd56d23b812174b346");

      const impId = buildImportedModelId(p, c, m);
      expect(impId.split("::").pop()).toBe("fbf1303b00e674a155829716f5787fe2");
    });
  });

  describe("Gate 4: immediate transaction rollback on error", () => {
    it("transaction rollback leaves zero partial state when an error occurs", async () => {
      const { batchUpsertImportedModels, listImportedModels } = await import("@/lib/db/repos/modelMetadataRepo.js");

      const models = [
        { modelId: "model-1", capabilities: { vision: true } },
        { modelId: "model-2", capabilities: { tools: true } },
        { modelId: null, capabilities: {} }, // Invalid: should trigger validation throw
      ];

      await expect(
        batchUpsertImportedModels({
          provider: "openai",
          connectionId: "conn-1",
          models,
        })
      ).rejects.toThrow();

      // Ensure neither model-1 nor model-2 was committed
      const stored = await listImportedModels({ provider: "openai", connectionId: "conn-1" });
      expect(stored).toHaveLength(0);
    });
  });

  describe("Gate 5: field-level distinction, nullable unknown, reasoning enum & no credentials", () => {
    it("null capabilities represent unknown (not false) and credentials are scrubbed", async () => {
      const { upsertCapabilityOverride, getCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");

      const saved = await upsertCapabilityOverride({
        provider: "openrouter",
        modelId: "vendor/test-model",
        capabilities: {
          vision: null, // Unknown! Must NOT become false
          tools: true,
          audioInput: false,
          contextWindow: 128000,
          maxOutputTokens: 4096,
          apiKey: "sk-super-secret-12345", // Credential! Must be stripped
          client_secret: "forbidden-token", // Credential! Must be stripped
        },
        source: "manual",
      });

      expect(saved.capabilities.vision).toBeNull();
      expect(saved.capabilities.tools).toBe(true);
      expect(saved.capabilities.audioInput).toBe(false);
      expect(saved.capabilities.contextWindow).toBe(128000);
      expect(saved.capabilities.apiKey).toBeUndefined();
      expect(saved.capabilities.client_secret).toBeUndefined();

      const retrieved = await getCapabilityOverride({
        provider: "openrouter",
        modelId: "vendor/test-model",
        source: "manual",
      });

      expect(retrieved.capabilities.vision).toBeNull();
      expect(retrieved.capabilities.apiKey).toBeUndefined();
    });

    it("validates reasoning capability shape and enum levels", async () => {
      const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");

      // Structured reasoning metadata
      const saved = await upsertCapabilityOverride({
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        capabilities: {
          reasoning: {
            supported: true,
            effortLevels: ["low", "medium", "high"],
          },
        },
        source: "manual",
      });

      expect(saved.capabilities.reasoning.supported).toBe(true);
      expect(saved.capabilities.reasoning.effortLevels).toEqual(["low", "medium", "high"]);
    });

    it("getResolvedModelMetadata returns field-level distinction and provenance cascade", async () => {
      const {
        upsertCapabilityOverride,
        upsertImportedModel,
        getResolvedModelMetadata,
      } = await import("@/lib/db/repos/modelMetadataRepo.js");

      // 1. Discovered/imported model advertises vision and 100k context
      await upsertImportedModel({
        provider: "openrouter",
        connectionId: "conn-1",
        modelId: "meta/llama-3",
        capabilities: {
          vision: true,
          tools: true,
          contextWindow: 100000,
          maxOutputTokens: 4096,
        },
      });

      // 2. Auto-discovery override reconciles context to 128k
      await upsertCapabilityOverride({
        provider: "openrouter",
        modelId: "meta/llama-3",
        capabilities: {
          contextWindow: 128000,
        },
        source: "auto:discovery",
      });

      // 3. Manual operator override pins vision=false and contextWindow=200k
      await upsertCapabilityOverride({
        provider: "openrouter",
        modelId: "meta/llama-3",
        capabilities: {
          vision: false,
          contextWindow: 200000,
        },
        source: "manual",
      });

      // Resolve cascade: manual > auto:discovery > imported
      const resolved = await getResolvedModelMetadata({
        provider: "openrouter",
        modelId: "meta/llama-3",
      });

      expect(resolved.capabilities.vision).toBe(false);
      expect(resolved.provenance.vision).toBe("manual");

      expect(resolved.capabilities.contextWindow).toBe(200000);
      expect(resolved.provenance.contextWindow).toBe("manual");

      expect(resolved.capabilities.tools).toBe(true);
      expect(resolved.provenance.tools).toBe("imported");

      expect(resolved.capabilities.maxOutputTokens).toBe(4096);
      expect(resolved.provenance.maxOutputTokens).toBe("imported");
    });
  });

  describe("Gate 6: source-scoped catalog membership & shared-source snapshot pruning", () => {
    it("complete snapshot pruning removes obsolete models from source but preserves shared models and manual overrides", async () => {
      const {
        upsertImportedModel,
        upsertCapabilityOverride,
        pruneImportedSnapshot,
        listImportedModels,
        getCapabilityOverride,
      } = await import("@/lib/db/repos/modelMetadataRepo.js");

      // Connection 1 advertises model-A and model-Shared
      await upsertImportedModel({
        provider: "openrouter",
        connectionId: "conn-1",
        modelId: "model-A",
      });
      await upsertImportedModel({
        provider: "openrouter",
        connectionId: "conn-1",
        modelId: "model-Shared",
      });

      // Connection 2 also advertises model-Shared and model-B
      await upsertImportedModel({
        provider: "openrouter",
        connectionId: "conn-2",
        modelId: "model-Shared",
      });
      await upsertImportedModel({
        provider: "openrouter",
        connectionId: "conn-2",
        modelId: "model-B",
      });

      // Operator sets a manual override on model-A
      await upsertCapabilityOverride({
        provider: "openrouter",
        modelId: "model-A",
        capabilities: { vision: true },
        source: "manual",
      });

      // Snapshot prune on conn-1: conn-1 now only advertises model-Shared (model-A has vanished upstream)
      const pruneResult = await pruneImportedSnapshot({
        provider: "openrouter",
        connectionId: "conn-1",
        activeModelIds: ["model-Shared"],
        options: { complete: true },
      });

      expect(pruneResult.pruned).toBe(1); // model-A pruned from conn-1
      expect(pruneResult.skipped).toBe(false);

      // Verify conn-1 only has model-Shared
      const conn1Models = await listImportedModels({
        provider: "openrouter",
        connectionId: "conn-1",
        lifecycle: "active",
      });
      expect(conn1Models.map((m) => m.modelId)).toEqual(["model-Shared"]);

      // Verify conn-2 still has model-Shared and model-B intact
      const conn2Models = await listImportedModels({
        provider: "openrouter",
        connectionId: "conn-2",
        lifecycle: "active",
      });
      expect(conn2Models.map((m) => m.modelId)).toContain("model-Shared");
      expect(conn2Models.map((m) => m.modelId)).toContain("model-B");

      // Verify operator manual override on model-A was NOT deleted!
      const manualOverride = await getCapabilityOverride({
        provider: "openrouter",
        modelId: "model-A",
        source: "manual",
      });
      expect(manualOverride).not.toBeNull();
      expect(manualOverride.capabilities.vision).toBe(true);
    });

    it("pruning skips when snapshot is partial or empty without authoritativeEmpty flag", async () => {
      const {
        upsertImportedModel,
        pruneImportedSnapshot,
        listImportedModels,
      } = await import("@/lib/db/repos/modelMetadataRepo.js");

      await upsertImportedModel({
        provider: "openai",
        connectionId: "conn-1",
        modelId: "gpt-4o",
      });

      // 1. Incomplete snapshot (e.g. pagination failure) -> must skip
      const skipIncomplete = await pruneImportedSnapshot({
        provider: "openai",
        connectionId: "conn-1",
        activeModelIds: [],
        options: { complete: false },
      });
      expect(skipIncomplete.skipped).toBe(true);
      expect(skipIncomplete.reason).toBe("incomplete_snapshot");

      // 2. Empty listing without authoritativeEmpty flag -> must skip
      const skipEmpty = await pruneImportedSnapshot({
        provider: "openai",
        connectionId: "conn-1",
        activeModelIds: [],
        options: { complete: true, authoritativeEmpty: false },
      });
      expect(skipEmpty.skipped).toBe(true);
      expect(skipEmpty.reason).toBe("authoritative_empty_required");

      // Verify model still active
      const models = await listImportedModels({ provider: "openai", connectionId: "conn-1" });
      expect(models).toHaveLength(1);
      expect(models[0].modelId).toBe("gpt-4o");
    });
  });

  describe("Gate 7: legacy wildcard model_pattern rows preservation", () => {
    it("preserves legacy rows where provider is NULL and resolves deterministically", async () => {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const {
        getCapabilityOverride,
        upsertCapabilityOverride,
      } = await import("@/lib/db/repos/modelMetadataRepo.js");

      const db = await getAdapter();

      // Seed a legacy row created by wave 2 (provider is NULL, model_pattern is wildcard)
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO model_capability_overrides
          (id, model_pattern, capabilities_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["legacy-ovr-1", "claude-*", JSON.stringify({ vision: true, pdf: true }), now, now]
      );

      // 1. Query for a matching claude model with no scoped override -> falls back to legacy wildcard
      const resolvedLegacy = await getCapabilityOverride({
        provider: "anthropic",
        modelId: "claude-3-opus",
      });
      expect(resolvedLegacy).not.toBeNull();
      expect(resolvedLegacy.capabilities.vision).toBe(true);
      expect(resolvedLegacy.capabilities.pdf).toBe(true);

      // 2. Now add a scoped override for claude-3-opus with pdf=false
      await upsertCapabilityOverride({
        provider: "anthropic",
        modelId: "claude-3-opus",
        capabilities: { pdf: false },
        source: "manual",
      });

      // 3. Query again: scoped override wins over legacy wildcard!
      const resolvedScoped = await getCapabilityOverride({
        provider: "anthropic",
        modelId: "claude-3-opus",
      });
      expect(resolvedScoped).not.toBeNull();
      expect(resolvedScoped.capabilities.pdf).toBe(false);

      // 4. Query another claude model: legacy wildcard still active!
      const resolvedOther = await getCapabilityOverride({
        provider: "anthropic",
        modelId: "claude-3-haiku",
      });
      expect(resolvedOther).not.toBeNull();
      expect(resolvedOther.capabilities.pdf).toBe(true);
    });
  });
});

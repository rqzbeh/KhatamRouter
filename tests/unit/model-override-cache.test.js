import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cache-test-"));
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

describe("Model Override Cache (Spec 017)", () => {
  it("startup uninitialized DB returns ready: false without crashing", async () => {
    const { getOverrideSourcesSync, isOverrideCacheReady } = await import("@/lib/models/overrideCache.js");
    const sources = getOverrideSourcesSync();
    expect(sources.ready).toBe(false);
    expect(Array.isArray(sources.manualOverrides)).toBe(true);
    expect(Array.isArray(sources.autoOverrides)).toBe(true);
    expect(isOverrideCacheReady()).toBe(false);
  });

  it("async initializeOverrideCache loads DB snapshot and exposes ready: true", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const {
      upsertCapabilityOverride,
      upsertImportedModel,
    } = await import("@/lib/db/repos/modelMetadataRepo.js");

    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: { supportsVision: false, contextWindow: 128000 },
      source: "manual",
    });

    await upsertCapabilityOverride({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      capabilities: { contextWindow: 200000 },
      source: "auto:discovery",
    });

    await upsertImportedModel({
      provider: "openrouter",
      connectionId: "conn-1",
      modelId: "meta-llama/llama-3-70b",
      capabilities: { contextWindow: 8192, supportsTools: true },
    });

    const { initializeOverrideCache, getOverrideSourcesSync } = await import(
      "@/lib/models/overrideCache.js"
    );

    const snapshot = await initializeOverrideCache();
    expect(snapshot.ready).toBe(true);

    const sources = getOverrideSourcesSync();
    expect(sources.ready).toBe(true);

    // Verify manual override
    const manualGpt = sources.manualOverrides.find(
      (m) => m.provider === "openai" && m.modelId === "gpt-4o"
    );
    expect(manualGpt).toBeDefined();
    expect(manualGpt.supportsVision).toBe(false);
    expect(manualGpt.contextWindow).toBe(128000);
    expect(manualGpt.source).toBe("manual");

    // Verify auto override
    const autoClaude = sources.autoOverrides.find(
      (m) => m.provider === "anthropic" && m.modelId === "claude-3-5-sonnet"
    );
    expect(autoClaude).toBeDefined();
    expect(autoClaude.contextWindow).toBe(200000);
    expect(autoClaude.source).toBe("auto:discovery");

    // Verify active imported model is present in auto layer
    const importedLlama = sources.autoOverrides.find(
      (m) => m.provider === "openrouter" && m.modelId === "meta-llama/llama-3-70b"
    );
    expect(importedLlama).toBeDefined();
    expect(importedLlama.contextWindow).toBe(8192);
  });

  it("synchronous local write invalidates cache without stale window", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { initializeOverrideCache, getOverrideSourcesSync } = await import(
      "@/lib/models/overrideCache.js"
    );
    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");

    await initializeOverrideCache();
    let sources = getOverrideSourcesSync();
    expect(sources.manualOverrides.length).toBe(0);

    // Write a new manual override
    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: { supportsVision: false },
      source: "manual",
    });

    // Immediate synchronous read sees the change without waiting
    sources = getOverrideSourcesSync();
    expect(sources.manualOverrides.length).toBe(1);
    expect(sources.manualOverrides[0].modelId).toBe("gpt-4o");
    expect(sources.manualOverrides[0].supportsVision).toBe(false);
  });

  it("CONFIG_RELOAD cluster event invalidates cache across simulated replicas", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const { initializeOverrideCache, getOverrideSourcesSync } = await import(
      "@/lib/models/overrideCache.js"
    );
    const { publishKhatamEvent, KHATAM_EVENTS } = await import("@/lib/redis/events.js");

    await initializeOverrideCache();
    const initialSources = getOverrideSourcesSync();
    const initialGen = initialSources.generation;

    // Direct DB mutation without repo wrapper (simulating another worker/replica write)
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO model_capability_overrides (id, model_pattern, provider, model_id, source, capabilities_json, created_at, updated_at)
       VALUES ('replica-ovr', 'test-model', 'openai', 'test-model', 'manual', '{"supportsVision":true}', ?, ?)`,
      [now, now]
    );

    // Before event: cache is clean and has initial generation
    expect(getOverrideSourcesSync().generation).toBe(initialGen);

    // Publish CONFIG_RELOAD event with settings scope
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { scope: "settings", timestamp: Date.now() });

    // Next sync read picks up the new generation and loads the row
    const reloaded = getOverrideSourcesSync();
    expect(reloaded.generation).toBeGreaterThan(initialGen);
    const found = reloaded.manualOverrides.find((m) => m.modelId === "test-model");
    expect(found).toBeDefined();
    expect(found.supportsVision).toBe(true);
  });

  it("never stores raw credentials or secrets in snapshot", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");
    const { initializeOverrideCache, getOverrideSourcesSync } = await import(
      "@/lib/models/overrideCache.js"
    );

    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: {
        supportsVision: true,
        apiKey: "sk-secret-token-12345",
        authorization: "Bearer secret",
        client_secret: "shhh",
      },
      source: "manual",
    });

    await initializeOverrideCache();
    const sources = getOverrideSourcesSync();
    const item = sources.manualOverrides.find((m) => m.modelId === "gpt-4o");

    expect(item.apiKey).toBeUndefined();
    expect(item.authorization).toBeUndefined();
    expect(item.client_secret).toBeUndefined();
    expect(JSON.stringify(sources)).not.toContain("sk-secret-token-12345");
  });

  it("fail-closed on 50k bound breach, retaining previous good snapshot", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const { initializeOverrideCache, getOverrideSourcesSync } = await import(
      "@/lib/models/overrideCache.js"
    );

    // Initial valid state with 1 row
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO model_capability_overrides (id, model_pattern, provider, model_id, source, capabilities_json, created_at, updated_at)
       VALUES ('good-row', 'gpt-good', 'openai', 'gpt-good', 'manual', '{"supportsVision":true}', ?, ?)`,
      [now, now]
    );

    const initial = await initializeOverrideCache();
    expect(initial.ready).toBe(true);
    expect(initial.manualOverrides.length).toBe(1);

    // Simulate exceeding the 50k cap using transaction to batch insert
    const insertStmt = db.prepare(
      `INSERT INTO model_capability_overrides (id, model_pattern, provider, model_id, source, capabilities_json, created_at, updated_at)
       VALUES (?, ?, 'openai', ?, 'manual', '{"supportsVision":true}', ?, ?)`
    );

    db.immediate(() => {
      for (let i = 0; i < 50005; i++) {
        insertStmt.run(`bulk-${i}`, `gpt-${i}`, `gpt-${i}`, now, now);
      }
    });

    // Invalidate and attempt sync reload: bound is breached, must retain previous good snapshot
    const { invalidateOverrideCache } = await import("@/lib/models/overrideCache.js");
    invalidateOverrideCache();

    const postBreach = getOverrideSourcesSync();
    // Retains previous good snapshot (length 1), does not crash or expose unverified partial state
    expect(postBreach.ready).toBe(true);
    expect(postBreach.manualOverrides.length).toBe(1);
    expect(postBreach.manualOverrides[0].modelId).toBe("gpt-good");
  });
});

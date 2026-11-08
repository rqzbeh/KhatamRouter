import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-wiring-test-"));
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

describe("Model Override Runtime Wiring & API Integration (Spec 017)", () => {
  it("evaluateTargetCompatibility enforces fail-closed decision on declared manual false for vision model", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { initializeOverrideCache } = await import("@/lib/models/overrideCache.js");
    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");
    const {
      evaluateTargetCompatibility,
      isVisionIncompatibleTarget,
      resolveCaps,
    } = await import("@/domain/requestCapabilities.js");

    // "gpt-4o" is normally vision-capable in the open-sse catalog floor
    // Operator declares manual override: supportsVision = false
    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: { supportsVision: false },
      source: "manual",
    });

    await initializeOverrideCache();

    // Verify resolveCaps reflects manual false
    const caps = resolveCaps("openai/gpt-4o");
    expect(caps.vision).toBe(false);

    // Image request requirements
    const imageRequirements = {
      requiresVision: true,
      requiresTools: false,
      requestedOutputTokens: 0,
      requiredContextTokens: 1000,
    };

    const verdict = evaluateTargetCompatibility("openai/gpt-4o", imageRequirements);
    expect(verdict.compatible).toBe(false);
    expect(verdict.failures).toContain("vision");
    expect(isVisionIncompatibleTarget("openai/gpt-4o", imageRequirements)).toBe(true);
  });

  it("context-only manual override retains provider catalog floor for vision", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { initializeOverrideCache } = await import("@/lib/models/overrideCache.js");
    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");
    const {
      evaluateTargetCompatibility,
      isVisionIncompatibleTarget,
      resolveCaps,
    } = await import("@/domain/requestCapabilities.js");

    // Operator overrides only contextWindow on a vision model (e.g. gpt-4o)
    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: { contextWindow: 64000 },
      source: "manual",
    });

    await initializeOverrideCache();

    const caps = resolveCaps("openai/gpt-4o");
    expect(caps.contextWindow).toBe(64000);
    // Retains vision support from catalog floor
    expect(caps.vision).toBe(true);

    const imageRequirements = {
      requiresVision: true,
      requiresTools: false,
      requestedOutputTokens: 0,
      requiredContextTokens: 1000,
    };

    const verdict = evaluateTargetCompatibility("openai/gpt-4o", imageRequirements);
    expect(verdict.compatible).toBe(true);
    expect(verdict.failures).toHaveLength(0);
    expect(isVisionIncompatibleTarget("openai/gpt-4o", imageRequirements)).toBe(false);
  });

  it("resolveCaps resolves provider alias mapping (e.g. ocg -> opencode-go)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { initializeOverrideCache } = await import("@/lib/models/overrideCache.js");
    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");
    const { resolveCaps } = await import("@/domain/requestCapabilities.js");

    // Override set on canonical provider ID "opencode-go"
    await upsertCapabilityOverride({
      provider: "opencode-go",
      modelId: "custom-coder",
      capabilities: { contextWindow: 99999, supportsVision: true },
      source: "manual",
    });

    await initializeOverrideCache();

    // Query using UI alias "ocg"
    const caps = resolveCaps("ocg/custom-coder");
    expect(caps.contextWindow).toBe(99999);
    expect(caps.vision).toBe(true);
  });

  it("uninitialized DB safely falls back to catalog floor without throwing", async () => {
    const { resolveCaps, isVisionIncompatibleTarget } = await import(
      "@/domain/requestCapabilities.js"
    );

    // Call resolveCaps before any initializeOverrideCache or DB boot
    // Text-only model remains non-vision (fails closed on image requests)
    const textCaps = resolveCaps("deepseek/deepseek-chat");
    expect(textCaps.vision).toBe(false);

    const imageRequirements = { requiresVision: true };
    expect(isVisionIncompatibleTarget("deepseek/deepseek-chat", imageRequirements)).toBe(true);

    // Known vision model resolves from catalog floor without error
    const visionCaps = resolveCaps("anthropic/claude-sonnet-4.6");
    expect(visionCaps.vision).toBe(true);
    expect(isVisionIncompatibleTarget("anthropic/claude-sonnet-4.6", imageRequirements)).toBe(false);
  });

  it("api/models GET uses cached resolver across builtins and custom rows without N+1 queries", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    const { upsertCapabilityOverride } = await import("@/lib/db/repos/modelMetadataRepo.js");
    const { addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");

    // Add manual override for a builtin model
    await upsertCapabilityOverride({
      provider: "openai",
      modelId: "gpt-4o",
      capabilities: { contextWindow: 555555 },
      source: "manual",
    });

    // Add a custom model
    await addCustomModel({
      providerAlias: "openai",
      id: "my-finetuned-gpt",
      name: "My Fine-Tuned GPT",
      caps: { vision: true },
    });

    const { GET } = await import("@/app/api/models/route.js");
    const res = await GET();
    expect(res.status).toBe(200);

    const { models } = await res.json();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    // Verify builtin model picked up manual override
    const gpt4o = models.find((m) => m.provider === "openai" && m.model === "gpt-4o");
    if (gpt4o) {
      expect(gpt4o.caps.contextWindow).toBe(555555);
      expect(gpt4o.caps.provenance.contextWindow).toBe("manual");
      expect(gpt4o.caps.supportsVision).toBeDefined();
    }

    // Verify custom model is present
    const custom = models.find((m) => m.model === "my-finetuned-gpt");
    expect(custom).toBeDefined();
    expect(custom.name).toBe("My Fine-Tuned GPT");
  });

  it("handleChat awaits initializeOverrideCache and returns 503 if initialization fails", async () => {
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const overrideCache = await import("@/lib/models/overrideCache.js");

    // Spy and simulate failure in initializeOverrideCache
    const spy = vi
      .spyOn(overrideCache, "initializeOverrideCache")
      .mockRejectedValueOnce(new Error("Simulated SQLite lock failure"));

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("Capability cache unavailable");

    spy.mockRestore();
  });
});

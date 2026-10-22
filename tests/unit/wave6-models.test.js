// Wave 6 — Live Model Discovery, Capability Resolution & Fail-Closed Combo Routing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  normalizeDiscoveredModels,
  detectVisionInput,
  detectToolsSupport,
  detectReasoningSupport,
  detectSupportedThinkingEfforts,
  detectDefaultThinkingEffort,
  extractContextWindow,
  extractMaxOutputTokens,
  firstPositiveNumber,
} from "@/lib/models/discovery.js";
import { resolveModelCapabilities } from "@/lib/models/capabilities.js";
import {
  reconcileContextWindows,
  runDatabaseContextReconcile,
} from "@/lib/models/contextReconciler.js";
import {
  deriveRequestRequirements,
  evaluateTargetCompatibility,
  isVisionIncompatibleTarget,
  filterCompatibleComboTargets,
  isCapabilityGuardEnabled,
} from "@/domain/requestCapabilities.js";
import { handleComboChat } from "open-sse/services/combo.js";

// ─── 1. Defensive Normalisation Across 4 Real Payload Shapes ───────────────────
describe("Wave 6 Discovery: Defensive Normalisation (Never Throws)", () => {
  it("Shape 1: Standard OpenAI /v1/models payload", () => {
    const openAiPayload = {
      object: "list",
      data: [
        {
          id: "gpt-4o",
          object: "model",
          created: 1715368132,
          owned_by: "system",
        },
        {
          id: "gpt-4o-mini",
          object: "model",
          created: 1721172741,
          owned_by: "system",
        },
      ],
    };

    const models = normalizeDiscoveredModels(openAiPayload);
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4o");
    expect(models[0].name).toBe("gpt-4o");
    expect(models[0].supportsStreaming).toBe(true);
    expect(models[1].id).toBe("gpt-4o-mini");
  });

  it("Shape 2: OpenRouter architecture modality and nested top_provider payload", () => {
    const openRouterPayload = {
      data: [
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Anthropic: Claude 3.5 Sonnet",
          context_length: 200000,
          architecture: {
            modality: "text+image->text",
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          top_provider: {
            context_length: 200000,
            max_completion_tokens: 8192,
          },
          reasoning: {
            supported_efforts: ["low", "medium", "high", "extra"],
            default_effort: "medium",
          },
        },
      ],
    };

    const models = normalizeDiscoveredModels(openRouterPayload);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe("anthropic/claude-3.5-sonnet");
    expect(m.name).toBe("Anthropic: Claude 3.5 Sonnet");
    expect(m.contextWindow).toBe(200000);
    expect(m.maxOutputTokens).toBe(8192);
    expect(m.supportsVision).toBe(true);
    expect(m.modalities).toContain("image");
    expect(m.supportsReasoning).toBe(true);
    // Synonyms normalized: "extra" -> "xhigh"
    expect(m.supportedThinkingEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(m.defaultThinkingEffort).toBe("medium");
  });

  it("Shape 3: Lemonade Server / CLIProxy labels array and reasoning levels", () => {
    const lemonadePayload = {
      data: [
        {
          id: "lemonade-codex-1",
          name: "Codex Agent 1",
          labels: ["chat", "vision", "reasoning", "tool-calling"],
          context_window: 131072,
          max_output_tokens: 4096,
          supported_reasoning_levels: ["low", "high"],
        },
      ],
    };

    const models = normalizeDiscoveredModels(lemonadePayload);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe("lemonade-codex-1");
    expect(m.supportsVision).toBe(true);
    expect(m.supportsTools).toBe(true);
    expect(m.supportsReasoning).toBe(true);
    expect(m.contextWindow).toBe(131072);
    expect(m.maxOutputTokens).toBe(4096);
    expect(m.supportedThinkingEfforts).toEqual(["low", "high"]);
  });

  it("Shape 4: Ollama / Vertex native models array with details and capabilities", () => {
    const ollamaPayload = {
      models: [
        {
          name: "llama3.2-vision:11b",
          details: { family: "llama", parameter_size: "11B" },
          capabilities: ["tools", "vision"],
          context_length: 128000,
        },
      ],
    };

    const models = normalizeDiscoveredModels(ollamaPayload);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe("llama3.2-vision:11b");
    expect(m.supportsVision).toBe(true);
    expect(m.supportsTools).toBe(true);
    expect(m.contextWindow).toBe(128000);
  });

  it("Adversarial and malformed inputs never throw", () => {
    expect(normalizeDiscoveredModels(null)).toEqual([]);
    expect(normalizeDiscoveredModels(undefined)).toEqual([]);
    expect(normalizeDiscoveredModels("not-json")).toEqual([]);
    expect(normalizeDiscoveredModels(42)).toEqual([]);
    expect(normalizeDiscoveredModels({})).toEqual([]);
    expect(normalizeDiscoveredModels({ data: null })).toEqual([]);
    expect(normalizeDiscoveredModels({ data: [null, undefined, 123, "string", {}, { id: "" }] })).toEqual([]);

    // Helper functions never throw
    expect(detectVisionInput(null)).toBe(false);
    expect(detectToolsSupport(undefined)).toBe(false);
    expect(detectReasoningSupport("bad")).toBe(false);
    expect(detectSupportedThinkingEfforts(123)).toBeUndefined();
    expect(detectDefaultThinkingEffort(null)).toBeUndefined();
    expect(extractContextWindow(null)).toBeNull();
    expect(extractMaxOutputTokens(null)).toBeNull();
    expect(firstPositiveNumber(null, -5, "abc", 100)).toBe(100);
  });
});

// ─── 2. Capability Precedence Cascade as a Pure Function ───────────────────────
describe("Wave 6 Capabilities: Pure Function Precedence Cascade", () => {
  it("Manual pin (Layer 1) beats auto:discovery (Layer 2) and catalog", () => {
    const sources = {
      manualOverrides: new Map([
        ["anthropic/claude-3-opus", { contextWindow: 500000, supportsVision: true }],
      ]),
      autoOverrides: new Map([
        ["anthropic/claude-3-opus", { contextWindow: 250000, supportsVision: false }],
      ]),
      providerOverrides: {
        anthropic: { "claude-3-opus": { contextWindow: 200000 } },
      },
      defaultCapabilities: { contextWindow: 128000, maxOutput: 4096, tools: true },
    };

    const res = resolveModelCapabilities(
      { provider: "anthropic", model: "claude-3-opus" },
      sources
    );
    expect(res.contextWindow).toBe(500000);
    expect(res.supportsVision).toBe(true);
    expect(res.source).toBe("manual");
  });

  it("Auto:discovery override (Layer 2) beats provider table (Layer 3) and canonical model", () => {
    const sources = {
      autoOverrides: new Map([
        ["openrouter/custom-gemini", { contextWindow: 2000000, supportsVision: true }],
      ]),
      providerOverrides: {
        openrouter: { "custom-gemini": { contextWindow: 1000000, supportsVision: false } },
      },
      defaultCapabilities: { contextWindow: 128000, maxOutput: 4096, tools: true },
    };

    const res = resolveModelCapabilities(
      { provider: "openrouter", model: "custom-gemini" },
      sources
    );
    expect(res.contextWindow).toBe(2000000);
    expect(res.supportsVision).toBe(true);
    expect(res.source).toBe("auto:discovery");
  });

  it("Provider override (Layer 3) beats canonical and pattern capabilities", () => {
    const sources = {
      providerOverrides: {
        copilot: { "claude-sonnet-4-6": { contextWindow: 128000, maxOutput: 32000 } },
      },
      modelCapabilities: {
        "claude-sonnet-4-6": { contextWindow: 200000, maxOutput: 64000 },
      },
      defaultCapabilities: { contextWindow: 128000, maxOutput: 4096, tools: true },
    };

    const res = resolveModelCapabilities(
      { provider: "copilot", model: "claude-sonnet-4-6" },
      sources
    );
    expect(res.contextWindow).toBe(128000);
    expect(res.maxOutputTokens).toBe(32000);
    expect(res.source).toBe("provider");
  });

  it("persistedOverrides: false flag bypasses manual and auto pins for reconciler baseline", () => {
    const sources = {
      manualOverrides: new Map([
        ["vllm/llama-3", { contextWindow: 256000 }],
      ]),
      autoOverrides: new Map([
        ["vllm/llama-3", { contextWindow: 200000 }],
      ]),
      patternCapabilities: [
        { pattern: "*llama-3*", caps: { contextWindow: 131072, tools: true } },
      ],
      defaultCapabilities: { contextWindow: 128000, maxOutput: 4096, tools: true },
    };

    // With persistedOverrides: false, manual & auto overrides are bypassed
    const res = resolveModelCapabilities(
      { provider: "vllm", model: "llama-3" },
      sources,
      { persistedOverrides: false }
    );
    expect(res.contextWindow).toBe(131072);
    expect(res.source).toBe("pattern");
  });

  it("Pattern match (Layer 6) beats safe floor (Layer 7)", () => {
    const sources = {
      patternCapabilities: [
        { pattern: "*custom-agent*", caps: { contextWindow: 65536, supportsTools: true, reasoning: true } },
      ],
      defaultCapabilities: { contextWindow: 32768, maxOutput: 2048, tools: false },
    };

    const res = resolveModelCapabilities(
      { provider: "custom", model: "my-custom-agent-v1" },
      sources
    );
    expect(res.contextWindow).toBe(65536);
    expect(res.supportsTools).toBe(true);
    expect(res.supportsReasoning).toBe(true);
    expect(res.source).toBe("pattern");
  });
});

// ─── 3. Self-Correcting Context Reconciler with Manual Pin Protection ─────────
describe("Wave 6 Reconciler: Self-Correcting Context Reconciler", () => {
  it("Discovered divergence writes auto:discovery override", () => {
    const written = [];
    const deps = {
      getCatalogWindow: (provider, modelId) => 128000,
      getExistingSource: (provider, modelId) => null,
      writeAuto: (provider, modelId, window) => {
        written.push({ provider, modelId, window });
      },
      removeOverride: vi.fn(),
    };

    const discovered = [
      { provider: "vllm", modelId: "deepseek-coder", contextWindow: 256000 },
    ];

    const result = reconcileContextWindows(discovered, deps);
    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);
    expect(result.skippedManual).toBe(0);
    expect(result.removed).toBe(0);
    expect(written).toEqual([
      { provider: "vllm", modelId: "deepseek-coder", window: 256000 },
    ]);
  });

  it("NEVER clobbers or overwrites an operator's manual pin", () => {
    const written = [];
    const removed = [];
    const deps = {
      getCatalogWindow: () => 128000,
      getExistingSource: (provider, modelId) => "manual",
      writeAuto: (provider, modelId, window) => written.push({ provider, modelId, window }),
      removeOverride: (provider, modelId) => removed.push({ provider, modelId }),
    };

    const discovered = [
      { provider: "openai", modelId: "gpt-4o", contextWindow: 200000 },
    ];

    const result = reconcileContextWindows(discovered, deps);
    expect(result.scanned).toBe(1);
    expect(result.skippedManual).toBe(1);
    expect(result.written).toBe(0);
    expect(result.removed).toBe(0);
    expect(written).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it("Prunes redundant auto:discovery override when catalog catches up", () => {
    const removed = [];
    const deps = {
      getCatalogWindow: () => 200000, // Catalog updated to 200k
      getExistingSource: () => "auto:discovery",
      writeAuto: vi.fn(),
      removeOverride: (provider, modelId) => removed.push({ provider, modelId }),
    };

    const discovered = [
      { provider: "anthropic", modelId: "claude-sonnet-4-6", contextWindow: 200000 },
    ];

    const result = reconcileContextWindows(discovered, deps);
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.written).toBe(0);
    expect(removed).toEqual([{ provider: "anthropic", modelId: "claude-sonnet-4-6" }]);
  });

  it("Invalid or non-positive window drops stale auto:discovery pin", () => {
    const removed = [];
    const deps = {
      getCatalogWindow: () => 128000,
      getExistingSource: () => "auto:discovery",
      writeAuto: vi.fn(),
      removeOverride: (provider, modelId) => removed.push({ provider, modelId }),
    };

    const discovered = [
      { provider: "grok-cli", modelId: "grok-beta", contextWindow: -1 },
    ];

    const result = reconcileContextWindows(discovered, deps);
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(removed).toEqual([{ provider: "grok-cli", modelId: "grok-beta" }]);
  });
});

// ─── 4. Request Capability Derivation ──────────────────────────────────────────
describe("Wave 6 Requirements: Request Modality and Resource Derivation", () => {
  it("OpenAI image_url in user message triggers requiresVision", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture?" },
            { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
          ],
        },
      ],
      max_tokens: 1000,
    };

    const reqs = deriveRequestRequirements(body);
    expect(reqs.requiresVision).toBe(true);
    expect(reqs.requiresTools).toBe(false);
    expect(reqs.requestedOutputTokens).toBe(1000);
    expect(reqs.estimatedInputTokens).toBeGreaterThan(0);
    expect(reqs.requiredContextTokens).toBe(reqs.estimatedInputTokens + 1000);
  });

  it("Gemini inlineData image trigger requiresVision", () => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
          ],
        },
      ],
    };

    const reqs = deriveRequestRequirements(body);
    expect(reqs.requiresVision).toBe(true);
  });

  it("Responses API input_image triggers requiresVision", () => {
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/jpeg;base64,abc" }],
        },
      ],
    };

    const reqs = deriveRequestRequirements(body);
    expect(reqs.requiresVision).toBe(true);
  });

  it("Tools declaration triggers requiresTools", () => {
    const body = {
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "ls" } }],
    };

    const reqs = deriveRequestRequirements(body);
    expect(reqs.requiresTools).toBe(true);
    expect(reqs.requiresVision).toBe(false);
  });

  it("Reasoning effort triggers requiresReasoning", () => {
    const body = {
      messages: [{ role: "user", content: "solve equation" }],
      reasoning_effort: "high",
    };

    const reqs = deriveRequestRequirements(body);
    expect(reqs.requiresReasoning).toBe(true);
  });
});

// ─── 5. Fail-Closed Combo Gating Proof ─────────────────────────────────────────
describe("Wave 6 Combo: Fail-Closed Capability Gating Proof", () => {
  it("isVisionIncompatibleTarget accurately identifies text-only targets", () => {
    const reqs = { requiresVision: true };
    // deepseek-chat is text-only (vision: false)
    expect(isVisionIncompatibleTarget("deepseek/deepseek-chat", reqs)).toBe(true);
    // claude-sonnet-4.6 supports vision
    expect(isVisionIncompatibleTarget("anthropic/claude-sonnet-4.6", reqs)).toBe(false);
  });

  it("filterCompatibleComboTargets fails closed when all targets lack vision", () => {
    const targets = ["deepseek/deepseek-chat", "openai/gpt-3.5-turbo"];
    const reqs = { requiresVision: true };

    const gate = filterCompatibleComboTargets(targets, reqs, { comboName: "text-only-combo" });
    expect(gate.failClosed).toBe(true);
    expect(gate.kept).toHaveLength(0);
    expect(gate.rejected).toHaveLength(2);
    expect(gate.error).toContain("No target in combo text-only-combo has confirmed vision support");
  });

  it("filterCompatibleComboTargets prunes text-only models and keeps vision-capable ones", () => {
    const targets = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    const reqs = { requiresVision: true };

    const gate = filterCompatibleComboTargets(targets, reqs, { comboName: "mixed-combo" });
    expect(gate.failClosed).toBe(false);
    expect(gate.kept).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(gate.rejected).toHaveLength(1);
    expect(gate.rejected[0].model).toBe("deepseek/deepseek-chat");
  });

  it("handleComboChat fails closed on image request against text-only combo (0 calls to upstream)", async () => {
    const imageBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Explain this diagram" },
            { type: "image_url", image_url: { url: "https://example.com/diagram.png" } },
          ],
        },
      ],
    };

    const singleModelSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const response = await handleComboChat({
      body: imageBody,
      models: ["deepseek/deepseek-chat", "openai/gpt-3.5-turbo"],
      handleSingleModel: singleModelSpy,
      log: logSpy,
      comboName: "text-only-combo",
      capabilityGuard: true, // explicit opt-in
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("vision_unsupported");
    expect(body.error.message).toContain("No target in combo text-only-combo has confirmed vision support");

    // PROOF: ZERO calls to upstream text-only models!
    expect(singleModelSpy).toHaveBeenCalledTimes(0);
  });

  it("handleComboChat prunes text-only model and routes ONLY to vision-capable target", async () => {
    const imageBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the chart" },
            { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
          ],
        },
      ],
    };

    const attemptedModels = [];
    const singleModelSpy = vi.fn().mockImplementation(async (body, modelStr) => {
      attemptedModels.push(modelStr);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Chart shows growth" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const response = await handleComboChat({
      body: imageBody,
      models: ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"],
      handleSingleModel: singleModelSpy,
      log: logSpy,
      comboName: "hybrid-combo",
      capabilityGuard: true,
    });

    expect(response.status).toBe(200);
    // Dispatched ONLY to vision-capable claude-sonnet-4.6; deepseek-chat was never touched!
    expect(attemptedModels).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(singleModelSpy).toHaveBeenCalledTimes(1);
  });

  it("handleComboChat retains normal fallback order for text-only request", async () => {
    const textBody = {
      messages: [{ role: "user", content: "Tell me a short joke" }],
    };

    const attemptedModels = [];
    const singleModelSpy = vi.fn().mockImplementation(async (body, modelStr) => {
      attemptedModels.push(modelStr);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Joke response" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const response = await handleComboChat({
      body: textBody,
      models: ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"],
      handleSingleModel: singleModelSpy,
      log: logSpy,
      comboName: "hybrid-combo",
      capabilityGuard: true,
    });

    expect(response.status).toBe(200);
    // Primary model is deepseek-chat for text-only
    expect(attemptedModels[0]).toBe("deepseek/deepseek-chat");
  });

  it("isCapabilityGuardEnabled obeys environment variable", () => {
    expect(isCapabilityGuardEnabled({})).toBe(false);
    expect(isCapabilityGuardEnabled({ KHATAM_MODEL_CAPABILITY_GUARD: "0" })).toBe(false);
    expect(isCapabilityGuardEnabled({ KHATAM_MODEL_CAPABILITY_GUARD: "false" })).toBe(false);
    expect(isCapabilityGuardEnabled({ KHATAM_MODEL_CAPABILITY_GUARD: "1" })).toBe(true);
    expect(isCapabilityGuardEnabled({ KHATAM_MODEL_CAPABILITY_GUARD: "true" })).toBe(true);
  });
});

// ─── 6. Database Integration & Schema Consistency ─────────────────────────────
describe("Wave 6 Database: Migration 004 & Reconciler DB Execution", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;
  const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-wave6-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.DATA_DIR_ALLOW_TEMP = "1";
    delete global._dbAdapter;
    vi.resetModules();
  });

  afterEach(() => {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
    else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
  });

  it("Migration 004 records version 4 and adds provider, model_id, source columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const mcoCols = new Set(
      (db.all("PRAGMA table_info(model_context_overrides)") || []).map((r) => r.name)
    );
    expect(mcoCols.has("provider")).toBe(true);
    expect(mcoCols.has("model_id")).toBe(true);
    expect(mcoCols.has("source")).toBe(true);

    const mcCols = new Set(
      (db.all("PRAGMA table_info(model_capabilities)") || []).map((r) => r.name)
    );
    expect(mcCols.has("source")).toBe(true);

    const rows = db.all("SELECT version FROM _khatam_migrations ORDER BY CAST(version AS INTEGER) ASC");
    const versions = rows.map((r) => String(r.version));
    expect(versions).toContain("1");
    expect(versions).toContain("2");
    expect(versions).toContain("3");
    expect(versions).toContain("4");
  });

  it("runDatabaseContextReconcile writes auto:discovery rows and protects manual rows in DB", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // Seed a manual override
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO model_context_overrides (id, model_pattern, provider, model_id, context_window, source, created_at, updated_at)
       VALUES ('manual-1', 'claude-opus-4-6', 'anthropic', 'claude-opus-4-6', 1000000, 'manual', ?, ?)`,
      [now, now]
    );

    const discovered = [
      // 1. Diverges from catalog (catalog is 200k, discovered is 300k)
      { provider: "openai", modelId: "gpt-4o", contextWindow: 300000 },
      // 2. Manual pin (should NOT be overwritten even though discovered says 200k)
      { provider: "anthropic", modelId: "claude-opus-4-6", contextWindow: 200000 },
    ];

    const result = await runDatabaseContextReconcile(db, discovered, (prov, mod) => 200000);
    expect(result.scanned).toBe(2);
    expect(result.written).toBe(1);
    expect(result.skippedManual).toBe(1);

    // Verify auto row written
    const autoRow = db.get(
      "SELECT * FROM model_context_overrides WHERE provider = 'openai' AND model_id = 'gpt-4o'"
    );
    expect(autoRow).toBeTruthy();
    expect(autoRow.context_window).toBe(300000);
    expect(autoRow.source).toBe("auto:discovery");

    // Verify manual row untouched
    const manualRow = db.get(
      "SELECT * FROM model_context_overrides WHERE provider = 'anthropic' AND model_id = 'claude-opus-4-6'"
    );
    expect(manualRow.context_window).toBe(1000000);
    expect(manualRow.source).toBe("manual");
  });
});

import { describe, it, expect, vi } from "vitest";
import { normalizeDiscoveredModels } from "@/lib/models/discovery.js";
import { reconcileContextWindows } from "@/lib/models/contextReconciler.js";
import { resolveModelCapabilities } from "@/lib/models/capabilities.js";

describe("US7 Scenario 8: Model Discovery & Context Reconciler Pipeline", () => {
  it("preserves providerIdOrOptions argument in normalizeDiscoveredModels", () => {
    const rawOpenAiResponse = {
      object: "list",
      data: [
        {
          id: "custom-deepseek-v3",
          context_length: 64000,
          max_output_tokens: 4096,
          supports_vision: false,
        },
      ],
    };

    // Call normalizeDiscoveredModels with providerId
    const models = normalizeDiscoveredModels(rawOpenAiResponse, "openrouter");
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("custom-deepseek-v3");
    // Must NOT drop providerId!
    expect(models[0].provider).toBe("openrouter");
    expect(models[0].contextWindow).toBe(64000);
  });

  it("feeds discovered models into reconcileContextWindows and updates auto:discovery overrides", () => {
    const discovered = normalizeDiscoveredModels(
      [
        {
          id: "llama-3-8b",
          context_window: 131072,
        },
      ],
      "groq"
    );

    const writtenOverrides = new Map();
    const mockDeps = {
      getCatalogWindow: (provider, modelId) => 8192, // Catalog says 8k, discovered is 128k
      getExistingSource: (provider, modelId) => null,
      writeAuto: (provider, modelId, window) => {
        writtenOverrides.set(`${provider}/${modelId}`, { window, source: "auto:discovery" });
      },
      removeOverride: vi.fn(),
    };

    const result = reconcileContextWindows(discovered, mockDeps);
    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);

    expect(writtenOverrides.get("groq/llama-3-8b")).toEqual({
      window: 131072,
      source: "auto:discovery",
    });
  });

  it("cascades auto:discovery contextWindow into request-time resolveModelCapabilities", () => {
    const autoOverrides = new Map([
      ["groq/llama-3-8b", { contextWindow: 131072, source: "auto:discovery" }],
    ]);

    const resolved = resolveModelCapabilities(
      { provider: "groq", model: "llama-3-8b" },
      { autoOverrides }
    );

    expect(resolved.contextWindow).toBe(131072);
  });
});

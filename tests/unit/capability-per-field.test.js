import { describe, expect, it } from "vitest";
import {
  findOverride,
  normalizeModelIds,
  resolveModelCapabilities,
} from "../../src/lib/models/capabilities.js";

const FLOOR = {
  vision: false,
  tools: false,
  reasoning: false,
  contextWindow: 4096,
  maxOutput: 1024,
  audioInput: false,
  videoInput: false,
  supportsStreaming: true,
};

describe("Spec 017 T031/T032: Per-Field Capability Precedence Cascade", () => {
  describe("1. One-field override preserves other layers and records field provenance", () => {
    it("manual contextWindow override preserves provider vision, tools, and maxOutput", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "model-a" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "model-a": {
                vision: true,
                tools: true,
                contextWindow: 64000,
                maxOutput: 8000,
              },
            },
          },
          manualOverrides: {
            "fixture/model-a": { contextWindow: 128000 },
          },
        }
      );

      expect(caps.contextWindow).toBe(128000);
      expect(caps.supportsVision).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxOutputTokens).toBe(8000);

      expect(caps.source).toBe("manual");
      expect(caps.provenance.contextWindow).toBe("manual");
      expect(caps.provenance.supportsVision).toBe("provider");
      expect(caps.provenance.supportsTools).toBe("provider");
      expect(caps.provenance.maxOutputTokens).toBe("provider");
    });

    it("manual supportsTools: false preserves provider vision and limits (original parent regression)", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "model-b" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/model-b": { supportsTools: false },
          },
          providerOverrides: {
            fixture: {
              "model-b": {
                vision: true,
                tools: true,
                contextWindow: 64000,
                maxOutput: 8000,
              },
            },
          },
        }
      );

      expect(caps.supportsTools).toBe(false);
      expect(caps.supportsVision).toBe(true);
      expect(caps.contextWindow).toBe(64000);
      expect(caps.maxOutputTokens).toBe(8000);

      expect(caps.source).toBe("manual");
      expect(caps.provenance.supportsTools).toBe("manual");
      expect(caps.provenance.supportsVision).toBe("provider");
      expect(caps.provenance.contextWindow).toBe("provider");
      expect(caps.provenance.maxOutputTokens).toBe("provider");
    });
  });

  describe("2. Explicit false and heuristics protection", () => {
    it("manual explicit supportsVision: false beats name-based vision heuristics", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "qwen-vl-max" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/qwen-vl-max": { supportsVision: false },
          },
        }
      );

      expect(caps.supportsVision).toBe(false);
      expect(caps.provenance.supportsVision).toBe("manual");
      expect(caps.source).toBe("manual");
    });

    it("manual explicit vision: false beats canonical exact table", () => {
      const caps = resolveModelCapabilities(
        { provider: "openai", model: "gpt-4o" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {
            "gpt-4o": { vision: true, tools: true, contextWindow: 128000 },
          },
          manualOverrides: {
            "openai/gpt-4o": { vision: false },
          },
        }
      );

      expect(caps.supportsVision).toBe(false);
      expect(caps.supportsTools).toBe(true);
      expect(caps.contextWindow).toBe(128000);
      expect(caps.provenance.supportsVision).toBe("manual");
      expect(caps.provenance.supportsTools).toBe("canonical");
      expect(caps.provenance.contextWindow).toBe("canonical");
    });

    it("heuristic turns vision on if uncatalogued model looks like vision and no manual false", () => {
      const caps = resolveModelCapabilities(
        { provider: "custom", model: "custom-vl-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {},
        }
      );

      expect(caps.supportsVision).toBe(true);
      expect(caps.provenance.supportsVision).toBe("pattern");
      expect(caps.source).toBe("pattern");
    });

    it("provider explicit vision: false beats name-based vision heuristics", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "qwen-vl-provider" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "qwen-vl-provider": { vision: false, contextWindow: 32000 },
            },
          },
        }
      );

      expect(caps.supportsVision).toBe(false);
      expect(caps.provenance.supportsVision).toBe("provider");
    });

    it("auto:discovery explicit vision: false beats name-based vision heuristics", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "qwen-vl-auto" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          autoOverrides: {
            "fixture/qwen-vl-auto": { supportsVision: false },
          },
        }
      );

      expect(caps.supportsVision).toBe(false);
      expect(caps.provenance.supportsVision).toBe("auto:discovery");
    });
  });

  describe("3. Null / undefined and invalid limits cannot shadow lower layers", () => {
    it("null and undefined fields in manual layer do not erase provider or floor values", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "null-test" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "null-test": {
                vision: true,
                tools: true,
                contextWindow: 32000,
                maxOutput: 4000,
              },
            },
          },
          manualOverrides: {
            "fixture/null-test": {
              contextWindow: null,
              supportsVision: undefined,
              supportsTools: null,
            },
          },
        }
      );

      expect(caps.contextWindow).toBe(32000);
      expect(caps.supportsVision).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxOutputTokens).toBe(4000);
      expect(caps.provenance.contextWindow).toBe("provider");
      expect(caps.provenance.supportsVision).toBe("provider");
      expect(caps.provenance.supportsTools).toBe("provider");
    });

    it("invalid non-positive limits (0, negative, NaN, string text) do not shadow valid lower limits", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "limit-test" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "limit-test": {
                contextWindow: 65536,
                maxOutput: 8192,
              },
            },
          },
          manualOverrides: {
            "fixture/limit-test": {
              contextWindow: 0,
              maxOutputTokens: -100,
            },
          },
          autoOverrides: {
            "fixture/limit-test": {
              contextWindow: "unlimited",
              maxOutputTokens: NaN,
            },
          },
        }
      );

      expect(caps.contextWindow).toBe(65536);
      expect(caps.maxOutputTokens).toBe(8192);
      expect(caps.provenance.contextWindow).toBe("provider");
      expect(caps.provenance.maxOutputTokens).toBe("provider");
    });

    it("valid positive string limits are converted to integers", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "str-limit" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/str-limit": {
              contextWindow: "131072.9",
              maxOutputTokens: "16384",
            },
          },
        }
      );

      expect(caps.contextWindow).toBe(131072);
      expect(caps.maxOutputTokens).toBe(16384);
      expect(caps.provenance.contextWindow).toBe("manual");
      expect(caps.provenance.maxOutputTokens).toBe("manual");
    });

    it("rejects non-integer limits < 1 such as 0.5 without floor-to-0 shadowing lower layer", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "float-limit" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "float-limit": { contextWindow: 4096 },
            },
          },
          manualOverrides: {
            "fixture/float-limit": { contextWindow: 0.5 },
          },
        }
      );

      expect(caps.contextWindow).toBe(4096);
      expect(caps.provenance.contextWindow).toBe("provider");
    });

    it("null thinkingFormat in higher layer does not shadow lower layer thinkingFormat", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "thinking-fmt" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "thinking-fmt": { thinkingFormat: "openai" },
            },
          },
          manualOverrides: {
            "fixture/thinking-fmt": { thinkingFormat: null },
          },
        }
      );

      expect(caps.thinkingFormat).toBe("openai");
      expect(caps.provenance.thinkingFormat).toBe("provider");
    });
  });

  describe("4. Vendor namespaces and scoped raw models", () => {
    it("preserves vendor namespaces in raw model containing slashes", () => {
      const caps = resolveModelCapabilities(
        { provider: "openrouter", model: "meta-llama/llama-3.1-70b-instruct" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: new Map([
            [
              "openrouter/meta-llama/llama-3.1-70b-instruct",
              { contextWindow: 131072, supportsTools: true },
            ],
            [
              "openrouter/llama-3.1-70b-instruct",
              { contextWindow: 8000, supportsTools: false },
            ],
          ]),
        }
      );

      expect(caps.contextWindow).toBe(131072);
      expect(caps.supportsTools).toBe(true);
      expect(caps.model).toBe("meta-llama/llama-3.1-70b-instruct");
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("nested provider record lookup checks raw model with namespace before canonical", () => {
      const caps = resolveModelCapabilities(
        { provider: "together", model: "publisher/custom-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            together: {
              "publisher/custom-model": { contextWindow: 90000, vision: true },
              "custom-model": { contextWindow: 10000, vision: false },
            },
          },
        }
      );

      expect(caps.contextWindow).toBe(90000);
      expect(caps.supportsVision).toBe(true);
      expect(caps.provenance.contextWindow).toBe("provider");
    });
  });

  describe("5. Array overrides matching and legacy provider NULL handling", () => {
    it("exact scoped provider+rawModel matches before preceding legacy wildcard row", () => {
      const overridesArray = [
        { model_pattern: "*", contextWindow: 1000, tools: false },
        {
          provider: "openai",
          modelId: "gpt-4o",
          contextWindow: 128000,
          tools: true,
        },
      ];

      const caps = resolveModelCapabilities(
        { provider: "openai", model: "gpt-4o" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(caps.contextWindow).toBe(128000);
      expect(caps.supportsTools).toBe(true);
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("supports array items with nested capabilities object or capabilities_json", () => {
      const overridesArray = [
        {
          provider: "mistral",
          model_id: "codestral-2501",
          capabilities: { contextWindow: 256000, tools: true },
        },
        {
          provider: "mistral",
          model_id: "mistral-large",
          capabilities_json: JSON.stringify({ contextWindow: 128000, vision: true }),
        },
      ];

      const capsCodestral = resolveModelCapabilities(
        { provider: "mistral", model: "codestral-2501" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(capsCodestral.contextWindow).toBe(256000);
      expect(capsCodestral.supportsTools).toBe(true);

      const capsLarge = resolveModelCapabilities(
        { provider: "mistral", model: "mistral-large" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(capsLarge.contextWindow).toBe(128000);
      expect(capsLarge.supportsVision).toBe(true);
    });

    it("falls back to legacy provider NULL pattern when no exact scoped row exists", () => {
      const overridesArray = [
        { model_pattern: "deepseek-*", contextWindow: 64000, reasoning: true },
      ];

      const caps = resolveModelCapabilities(
        { provider: "vllm", model: "deepseek-coder" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(caps.contextWindow).toBe(64000);
      expect(caps.supportsReasoning).toBe(true);
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("scoped exact false wins over legacy pattern true (conflict explicit false)", () => {
      const overridesArray = [
        { model_pattern: "model*", tools: true, contextWindow: 50000 },
        { provider: "fixture", modelId: "model-1", tools: false },
      ];

      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "model-1" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(caps.supportsTools).toBe(false);
      expect(caps.contextWindow).toBe(50000);
      expect(caps.provenance.supportsTools).toBe("manual");
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("handles null / non-object items in array safely", () => {
      const overridesArray = [
        null,
        undefined,
        "not-an-object",
        { provider: "fixture", modelId: "safe-model", contextWindow: 24000 },
      ];

      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "safe-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(caps.contextWindow).toBe(24000);
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("filters out rows tagged with another source in manualOverrides array", () => {
      const overridesArray = [
        {
          provider: "fixture",
          modelId: "filter-model",
          contextWindow: 99999,
          source: "auto:discovery",
        },
        {
          provider: "fixture",
          modelId: "filter-model",
          contextWindow: 33333,
          source: "manual",
        },
      ];

      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "filter-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: overridesArray,
        }
      );

      expect(caps.contextWindow).toBe(33333);
      expect(caps.provenance.contextWindow).toBe("manual");
    });

    it("Map / Record fills holes across scoped and unscoped entries", () => {
      const manualMap = new Map([
        ["fixture/hole-model", { supportsTools: false }],
        ["hole-model", { contextWindow: 48000 }],
      ]);

      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "hole-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: manualMap,
        }
      );

      expect(caps.supportsTools).toBe(false);
      expect(caps.contextWindow).toBe(48000);
      expect(caps.provenance.supportsTools).toBe("manual");
      expect(caps.provenance.contextWindow).toBe("manual");
    });
  });

  describe("6. Alias normalization per layer before merge", () => {
    it("higher layer tools:false beats lower layer supportsTools:true", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "alias-tools" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/alias-tools": { tools: false },
          },
          providerOverrides: {
            fixture: {
              "alias-tools": { supportsTools: true },
            },
          },
        }
      );

      expect(caps.supportsTools).toBe(false);
      expect(caps.provenance.supportsTools).toBe("manual");
    });

    it("higher layer supportsTools:false beats lower layer tools:true", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "alias-supports-tools" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/alias-supports-tools": { supportsTools: false },
          },
          providerOverrides: {
            fixture: {
              "alias-supports-tools": { tools: true },
            },
          },
        }
      );

      expect(caps.supportsTools).toBe(false);
      expect(caps.provenance.supportsTools).toBe("manual");
    });

    it("normalizes realContext, context_window, max_output_tokens, vision aliases", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "alias-mix" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "alias-mix": {
                realContext: 50000,
                max_output_tokens: 7000,
                vision: true,
                audio_input: true,
                video_input: true,
              },
            },
          },
        }
      );

      expect(caps.contextWindow).toBe(50000);
      expect(caps.maxOutputTokens).toBe(7000);
      expect(caps.supportsVision).toBe(true);
      expect(caps.supportsAudio).toBe(true);
      expect(caps.supportsVideo).toBe(true);
    });
  });

  describe("7. Reasoning structure and effort levels handling", () => {
    it("reasoning object { supported: false } is not coerced to true via Boolean(obj)", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "reasoning-false" },
        {
          defaultCapabilities: { ...FLOOR, reasoning: true },
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/reasoning-false": {
              reasoning: { supported: false },
            },
          },
        }
      );

      expect(caps.supportsReasoning).toBe(false);
      expect(caps.provenance.supportsReasoning).toBe("manual");
    });

    it("empty reasoning object {} does not invent supportsReasoning: true", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "reasoning-empty" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "fixture/reasoning-empty": {
              reasoning: {},
            },
          },
        }
      );

      expect(caps.supportsReasoning).toBe(false);
    });

    it("preserves effortLevels array and does not invent it when absent", () => {
      const capsWithEffort = resolveModelCapabilities(
        { provider: "anthropic", model: "claude-3-7-sonnet" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          manualOverrides: {
            "anthropic/claude-3-7-sonnet": {
              reasoning: {
                supported: true,
                effortLevels: ["low", "medium", "high"],
              },
            },
          },
        }
      );

      expect(capsWithEffort.supportsReasoning).toBe(true);
      expect(capsWithEffort.effortLevels).toEqual(["low", "medium", "high"]);
      expect(capsWithEffort.supportedThinkingEfforts).toEqual(["low", "medium", "high"]);

      const capsWithoutEffort = resolveModelCapabilities(
        { provider: "anthropic", model: "claude-3-5-sonnet" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
        }
      );

      expect(capsWithoutEffort.effortLevels).toBeUndefined();
      expect(capsWithoutEffort.supportedThinkingEfforts).toBeUndefined();
    });

    it("manual supportsReasoning: false omits effortLevels even if provider defined effortLevels", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "reasoning-suppress" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
          providerOverrides: {
            fixture: {
              "reasoning-suppress": {
                reasoning: {
                  supported: true,
                  effortLevels: ["low", "medium", "high"],
                },
              },
            },
          },
          manualOverrides: {
            "fixture/reasoning-suppress": { supportsReasoning: false },
          },
        }
      );

      expect(caps.supportsReasoning).toBe(false);
      expect(caps.effortLevels).toBeUndefined();
      expect(caps.supportedThinkingEfforts).toBeUndefined();
    });
  });

  describe("8. Catalog delta source and persistedOverrides options", () => {
    it("catalogSource integrates at Layer 4 (below provider, above canonical)", () => {
      const catalogSource = {
        getLimits: (provider, model) => {
          if (model === "catalog-model") {
            return { contextWindow: 150000, maxOutput: 16000 };
          }
          return null;
        },
        getModalities: (provider, model) => {
          if (model === "catalog-model") {
            return { input: ["image", "video"] };
          }
          return null;
        },
      };

      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "catalog-model" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {
            "catalog-model": { contextWindow: 60000, vision: false },
          },
          catalogSource,
        }
      );

      expect(caps.contextWindow).toBe(150000);
      expect(caps.maxOutputTokens).toBe(16000);
      expect(caps.supportsVision).toBe(true);
      expect(caps.supportsVideo).toBe(true);
      expect(caps.provenance.contextWindow).toBe("catalog");
      expect(caps.provenance.supportsVision).toBe("catalog");
      expect(caps.source).toBe("catalog");
    });

    it("persistedOverrides: false bypasses manual and auto overrides completely", () => {
      const caps = resolveModelCapabilities(
        { provider: "fixture", model: "persisted-test" },
        {
          defaultCapabilities: FLOOR,
          patternCapabilities: [],
          modelCapabilities: {
            "persisted-test": { contextWindow: 80000, tools: true },
          },
          manualOverrides: {
            "fixture/persisted-test": { contextWindow: 999999, tools: false },
          },
          autoOverrides: {
            "fixture/persisted-test": { contextWindow: 555555 },
          },
        },
        { persistedOverrides: false }
      );

      expect(caps.contextWindow).toBe(80000);
      expect(caps.supportsTools).toBe(true);
      expect(caps.provenance.contextWindow).toBe("canonical");
      expect(caps.provenance.supportsTools).toBe("canonical");
      expect(caps.source).toBe("canonical");
    });
  });

  describe("9. Edge cases and robust input handling", () => {
    it("handles string target input (legacy call format)", () => {
      const caps = resolveModelCapabilities("gpt-4o", {
        defaultCapabilities: FLOOR,
        patternCapabilities: [],
        modelCapabilities: {
          "gpt-4o": { contextWindow: 128000, vision: true },
        },
      });

      expect(caps.model).toBe("gpt-4o");
      expect(caps.contextWindow).toBe(128000);
      expect(caps.supportsVision).toBe(true);
    });

    it("handles null / undefined target safely", () => {
      const capsNull = resolveModelCapabilities(null, { defaultCapabilities: FLOOR });
      expect(capsNull.model).toBe("");
      expect(capsNull.contextWindow).toBe(FLOOR.contextWindow);

      const capsEmpty = resolveModelCapabilities({}, { defaultCapabilities: FLOOR });
      expect(capsEmpty.model).toBe("");
      expect(capsEmpty.contextWindow).toBe(FLOOR.contextWindow);
    });

    it("normalizeModelIds handles empty and non-string values", () => {
      expect(normalizeModelIds("")).toEqual({ canonical: "", raw: "" });
      expect(normalizeModelIds(null)).toEqual({ canonical: "", raw: "" });
      expect(normalizeModelIds("anthropic/claude-3-opus")).toEqual({
        canonical: "claude-3-opus",
        raw: "anthropic/claude-3-opus",
      });
      expect(normalizeModelIds("claude-3-opus")).toEqual({
        canonical: "claude-3-opus",
        raw: "claude-3-opus",
      });
    });

    it("findOverride returns null on invalid or empty overrides container", () => {
      expect(findOverride(null, "p", "c", "r")).toBeNull();
      expect(findOverride(undefined, "p", "c", "r")).toBeNull();
      expect(findOverride("not-an-object", "p", "c", "r")).toBeNull();
    });
  });
});

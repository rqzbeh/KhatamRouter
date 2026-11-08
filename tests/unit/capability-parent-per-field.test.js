import { describe, expect, it } from "vitest";
import { resolveModelCapabilities } from "../../src/lib/models/capabilities.js";

const floor = { vision: false, tools: false, reasoning: false, contextWindow: 4096, maxOutput: 1024 };
describe("independent per-field capability override precedence", () => {
  it("manual one-field override preserves provider limits and capabilities", () => {
    const caps = resolveModelCapabilities({ provider: "fixture", model: "model" }, {
      defaultCapabilities: floor, patternCapabilities: [], modelCapabilities: {},
      manualOverrides: { "fixture/model": { supportsTools: false } },
      providerOverrides: { fixture: { model: { vision: true, tools: true, contextWindow: 64000, maxOutput: 8000 } } },
    });
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsVision).toBe(true);
    expect(caps.contextWindow).toBe(64000);
    expect(caps.maxOutputTokens).toBe(8000);
  });
  it("manual explicit vision false beats model-name heuristics", () => {
    const caps = resolveModelCapabilities({ provider: "fixture", model: "gpt-4o" }, {
      manualOverrides: { "fixture/gpt-4o": { supportsVision: false } },
    });
    expect(caps.supportsVision).toBe(false);
  });
  it("inherits a legacy manual field not overridden by an exact provider row", () => {
    const caps = resolveModelCapabilities({ provider: "fixture", model: "model" }, {
      defaultCapabilities: floor, patternCapabilities: [], modelCapabilities: {}, providerOverrides: {},
      manualOverrides: [
        { provider: null, model_pattern: "model", capabilities: { contextWindow: 42000 } },
        { provider: "fixture", modelId: "model", capabilities: { supportsTools: true } },
      ],
    });
    expect(caps.supportsTools).toBe(true);
    expect(caps.contextWindow).toBe(42000);
  });
  it("scoped raw model identifiers containing slash retain their namespace", () => {
    const caps = resolveModelCapabilities({ provider: "fixture", model: "publisher/model" }, {
      defaultCapabilities: floor, patternCapabilities: [], modelCapabilities: {}, providerOverrides: {},
      manualOverrides: { "fixture/publisher/model": { contextWindow: 42000 } },
    });
    expect(caps.contextWindow).toBe(42000);
  });
});

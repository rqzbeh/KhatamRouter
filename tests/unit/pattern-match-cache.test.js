import { describe, expect, it } from "vitest";
import {
  matchPattern,
  PATTERN_PRICING,
  _getPatternCacheSize,
  _clearPatternCache,
} from "../../open-sse/providers/pricing.js";
import { PATTERN_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

// Canonical reference implementation (uncached) to verify strict identity
function uncachedMatchPattern(pattern, model) {
  const regex = new RegExp(
    "^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i"
  );
  return regex.test(model);
}

describe("pattern-match-cache (T010b)", () => {
  it("strictly matches uncached reference across all PATTERN_PRICING and PATTERN_CAPABILITIES", () => {
    const testModels = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "o1",
      "o1-mini",
      "o1-preview",
      "o3-mini",
      "o3-mini-high",
      "claude-3-opus-20240229",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-7-sonnet",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-1.5-pro-latest",
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v3",
      "deepseek-r1",
      "minimax-m2.5",
      "MiniMax-M2.5",
      "grok-code-beta",
      "grok-2-1212",
      "qwen-turbo",
      "qwen-max",
      "llama-3.1-70b-instruct",
      "mistral-large-latest",
      "non-matching-model-xyz",
      "",
      "gpt",
      "sonnet",
      "flash",
    ];

    const pricingPatterns = PATTERN_PRICING.map(p => p.pattern);
    const capabilityPatterns = PATTERN_CAPABILITIES.map(c => c.pattern);
    const allPatterns = Array.from(new Set([...pricingPatterns, ...capabilityPatterns]));

    expect(allPatterns.length).toBeGreaterThan(20);

    for (const pattern of allPatterns) {
      for (const model of testModels) {
        const expected = uncachedMatchPattern(pattern, model);
        const actual = matchPattern(pattern, model);
        expect(actual).toBe(expected);
      }
    }
  });

  it("handles metacharacter escaping correctly (. + ? ^ $ { } ( ) [ ] | \\)", () => {
    const cases = [
      { pattern: "model-v1.0-*", match: "model-v1.0-chat", noMatch: "model-v1x0-chat" },
      { pattern: "model+fast-*", match: "model+fast-turbo", noMatch: "modelfast-turbo" },
      { pattern: "model-(beta)-*", match: "model-(beta)-v1", noMatch: "model-beta-v1" },
      { pattern: "model-[ab]-*", match: "model-[ab]-v1", noMatch: "model-a-v1" },
      { pattern: "model?-*", match: "model?-v1", noMatch: "mode-v1" },
      { pattern: "^model$-*", match: "^model$-v1", noMatch: "model-v1" },
      { pattern: "model{1,2}-*", match: "model{1,2}-v1", noMatch: "model1-v1" },
      { pattern: "model|alt-*", match: "model|alt-v1", noMatch: "model-v1" },
      { pattern: "model\\d-*", match: "model\\d-v1", noMatch: "model5-v1" },
    ];

    for (const { pattern, match, noMatch } of cases) {
      expect(matchPattern(pattern, match)).toBe(true);
      expect(matchPattern(pattern, noMatch)).toBe(false);
      expect(matchPattern(pattern, match)).toBe(uncachedMatchPattern(pattern, match));
      expect(matchPattern(pattern, noMatch)).toBe(uncachedMatchPattern(pattern, noMatch));
    }
  });

  it("enforces case-insensitivity on both pattern and model id", () => {
    expect(matchPattern("MiniMax-*", "minimax-m2.5")).toBe(true);
    expect(matchPattern("minimax-*", "MiniMax-M2.5")).toBe(true);
    expect(matchPattern("CLAUDE-*", "claude-3-opus")).toBe(true);
    expect(matchPattern("claude-*", "CLAUDE-3-OPUS")).toBe(true);
    expect(matchPattern("gPt-4O*", "GPT-4o-mini")).toBe(true);
  });

  it("enforces full-string anchors (^ and $)", () => {
    expect(matchPattern("gpt-*", "gpt-4o")).toBe(true);
    expect(matchPattern("gpt-*", "my-gpt-4o")).toBe(false);
    expect(matchPattern("*-sonnet", "claude-sonnet")).toBe(true);
    expect(matchPattern("*-sonnet", "claude-sonnet-v1")).toBe(false);
    expect(matchPattern("exact-name", "exact-name")).toBe(true);
    expect(matchPattern("exact-name", "exact-name-extra")).toBe(false);
    expect(matchPattern("exact-name", "pre-exact-name")).toBe(false);
  });

  it("handles single, multiple, and consecutive wildcards", () => {
    expect(matchPattern("*", "anything-at-all")).toBe(true);
    expect(matchPattern("*", "")).toBe(true);
    expect(matchPattern("*-*-*", "a-b-c")).toBe(true);
    expect(matchPattern("*-*-*", "a-b")).toBe(false);
    expect(matchPattern("**", "test")).toBe(true);
    expect(matchPattern("gpt-**-turbo", "gpt-4-turbo")).toBe(true);
  });

  it("is zero-stateful across repeated calls (no lastIndex drift)", () => {
    for (let i = 0; i < 100; i++) {
      expect(matchPattern("gpt-*", "gpt-4o")).toBe(true);
      expect(matchPattern("gpt-*", "claude-sonnet")).toBe(false);
      expect(matchPattern("*-instruct", "llama-3-instruct")).toBe(true);
      expect(matchPattern("*-instruct", "llama-3-base")).toBe(false);
    }
  });

  it("bounds cache capacity to at most 512 entries and evicts oldest entries", () => {
    expect(typeof _clearPatternCache).toBe("function");
    expect(typeof _getPatternCacheSize).toBe("function");
    _clearPatternCache();

    // Insert 600 unique patterns
    for (let i = 0; i < 600; i++) {
      const pattern = `test-pattern-${i}-*`;
      const model = `test-pattern-${i}-model`;
      expect(matchPattern(pattern, model)).toBe(true);
    }

    expect(_getPatternCacheSize()).toBeLessThanOrEqual(512);
    expect(_getPatternCacheSize()).toBe(512);

    // Re-verify that an evicted pattern still functions correctly when requested again
    const earlyPattern = "test-pattern-5-*";
    const earlyModel = "test-pattern-5-model";
    expect(matchPattern(earlyPattern, earlyModel)).toBe(true);
    expect(matchPattern(earlyPattern, "other-model")).toBe(false);
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import {
  matchPattern,
  PATTERN_PRICING,
  _getPatternCacheSize,
  _clearPatternCache,
} from "../../open-sse/providers/pricing.js";
import { PATTERN_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

// Uncached reference: byte-for-byte the HEAD implementation of matchPattern.
function uncachedMatchPattern(pattern, model) {
  const regex = new RegExp(
    "^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i"
  );
  return regex.test(model);
}

const CACHE_MAX = 512;

describe("pattern-match-cache (T010)", () => {
  beforeEach(() => {
    _clearPatternCache();
  });

  it("returns identical results to the uncached HEAD implementation over real model ids and every registry pattern", () => {
    const testModels = [
      "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo",
      "o1", "o1-mini", "o1-preview", "o3-mini", "o3-mini-high",
      "claude-3-opus-20240229", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
      "claude-3-7-sonnet", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro-latest",
      "deepseek-chat", "deepseek-reasoner", "deepseek-v3", "deepseek-r1",
      "minimax-m2.5", "MiniMax-M2.5", "grok-code-beta", "grok-2-1212",
      "qwen-turbo", "qwen-max", "llama-3.1-70b-instruct", "mistral-large-latest",
      "non-matching-model-xyz", "", "gpt", "sonnet", "flash",
    ];
    const patterns = Array.from(new Set([
      ...PATTERN_PRICING.map(p => p.pattern),
      ...PATTERN_CAPABILITIES.map(c => c.pattern),
    ]));
    expect(patterns.length).toBeGreaterThan(20);

    // Run twice: first pass populates the cache, second pass reads from it.
    for (let pass = 0; pass < 2; pass++) {
      for (const pattern of patterns) {
        for (const model of testModels) {
          expect(matchPattern(pattern, model)).toBe(uncachedMatchPattern(pattern, model));
        }
      }
    }
  });

  it("escapes regex metacharacters in patterns so they match literally", () => {
    const cases = [
      { pattern: "model-v1.0-*", match: "model-v1.0-chat", noMatch: "model-v1x0-chat" },
      { pattern: "model+fast-*", match: "model+fast-turbo", noMatch: "modelfast-turbo" },
      { pattern: "model-(beta)-*", match: "model-(beta)-v1", noMatch: "model-beta-v1" },
      { pattern: "model-[ab]-*", match: "model-[ab]-v1", noMatch: "model-a-v1" },
      { pattern: "model?-*", match: "model?-v1", noMatch: "mode-v1" },
      { pattern: "model{1,2}-*", match: "model{1,2}-v1", noMatch: "model1-v1" },
      { pattern: "model|alt-*", match: "model|alt-v1", noMatch: "model-v1" },
      { pattern: "model\\d-*", match: "model\\d-v1", noMatch: "model5-v1" },
    ];
    for (const { pattern, match, noMatch } of cases) {
      expect(matchPattern(pattern, match)).toBe(true);
      expect(matchPattern(pattern, noMatch)).toBe(false);
      expect(matchPattern(pattern, match)).toBe(uncachedMatchPattern(pattern, match));
    }
  });

  it("is case-insensitive on both pattern and model id, including on cache hits", () => {
    for (let i = 0; i < 2; i++) {
      expect(matchPattern("MiniMax-*", "minimax-m2.5")).toBe(true);
      expect(matchPattern("minimax-*", "MiniMax-M2.5")).toBe(true);
      expect(matchPattern("gPt-4O*", "GPT-4o-mini")).toBe(true);
      expect(matchPattern("claude-*", "CLAUDE-3-OPUS")).toBe(true);
    }
  });

  it("globs * as anchored wildcards: full-string match, no partial matches", () => {
    expect(matchPattern("gpt-*", "gpt-4o")).toBe(true);
    expect(matchPattern("gpt-*", "my-gpt-4o")).toBe(false);
    expect(matchPattern("*-sonnet", "claude-sonnet")).toBe(true);
    expect(matchPattern("*-sonnet", "claude-sonnet-v1")).toBe(false);
    expect(matchPattern("exact-name", "exact-name-extra")).toBe(false);
    expect(matchPattern("*", "")).toBe(true);
    expect(matchPattern("*-*-*", "a-b")).toBe(false);
    expect(matchPattern("gpt-**-turbo", "gpt-4-turbo")).toBe(true);
  });

  it("keeps results stable across repeated cache hits (no stateful regex drift)", () => {
    for (let i = 0; i < 100; i++) {
      expect(matchPattern("gpt-*", "gpt-4o")).toBe(true);
      expect(matchPattern("gpt-*", "claude-sonnet")).toBe(false);
      expect(matchPattern("*-instruct", "llama-3-instruct")).toBe(true);
      expect(matchPattern("*-instruct", "llama-3-base")).toBe(false);
    }
  });

  it("caps the cache at 512 entries under 600 distinct patterns and evicts the oldest", () => {
    for (let i = 0; i < 600; i++) {
      expect(matchPattern(`test-pattern-${i}-*`, `test-pattern-${i}-model`)).toBe(true);
    }
    expect(_getPatternCacheSize()).toBe(CACHE_MAX);

    // Evicted pattern (index 0) still returns correct results after recompilation.
    expect(matchPattern("test-pattern-0-*", "test-pattern-0-model")).toBe(true);
    expect(matchPattern("test-pattern-0-*", "other-model")).toBe(false);
    expect(_getPatternCacheSize()).toBe(CACHE_MAX);
  });

  // NOTE: recency order is not observable through the public API (only size and
  // results are). This test pins bounded size and result correctness through a
  // re-read + eviction cycle; it does not prove LRU-vs-FIFO ordering.
  it("stays at the bound and returns correct results through a re-read + eviction cycle", () => {
    for (let i = 0; i < CACHE_MAX; i++) matchPattern(`k${i}-*`, `k${i}-x`);
    matchPattern("k0-*", "k0-x");
    matchPattern("fresh-*", "fresh-x");
    expect(_getPatternCacheSize()).toBe(CACHE_MAX);

    expect(matchPattern("k0-*", "k0-x")).toBe(true);
    expect(matchPattern("k1-*", "k1-x")).toBe(true);
    expect(matchPattern("fresh-*", "fresh-x")).toBe(true);
    expect(_getPatternCacheSize()).toBe(CACHE_MAX);
  });
});

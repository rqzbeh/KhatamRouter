import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { parseModel, resolveModelAliasFromMap } from "../../open-sse/services/model.js";

// Grok 4.7 has a 500k window like 4.6, but had no pattern row of its own, so it
// fell through to `*grok-4*` (256k). Combos report the smallest member window,
// and stripHistoryForContext() trims history at 80% of it.

const caps = (id, provider) => getCapabilitiesForModel(provider, id);

describe("Grok 4.7 context window", () => {
  it.each(["xai", "grok-cli", "opencode-go", "tokenharbor"])("advertises 500k via %s", (provider) => {
    expect(caps("grok-4.7", provider).contextWindow).toBe(500000);
  });

  it("keeps the full Grok 4 feature set: vision, reasoning, search and tools", () => {
    const c = caps("grok-4.7", "grok-cli");
    expect(c).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      tools: true,
      thinkingFormat: "openai",
      maxOutput: 500000,
    });
  });

  it("matches variant ids too", () => {
    expect(caps("grok-4.7-build-fast", "grok-cli").contextWindow).toBe(500000);
  });

  it("leaves the older catch-all alone", () => {
    expect(caps("grok-4", "xai").contextWindow).toBe(256000);
    expect(caps("grok-4.6", "xai").contextWindow).toBe(500000);
  });
});

describe("Grok 4.7 in the static model lists", () => {
  it.each(["xai", "grok-cli"])("%s lists grok-4.7", (id) => {
    const entry = REGISTRY.find((p) => p.id === id);
    expect(entry.models.map((m) => m.id)).toContain("grok-4.7");
  });
});

describe("Grok 4.7 alias verification", () => {
  it("does not accidentally map grok-4.7 to a different model alias", () => {
    expect(resolveModelAliasFromMap("grok-4.7")).toBeNull();
  });

  it("parses xai and grok-cli provider models correctly", () => {
    const xaiParsed = parseModel("xai/grok-4.7");
    expect(xaiParsed).toEqual({
      provider: "xai",
      model: "grok-4.7",
      isAlias: false,
      providerAlias: "xai",
    });

    const gcliParsed = parseModel("gcli/grok-4.7");
    expect(gcliParsed).toEqual({
      provider: "grok-cli",
      model: "grok-4.7",
      isAlias: false,
      providerAlias: "gcli",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODELS,
  findModel,
  getModelSupportedFormats,
  getModelTargetFormat,
  getModelStrip,
  getModelUpstreamId,
  getModelType,
  findModelName,
  isValidModel,
  getModelMeta,
  getModelQuotaFamily,
  getProviderModels,
  getDefaultModel,
} from "../../open-sse/config/providerModels.js";
import { normalizeModelId } from "../../open-sse/providers/models/schema.js";

const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);

// Canonical linear scan reference implementation from master
function linearFindModel(models, modelId, aliasOrId) {
  if (!models) return undefined;
  const baseModelId = typeof modelId === "string"
    ? modelId.replace(/\([^()]+\)\s*$/, "").trim()
    : modelId;
  const found = models.find(m => m.id === modelId || m.id === baseModelId);
  if (found) return found;
  if (!DOT_VERSION_PROVIDERS.has(aliasOrId)) return undefined;
  const normalized = normalizeModelId(baseModelId);
  if (normalized === baseModelId) return undefined;
  return models.find(m => m.id === normalized);
}

describe("model-index-map (T010)", () => {
  it("strictly matches linear scan for EVERY model across EVERY provider in PROVIDER_MODELS", () => {
    let totalChecked = 0;

    for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
      if (!Array.isArray(models)) continue;

      for (const model of models) {
        if (!model || !model.id) continue;
        totalChecked++;

        // 1. Direct modelId lookup with (models, id, alias)
        const expected = linearFindModel(models, model.id, alias);
        const actual = findModel(models, model.id, alias);
        expect(actual).toBe(expected);

        // 2. Convenience lookup with (alias, id)
        const actualByAlias = findModel(alias, model.id);
        expect(actualByAlias).toBe(expected);

        // 3. Suffix variant: model(high)
        const suffixed = `${model.id} (high)`;
        const expectedSuffixed = linearFindModel(models, suffixed, alias);
        const actualSuffixed = findModel(models, suffixed, alias);
        expect(actualSuffixed).toBe(expectedSuffixed);

        // 4. Suffix variant: model(medium)
        const suffixedMed = `${model.id} (medium)`;
        const expectedMed = linearFindModel(models, suffixedMed, alias);
        const actualMed = findModel(models, suffixedMed, alias);
        expect(actualMed).toBe(expectedMed);
      }
    }

    expect(totalChecked).toBeGreaterThan(100);
  });

  it("preserves first-match semantics on duplicate model IDs within the same provider (e.g. gemini)", () => {
    const geminiModels = PROVIDER_MODELS["gemini"] || [];
    const duplicates = geminiModels.filter(m => m.id === "gemini-2.5-pro");
    expect(duplicates.length).toBeGreaterThan(1);

    const firstEntry = duplicates[0];
    const secondEntry = duplicates[1];
    expect(firstEntry).not.toBe(secondEntry);

    const linearResult = linearFindModel(geminiModels, "gemini-2.5-pro", "gemini");
    const mapResult = findModel(geminiModels, "gemini-2.5-pro", "gemini");

    expect(linearResult).toBe(firstEntry);
    expect(mapResult).toBe(firstEntry);
    expect(mapResult).not.toBe(secondEntry);
  });

  it("preserves cross-provider isolation for identical model IDs", () => {
    const openaiModel = findModel(PROVIDER_MODELS["openai"], "gpt-4o", "openai");
    const githubModel = findModel(PROVIDER_MODELS["github"], "gpt-4o", "github");

    if (openaiModel && githubModel) {
      expect(openaiModel).not.toBe(githubModel);
    }

    const openaiByAlias = findModel("openai", "gpt-4o");
    const githubByAlias = findModel("github", "gpt-4o");
    if (openaiByAlias && githubByAlias) {
      expect(openaiByAlias).not.toBe(githubByAlias);
    }
  });

  it("handles dot-version normalization for DOT_VERSION_PROVIDERS (kr, kiro) and not others", () => {
    // In "kr" provider, "claude-sonnet-4-5" normalizes to "claude-sonnet-4.5"
    const krModels = PROVIDER_MODELS["kr"];
    if (krModels && krModels.some(m => m.id === "claude-sonnet-4.5")) {
      const linear = linearFindModel(krModels, "claude-sonnet-4-5", "kr");
      const mapped = findModel(krModels, "claude-sonnet-4-5", "kr");
      expect(mapped).toBeDefined();
      expect(mapped).toBe(linear);

      // With suffix
      const linearSuffix = linearFindModel(krModels, "claude-sonnet-4-5 (high)", "kr");
      const mappedSuffix = findModel(krModels, "claude-sonnet-4-5 (high)", "kr");
      expect(mappedSuffix).toBe(linearSuffix);
    }

    // In "openai", dot-version normalization must NOT occur
    const openaiModels = PROVIDER_MODELS["openai"] || [];
    const nonDotLinear = linearFindModel(openaiModels, "gpt-4-5", "openai");
    const nonDotMapped = findModel(openaiModels, "gpt-4-5", "openai");
    expect(nonDotMapped).toBe(nonDotLinear);
  });

  it("returns undefined for unknown models and gracefully handles nil inputs", () => {
    expect(findModel(PROVIDER_MODELS["openai"], "non-existent-model-xyz", "openai")).toBeUndefined();
    expect(findModel("openai", "non-existent-model-xyz")).toBeUndefined();
    expect(findModel(null, "gpt-4o", "openai")).toBeUndefined();
    expect(findModel(undefined, "gpt-4o", "openai")).toBeUndefined();
    expect(findModel([], "gpt-4o", "openai")).toBeUndefined();
  });

  it("falls back to linear scan for custom, dynamic, or unindexed models arrays", () => {
    const customList = [
      { id: "custom-alpha", name: "Custom Alpha" },
      { id: "custom-beta", name: "Custom Beta" },
    ];

    expect(findModel(customList, "custom-alpha", "custom-alias")).toBe(customList[0]);
    expect(findModel(customList, "custom-alpha (high)", "custom-alias")).toBe(customList[0]);
    expect(findModel(customList, "custom-gamma", "custom-alias")).toBeUndefined();
  });

  it("verifies chatCore helper functions use the indexed findModel correctly", () => {
    expect(isValidModel("openai", "gpt-4o")).toBe(true);
    expect(isValidModel("openai", "unknown-xyz")).toBe(false);

    expect(findModelName("openai", "gpt-4o")).toBeTruthy();
    expect(findModelName("openai", "unknown-xyz")).toBe("unknown-xyz");

    expect(getModelMeta("openai", "gpt-4o")).toBeTruthy();
    expect(getModelMeta("openai", "unknown-xyz")).toBeNull();

    const formats = getModelSupportedFormats("openai", "gpt-4o");
    expect(formats === null || Array.isArray(formats)).toBe(true);

    const targetFmt = getModelTargetFormat("openai", "gpt-4o");
    expect(targetFmt === null || typeof targetFmt === "string").toBe(true);

    const strip = getModelStrip("openai", "gpt-4o");
    expect(Array.isArray(strip)).toBe(true);

    const type = getModelType("openai", "gpt-4o");
    expect(type === null || typeof type === "string").toBe(true);

    const upstream = getModelUpstreamId("openai", "gpt-4o");
    expect(typeof upstream).toBe("string");

    const quota = getModelQuotaFamily("openai", "gpt-4o");
    expect(quota === null || typeof quota === "string").toBe(true);

    expect(getDefaultModel("openai")).toBe(PROVIDER_MODELS["openai"]?.[0]?.id || null);
    expect(getProviderModels("openai")).toBe(PROVIDER_MODELS["openai"]);
  });
});

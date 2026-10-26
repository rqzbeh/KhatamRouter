import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getModelsByProviderId, isValidModel } from "../../open-sse/config/providerModels.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";

describe("Runcrate provider", () => {
  const entry = REGISTRY.find((e) => e.id === "runcrate");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("runcrate");
    expect(entry.aliases).toContain("rc");
    expect(entry.uiAlias).toBe("rc");
  });

  it("points at the verified OpenAI-compatible base URL and billing validateUrl", () => {
    expect(PROVIDERS.runcrate.baseUrl).toBe("https://api.runcrate.ai/v1/chat/completions");
    expect(PROVIDERS.runcrate.validateUrl).toBe("https://www.runcrate.ai/api/v1/billing/balance");
  });

  it("strips UTM tracking queries from display.website", () => {
    expect(entry.display.website).toBe("https://www.runcrate.ai/inference/free");
    expect(entry.display.website).not.toContain("utm_source");
    expect(entry.display.website).not.toContain("9router");
  });

  it("has fixed HTTPS constants and no hardcoded secrets", () => {
    expect(entry.display.website.startsWith("https://")).toBe(true);
    expect(entry.display.notice.apiKeyUrl.startsWith("https://")).toBe(true);
    expect(PROVIDERS.runcrate.baseUrl.startsWith("https://")).toBe(true);
    expect(PROVIDERS.runcrate.validateUrl.startsWith("https://")).toBe(true);
  });

  it("lists declared models in providerModels and validates them", () => {
    const models = getModelsByProviderId("runcrate");
    expect(models.length).toBe(6);
    expect(models.some((m) => m.id === "deepseek-ai/DeepSeek-V4.1-Flash")).toBe(true);
    expect(isValidModel("runcrate", "deepseek-ai/DeepSeek-V4.1-Flash")).toBe(true);
  });

  it("resolves alias rc to runcrate", () => {
    expect(resolveProviderAlias("rc")).toBe("runcrate");
    expect(resolveProviderAlias("runcrate")).toBe("runcrate");
    expect(parseModel("rc/deepseek-ai/DeepSeek-V4.1-Flash")).toMatchObject({
      provider: "runcrate",
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
    });
  });
});

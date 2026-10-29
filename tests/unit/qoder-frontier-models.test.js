import { describe, expect, it } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getQoderStaticModelConfig, QODER_STATIC_MODEL_CONFIGS } from "../../open-sse/shared/qoder/constants.js";
import qoderRegistry from "../../open-sse/providers/registry/qoder.js";
import qoderCnRegistry from "../../open-sse/providers/registry/qoder-cn.js";

describe("Qoder frontier reasoning models (Sonus / Cantus)", () => {
  it("registers smodel and cmodel in both qoder and qoder-cn registries", () => {
    const qoderModels = qoderRegistry.models.map((m) => m.id);
    const qoderCnModels = qoderCnRegistry.models.map((m) => m.id);

    expect(qoderModels).toContain("smodel");
    expect(qoderModels).toContain("cmodel");
    expect(qoderCnModels).toContain("smodel");
    expect(qoderCnModels).toContain("cmodel");
  });

  it("exposes smodel and cmodel through provider models index", () => {
    const qoderEntry = getModelsByProviderId("qoder").find((m) => m.id === "smodel");
    const qoderCnEntry = getModelsByProviderId("qoder-cn").find((m) => m.id === "cmodel");

    expect(qoderEntry?.name).toBe("Sonus");
    expect(qoderCnEntry?.name).toBe("Cantus");
  });

  it("resolves static fallback configuration for smodel and cmodel", () => {
    const sonusCfg = getQoderStaticModelConfig("smodel");
    const cantusCfg = getQoderStaticModelConfig("cmodel");

    expect(sonusCfg).toMatchObject({
      key: "smodel",
      display_name: "Sonus",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 180000,
    });
    expect(cantusCfg).toMatchObject({
      key: "cmodel",
      display_name: "Cantus",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 180000,
    });
  });

  it("provides capabilities for smodel and cmodel across qoder and qoder-cn", () => {
    for (const provider of ["qoder", "qoder-cn"]) {
      expect(getCapabilitiesForModel(provider, "smodel")).toMatchObject({
        vision: true,
        reasoning: true,
        contextWindow: 180000,
        maxOutput: 65536,
      });
      expect(getCapabilitiesForModel(provider, "cmodel")).toMatchObject({
        vision: true,
        reasoning: true,
        contextWindow: 180000,
        maxOutput: 65536,
      });
    }
  });
});

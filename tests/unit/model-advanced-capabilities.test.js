import { describe, expect, it } from "vitest";
import {
  resolveModelCapabilities,
  normalizeModelIds,
  findOverride,
} from "../../src/lib/models/capabilities.js";
import {
  reconcileCatalog,
  FIELD_SOURCES,
} from "../../src/lib/models/catalogReconcile.js";
import { resolveCaps } from "../../src/shared/hooks/useModelCaps.js";

const SAFE_FLOOR = {
  vision: false,
  tools: true,
  reasoning: false,
  contextWindow: 4096,
  maxOutput: 1024,
  audioInput: false,
  videoInput: false,
  supportsStreaming: true,
  imageOutput: false,
  search: false,
};

describe("Model Advanced Capabilities (Spec 017 & Correctness Fix)", () => {
  describe("1. Cascade Resolver: Four Advanced Flags Unknown Semantics", () => {
    it("returns null for all 4 advanced flags when no evidence exists (does not invent false)", () => {
      const resolved = resolveModelCapabilities(
        { provider: "testprov", model: "generic-text-model" },
        {
          defaultCapabilities: SAFE_FLOOR,
          patternCapabilities: [],
          modelCapabilities: {},
        }
      );

      // Four advanced flags must be null, not false
      expect(resolved.supportsImageGeneration).toBeNull();
      expect(resolved.supportsImageEditing).toBeNull();
      expect(resolved.supportsWebSearch).toBeNull();
      expect(resolved.supportsWebFetch).toBeNull();

      // Provenance for unevidenced advanced flags must be unknown
      expect(resolved.provenance.supportsImageGeneration).toBe("unknown");
      expect(resolved.provenance.supportsImageEditing).toBe("unknown");
      expect(resolved.provenance.supportsWebSearch).toBe("unknown");
      expect(resolved.provenance.supportsWebFetch).toBe("unknown");

      // Legacy fields keep backward compatibility (booleans)
      expect(typeof resolved.supportsVision).toBe("boolean");
      expect(typeof resolved.supportsTools).toBe("boolean");
      expect(typeof resolved.supportsReasoning).toBe("boolean");
      expect(typeof resolved.supportsAudio).toBe("boolean");
      expect(typeof resolved.supportsVideo).toBe("boolean");
      expect(typeof resolved.supportsStreaming).toBe("boolean");
      expect(resolved.supportsVision).toBe(false);
      expect(resolved.supportsTools).toBe(true);
      expect(resolved.supportsReasoning).toBe(false);
      expect(resolved.provenance.supportsVision).toBe("default");
    });

    it("respects manual explicit false for each advanced field and records manual provenance", () => {
      const resolved = resolveModelCapabilities(
        { provider: "testprov", model: "model-with-manual-false" },
        {
          defaultCapabilities: SAFE_FLOOR,
          patternCapabilities: [],
          modelCapabilities: {
            "model-with-manual-false": {
              imageOutput: true,
              search: true,
            },
          },
          manualOverrides: {
            "testprov/model-with-manual-false": {
              supportsImageGeneration: false,
              supportsImageEditing: false,
              supportsWebSearch: false,
              supportsWebFetch: false,
            },
          },
        }
      );

      expect(resolved.supportsImageGeneration).toBe(false);
      expect(resolved.supportsImageEditing).toBe(false);
      expect(resolved.supportsWebSearch).toBe(false);
      expect(resolved.supportsWebFetch).toBe(false);

      expect(resolved.provenance.supportsImageGeneration).toBe("manual");
      expect(resolved.provenance.supportsImageEditing).toBe("manual");
      expect(resolved.provenance.supportsWebSearch).toBe("manual");
      expect(resolved.provenance.supportsWebFetch).toBe("manual");
      expect(resolved.source).toBe("manual");
    });

    it("allows manual true to survive and override lower layers", () => {
      const resolved = resolveModelCapabilities(
        { provider: "testprov", model: "model-manual-true" },
        {
          defaultCapabilities: SAFE_FLOOR,
          manualOverrides: {
            "testprov/model-manual-true": {
              supportsImageGeneration: true,
              supportsImageEditing: true,
              supportsWebSearch: true,
              supportsWebFetch: true,
            },
          },
        }
      );

      expect(resolved.supportsImageGeneration).toBe(true);
      expect(resolved.supportsImageEditing).toBe(true);
      expect(resolved.supportsWebSearch).toBe(true);
      expect(resolved.supportsWebFetch).toBe(true);

      expect(resolved.provenance.supportsImageGeneration).toBe("manual");
      expect(resolved.provenance.supportsImageEditing).toBe("manual");
      expect(resolved.provenance.supportsWebSearch).toBe("manual");
      expect(resolved.provenance.supportsWebFetch).toBe("manual");
    });

    it("survives auto:discovery overrides with proper provenance", () => {
      const resolved = resolveModelCapabilities(
        { provider: "testprov", model: "model-auto" },
        {
          defaultCapabilities: SAFE_FLOOR,
          autoOverrides: {
            "testprov/model-auto": {
              source: "auto:discovery",
              supportsWebSearch: true,
              supportsImageGeneration: false,
            },
          },
        }
      );

      expect(resolved.supportsWebSearch).toBe(true);
      expect(resolved.supportsImageGeneration).toBe(false);
      expect(resolved.provenance.supportsWebSearch).toBe("auto:discovery");
      expect(resolved.provenance.supportsImageGeneration).toBe("auto:discovery");
      expect(resolved.supportsWebFetch).toBeNull();
      expect(resolved.provenance.supportsWebFetch).toBe("unknown");
    });
  });

  describe("2. Canonical Alias Maps & Kind-Based Mappings", () => {
    it("resolves imageGeneration aliases (imageOutput, image_generation, image_output)", () => {
      const r1 = resolveModelCapabilities(
        { provider: "test", model: "m1" },
        {
          defaultCapabilities: SAFE_FLOOR,
          manualOverrides: { "test/m1": { imageOutput: true } },
        }
      );
      expect(r1.supportsImageGeneration).toBe(true);

      const r2 = resolveModelCapabilities(
        { provider: "test", model: "m2" },
        {
          defaultCapabilities: SAFE_FLOOR,
          manualOverrides: { "test/m2": { image_generation: false } },
        }
      );
      expect(r2.supportsImageGeneration).toBe(false);
    });

    it("resolves webSearch aliases (webSearch, web_search, search)", () => {
      const r1 = resolveModelCapabilities(
        { provider: "test", model: "m1" },
        {
          defaultCapabilities: SAFE_FLOOR,
          manualOverrides: { "test/m1": { search: true } },
        }
      );
      expect(r1.supportsWebSearch).toBe(true);

      const r2 = resolveModelCapabilities(
        { provider: "test", model: "m2" },
        {
          defaultCapabilities: SAFE_FLOOR,
          manualOverrides: { "test/m2": { web_search: false } },
        }
      );
      expect(r2.supportsWebSearch).toBe(false);
    });

    it("maps image generation & editing from raw explicit kind (never model name)", () => {
      // 1. Explicit kind 'image' produces supportsImageGeneration: true
      const rImageKind = resolveModelCapabilities(
        { provider: "test", model: "arbitrary-id-1", kind: "image" },
        { defaultCapabilities: SAFE_FLOOR }
      );
      expect(rImageKind.supportsImageGeneration).toBe(true);
      expect(rImageKind.supportsImageEditing).toBeNull();

      // 2. Explicit kind 'image-to-image' produces supportsImageGeneration: true AND supportsImageEditing: true
      const rEditKind = resolveModelCapabilities(
        { provider: "test", model: "arbitrary-id-2", kind: "image-to-image" },
        { defaultCapabilities: SAFE_FLOOR }
      );
      expect(rEditKind.supportsImageGeneration).toBe(true);
      expect(rEditKind.supportsImageEditing).toBe(true);

      // 3. Raw capabilities array containing 'edit' maps to image editing
      const rRawCaps = resolveModelCapabilities(
        { provider: "test", model: "arbitrary-id-3", capabilities: ["edit"] },
        { defaultCapabilities: SAFE_FLOOR }
      );
      expect(rRawCaps.supportsImageEditing).toBe(true);

      // 4. Model name containing 'image' or 'dall-e' does NOT trigger image generation (no name heuristics!)
      const rNameHeuristicBypassed = resolveModelCapabilities(
        { provider: "test", model: "dall-e-3-ultra-image-edit-super" },
        { defaultCapabilities: SAFE_FLOOR }
      );
      expect(rNameHeuristicBypassed.supportsImageGeneration).toBeNull();
      expect(rNameHeuristicBypassed.supportsImageEditing).toBeNull();
    });

    it("modalities.output = ['image'] grants supportsImageGeneration", () => {
      const r = resolveModelCapabilities(
        {
          provider: "test",
          model: "modal-out-test",
          modalities: { output: ["image"] },
        },
        { defaultCapabilities: SAFE_FLOOR }
      );
      expect(r.supportsImageGeneration).toBe(true);
    });
  });

  describe("3. Catalog Reconciliation: Four Fields & Absent Semantics", () => {
    const listing = (models, extra = {}) => ({
      complete: true,
      authoritativeEmpty: false,
      models,
      ...extra,
    });
    const prev = (entries) =>
      entries.map((e) => ({
        id: e.id,
        lifecycle: "active",
        capabilities: {},
        ...e,
      }));

    it("keeps omitted advanced fields absent (never coerces to false)", () => {
      const r = reconcileCatalog({
        previous: [],
        listing: listing([{ id: "model-plain", name: "model-plain" }]),
      });

      expect(r.add).toHaveLength(1);
      const added = r.add[0];
      expect(added.capabilities.supportsImageGeneration).toBeUndefined();
      expect(added.capabilities.supportsImageEditing).toBeUndefined();
      expect(added.capabilities.supportsWebSearch).toBeUndefined();
      expect(added.capabilities.supportsWebFetch).toBeUndefined();

      expect(added.provenance.supportsImageGeneration).toBe(FIELD_SOURCES.UNKNOWN);
      expect(added.provenance.supportsImageEditing).toBe(FIELD_SOURCES.UNKNOWN);
      expect(added.provenance.supportsWebSearch).toBe(FIELD_SOURCES.UNKNOWN);
      expect(added.provenance.supportsWebFetch).toBe(FIELD_SOURCES.UNKNOWN);
    });

    it("survives explicit manual false during reconciliation and records manual provenance", () => {
      const r = reconcileCatalog({
        previous: prev([{ id: "m1", capabilities: { supportsWebSearch: true } }]),
        listing: listing([{ id: "m1", supportsWebSearch: true }]),
        overrides: {
          m1: {
            supportsWebSearch: { value: false, source: "manual" },
          },
        },
      });

      // Does not update because manual override pins it to false
      expect(r.update).toEqual([]);
      expect(r.divergences).toHaveLength(1);
      expect(r.divergences[0]).toEqual({
        id: "m1",
        field: "supportsWebSearch",
        manual: false,
        discovered: true,
      });
    });

    it("survives listing-discovered true and sets provenance to listing", () => {
      const r = reconcileCatalog({
        previous: prev([{ id: "m2", capabilities: {} }]),
        listing: listing([
          {
            id: "m2",
            supportsImageGeneration: true,
            supportsWebSearch: true,
          },
        ]),
      });

      expect(r.update).toHaveLength(1);
      expect(r.update[0].changes).toEqual({
        supportsImageGeneration: true,
        supportsWebSearch: true,
      });
      expect(r.update[0].provenance.supportsImageGeneration).toBe(FIELD_SOURCES.LISTING);
      expect(r.update[0].provenance.supportsWebSearch).toBe(FIELD_SOURCES.LISTING);
    });

    it("survives enrichment (models.dev) true and sets provenance to models.dev", () => {
      const r = reconcileCatalog({
        previous: prev([{ id: "m3", capabilities: {} }]),
        listing: listing([{ id: "m3" }]),
        enrichment: {
          m3: {
            supportsWebFetch: true,
          },
        },
      });

      expect(r.update).toHaveLength(1);
      expect(r.update[0].changes).toEqual({
        supportsWebFetch: true,
      });
      expect(r.update[0].provenance.supportsWebFetch).toBe(FIELD_SOURCES.ENRICHMENT);
    });

    it("preserves existing reasoning array (supportedThinkingEfforts) unchanged", () => {
      const r = reconcileCatalog({
        previous: prev([{ id: "m4", capabilities: {} }]),
        listing: listing([
          {
            id: "m4",
            supportsReasoning: true,
            supportedThinkingEfforts: ["low", "medium", "high"],
          },
        ]),
      });

      expect(r.update).toHaveLength(1);
      expect(r.update[0].changes.supportedThinkingEfforts).toEqual(["low", "medium", "high"]);
      expect(r.update[0].provenance.supportedThinkingEfforts).toBe(FIELD_SOURCES.LISTING);
    });

    it("respects raw declaration explicit false without false inference when field is absent from raw", () => {
      const r = reconcileCatalog({
        previous: [],
        listing: listing([
          {
            id: "raw-declared-false",
            name: "raw-declared-false",
            supportsImageGeneration: false,
            raw: {
              supportsImageGeneration: false,
            },
          },
          {
            id: "raw-no-signal",
            name: "raw-no-signal",
            supportsImageGeneration: false, // Normalizer default false
            raw: {
              id: "raw-no-signal", // Raw payload carried no image generation signal!
            },
          },
        ]),
      });

      const explicitFalse = r.add.find((m) => m.id === "raw-declared-false");
      const noSignal = r.add.find((m) => m.id === "raw-no-signal");

      expect(explicitFalse.capabilities.supportsImageGeneration).toBe(false);
      expect(explicitFalse.provenance.supportsImageGeneration).toBe(FIELD_SOURCES.LISTING);

      // Must NOT infer false for absent signal!
      expect(noSignal.capabilities.supportsImageGeneration).toBeUndefined();
      expect(noSignal.provenance.supportsImageGeneration).toBe(FIELD_SOURCES.UNKNOWN);
    });
  });

  describe("4. Hook & Resolver: resolveCaps surfaces advanced fields & provenance", () => {
    it("returns advanced fields, provenance, and consumer badge keys from cache match", () => {
      const byFull = {
        "testprov/model-x": {
          supportsVision: true,
          supportsTools: true,
          supportsReasoning: true,
          supportsImageGeneration: true,
          supportsImageEditing: false,
          supportsWebSearch: true,
          supportsWebFetch: null,
          contextWindow: 128000,
          maxOutput: 4096,
          provenance: {
            supportsImageGeneration: "manual",
            supportsWebSearch: "listing",
          },
        },
      };

      const caps = resolveCaps(byFull, {}, "testprov/model-x");
      expect(caps).not.toBeNull();
      expect(caps.supportsImageGeneration).toBe(true);
      expect(caps.supportsImageEditing).toBe(false);
      expect(caps.supportsWebSearch).toBe(true);
      expect(caps.supportsWebFetch).toBeNull();
      expect(caps.provenance.supportsImageGeneration).toBe("manual");

      // Consumer badge keys used by CapacityBadges
      expect(caps.imageOutput).toBe(true);
      expect(caps.search).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.tools).toBe(true);
      expect(caps.reasoning).toBe(true);
    });

    it("returns null for advanced fields and fallback provenance on fallback model", () => {
      const caps = resolveCaps({}, {}, "unknown-prov/nonexistent-model-xyz");
      expect(caps).not.toBeNull();
      expect(caps.supportsImageGeneration).toBeNull();
      expect(caps.supportsImageEditing).toBeNull();
      expect(caps.supportsWebFetch).toBeNull();
      expect(caps.provenance).toBeDefined();
    });
  });
});

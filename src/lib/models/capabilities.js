/**
 * Model capabilities precedence cascade as a pure function (Wave 6).
 *
 * Precedence Order (first match wins):
 *   1. Manual operator overrides (source: "manual")
 *   2. Auto-discovery overrides (source: "auto:discovery")
 *   3. Provider-specific static registry overrides (PROVIDER_CAPABILITIES)
 *   4. Synced catalog deltas (models.dev)
 *   5. Canonical exact model definitions (MODEL_CAPABILITIES)
 *   6. Glob pattern match (PATTERN_CAPABILITIES)
 *   7. Safe floor (DEFAULT_CAPABILITIES)
 *
 * When options.persistedOverrides === false, layers 1 and 2 are bypassed,
 * giving the pure catalog view used for reconciler baseline comparisons.
 */

import {
  DEFAULT_CAPABILITIES,
  MODEL_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  PATTERN_CAPABILITIES,
} from "open-sse/providers/capabilities.js";
import { matchPattern } from "open-sse/providers/pricing.js";
import { looksLikeVisionModel } from "open-sse/providers/visionPatterns.js";

/**
 * Standardize lookup model strings: strip provider prefixes if present.
 */
function normalizeModelIds(modelStr) {
  if (!modelStr) return { canonical: "", raw: "" };
  const raw = String(modelStr).trim();
  const canonical = raw.includes("/") ? raw.split("/").pop() || raw : raw;
  return { canonical, raw };
}

/**
 * Look up in a Map, Record, or Array of overrides.
 */
function findOverride(overrides, provider, canonicalModel, rawModel) {
  if (!overrides) return null;

  // 1. Map lookup
  if (overrides instanceof Map) {
    if (provider && overrides.has(`${provider}/${canonicalModel}`)) {
      return overrides.get(`${provider}/${canonicalModel}`);
    }
    if (provider && overrides.has(`${provider}/${rawModel}`)) {
      return overrides.get(`${provider}/${rawModel}`);
    }
    if (overrides.has(canonicalModel)) return overrides.get(canonicalModel);
    if (overrides.has(rawModel)) return overrides.get(rawModel);
    return null;
  }

  // 2. Plain Object / nested Record
  if (typeof overrides === "object" && !Array.isArray(overrides)) {
    if (provider && overrides[provider]) {
      const pGroup = overrides[provider];
      if (pGroup[canonicalModel]) return pGroup[canonicalModel];
      if (pGroup[rawModel]) return pGroup[rawModel];
    }
    if (overrides[`${provider}/${canonicalModel}`]) return overrides[`${provider}/${canonicalModel}`];
    if (overrides[`${provider}/${rawModel}`]) return overrides[`${provider}/${rawModel}`];
    if (overrides[canonicalModel]) return overrides[canonicalModel];
    if (overrides[rawModel]) return overrides[rawModel];
    return null;
  }

  // 3. Array of override objects [{ provider, modelId, ... }]
  if (Array.isArray(overrides)) {
    for (const item of overrides) {
      if (!item || typeof item !== "object") continue;
      const pMatch = !item.provider || !provider || item.provider === provider || item.provider === "*";
      const mMatch =
        item.modelId === canonicalModel ||
        item.modelId === rawModel ||
        item.model_id === canonicalModel ||
        item.model_id === rawModel ||
        item.model_pattern === canonicalModel ||
        item.model_pattern === rawModel ||
        (item.model_pattern && matchPattern(item.model_pattern, canonicalModel));
      if (pMatch && mMatch) return item;
    }
    return null;
  }

  return null;
}

/**
 * Pure function: resolve capabilities and limits across the 7-tier precedence cascade.
 *
 * @param {{ provider?: string|null, model: string }} target
 * @param {object} [sources] injectable source fixtures
 * @param {object} [options] { persistedOverrides?: boolean }
 * @returns {object} resolved capabilities
 */
export function resolveModelCapabilities(target, sources = {}, options = {}) {
  const provider = target?.provider || null;
  const rawModelInput = target?.model || "";
  const { canonical, raw } = normalizeModelIds(rawModelInput);

  const usePersisted = options.persistedOverrides !== false;

  const defaultCaps = sources.defaultCapabilities || DEFAULT_CAPABILITIES;
  const providerCaps = sources.providerOverrides || PROVIDER_CAPABILITIES;
  const modelCaps = sources.modelCapabilities || MODEL_CAPABILITIES;
  const patternCaps = sources.patternCapabilities || PATTERN_CAPABILITIES;
  const catalogSource = sources.catalogSource || null;

  // Layer 1: Manual Operator Override (persisted)
  if (usePersisted && sources.manualOverrides) {
    const manual = findOverride(sources.manualOverrides, provider, canonical, raw);
    if (manual) {
      return buildResolved({
        base: manual,
        provider,
        model: raw,
        defaultCaps,
        source: "manual",
      });
    }
  }

  // Layer 2: Auto-Discovery Override (persisted)
  if (usePersisted && sources.autoOverrides) {
    const auto = findOverride(sources.autoOverrides, provider, canonical, raw);
    if (auto) {
      return buildResolved({
        base: auto,
        provider,
        model: raw,
        defaultCaps,
        source: "auto:discovery",
      });
    }
  }

  // Layer 3: Provider-Specific Static Registry Override
  if (provider && providerCaps[provider]) {
    const pGroup = providerCaps[provider];
    const match = pGroup[raw] || pGroup[canonical];
    if (match) {
      return buildResolved({
        base: match,
        provider,
        model: raw,
        defaultCaps,
        source: "provider",
      });
    }
  }

  // Layer 4: Synced Catalog (models.dev deltas)
  let catalogDelta = null;
  if (catalogSource) {
    const limits = catalogSource.getLimits?.(provider, raw) || catalogSource.getLimits?.(provider, canonical);
    const modalities = catalogSource.getModalities?.(provider, raw) || catalogSource.getModalities?.(provider, canonical);
    if (limits || modalities) {
      catalogDelta = { ...(limits || {}), ...(modalities || {}) };
    }
  }

  // Layer 5: Canonical Exact Model Entry
  const exactModel = modelCaps[canonical] || modelCaps[raw];
  if (exactModel) {
    const merged = catalogDelta ? { ...exactModel, ...catalogDelta } : exactModel;
    return buildResolved({
      base: merged,
      provider,
      model: raw,
      defaultCaps,
      source: catalogDelta ? "catalog" : "canonical",
    });
  }

  // Layer 6: Pattern Capabilities
  if (Array.isArray(patternCaps)) {
    for (const { pattern, caps } of patternCaps) {
      if (matchPattern(pattern, canonical) || matchPattern(pattern, raw)) {
        const merged = catalogDelta ? { ...caps, ...catalogDelta } : caps;
        return buildResolved({
          base: merged,
          provider,
          model: raw,
          defaultCaps,
          source: catalogDelta ? "catalog" : "pattern",
        });
      }
    }
  }

  // Layer 7: Safe Fallback Floor
  const floorBase = catalogDelta ? { ...defaultCaps, ...catalogDelta } : defaultCaps;
  return buildResolved({
    base: floorBase,
    provider,
    model: raw,
    defaultCaps,
    source: catalogDelta ? "catalog" : "default",
  });
}

function buildResolved({ base, provider, model, defaultCaps, source }) {
  const contextWindow =
    base.contextWindow ??
    base.context_window ??
    base.realContext ??
    base.real_context ??
    base.contextLength ??
    defaultCaps.contextWindow;

  const maxOutputTokens =
    base.maxOutputTokens ??
    base.max_output_tokens ??
    base.maxOutput ??
    defaultCaps.maxOutput;

  let supportsVision =
    base.supportsVision ??
    base.supports_vision ??
    base.vision ??
    false;

  if (!supportsVision && looksLikeVisionModel(model)) {
    supportsVision = true;
  }

  const supportsTools =
    base.supportsTools ??
    base.supports_tools ??
    base.tools ??
    defaultCaps.tools;

  const supportsReasoning =
    base.supportsReasoning ??
    base.supports_reasoning ??
    base.reasoning ??
    defaultCaps.reasoning;

  const supportsAudio =
    base.supportsAudio ??
    base.supports_audio ??
    base.audioInput ??
    false;

  const supportsVideo =
    base.supportsVideo ??
    base.supports_video ??
    base.videoInput ??
    false;

  const supportsStreaming =
    base.supportsStreaming ??
    base.supports_streaming ??
    true;

  return {
    provider,
    model,
    contextWindow,
    maxOutputTokens,
    supportsVision: Boolean(supportsVision),
    supportsTools: Boolean(supportsTools),
    supportsReasoning: Boolean(supportsReasoning),
    supportsAudio: Boolean(supportsAudio),
    supportsVideo: Boolean(supportsVideo),
    supportsStreaming: Boolean(supportsStreaming),
    thinkingFormat: base.thinkingFormat || null,
    source,
  };
}

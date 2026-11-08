/**
 * Model capabilities precedence cascade as a pure function (Wave 6 / Spec 017).
 *
 * Precedence Order (per field):
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

const BOOLEAN_FIELDS = {
  supportsVision: ["supportsVision", "supports_vision", "vision"],
  supportsTools: ["supportsTools", "supports_tools", "tools", "tool_call"],
  supportsAudio: ["supportsAudio", "supports_audio", "audioInput", "audio_input"],
  supportsVideo: ["supportsVideo", "supports_video", "videoInput", "video_input"],
  supportsStreaming: ["supportsStreaming", "supports_streaming", "streaming"],
  supportsImageGeneration: [
    "supportsImageGeneration",
    "supports_image_generation",
    "imageGeneration",
    "image_generation",
    "imageOutput",
    "image_output",
  ],
  supportsImageEditing: [
    "supportsImageEditing",
    "supports_image_editing",
    "imageEditing",
    "image_editing",
  ],
  supportsWebSearch: [
    "supportsWebSearch",
    "supports_web_search",
    "webSearch",
    "web_search",
    "search",
  ],
  supportsWebFetch: [
    "supportsWebFetch",
    "supports_web_fetch",
    "webFetch",
    "web_fetch",
  ],
};

const ADVANCED_BOOLEAN_FIELDS = new Set([
  "supportsImageGeneration",
  "supportsImageEditing",
  "supportsWebSearch",
  "supportsWebFetch",
]);

const LIMIT_FIELDS = {
  contextWindow: ["contextWindow", "context_window", "realContext", "real_context", "contextLength", "context_length"],
  maxOutputTokens: ["maxOutputTokens", "max_output_tokens", "maxOutput", "max_output"],
};

const SOURCE_PRECEDENCE = [
  "manual",
  "auto:discovery",
  "provider",
  "catalog",
  "canonical",
  "pattern",
  "default",
];

export function normalizeModelIds(modelStr) {
  if (!modelStr) return { canonical: "", raw: "" };
  const raw = String(modelStr).trim();
  const canonical = raw.includes("/") ? raw.split("/").pop() || raw : raw;
  return { canonical, raw };
}

function parsePositiveIntegerLimit(val) {
  if (typeof val === "number") {
    if (!Number.isFinite(val) || val < 1) return null;
    return Math.floor(val);
  }
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.floor(n);
  }
  return null;
}

function unwrapOverride(item) {
  if (!item || typeof item !== "object") return null;
  let caps = item;
  if (item.capabilities && typeof item.capabilities === "object" && !Array.isArray(item.capabilities)) {
    caps = { ...item, ...item.capabilities };
  }
  if (typeof item.capabilities_json === "string") {
    try {
      const parsed = JSON.parse(item.capabilities_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        caps = { ...item, ...parsed };
      }
    } catch {
      // Ignore JSON parse errors on malformed storage rows
    }
  }
  return caps;
}

function normalizeLayer(layerData) {
  if (!layerData || typeof layerData !== "object") return null;
  const unwrap = unwrapOverride(layerData);
  if (!unwrap) return null;

  const out = {};

  // Boolean capability fields
  for (const [canonicalField, aliases] of Object.entries(BOOLEAN_FIELDS)) {
    for (const alias of aliases) {
      if (typeof unwrap[alias] === "boolean") {
        out[canonicalField] = unwrap[alias];
        break;
      }
    }
  }

  // Numeric limit fields (integer >= 1)
  for (const [canonicalField, aliases] of Object.entries(LIMIT_FIELDS)) {
    for (const alias of aliases) {
      const parsed = parsePositiveIntegerLimit(unwrap[alias]);
      if (parsed !== null) {
        out[canonicalField] = parsed;
        break;
      }
    }
    if (out[canonicalField] === undefined && unwrap.limit) {
      const key = canonicalField === "contextWindow" ? "context" : "output";
      const parsed = parsePositiveIntegerLimit(unwrap.limit[key]);
      if (parsed !== null) out[canonicalField] = parsed;
    }
  }

  // Reasoning support & effort levels (without Boolean(object)->true bug)
  const reasoningVal =
    unwrap.supportsReasoning ??
    unwrap.supports_reasoning ??
    unwrap.reasoning ??
    unwrap.reasoning_effort;

  if (typeof reasoningVal === "boolean") {
    out.supportsReasoning = reasoningVal;
  } else if (reasoningVal && typeof reasoningVal === "object" && !Array.isArray(reasoningVal)) {
    if (typeof reasoningVal.supported === "boolean") {
      out.supportsReasoning = reasoningVal.supported;
    } else if (
      (Array.isArray(reasoningVal.effortLevels) && reasoningVal.effortLevels.length > 0) ||
      (Array.isArray(reasoningVal.supported_efforts) && reasoningVal.supported_efforts.length > 0) ||
      reasoningVal.default_effort
    ) {
      out.supportsReasoning = true;
    }
    const efforts = reasoningVal.effortLevels || reasoningVal.supported_efforts;
    if (Array.isArray(efforts) && efforts.length > 0) {
      out.effortLevels = efforts.map(String);
    }
  }

  const topEfforts =
    unwrap.effortLevels ??
    unwrap.supportedThinkingEfforts ??
    unwrap.supported_reasoning_levels;

  if (Array.isArray(topEfforts) && topEfforts.length > 0) {
    out.effortLevels = topEfforts.map(String);
    if (out.supportsReasoning === undefined) out.supportsReasoning = true;
  }

  // Thinking format: string only, null/undefined never shadows lower layers
  const fmt = unwrap.thinkingFormat ?? unwrap.thinking_format;
  if (typeof fmt === "string" && fmt.trim() !== "") {
    out.thinkingFormat = fmt.trim();
  }

  // Modalities input array support (from catalogSource / models.dev)
  const modalitiesInput = Array.isArray(unwrap.modalities?.input)
    ? unwrap.modalities.input
    : Array.isArray(unwrap.input)
    ? unwrap.input
    : null;

  if (modalitiesInput) {
    if (out.supportsVision === undefined && modalitiesInput.includes("image")) out.supportsVision = true;
    if (out.supportsAudio === undefined && modalitiesInput.includes("audio")) out.supportsAudio = true;
    if (out.supportsVideo === undefined && modalitiesInput.includes("video")) out.supportsVideo = true;
  }

  // Derive image generation and editing from explicit kind / type (never model name)
  const explicitKind = String(
    unwrap.kind || unwrap.type || unwrap.raw?.kind || unwrap.raw?.type || unwrap.serviceKind || ""
  ).toLowerCase().trim();

  if (explicitKind) {
    if (explicitKind === "image" || explicitKind === "text-to-image") {
      if (out.supportsImageGeneration === undefined) {
        out.supportsImageGeneration = true;
      }
    } else if (explicitKind === "image-to-image" || explicitKind === "inpainting") {
      if (out.supportsImageEditing === undefined) {
        out.supportsImageEditing = true;
      }
      if (out.supportsImageGeneration === undefined) {
        out.supportsImageGeneration = true;
      }
    } else if (explicitKind === "websearch") {
      if (out.supportsWebSearch === undefined) {
        out.supportsWebSearch = true;
      }
    } else if (explicitKind === "webfetch") {
      if (out.supportsWebFetch === undefined) {
        out.supportsWebFetch = true;
      }
    }
  }

  const rawCaps = Array.isArray(unwrap.capabilities)
    ? unwrap.capabilities
    : Array.isArray(unwrap.raw?.capabilities)
    ? unwrap.raw.capabilities
    : null;
  if (rawCaps) {
    if (rawCaps.includes("edit") || rawCaps.includes("inpainting") || rawCaps.includes("mask")) {
      if (out.supportsImageEditing === undefined) out.supportsImageEditing = true;
    }
  }

  // Modalities output array support (from catalogSource / models.dev)
  const modalitiesOutput = Array.isArray(unwrap.modalities?.output)
    ? unwrap.modalities.output
    : Array.isArray(unwrap.output)
    ? unwrap.output
    : null;

  if (modalitiesOutput) {
    if (out.supportsImageGeneration === undefined && modalitiesOutput.includes("image")) {
      out.supportsImageGeneration = true;
    }
    if (out.supportsAudio === undefined && modalitiesOutput.includes("audio")) {
      out.supportsAudio = true;
    }
  }

  return out;
}

function mergeLayerSpecificity(objects) {
  if (!objects || objects.length === 0) return null;
  const result = {};
  for (const obj of objects) {
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (result[k] === undefined && v !== undefined) {
        result[k] = v;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function isSourceMatch(item, expectedSource) {
  if (!expectedSource || !item || typeof item !== "object") return true;
  if (!item.source) return true;
  const s = String(item.source).trim();
  if (expectedSource === "manual") return s === "manual";
  if (expectedSource === "auto:discovery") return s === "auto:discovery" || s === "auto";
  return s === expectedSource;
}

function rankArrayItem(item, provider, canonicalModel, rawModel) {
  if (!item || typeof item !== "object") return -1;
  const itemProv = item.provider ? String(item.provider).trim() : null;
  const itemModel = item.modelId || item.model_id;
  const itemPattern = item.model_pattern || item.modelPattern;

  const matchesProv = itemProv && provider && itemProv === provider;
  const isLegacyProv = !itemProv || itemProv === "*";

  if (matchesProv) {
    if (itemModel === rawModel) return 0; // exactraw
    if (itemModel === canonicalModel) return 1; // exactcanonical
    if (itemPattern && (matchPattern(itemPattern, rawModel) || matchPattern(itemPattern, canonicalModel))) return 2; // patterns
  } else if (isLegacyProv) {
    if (itemModel === rawModel || (itemPattern === rawModel && itemPattern !== "*")) return 3; // legacyraw
    if (itemModel === canonicalModel || (itemPattern === canonicalModel && itemPattern !== "*")) return 4; // legacycanonical
    if (itemPattern && itemPattern !== "*" && (matchPattern(itemPattern, rawModel) || matchPattern(itemPattern, canonicalModel))) return 5; // patterns
    if (itemPattern === "*" || (!itemPattern && !itemModel)) return 6; // wildcard
  }
  return -1;
}

function findInArray(items, provider, canonicalModel, rawModel, expectedSource) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const rankedItems = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (!isSourceMatch(item, expectedSource)) continue;

    const rank = rankArrayItem(item, provider, canonicalModel, rawModel);
    if (rank === -1) continue;

    const norm = normalizeLayer(item);
    if (norm) {
      rankedItems.push({ rank, norm });
    }
  }

  if (rankedItems.length === 0) return null;
  rankedItems.sort((a, b) => a.rank - b.rank);
  return mergeLayerSpecificity(rankedItems.map((x) => x.norm));
}

export function findOverride(overrides, provider, canonicalModel, rawModel, expectedSource = null) {
  if (!overrides) return null;

  // 1. Map lookup (check full provider/raw first, fill holes from broader keys)
  if (overrides instanceof Map) {
    const keys = [
      provider ? `${provider}/${rawModel}` : null,
      provider && canonicalModel !== rawModel ? `${provider}/${canonicalModel}` : null,
      rawModel,
      canonicalModel !== rawModel ? canonicalModel : null,
    ].filter(Boolean);

    const normalizedList = [];
    for (const k of keys) {
      if (overrides.has(k)) {
        const val = overrides.get(k);
        if (isSourceMatch(val, expectedSource)) {
          const norm = normalizeLayer(val);
          if (norm) normalizedList.push(norm);
        }
      }
    }
    return mergeLayerSpecificity(normalizedList);
  }

  // 2. Plain Object / nested Record
  if (typeof overrides === "object" && !Array.isArray(overrides)) {
    const normalizedList = [];

    if (provider && overrides[provider] && typeof overrides[provider] === "object") {
      const pGroup = overrides[provider];
      if (pGroup[rawModel] !== undefined && isSourceMatch(pGroup[rawModel], expectedSource)) {
        const norm = normalizeLayer(pGroup[rawModel]);
        if (norm) normalizedList.push(norm);
      }
      if (canonicalModel !== rawModel && pGroup[canonicalModel] !== undefined && isSourceMatch(pGroup[canonicalModel], expectedSource)) {
        const norm = normalizeLayer(pGroup[canonicalModel]);
        if (norm) normalizedList.push(norm);
      }
    }

    const keys = [
      provider ? `${provider}/${rawModel}` : null,
      provider && canonicalModel !== rawModel ? `${provider}/${canonicalModel}` : null,
      rawModel,
      canonicalModel !== rawModel ? canonicalModel : null,
    ].filter(Boolean);

    for (const k of keys) {
      if (overrides[k] !== undefined && isSourceMatch(overrides[k], expectedSource)) {
        const norm = normalizeLayer(overrides[k]);
        if (norm) normalizedList.push(norm);
      }
    }
    return mergeLayerSpecificity(normalizedList);
  }

  // 3. Array of override objects [{ provider, modelId, ... }]
  if (Array.isArray(overrides)) {
    return findInArray(overrides, provider, canonicalModel, rawModel, expectedSource);
  }

  return null;
}

export function resolveModelCapabilities(target, sources = {}, options = {}) {
  const targetObj = typeof target === "string" ? { model: target } : target;
  const provider = targetObj?.provider || null;
  const rawModelInput = targetObj?.model || targetObj?.modelId || targetObj?.model_id || "";
  const { canonical, raw } = normalizeModelIds(rawModelInput);

  const usePersisted = options.persistedOverrides !== false;

  const defaultCaps = sources.defaultCapabilities || DEFAULT_CAPABILITIES;
  const providerCaps = sources.providerOverrides || PROVIDER_CAPABILITIES;
  const modelCaps = sources.modelCapabilities || MODEL_CAPABILITIES;
  const patternCaps = sources.patternCapabilities || PATTERN_CAPABILITIES;
  const catalogSource = sources.catalogSource || null;

  const layers = [];

  // Layer 1: Manual Operator Override (persisted)
  if (usePersisted && sources.manualOverrides) {
    const manualData = findOverride(sources.manualOverrides, provider, canonical, raw, "manual");
    if (manualData) {
      layers.push({ source: "manual", data: manualData });
    }
  }

  // Layer 2: Auto-Discovery Override (persisted)
  if (usePersisted && sources.autoOverrides) {
    const autoData = findOverride(sources.autoOverrides, provider, canonical, raw, "auto:discovery");
    if (autoData) {
      layers.push({ source: "auto:discovery", data: autoData });
    }
  }

  // Layer 3: Provider-Specific Static Registry Override
  if (provider && providerCaps && providerCaps[provider]) {
    const pGroup = providerCaps[provider];
    const normRaw = pGroup[raw] ? normalizeLayer(pGroup[raw]) : null;
    const normCanonical = (canonical !== raw && pGroup[canonical]) ? normalizeLayer(pGroup[canonical]) : null;
    const merged = mergeLayerSpecificity([normRaw, normCanonical].filter(Boolean));
    if (merged) {
      layers.push({ source: "provider", data: merged });
    }
  }

  // Layer 4: Synced Catalog (models.dev deltas)
  if (catalogSource) {
    const limits =
      catalogSource.getLimits?.(provider, raw) ||
      catalogSource.getLimits?.(provider, canonical);
    const modalities =
      catalogSource.getModalities?.(provider, raw) ||
      catalogSource.getModalities?.(provider, canonical);
    if (limits || modalities) {
      layers.push({
        source: "catalog",
        data: normalizeLayer({ ...(limits || {}), ...(modalities || {}), modalities }),
      });
    }
  }

  // Layer 5: Canonical Exact Model Entry (and target input declarations)
  const exactModel = modelCaps[raw] || modelCaps[canonical];
  const normTarget = normalizeLayer(targetObj);
  const canonicalMerged = mergeLayerSpecificity([
    exactModel ? normalizeLayer(exactModel) : null,
    normTarget,
  ].filter(Boolean));
  if (canonicalMerged) {
    layers.push({ source: "canonical", data: canonicalMerged });
  }

  // Layer 6: Pattern Capabilities
  if (Array.isArray(patternCaps)) {
    for (const item of patternCaps) {
      if (!item) continue;
      const pat = item.pattern || item.model_pattern;
      const caps = item.caps || item.capabilities || item;
      if (pat && (matchPattern(pat, raw) || matchPattern(pat, canonical))) {
        layers.push({ source: "pattern", data: normalizeLayer(caps) });
        break;
      }
    }
  }

  // Layer 7: Safe Fallback Floor (default layer never invents false for advanced fields)
  const normDefault = normalizeLayer(defaultCaps);
  if (normDefault) {
    for (const f of ADVANCED_BOOLEAN_FIELDS) {
      delete normDefault[f];
    }
    layers.push({ source: "default", data: normDefault });
  }

  // Merge fields across cascade
  const resolved = {};
  const provenance = {};

  const allFieldKeys = [
    ...Object.keys(BOOLEAN_FIELDS),
    ...Object.keys(LIMIT_FIELDS),
    "supportsReasoning",
    "thinkingFormat",
  ];

  for (const field of allFieldKeys) {
    for (const layer of layers) {
      if (layer.data && layer.data[field] !== undefined) {
        resolved[field] = layer.data[field];
        provenance[field] = layer.source;
        break;
      }
    }
  }

  // Advanced capability flags: unknown is null, never invent false if no evidence
  for (const field of ADVANCED_BOOLEAN_FIELDS) {
    if (resolved[field] === undefined) {
      resolved[field] = null;
      provenance[field] = "unknown";
    }
  }

  // Validate limits against defaultCaps / DEFAULT_CAPABILITIES canonical fallback
  if (resolved.contextWindow === undefined) {
    resolved.contextWindow =
      parsePositiveIntegerLimit(defaultCaps.contextWindow ?? defaultCaps.context_window) ??
      parsePositiveIntegerLimit(DEFAULT_CAPABILITIES.contextWindow) ??
      4096;
    provenance.contextWindow = "default";
  }

  if (resolved.maxOutputTokens === undefined) {
    resolved.maxOutputTokens =
      parsePositiveIntegerLimit(defaultCaps.maxOutput ?? defaultCaps.max_output ?? defaultCaps.maxOutputTokens) ??
      parsePositiveIntegerLimit(DEFAULT_CAPABILITIES.maxOutput) ??
      1024;
    provenance.maxOutputTokens = "default";
  }

  if (resolved.supportsVision === undefined) {
    resolved.supportsVision = false;
    provenance.supportsVision = "default";
  }

  if (resolved.supportsTools === undefined) {
    resolved.supportsTools = defaultCaps.tools ?? DEFAULT_CAPABILITIES.tools ?? true;
    provenance.supportsTools = "default";
  }

  if (resolved.supportsReasoning === undefined) {
    resolved.supportsReasoning = defaultCaps.reasoning ?? DEFAULT_CAPABILITIES.reasoning ?? false;
    provenance.supportsReasoning = "default";
  }

  if (resolved.supportsAudio === undefined) {
    resolved.supportsAudio = defaultCaps.audioInput ?? false;
    provenance.supportsAudio = "default";
  }

  if (resolved.supportsVideo === undefined) {
    resolved.supportsVideo = defaultCaps.videoInput ?? false;
    provenance.supportsVideo = "default";
  }

  if (resolved.supportsStreaming === undefined) {
    resolved.supportsStreaming = defaultCaps.supportsStreaming ?? defaultCaps.streaming ?? true;
    provenance.supportsStreaming = "default";
  }

  if (resolved.thinkingFormat === undefined) {
    resolved.thinkingFormat = defaultCaps.thinkingFormat ?? null;
    provenance.thinkingFormat = "default";
  }

  // Name heuristic runs ONLY if NO authoritative non-default layer provided evidence for vision
  if (!resolved.supportsVision && provenance.supportsVision === "default") {
    if (looksLikeVisionModel(raw) || looksLikeVisionModel(canonical)) {
      resolved.supportsVision = true;
      provenance.supportsVision = "pattern";
    }
  }

  // Calculate highest participating source for legacy source compatibility
  const participatingSources = new Set(Object.values(provenance));
  let highestSource = "default";
  for (const s of SOURCE_PRECEDENCE) {
    if (participatingSources.has(s)) {
      highestSource = s;
      break;
    }
  }

  const result = {
    provider,
    model: raw,
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
    supportsVision: Boolean(resolved.supportsVision),
    supportsTools: Boolean(resolved.supportsTools),
    supportsReasoning: Boolean(resolved.supportsReasoning),
    supportsAudio: Boolean(resolved.supportsAudio),
    supportsVideo: Boolean(resolved.supportsVideo),
    supportsStreaming: Boolean(resolved.supportsStreaming),
    supportsImageGeneration: resolved.supportsImageGeneration ?? null,
    supportsImageEditing: resolved.supportsImageEditing ?? null,
    supportsWebSearch: resolved.supportsWebSearch ?? null,
    supportsWebFetch: resolved.supportsWebFetch ?? null,
    thinkingFormat: resolved.thinkingFormat || null,
    source: highestSource,
    provenance,
  };

  // Only expose effortLevels when reasoning is supported
  if (resolved.supportsReasoning) {
    for (const layer of layers) {
      if (Array.isArray(layer.data?.effortLevels) && layer.data.effortLevels.length > 0) {
        result.effortLevels = [...layer.data.effortLevels];
        result.supportedThinkingEfforts = [...layer.data.effortLevels];
        provenance.effortLevels = layer.source;
        provenance.supportedThinkingEfforts = layer.source;
        break;
      }
    }
  }

  return result;
}

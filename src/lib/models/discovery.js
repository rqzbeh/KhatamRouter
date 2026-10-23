/**
 * Defensive normalisation of upstream /v1/models payloads (Wave 6).
 *
 * Upstream gateways expose models across diverse schemas (Standard OpenAI,
 * OpenRouter architecture/modality, Lemonade labels, Ollama native models array).
 * Every function in this module is guaranteed to NEVER throw, even when given
 * corrupt, circular, null, or malformed data.
 */

const CANONICAL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SYNONYMS = { extra: "xhigh", maximum: "max", min: "low" };

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Return the first candidate that is a finite, positive number.
 */
export function firstPositiveNumber(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * Detect vision (image input) support from an upstream record.
 * Never throws. Returns boolean.
 */
export function detectVisionInput(record) {
  if (!record || typeof record !== "object") return false;
  try {
    if (record.supportsVision === true || record.vision === true || record.supports_vision === true) {
      return true;
    }

    const architecture = asRecord(record.architecture);

    // Array of input modalities (e.g. ["text", "image"])
    const checkModalitiesList = (list) => {
      if (!Array.isArray(list)) return false;
      return list.some((entry) => {
        const s = toNonEmptyString(entry);
        return s ? s.toLowerCase() === "image" || s.toLowerCase() === "vision" : false;
      });
    };

    if (checkModalitiesList(architecture.input_modalities)) return true;
    if (checkModalitiesList(record.input_modalities)) return true;

    // Modality string (e.g. "text+image->text" — input is before ->)
    const modalityStr = toNonEmptyString(architecture.modality) || toNonEmptyString(record.modality);
    if (modalityStr) {
      const [inputPart] = modalityStr.toLowerCase().split("->");
      if ((inputPart || "").includes("image") || (inputPart || "").includes("vision")) return true;
    }

    // Lemonade Server / labels array (e.g. ["chat", "vision", "tool-calling"])
    const labels = Array.isArray(record.labels) ? record.labels : [];
    if (labels.some((l) => {
      const s = toNonEmptyString(l);
      return s ? s.toLowerCase() === "vision" || s.toLowerCase() === "image" : false;
    })) {
      return true;
    }

    // Ollama / capabilities array
    const caps = Array.isArray(record.capabilities) ? record.capabilities : [];
    if (caps.some((c) => {
      const s = toNonEmptyString(c);
      return s ? s.toLowerCase() === "vision" || s.toLowerCase() === "image" : false;
    })) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect tools (function calling) support from an upstream record.
 * Never throws. Returns boolean.
 */
export function detectToolsSupport(record) {
  if (!record || typeof record !== "object") return false;
  try {
    if (record.supportsTools === true || record.tools === true || record.tool_calling === true || record.toolCalling === true) {
      return true;
    }
    if (record.supportsTools === false || record.tools === false || record.tool_calling === false || record.toolCalling === false) {
      return false;
    }

    const labels = Array.isArray(record.labels) ? record.labels : [];
    if (labels.some((l) => {
      const s = toNonEmptyString(l)?.toLowerCase();
      return s === "tool-calling" || s === "tools" || s === "functions" || s === "function-calling";
    })) {
      return true;
    }

    const caps = Array.isArray(record.capabilities) ? record.capabilities : [];
    if (caps.some((c) => {
      const s = toNonEmptyString(c)?.toLowerCase();
      return s === "tools" || s === "tool_calling" || s === "functions";
    })) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Normalize an effort string onto the canonical vocabulary.
 */
export function normalizeSupportedEffort(effort) {
  if (typeof effort !== "string") return "";
  const trimmed = effort.trim().toLowerCase();
  if (CANONICAL_EFFORTS.includes(trimmed)) return trimmed;
  return EFFORT_SYNONYMS[trimmed] || trimmed;
}

/**
 * Detect supported reasoning / thinking effort levels.
 * Never throws. Returns string[] | undefined.
 */
export function detectSupportedThinkingEfforts(record) {
  if (!record || typeof record !== "object") return undefined;
  try {
    if (Array.isArray(record.supportedThinkingEfforts) && record.supportedThinkingEfforts.length > 0) {
      return record.supportedThinkingEfforts
        .filter((e) => typeof e === "string" && e.length > 0)
        .map(normalizeSupportedEffort);
    }

    const reasoning = asRecord(record.reasoning);
    const candidateList =
      (Array.isArray(reasoning.supported_efforts) && reasoning.supported_efforts) ||
      (Array.isArray(record.supported_reasoning_levels) && record.supported_reasoning_levels) ||
      (Array.isArray(record.thinking?.levels) && record.thinking.levels) ||
      null;

    if (!candidateList) return undefined;

    const efforts = [];
    for (const entry of candidateList) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        efforts.push(normalizeSupportedEffort(entry));
      } else if (entry && typeof entry === "object") {
        const val = toNonEmptyString(entry.effort) || toNonEmptyString(entry.value) || toNonEmptyString(entry.id);
        if (val) efforts.push(normalizeSupportedEffort(val));
      }
    }

    const deduped = Array.from(new Set(efforts.filter(Boolean)));
    return deduped.length > 0 ? deduped : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect vendor-declared default reasoning effort.
 * Never throws. Returns string | undefined.
 */
export function detectDefaultThinkingEffort(record) {
  if (!record || typeof record !== "object") return undefined;
  try {
    const rawDefault =
      toNonEmptyString(record.defaultThinkingEffort) ||
      toNonEmptyString(record.reasoning?.default_effort);
    return rawDefault ? normalizeSupportedEffort(rawDefault) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect reasoning support from an upstream record.
 * Never throws. Returns boolean.
 */
export function detectReasoningSupport(record) {
  if (!record || typeof record !== "object") return false;
  try {
    if (record.supportsReasoning === true || record.reasoning === true || record.reasoning_effort === true) {
      return true;
    }
    const reasoning = asRecord(record.reasoning);
    if (reasoning.supported_efforts || reasoning.default_effort) return true;

    if (Array.isArray(record.supported_reasoning_levels) && record.supported_reasoning_levels.length > 0) {
      return true;
    }

    const labels = Array.isArray(record.labels) ? record.labels : [];
    if (labels.some((l) => {
      const s = toNonEmptyString(l)?.toLowerCase();
      return s === "reasoning" || s === "thinking";
    })) {
      return true;
    }

    const caps = Array.isArray(record.capabilities) ? record.capabilities : [];
    if (caps.some((c) => {
      const s = toNonEmptyString(c)?.toLowerCase();
      return s === "reasoning" || s === "thinking";
    })) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Extract context window (token limit) from diverse upstream candidate fields.
 * Never throws. Returns number | null.
 */
export function extractContextWindow(record) {
  if (!record || typeof record !== "object") return null;
  try {
    const topProvider = asRecord(record.top_provider);
    return firstPositiveNumber(
      record.context_length,
      record.contextLength,
      record.context_window,
      record.contextWindow,
      record.max_model_len,
      record.maxModelLen,
      record.max_context_window,
      record.max_context_window_tokens,
      record.max_input_tokens,
      record.maxInputTokens,
      record.inputTokenLimit,
      topProvider.context_length
    );
  } catch {
    return null;
  }
}

/**
 * Extract maximum output completion tokens from diverse upstream candidate fields.
 * Never throws. Returns number | null.
 */
export function extractMaxOutputTokens(record) {
  if (!record || typeof record !== "object") return null;
  try {
    const topProvider = asRecord(record.top_provider);
    return firstPositiveNumber(
      record.max_output_tokens,
      record.maxOutputTokens,
      record.outputTokenLimit,
      record.output_tokens,
      record.max_tokens,
      topProvider.max_completion_tokens
    );
  } catch {
    return null;
  }
}

/**
 * Defensively normalize an upstream /v1/models payload into standardized model descriptors.
 *
 * Handles:
 * - Standard OpenAI: `{ object: "list", data: [{ id: "...", ... }] }`
 * - OpenRouter: `{ data: [{ id: "...", architecture: {...}, context_length: ... }] }`
 * - Lemonade Server: `{ data: [{ id: "...", labels: [...] }] }`
 * - Ollama: `{ models: [{ name: "...", details: {...}, capabilities: [...] }] }`
 * - Direct arrays: `[{ id: "...", ... }]`
 * - Missing/null/invalid inputs: returns `[]` without throwing
 *
 * @param {unknown} payload
 * @param {string|object} [providerIdOrOptions]
 * @returns {Array<object>}
 */
export function normalizeDiscoveredModels(payload, providerIdOrOptions = null) {
  if (!payload) return [];

  const provider = typeof providerIdOrOptions === "string"
    ? providerIdOrOptions
    : (providerIdOrOptions?.provider || providerIdOrOptions?.providerId || null);

  let rawList = null;
  try {
    if (Array.isArray(payload)) {
      rawList = payload;
    } else if (payload && typeof payload === "object") {
      if (Array.isArray(payload.data)) {
        rawList = payload.data;
      } else if (Array.isArray(payload.models)) {
        rawList = payload.models;
      }
    }
  } catch {
    return [];
  }

  if (!rawList || !Array.isArray(rawList)) return [];

  const deduped = new Map();

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;

    try {
      const id =
        toNonEmptyString(item.id) ||
        toNonEmptyString(item.name) ||
        toNonEmptyString(item.model);
      if (!id) continue;

      const name =
        toNonEmptyString(item.name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.display_name) ||
        id;

      const supportsVision = detectVisionInput(item);
      const supportsTools = detectToolsSupport(item);
      const supportsReasoning = detectReasoningSupport(item);
      const supportedThinkingEfforts = detectSupportedThinkingEfforts(item);
      const defaultThinkingEffort = detectDefaultThinkingEffort(item);

      const contextWindow = extractContextWindow(item);
      const maxOutputTokens = extractMaxOutputTokens(item);

      const modalities = ["text"];
      if (supportsVision) modalities.push("image");

      const itemProvider =
        toNonEmptyString(item.provider) ||
        toNonEmptyString(item.providerId) ||
        provider ||
        null;

      const normalized = {
        id,
        name,
        ...(itemProvider ? { provider: itemProvider } : {}),
        contextWindow,
        maxOutputTokens,
        supportsVision,
        supportsTools,
        supportsReasoning,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: item.supports_streaming !== false && item.stream !== false,
        ...(supportedThinkingEfforts ? { supportedThinkingEfforts } : {}),
        ...(defaultThinkingEffort ? { defaultThinkingEffort } : {}),
        modalities,
        raw: item,
      };

      deduped.set(id, normalized);
    } catch {
      // Individual record failure dropped defensively
      continue;
    }
  }

  return Array.from(deduped.values());
}

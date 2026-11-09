/**
 * src/lib/models/listingCompleteness.js
 *
 * Pure, shared completeness evaluation, pagination detection, and shape normalizers
 * for model discovery across all provider adapters in KhatamRouter.
 */

export const MAX_PAGINATION_PAGES = 20;
export const MAX_PAGINATION_RECORDS = 160000;
export const MAX_PAGINATION_DEADLINE_MS = 30000;

export const VALID_CLOUDFLARE_ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Known Cloudflare Workers AI task mapping to canonical KhatamRouter kinds and types.
 * Image-to-text is a vision LLM, NOT an image generation model.
 * Speech recognition is stt, text-to-speech is tts.
 * Unknown tasks are preserved without inferring llm.
 */
export const CLOUDFLARE_TASK_MAP = {
  // LLM / text generation
  "text generation": { type: "llm", kind: "llm" },
  "text-generation": { type: "llm", kind: "llm" },
  "translation": { type: "llm", kind: "llm" },
  "summarization": { type: "llm", kind: "llm" },

  // Vision LLM: image-to-text is a vision LLM, NOT image generation!
  "image-to-text": { type: "llm", kind: "llm", supportsVision: true },

  // Image generation & editing
  "text-to-image": { type: "image", kind: "image" },
  "image-to-image": { type: "image", kind: "image", capabilities: ["edit"] },
  "inpainting": { type: "image", kind: "image", capabilities: ["edit", "mask"] },

  // Speech / Audio
  "automatic speech recognition": { type: "stt", kind: "stt" },
  "speech-to-text": { type: "stt", kind: "stt" },
  "text-to-speech": { type: "tts", kind: "tts" },

  // Embeddings
  "text embeddings": { type: "embedding", kind: "embedding" },
  "embeddings": { type: "embedding", kind: "embedding" },
};

/**
 * Supported proxy types in KhatamRouter.
 */
export const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify", "psiphon", "opencode2api"];

/**
 * Validates whether the resolved connection proxy configuration can be honored
 * by proxyAwareFetch.
 * Returns { ok: true, proxyOptions } if supported, or { ok: false, status: 503, error: string }
 * if unsupported or invalid.
 */
export function validateProxySupport(proxy, providerSpecificData = {}) {
  const psd = providerSpecificData || {};
  const hasEgress = hasConfiguredProxyEgress(proxy, psd);

  if (!hasEgress) {
    return { ok: true, proxyOptions: null };
  }

  if (proxy?.source === "error" || proxy?.error) {
    return {
      ok: false,
      status: 503,
      error: "Configured proxy egress resolution failed (fail-closed)",
    };
  }

  // Check if proxy pool has an unsupported type
  if (proxy?.proxyPool) {
    const poolType = proxy.proxyPool.type;
    if (poolType && !VALID_PROXY_TYPES.includes(poolType)) {
      return {
        ok: false,
        status: 503,
        error: `Configured proxy pool type '${poolType}' is unsupported for model discovery (fail-closed)`,
      };
    }
  }

  // Check if providerSpecificData explicitly specified an unsupported proxy pool type
  if (psd?.proxyPool?.type && !VALID_PROXY_TYPES.includes(psd.proxyPool.type)) {
    return {
      ok: false,
      status: 503,
      error: `Configured proxy pool type '${psd.proxyPool.type}' is unsupported for model discovery (fail-closed)`,
    };
  }

  // Must have a usable proxy target: connectionProxyUrl, vercelRelayUrl, psiphon, or opencode2api sidecar
  const hasTarget = Boolean(
    proxy?.connectionProxyUrl ||
    proxy?.vercelRelayUrl ||
    proxy?.psiphonPoolId ||
    proxy?.opencodeSidecarUrl ||
    proxy?.opencodeSidecarPoolId ||
    psd?.connectionProxyUrl ||
    psd?.vercelRelayUrl ||
    psd?.opencodeSidecarUrl ||
    psd?.opencodeSidecarPoolId
  );

  if (!hasTarget) {
    return {
      ok: false,
      status: 503,
      error: "Configured proxy egress cannot be honored: missing proxy URL or pool target (fail-closed)",
    };
  }

  const proxyOptions = {
    connectionProxyEnabled: proxy?.connectionProxyEnabled === true || psd?.connectionProxyEnabled === true,
    connectionProxyUrl: proxy?.connectionProxyUrl || psd?.connectionProxyUrl || "",
    connectionNoProxy: proxy?.connectionNoProxy || psd?.connectionNoProxy || "",
    vercelRelayUrl: proxy?.vercelRelayUrl || psd?.vercelRelayUrl || "",
    strictProxy: true, // Fail-closed: never silently fall back to direct host egress on failure
    proxyPoolId: proxy?.proxyPoolId || psd?.proxyPoolId || "",
    proxyPool: proxy?.proxyPool || psd?.proxyPool || null,
    psiphonPoolId: proxy?.psiphonPoolId || psd?.psiphonPoolId || "",
    opencodeSidecarUrl: proxy?.opencodeSidecarUrl || psd?.opencodeSidecarUrl || "",
    opencodeSidecarKey: proxy?.opencodeSidecarKey || psd?.opencodeSidecarKey || "",
    opencodeSidecarPoolId: proxy?.opencodeSidecarPoolId || psd?.opencodeSidecarPoolId || "",
    opencodeSidecarGeneration: proxy?.opencodeSidecarGeneration ?? psd?.opencodeSidecarGeneration ?? 0,
  };

  return { ok: true, proxyOptions };
}

/**
 * Check if the connection has configured proxy egress that would be bypassed
 * by direct host fetch.
 */
export function hasConfiguredProxyEgress(proxyConfig, providerSpecificData = null) {
  if (providerSpecificData && typeof providerSpecificData === "object") {
    if (
      providerSpecificData.strictProxy === true ||
      providerSpecificData.connectionProxyEnabled === true ||
      providerSpecificData.connectionProxyUrl ||
      providerSpecificData.proxyPoolId ||
      providerSpecificData.psiphonPoolId ||
      providerSpecificData.opencodeSidecarPoolId ||
      providerSpecificData.opencodeSidecarUrl
    ) {
      return true;
    }
  }
  if (!proxyConfig || typeof proxyConfig !== "object") return false;
  return Boolean(
    proxyConfig.strictProxy === true ||
    proxyConfig.connectionProxyEnabled === true ||
    proxyConfig.vercelRelayUrl ||
    proxyConfig.connectionProxyUrl ||
    proxyConfig.proxyPoolId ||
    proxyConfig.psiphonPoolId ||
    proxyConfig.opencodeSidecarPoolId ||
    proxyConfig.opencodeSidecarUrl
  );
}

/**
 * Conservative check for non-empty string, non-zero number, non-empty object/array,
 * or true boolean in pagination cursor/token/page candidate fields.
 */
export function isSignalPresent(val) {
  if (val === undefined || val === null || val === false || val === "" || val === 0) return false;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s.length > 0 && s !== "false" && s !== "null" && s !== "undefined" && s !== "0";
  }
  if (typeof val === "number") return Number.isFinite(val) && val > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "object") return Object.keys(val).length > 0;
  return Boolean(val);
}

/**
 * Shared conservative helper to detect pagination signals in OpenAI-style responses.
 * Ported directly from gateway to ensure identical semantics.
 */
export function hasOpenAIPaginationSignal(data) {
  if (!data || typeof data !== "object") return false;
  // Strict or string 'true' has_more
  if (data.has_more === true || (typeof data.has_more === "string" && data.has_more.trim().toLowerCase() === "true")) {
    return true;
  }
  // Check any pagination cursor / link / token / page markers:
  const candidateKeys = [
    "next",
    "next_page",
    "next_cursor",
    "nextPageToken",
    "next_token",
    "nextToken",
    "cursor",
    "after",
    "after_id",
  ];
  for (const k of candidateKeys) {
    if (isSignalPresent(data[k])) return true;
  }
  // Numeric pagination: e.g. page < total_pages
  if (typeof data.page === "number" && typeof data.total_pages === "number" && data.page < data.total_pages) {
    return true;
  }
  // last_id present along with has_more signal
  if (isSignalPresent(data.last_id) && data.has_more !== false) {
    return true;
  }
  return false;
}

/**
 * Evaluate raw OpenAI-style response for recognized shape, pagination signals,
 * and completeness. Never drops invalid raw records (they are passed through so
 * importer's inspectRawListing can suppress pruning safely).
 */
export function evaluateOpenAIListing(data) {
  if (!data || typeof data !== "object") {
    return {
      models: [],
      complete: false,
      recognized: false,
      warning: "OpenAI response was not a valid object or array",
    };
  }

  let rawArray = null;
  if (Array.isArray(data.data)) {
    rawArray = data.data;
  } else if (Array.isArray(data.models)) {
    rawArray = data.models;
  } else if (Array.isArray(data.results)) {
    rawArray = data.results;
  } else if (Array.isArray(data)) {
    rawArray = data;
  }

  if (!rawArray) {
    return {
      models: [],
      complete: false,
      recognized: false,
      warning: "OpenAI response lacked a recognized models array (expected data, models, results, or root array)",
    };
  }

  const hasPagination = hasOpenAIPaginationSignal(data);
  if (hasPagination) {
    return {
      models: rawArray,
      complete: false,
      recognized: true,
      warning: "Pagination signal detected; listing may be partial",
    };
  }

  return {
    models: rawArray,
    complete: true,
    recognized: true,
  };
}

/**
 * Validates Cloudflare account ID strictly against alphanumeric, dash, and underscore.
 */
export function validateCloudflareAccountId(accountId) {
  if (!accountId || typeof accountId !== "string") return false;
  return VALID_CLOUDFLARE_ACCOUNT_ID_REGEX.test(accountId.trim());
}

/**
 * Normalizes a Cloudflare Workers AI model search result row.
 * Preserves row.name as id when id is internal UUID or name starts with @cf/.
 * Maps exact known Cloudflare task categories. Unknown task categories are preserved
 * without inferring llm.
 * Malformed records without valid non-empty string id or name are never given fallback
 * strings that turn invalid records valid.
 */
export function mapCloudflareModelRow(row) {
  if (!row || typeof row !== "object") return row;

  const nameStr = typeof row.name === "string" ? row.name.trim() : "";
  const idStr = typeof row.id === "string" ? row.id.trim() : "";

  // If neither name nor id is a non-empty string, preserve raw properties as-is
  // without synthesizing an ID that turns an invalid record valid.
  if (!nameStr && !idStr) {
    return {
      ...row,
      raw: row,
    };
  }

  const isUuid = idStr && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idStr);
  const id = (nameStr && (isUuid || nameStr.startsWith("@cf/") || !idStr)) ? nameStr : (idStr || nameStr);
  const name = nameStr || idStr;

  const taskObj = row.task;
  const taskName = typeof taskObj === "object" && taskObj !== null
    ? (taskObj.name || taskObj.id || "")
    : (typeof taskObj === "string" ? taskObj : "");
  const normalizedTask = taskName.trim().toLowerCase();

  const mappedTask = CLOUDFLARE_TASK_MAP[normalizedTask];

  return {
    ...row,
    id,
    name,
    upstreamModelId: row.id,
    ...(mappedTask ? mappedTask : {}),
    description: row.description || "",
    task: row.task,
    raw: row,
  };
}

/**
 * Validates whether Antigravity (CodeAssist) models dictionary is a complete,
 * well-formed object dictionary with canonical string keys, no malformed entries,
 * and no pagination signals.
 */
export function validateAntigravityComplete(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.models || typeof data.models !== "object" || Array.isArray(data.models)) return false;
  const entries = Object.entries(data.models);
  if (entries.length === 0) return false;
  for (const [key, info] of entries) {
    if (typeof key !== "string" || !key.trim()) return false;
    if (!info || typeof info !== "object") return false;
  }
  if (hasOpenAIPaginationSignal(data)) return false;
  return true;
}

/**
 * Scrub sensitive keys from error strings and URLs to prevent logging keys.
 */
export function sanitizeNoKeys(str, keys = []) {
  if (typeof str !== "string") return String(str || "");
  let res = str.replace(/([?&]key=)[^&]+/gi, "$1[REDACTED]");
  for (const k of keys) {
    if (typeof k === "string" && k.length >= 4) {
      res = res.replaceAll(k, "[REDACTED]");
    }
  }
  return res;
}

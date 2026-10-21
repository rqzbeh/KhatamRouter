import {
  resolveProviderId,
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers.js";
import { getProviderNodes } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "./model.js";
import { isTrustedInternalRequest } from "./internalTrust.js";
import { keyAccessDeniedMessage } from "@/shared/constants/keyAccess.js";

const UUID_SUFFIX_REGEX = /-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const GENERAL_HEX_SUFFIX_REGEX = /-[0-9a-f]{8,}$/i;
const CACHE_TTL_MS = 30 * 1000; // 30-second TTL

// In-memory 30s cache for resolved model sets
const resolvedModelSetCache = new Map();

// In-memory 30s cache for provider nodes
let cachedNodes = null;
let cachedNodesExpiresAt = 0;

/**
 * Reset caches (exported for testing isolation).
 */
export function resetAllowedModelsCache() {
  resolvedModelSetCache.clear();
  cachedNodes = null;
  cachedNodesExpiresAt = 0;
}

/**
 * Fetch provider nodes with 30s in-memory caching.
 * @param {object} [options]
 * @returns {Promise<Array>}
 */
export async function getCachedProviderNodes(options = {}) {
  if (options.nodes) return options.nodes;
  const now = Date.now();
  if (cachedNodes && now < cachedNodesExpiresAt) {
    return cachedNodes;
  }
  try {
    const nodes = await getProviderNodes();
    cachedNodes = Array.isArray(nodes) ? nodes : [];
    cachedNodesExpiresAt = now + CACHE_TTL_MS;
    return cachedNodes;
  } catch {
    return cachedNodes || [];
  }
}

/**
 * Extract dimension from key record, access object, or raw value.
 */
function extractDimension(input, fieldName) {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    if (fieldName in input) return input[fieldName];
    if (input.access && fieldName in input.access) return input.access[fieldName];
  }
  return input;
}

/**
 * Parse and normalize a tri-state ACL dimension value.
 * Semantics:
 *  - null or undefined: null (wildcard / unrestricted: all allowed)
 *  - [] (empty array): [] (deny all: none allowed)
 *  - ["a", "b"]: string array normalized (case-insensitive whitelist)
 *  - Malformed strings, non-arrays, non-null objects: [] (FAIL CLOSED)
 *
 * @param {unknown} val - Raw dimension input
 * @returns {string[]|null} null for all-allowed, string[] for whitelist/deny
 */
export function parseTriState(val) {
  if (val === null || val === undefined) {
    return null; // Wildcard
  }
  let parsed = val;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Malformed JSON fails closed
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    // Malformed type fails closed
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Check if a service kind is allowed under tri-state rules.
 *
 * @param {unknown} allowedKinds - Tri-state allowedKinds value or key object
 * @param {string} kind - Requested kind (e.g. "llm", "stt", "tts", "embedding", "webSearch", "webFetch")
 * @returns {boolean} True if allowed, false if denied
 */
export function isKindAllowed(allowedKinds, kind) {
  if (!kind || typeof kind !== "string") return false;
  const list = parseTriState(extractDimension(allowedKinds, "allowedKinds"));
  if (list === null) return true; // null = all allowed
  if (list.length === 0) return false; // [] = none allowed
  const target = kind.trim().toLowerCase();
  return list.includes(target);
}

/**
 * Check if a combo is allowed under tri-state rules.
 *
 * @param {unknown} allowedCombos - Tri-state allowedCombos value or key object
 * @param {string} combo - Requested combo name
 * @returns {boolean} True if allowed, false if denied
 */
export function isComboAllowed(allowedCombos, combo) {
  if (!combo || typeof combo !== "string") return false;
  const list = parseTriState(extractDimension(allowedCombos, "allowedCombos"));
  if (list === null) return true; // null = all allowed
  if (list.length === 0) return false; // [] = none allowed
  const target = combo.trim().toLowerCase();
  return list.includes(target);
}

/**
 * Helper to strip UUID or hexadecimal suffix from compatible node IDs.
 * e.g. "openai-compatible-chat-f47ac10b-58cc-4372-a567-0e02b2c3d479" -> "openai-compatible-chat"
 */
function stripUuidSuffix(id) {
  if (typeof id !== "string") return id;
  let stripped = id.replace(UUID_SUFFIX_REGEX, "");
  if (stripped === id) {
    stripped = id.replace(GENERAL_HEX_SUFFIX_REGEX, "");
  }
  return stripped;
}

/**
 * Check if a provider is allowed under tri-state rules with node prefix resolution.
 *
 * @param {unknown} allowedProviders - Tri-state allowedProviders value or key object
 * @param {string} provider - Provider id or alias
 * @param {object} [options] - Options e.g. { nodes }
 * @returns {Promise<boolean>} True if allowed, false if denied
 */
export async function isProviderAllowed(allowedProviders, provider, options = {}) {
  if (!provider || typeof provider !== "string") return false;
  const list = parseTriState(extractDimension(allowedProviders, "allowedProviders"));
  if (list === null) return true; // null = all allowed
  if (list.length === 0) return false; // [] = none allowed

  const normProvider = provider.trim().toLowerCase();

  // 1. Direct match
  if (list.includes(normProvider)) return true;

  // 2. Resolved provider ID and alias
  const resolvedId = resolveProviderId(normProvider)?.toLowerCase();
  if (resolvedId && list.includes(resolvedId)) return true;

  const alias = getProviderAlias(normProvider)?.toLowerCase();
  if (alias && list.includes(alias)) return true;

  // 3. Provider-node-prefix resolution
  const nodes = await getCachedProviderNodes(options);
  const matchedNodeByProviderId = nodes.find(
    (n) => n?.id && n.id.toLowerCase() === normProvider
  );
  if (matchedNodeByProviderId?.prefix) {
    const nodePrefix = matchedNodeByProviderId.prefix.trim().toLowerCase();
    if (list.includes(nodePrefix)) return true;
  }

  const matchedNodeByPrefix = nodes.find(
    (n) => n?.prefix && n.prefix.trim().toLowerCase() === normProvider
  );
  if (matchedNodeByPrefix?.id) {
    const nodeId = matchedNodeByPrefix.id.toLowerCase();
    if (list.includes(nodeId)) return true;
  }

  // Check if any item in the allow list is a node prefix that maps to this provider
  for (const item of list) {
    const nodeByItemPrefix = nodes.find(
      (n) => n?.prefix && n.prefix.trim().toLowerCase() === item
    );
    if (nodeByItemPrefix?.id && nodeByItemPrefix.id.toLowerCase() === normProvider) {
      return true;
    }
  }

  // 4. Compatible node UUID suffix stripping & prefix matching
  const stripped = stripUuidSuffix(normProvider);
  if (stripped !== normProvider && list.includes(stripped)) {
    return true;
  }

  // Base compatible provider prefixes
  if (isOpenAICompatibleProvider(normProvider)) {
    if (list.includes("openai-compatible") || list.includes("openai-compatible-chat")) {
      return true;
    }
  }
  if (isAnthropicCompatibleProvider(normProvider)) {
    if (list.includes("anthropic-compatible") || list.includes("anthropic-compatible-chat")) {
      return true;
    }
  }
  if (isCustomEmbeddingProvider(normProvider)) {
    if (list.includes("custom-embedding")) {
      return true;
    }
  }

  // Inverse: item in allow list might have UUID suffix stripped
  for (const item of list) {
    const strippedItem = stripUuidSuffix(item);
    if (strippedItem === stripped || strippedItem === normProvider) {
      return true;
    }
  }

  return false;
}

/**
 * Build or retrieve a cached Set of canonical and equivalent strings for allowed models.
 * Cached for 30s to maximize proxy throughput.
 */
async function getResolvedAllowedModelsSet(list) {
  const cacheKey = list.slice().sort().join("|");
  const now = Date.now();
  const cached = resolvedModelSetCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.set;
  }

  const set = new Set();
  for (const entry of list) {
    set.add(entry);
    try {
      const info = await getModelInfo(entry);
      if (info?.provider && info?.model) {
        const p = info.provider.toLowerCase();
        const m = info.model.toLowerCase();
        set.add(`${p}/${m}`);

        const alias = getProviderAlias(p)?.toLowerCase();
        if (alias) set.add(`${alias}/${m}`);

        const resolvedId = resolveProviderId(p)?.toLowerCase();
        if (resolvedId) set.add(`${resolvedId}/${m}`);
      }
    } catch {
      // Keep entry in set even if resolution threw
    }
  }

  resolvedModelSetCache.set(cacheKey, {
    set,
    expiresAt: now + CACHE_TTL_MS,
  });

  return set;
}

/**
 * Check if a model is allowed under tri-state rules with a 30s resolution cache.
 *
 * @param {unknown} allowedModels - Tri-state allowedModels value or key object
 * @param {string} modelStr - Requested model string
 * @param {object} [options]
 * @returns {Promise<boolean>} True if allowed, false if denied
 */
export async function isModelAllowed(allowedModels, modelStr, options = {}) {
  if (!modelStr || typeof modelStr !== "string") return false;
  const list = parseTriState(extractDimension(allowedModels, "allowedModels"));
  if (list === null) return true; // null = all allowed
  if (list.length === 0) return false; // [] = none allowed

  const normModel = modelStr.trim().toLowerCase();

  // Fast check: direct membership in allow list
  if (list.includes(normModel)) return true;

  // Retrieve cached resolved Set (TTL 30s)
  const resolvedSet = await getResolvedAllowedModelsSet(list);
  if (resolvedSet.has(normModel)) return true;

  // Resolve requested model to canonical provider/model
  try {
    const info = await getModelInfo(modelStr);
    if (info?.provider && info?.model) {
      const p = info.provider.toLowerCase();
      const m = info.model.toLowerCase();
      if (resolvedSet.has(`${p}/${m}`)) return true;

      const alias = getProviderAlias(p)?.toLowerCase();
      if (alias && resolvedSet.has(`${alias}/${m}`)) return true;

      const resolvedId = resolveProviderId(p)?.toLowerCase();
      if (resolvedId && resolvedSet.has(`${resolvedId}/${m}`)) return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Resolve unified tri-state ACL for a key record, preserving backwards compatibility
 * with legacy `accessRestricted` and `accessAllow` columns.
 *
 * @param {object|null} keyRecord - The database key row/record
 * @returns {{
 *   allowedKinds: string[]|null,
 *   allowedProviders: string[]|null,
 *   allowedCombos: string[]|null,
 *   allowedModels: string[]|null,
 *   isRestricted: boolean
 * }}
 */
export function resolveKeyAcl(keyRecord) {
  if (!keyRecord) {
    return {
      allowedKinds: null,
      allowedProviders: null,
      allowedCombos: null,
      allowedModels: null,
      isRestricted: false,
    };
  }

  // Check if any of the new tri-state fields are explicitly defined (non-undefined)
  const hasNewFields =
    keyRecord.allowedKinds !== undefined ||
    keyRecord.allowedProviders !== undefined ||
    keyRecord.allowedCombos !== undefined ||
    keyRecord.allowedModels !== undefined;

  if (hasNewFields && (
    keyRecord.allowedKinds !== null ||
    keyRecord.allowedProviders !== null ||
    keyRecord.allowedCombos !== null ||
    keyRecord.allowedModels !== null
  )) {
    return {
      allowedKinds: parseTriState(keyRecord.allowedKinds),
      allowedProviders: parseTriState(keyRecord.allowedProviders),
      allowedCombos: parseTriState(keyRecord.allowedCombos),
      allowedModels: parseTriState(keyRecord.allowedModels),
      isRestricted: true,
    };
  }

  // Check legacy restricted flag
  const isLegacyRestricted = Boolean(
    keyRecord.access?.restricted || keyRecord.accessRestricted
  );

  if (!isLegacyRestricted) {
    return {
      allowedKinds: null,
      allowedProviders: null,
      allowedCombos: null,
      allowedModels: null,
      isRestricted: false,
    };
  }

  // Legacy key with restricted = true: map accessAllow into combos, models, providers
  let rawAllow = keyRecord.access?.allow;
  if (!rawAllow && typeof keyRecord.accessAllow === "string") {
    try {
      rawAllow = JSON.parse(keyRecord.accessAllow);
    } catch {
      rawAllow = [];
    }
  }
  const allowList = Array.isArray(rawAllow) ? rawAllow : [];

  if (allowList.length === 0) {
    return {
      allowedKinds: null,
      allowedProviders: [],
      allowedCombos: [],
      allowedModels: [],
      isRestricted: true,
    };
  }

  const combos = [];
  const models = [];
  const providers = [];

  for (const item of allowList) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.includes("/")) {
      models.push(trimmed);
    } else {
      // Bare names in legacy 9router could be combo names, bare model aliases, or search providers
      combos.push(trimmed);
      models.push(trimmed);
      providers.push(trimmed);
    }
  }

  return {
    allowedKinds: null,
    allowedProviders: null, // Legacy keys did not restrict provider for chat models
    allowedCombos: combos,
    allowedModels: models,
    isRestricted: true,
  };
}

/**
 * Standard OpenAI-compatible error response generator for ACL denials.
 */
export function aclErrorResponse(status, message, code) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 404 ? "invalid_request_error" : "forbidden",
        code,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function legacyDeniedResponse(model) {
  return new Response(
    JSON.stringify({
      error: {
        message: keyAccessDeniedMessage(model),
        type: "invalid_request_error",
        code: "key_access_denied",
      },
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

/**
 * Enforce unified tri-state ACL for a request.
 *
 * Sequence:
 * 1. Internal trust bypass check (valid machine token bypasses all gates)
 * 2. API key validity and active status (401 if invalid/inactive)
 * 3. Service kind check against allowedKinds (403 if denied, short-circuits)
 * 4. Combo or provider check against allowedCombos / allowedProviders (403 if denied)
 * 5. Model check against allowedModels (404 if denied)
 *
 * @param {object} params
 * @param {Request} [params.request]
 * @param {string} params.kind - "llm", "stt", etc.
 * @param {string} params.modelStr - requested model/combo name
 * @param {object|null} params.keyRecord - API key record from DB
 * @returns {Promise<Response|null>} Response on denial, or null when permitted
 */
export async function enforceUnifiedAcl({ request, kind, modelStr, keyRecord }) {
  // 1. Internal trust bypass check
  if (request && (await isTrustedInternalRequest(request))) {
    return null; // Bypasses all gates
  }

  if (!keyRecord) {
    return null; // Unauthenticated / unrestricted local mode
  }

  // 2. Active status check
  if (keyRecord.isActive === false || keyRecord.isActive === 0) {
    return new Response(
      JSON.stringify({
        error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  }

  const acl = resolveKeyAcl(keyRecord);
  if (!acl.isRestricted) {
    return null;
  }

  const isLegacy = (
    keyRecord.allowedKinds === undefined &&
    keyRecord.allowedProviders === undefined &&
    keyRecord.allowedCombos === undefined &&
    keyRecord.allowedModels === undefined &&
    Boolean(keyRecord.access?.restricted || keyRecord.accessRestricted)
  );

  // 3. Service kind check against allowedKinds (short-circuits before any provider/combo lookup!)
  if (!isKindAllowed(acl.allowedKinds, kind)) {
    return aclErrorResponse(403, `This API key is not allowed to use service kind "${kind}"`, "kind_not_allowed");
  }

  // 4a. Check if target is a combo
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    if (!isComboAllowed(acl.allowedCombos, modelStr)) {
      if (isLegacy) {
        return legacyDeniedResponse(modelStr);
      }
      return aclErrorResponse(403, `This API key is not allowed to use combo "${modelStr}"`, "combo_not_allowed");
    }
    return null; // Allowed via combo!
  }

  // 4b. Provider check (for regular models)
  const modelInfo = await getModelInfo(modelStr);
  if (modelInfo?.provider) {
    if (!(await isProviderAllowed(acl.allowedProviders, modelInfo.provider))) {
      if (isLegacy) {
        return legacyDeniedResponse(modelStr);
      }
      return aclErrorResponse(403, `This API key is not allowed to use provider "${modelInfo.provider}"`, "provider_not_allowed");
    }
  }

  // 5. Model check against allowedModels
  if (!(await isModelAllowed(acl.allowedModels, modelStr))) {
    if (isLegacy) {
      return legacyDeniedResponse(modelStr);
    }
    return aclErrorResponse(404, `The model "${modelStr}" does not exist or you do not have access to it.`, "model_not_found");
  }

  return null; // Permitted across all dimensions!
}

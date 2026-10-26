// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const MEDIA_ONLY_ALIASES = {
  el: "elevenlabs",
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  polly: "aws-polly",
  "aws-polly": "aws-polly",
};

const RESERVED_PROVIDER_PREFIXES = new Set([
  ...Object.keys(LOCAL_PROVIDER_ALIASES),
  ...Object.values(LOCAL_PROVIDER_ALIASES),
  ...Object.keys(MEDIA_ONLY_ALIASES),
  ...Object.values(MEDIA_ONLY_ALIASES),
]);

for (const entry of REGISTRY) {
  if (entry.id) {
    RESERVED_PROVIDER_PREFIXES.add(entry.id);
    RESERVED_PROVIDER_PREFIXES.add(entry.id.toLowerCase());
  }
  if (entry.alias) {
    RESERVED_PROVIDER_PREFIXES.add(entry.alias);
    RESERVED_PROVIDER_PREFIXES.add(entry.alias.toLowerCase());
  }
  for (const alias of entry.aliases || []) {
    RESERVED_PROVIDER_PREFIXES.add(alias);
    RESERVED_PROVIDER_PREFIXES.add(alias.toLowerCase());
  }
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string (e.g. "provider/model" or alias/combo)
 * @param {object|null} [preResolvedCombo] - Optional pre-resolved combo object to avoid re-querying
 */
export async function getModelInfo(modelStr, preResolvedCombo = undefined) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    const prefix = parsed.providerAlias?.toLowerCase();
    const isBuiltin = RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias) ||
      (prefix && RESERVED_PROVIDER_PREFIXES.has(prefix)) ||
      (parsed.provider && RESERVED_PROVIDER_PREFIXES.has(parsed.provider));

    if (!isBuiltin) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  let combo;
  if (preResolvedCombo !== undefined) {
    combo = (preResolvedCombo && (!preResolvedCombo.name || preResolvedCombo.name === parsed.model))
      ? preResolvedCombo
      : null;
  } else {
    combo = await getComboByName(parsed.model);
  }
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @param {string} modelStr - Model string
 * @param {object|null} [preResolvedCombo] - Optional pre-resolved combo object to avoid re-querying
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr, preResolvedCombo = undefined) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  let combo;
  if (preResolvedCombo !== undefined) {
    combo = (preResolvedCombo && (!preResolvedCombo.name || preResolvedCombo.name === modelStr))
      ? preResolvedCombo
      : null;
  } else {
    combo = await getComboByName(modelStr);
  }
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

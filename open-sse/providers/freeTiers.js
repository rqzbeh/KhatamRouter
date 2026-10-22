// Free-tier catalogue derived from the registry (no parallel catalog file).
// A provider offers free access when `hasFree === true` OR its category is
// "free"/"freeTier" (two independent axes in this codebase — OR them, don't
// reconcile). Provider-level free-ness is a TIER property, not a model one:
// it never fans out to the provider's paid models. Model rows are emitted only
// for a `category: "free"` provider (free by nature) or a model explicitly
// flagged `hasFree`.
import REGISTRY from "./registry/index.js";
import { modelKind, modelHasFree, modelFreeRefresh } from "./models/schema.js";

export const FREE_REFRESH_VALUES = ["daily", "weekly", "monthly", "one-time", "rolling"];

const FREE_CATEGORIES = new Set(["free", "freeTier"]);

// Deterministic output order: cadence groups (daily → weekly → monthly → rolling
// → one-time, then unknown last), then provider name, then model id.
const SORT_ORDER = ["daily", "weekly", "monthly", "rolling", "one-time"];
const refreshRank = (v) => (v === null ? SORT_ORDER.length : SORT_ORDER.indexOf(v));

// Allowlist guard so a typo in an annotation fails loudly instead of shipping.
function assertRefresh(value, where) {
  if (value !== null && !FREE_REFRESH_VALUES.includes(value)) {
    throw new Error(`Invalid freeRefresh "${value}" on ${where}`);
  }
  return value;
}

function isFreeProvider(entry) {
  return modelHasFree(entry) || FREE_CATEGORIES.has(entry.category);
}

/**
 * Returns the free-tier catalogue derived from the registry. A provider that
 * offers any free access contributes exactly ONE provider-level row (modelId
 * null) that carries the tier cadence. Model rows are added only where the model
 * itself is free: every model of a `category: "free"` provider, or a model
 * flagged `hasFree: true` (explicitly-free models on otherwise-mixed providers).
 */
export function listFreeTiers() {
  const rows = [];
  // A model id can appear under several kinds (e.g. gemini-2.5-flash is both llm
  // and stt); the catalogue keeps one row per (providerId, modelId).
  const seen = new Set();

  for (const entry of REGISTRY) {
    if (entry.hidden === true) continue;

    const providerId = entry.id;
    const providerFree = isFreeProvider(entry);
    const models = entry.models || [];

    if (!providerFree && !models.some((m) => modelHasFree(m))) continue;

    const providerAlias = entry.uiAlias || entry.alias || entry.id;
    const providerName = entry.display?.name || entry.id;
    const providerRefresh = assertRefresh(modelFreeRefresh(entry), providerId);
    const providerCategoryFree = entry.category === "free";

    // One provider row per qualifying provider — the home of the cadence.
    rows.push({
      providerId,
      providerAlias,
      providerName,
      modelId: null,
      modelName: null,
      kind: null,
      freeRefresh: providerRefresh,
    });

    for (const model of models) {
      if (!modelHasFree(model) && !providerCategoryFree) continue;
      const key = `${providerId}::${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const freeRefresh = assertRefresh(
        modelFreeRefresh(model) ?? providerRefresh,
        `${providerId}/${model.id}`,
      );
      rows.push({
        providerId,
        providerAlias,
        providerName,
        modelId: model.id,
        modelName: model.name ?? model.id,
        kind: modelKind(model),
        freeRefresh,
      });
    }
  }

  rows.sort((a, b) => {
    const byRefresh = refreshRank(a.freeRefresh) - refreshRank(b.freeRefresh);
    if (byRefresh !== 0) return byRefresh;
    const byProvider = a.providerName.localeCompare(b.providerName);
    if (byProvider !== 0) return byProvider;
    return String(a.modelId).localeCompare(String(b.modelId));
  });

  return rows;
}

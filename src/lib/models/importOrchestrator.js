// Import orchestrator: turns a provider's live model listing into catalog
// changes using the shared reconcile core.
//
//   discovery (existing /api/providers/[id]/models logic, guarded fetch)
//     -> normalizeDiscoveredModels
//     -> reconcileCatalog(previous imported snapshot, listing, manual overrides)
//     -> persist: imported_models (metadata) + customModels (what routing reads)
//
// Discovery is injected so this module stays testable and so the runtime
// import, automatic sync and the default-catalog script all share one path.

import { normalizeDiscoveredModels } from "./discovery.js";
import { reconcileCatalog, FIELD_SOURCES } from "./catalogReconcile.js";

const REQUIRED_REPO_METHODS = [
  "listImportedModels",
  "batchUpsertImportedModels",
  "pruneImportedSnapshot",
  "listCapabilityOverrides",
  "getCustomModels",
  "addCustomModel",
  "deleteCustomModel",
];

// Discovery results that are not a live, authoritative listing. Pruning on any
// of these would delete models just because the provider was briefly down or
// because an unknown adapter returned an unpaginated/partial response.
function isAuthoritative(discovery) {
  if (!discovery || typeof discovery !== "object") return false;
  const models = Array.isArray(discovery.models)
    ? discovery.models
    : (Array.isArray(discovery.data) ? discovery.data : null);
  if (!models) return false;
  if (discovery.warning) return false; // existing route sets this on static fallback
  if (discovery.fallback === true) return false;
  if (discovery.partial === true) return false;
  // Require explicit completeness evidence rather than inferring 200/no warning
  // as complete for unknown adapters.
  if (discovery.complete !== true) return false;
  return true;
}

// Inspect the raw listing before normalization drops invalid records.
function inspectRawListing(discovery) {
  const rawList = Array.isArray(discovery?.models)
    ? discovery.models
    : (Array.isArray(discovery?.data) ? discovery.data : (Array.isArray(discovery) ? discovery : null));
  if (!rawList) return { rawList: [], invalid: 0 };
  let invalid = 0;
  for (const item of rawList) {
    if (!item || typeof item !== "object") {
      invalid++;
      continue;
    }
    const id =
      (typeof item.id === "string" && item.id.trim()) ||
      (typeof item.name === "string" && item.name.trim()) ||
      (typeof item.model === "string" && item.model.trim());
    if (!id) {
      invalid++;
    }
  }
  return { rawList, invalid };
}

// Page through repository records without hardcoded truncation.
// If the source cap is reached, mark as capped so pruning is safely skipped.
async function fetchAllImportedModels(repo, { provider, connectionId, lifecycle }) {
  if (!repo || typeof repo.listImportedModels !== "function") return [];
  const PAGE_SIZE = 500;
  let offset = 0;
  const all = [];
  const MAX_RECORDS = 50000;
  while (true) {
    const page = await repo.listImportedModels({
      provider,
      ...(connectionId ? { connectionId } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      limit: PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
    if (all.length >= MAX_RECORDS) {
      all.capped = true;
      break;
    }
  }
  return all;
}

async function fetchAllCapabilityOverrides(repo, { provider, source }) {
  if (!repo || typeof repo.listCapabilityOverrides !== "function") return [];
  const PAGE_SIZE = 500;
  let offset = 0;
  const all = [];
  const MAX_RECORDS = 50000;
  while (true) {
    const page = await repo.listCapabilityOverrides({
      provider,
      ...(source ? { source } : {}),
      limit: PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
    if (all.length >= MAX_RECORDS) {
      all.capped = true;
      break;
    }
  }
  return all;
}

// Capabilities the importer persists, keyed the way the dashboard stores caps.
function toCustomCaps(capabilities) {
  const caps = {};
  if (capabilities.supportsVision === true) caps.vision = true;
  if (capabilities.supportsReasoning === true) caps.reasoning = true;
  return Object.keys(caps).length ? caps : undefined;
}

function overridesByModel(rows) {
  const out = {};
  for (const row of rows || []) {
    if (!row?.modelId || row.source !== FIELD_SOURCES.MANUAL) continue;
    const entry = out[row.modelId] || (out[row.modelId] = {});
    for (const [field, value] of Object.entries(row.capabilities || {})) {
      entry[field] = { value, source: FIELD_SOURCES.MANUAL };
    }
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} args.provider        provider id (e.g. "openrouter", "openai-compatible-chat-x")
 * @param {string} args.providerAlias   storage alias customModels uses for this provider
 * @param {string} args.connectionId
 * @param {() => Promise<{models?:Array,warning?:string,error?:string,status?:number,complete?:boolean}>} args.discover
 * @param {object} args.repo            { listImportedModels, batchUpsertImportedModels,
 *                                        pruneImportedSnapshot, listCapabilityOverrides,
 *                                        getCustomModels, addCustomModel, deleteCustomModel }
 * @param {Record<string,object>} [args.enrichment]
 * @param {boolean} [args.dryRun]
 * @param {AbortSignal} [args.signal]  checked before reconcile and before any write
 */
export async function importProviderModels({
  provider,
  providerAlias,
  connectionId,
  discover,
  repo,
  enrichment = {},
  dryRun = false,
  signal,
}) {
  if (!provider || !providerAlias || !connectionId || typeof discover !== "function" || !repo) {
    throw new Error("importProviderModels: provider, providerAlias, connectionId, discover and repo are required");
  }

  const missingMethods = REQUIRED_REPO_METHODS.filter((m) => typeof repo[m] !== "function");
  if (missingMethods.length > 0) {
    throw new Error(`importProviderModels: repo missing required persistence methods: ${missingMethods.join(", ")}`);
  }

  let discovery;
  try {
    discovery = await discover();
  } catch (error) {
    return { ok: false, status: 502, error: `Discovery failed: ${error?.message || error}` };
  }
  if (discovery?.error) {
    return { ok: false, status: discovery.status || 502, error: discovery.error };
  }
  if (signal?.aborted) {
    return { ok: false, status: 499, error: "Import aborted before reconcile" };
  }

  const { rawList, invalid: rawInvalid } = inspectRawListing(discovery);
  const authoritative = isAuthoritative(discovery);
  const normalized = normalizeDiscoveredModels(rawList, provider);
  const discoveredTypeById = new Map(
    normalized.map((m) => [m.id, m.raw?.type || m.raw?.kind || "llm"]),
  );

  const previousRows = await fetchAllImportedModels(repo, { provider, connectionId, lifecycle: "active" });
  const isCapped = Boolean(previousRows.capped);
  const previous = previousRows.map((row) => ({
    id: row.modelId,
    lifecycle: row.lifecycle,
    provenance: row.provenance,
    capabilities: row.capabilities || {},
  }));

  const overridesRows = await fetchAllCapabilityOverrides(repo, { provider, source: "manual" });
  if (overridesRows.capped) {
    return {
      ok: false,
      status: 500,
      error: "Capability overrides query reached safety cap; refusing catalog mutations to preserve manual overrides",
    };
  }
  const overrides = overridesByModel(overridesRows);

  const canPrune = authoritative && !isCapped;

  const result = reconcileCatalog({
    previous,
    listing: {
      complete: canPrune,
      fallback: !canPrune,
      authoritativeEmpty: false, // an empty live list is never trusted to wipe a catalog
      models: normalized,
      invalid: rawInvalid,
    },
    enrichment,
    overrides,
  });

  const summary = {
    ok: true,
    provider,
    connectionId,
    authoritative: canPrune && rawInvalid === 0,
    warning: discovery?.warning || null,
    added: result.add.map((m) => m.id),
    updated: result.update.map((m) => m.id),
    removed: result.remove.map((m) => m.id),
    stale: result.stale.map((m) => m.id),
    unchanged: result.unchanged.length,
    divergences: result.divergences,
    skipped: result.skipped,
    dryRun: Boolean(dryRun),
  };
  if (dryRun) return summary;
  if (signal?.aborted) {
    return { ok: false, status: 499, error: "Import aborted before write" };
  }

  const upserts = [...result.add, ...result.update].map((m) => ({
    modelId: m.id,
    capabilities: m.capabilities,
    metadata: { name: m.name, provenance: m.provenance },
  }));
  if (upserts.length) {
    await repo.batchUpsertImportedModels({ provider, connectionId, models: upserts });
  }

  // What routing and the dashboard read today. Add new, refresh caps on update,
  // never overwrite a model the user created by hand.
  const existingCustom = new Map(
    (await repo.getCustomModels())
      .filter((m) => m?.providerAlias === providerAlias)
      .map((m) => [m.id, m]),
  );
  for (const m of [...result.add, ...result.update]) {
    const prior = existingCustom.get(m.id);
    if (prior && prior.source !== "import") continue; // hand-added: leave it alone
    await repo.addCustomModel({
      providerAlias,
      id: m.id,
      type: discoveredTypeById.get(m.id) || prior?.type || "llm",
      name: m.name,
      caps: toCustomCaps(m.capabilities),
      source: "import",
    });
  }

  if (canPrune && !result.skipped.prune) {
    await repo.pruneImportedSnapshot({
      provider,
      connectionId,
      activeModelIds: normalized.map((m) => m.id),
      options: { complete: true, authoritativeEmpty: false },
    });

    if (summary.removed.length > 0) {
      // Query other active imported models for the same provider across all connections.
      // If another connection still advertises a model, preserve the shared model in customModels.
      const remainingActive = await fetchAllImportedModels(repo, { provider, lifecycle: "active" });
      if (!remainingActive.capped) {
        const activeAcrossConnections = new Set(remainingActive.map((r) => r.modelId));

        for (const id of summary.removed) {
          if (activeAcrossConnections.has(id)) {
            // Model is still actively advertised by another connection for this provider
            continue;
          }
          const prior = existingCustom.get(id);
          if (prior && prior.source === "import") {
            await repo.deleteCustomModel({ providerAlias, id, type: prior.type || "llm" });
          }
        }
      }
    }
  }

  return summary;
}

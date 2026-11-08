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

// Discovery results that are not a live, authoritative listing. Pruning on any
// of these would delete models just because the provider was briefly down.
function isAuthoritative(discovery) {
  if (!discovery || !Array.isArray(discovery.models)) return false;
  if (discovery.warning) return false; // existing route sets this on static fallback
  if (discovery.fallback === true) return false;
  if (discovery.partial === true) return false;
  return true;
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
 * @param {() => Promise<{models?:Array,warning?:string,error?:string,status?:number}>} args.discover
 * @param {object} args.repo            { listImportedModels, batchUpsertImportedModels,
 *                                        pruneImportedSnapshot, listCapabilityOverrides,
 *                                        getCustomModels, addCustomModel, deleteCustomModel }
 * @param {Record<string,object>} [args.enrichment]
 * @param {boolean} [args.dryRun]
 */
export async function importProviderModels({
  provider,
  providerAlias,
  connectionId,
  discover,
  repo,
  enrichment = {},
  dryRun = false,
}) {
  if (!provider || !providerAlias || !connectionId || typeof discover !== "function" || !repo) {
    throw new Error("importProviderModels: provider, providerAlias, connectionId, discover and repo are required");
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

  const authoritative = isAuthoritative(discovery);
  const normalized = normalizeDiscoveredModels(discovery?.models || [], provider);

  const previousRows = await repo.listImportedModels({ provider, connectionId, lifecycle: "active", limit: 5000 });
  const previous = previousRows.map((row) => ({
    id: row.modelId,
    lifecycle: row.lifecycle,
    provenance: row.provenance,
    capabilities: row.capabilities || {},
  }));
  const overrides = overridesByModel(await repo.listCapabilityOverrides({ provider, source: "manual", limit: 5000 }));

  const result = reconcileCatalog({
    previous,
    listing: {
      complete: authoritative,
      fallback: !authoritative,
      authoritativeEmpty: false, // an empty live list is never trusted to wipe a catalog
      models: normalized,
    },
    enrichment,
    overrides,
  });

  const summary = {
    ok: true,
    provider,
    connectionId,
    authoritative,
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
      type: "llm",
      name: m.name,
      caps: toCustomCaps(m.capabilities),
      source: "import",
    });
  }

  if (authoritative) {
    await repo.pruneImportedSnapshot({
      provider,
      connectionId,
      activeModelIds: normalized.map((m) => m.id),
      options: { complete: true, authoritativeEmpty: false },
    });
    for (const id of summary.removed) {
      const prior = existingCustom.get(id);
      if (prior && prior.source === "import") {
        await repo.deleteCustomModel({ providerAlias, id, type: prior.type || "llm" });
      }
    }
  }

  return summary;
}

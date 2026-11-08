/**
 * Server-only Model Capability & Context Overrides In-Memory Cache (Spec 017).
 *
 * Provides synchronous in-memory resolution for runtime routing, fail-closed
 * capability evaluation, and API model listings without N+1 database queries.
 *
 * Security & Integrity Invariants:
 * 1. Synchronous read path (getOverrideSourcesSync) via getAdapterSync.
 * 2. Async initialization (initializeOverrideCache) ensures DB driver and migrations.
 * 3. Local mutation invalidation is immediate and synchronous (zero stale window).
 * 4. Cluster-wide invalidation via CONFIG_RELOAD subscription (scope: settings/all).
 * 5. Bounded at 50,000 rows — fail closed on breach, retaining previous snapshot.
 * 6. Never caches raw tokens or credentials.
 * 7. Trusted identity override: row metadata (provider, modelId, source) always
 *    wins over untrusted JSON keys in capabilities_json (no cross-scope elevation).
 * 8. Missing expected migration tables fail closed (ready: false).
 */

import { getAdapter, getAdapterSync } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { scrubCredentials } from "@/lib/db/repos/modelMetadataRepo.js";
import {
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "@/lib/redis/events.js";

export const MAX_SNAPSHOT_ROWS = 50000;
export const MAX_CACHE_TTL_MS = 5000;

let cacheGeneration = 0;
let lastLoadedGeneration = -1;
let lastLoadedTime = 0;
let currentSnapshot = null;
let isReady = false;

function getEmptySources(ready = false) {
  return {
    ready,
    generation: cacheGeneration,
    manualOverrides: [],
    autoOverrides: [],
    manualMap: new Map(),
    autoMap: new Map(),
    importedModels: [],
  };
}

/**
 * Loads snapshot synchronously from initialized adapter.
 * Uses bounded queries (LIMIT 50001) to eliminate count/select races.
 * Enforces strict trusted identity precedence over arbitrary capabilities_json keys.
 */
function loadSnapshotSync(adapter) {
  // If in production build phase, skip DB reads
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return getEmptySources(false);
  }

  // 1. Verify table existence in sqlite_master
  const tables = adapter.all(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('model_capability_overrides', 'imported_models', 'model_context_overrides')`
  ) || [];
  const tableNames = new Set(tables.map((t) => t.name));

  // If core migration table is absent, fail-closed (ready: false)
  if (!tableNames.has("model_capability_overrides")) {
    isReady = false;
    currentSnapshot = null;
    return getEmptySources(false);
  }

  // 2. Load capability overrides with bound
  const capRows = adapter.all(
    `SELECT id, provider, model_id, model_pattern, source, capabilities_json
     FROM model_capability_overrides
     ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT ?`,
    [MAX_SNAPSHOT_ROWS + 1]
  ) || [];

  if (capRows.length > MAX_SNAPSHOT_ROWS) {
    throw new Error(
      `[overrideCache] Snapshot rows exceed bound (${MAX_SNAPSHOT_ROWS}). Fail-closed.`
    );
  }

  let totalRowCount = capRows.length;

  // 3. Load context overrides if table exists
  let ctxRows = [];
  if (tableNames.has("model_context_overrides")) {
    ctxRows = adapter.all(
      `SELECT id, provider, model_id, model_pattern, context_window, max_output_tokens, source
       FROM model_context_overrides
       LIMIT ?`,
      [MAX_SNAPSHOT_ROWS + 1 - totalRowCount]
    ) || [];
    totalRowCount += ctxRows.length;
    if (totalRowCount > MAX_SNAPSHOT_ROWS) {
      throw new Error(
        `[overrideCache] Snapshot total rows exceed bound (${MAX_SNAPSHOT_ROWS}). Fail-closed.`
      );
    }
  }

  // 4. Load active imported models if table exists
  let impRows = [];
  if (tableNames.has("imported_models")) {
    impRows = adapter.all(
      `SELECT id, provider, connection_id, model_id, capabilities_json, metadata_json, lifecycle
       FROM imported_models
       WHERE lifecycle = 'active'
       ORDER BY updated_at DESC
       LIMIT ?`,
      [MAX_SNAPSHOT_ROWS + 1 - totalRowCount]
    ) || [];
    totalRowCount += impRows.length;
    if (totalRowCount > MAX_SNAPSHOT_ROWS) {
      throw new Error(
        `[overrideCache] Snapshot total rows exceed bound (${MAX_SNAPSHOT_ROWS}). Fail-closed.`
      );
    }
  }

  const manualList = [];
  const autoList = [];
  const manualMap = new Map();
  const autoMap = new Map();

  // Process capability overrides
  for (const r of capRows) {
    const rawCaps = parseJson(r.capabilities_json, {});
    const cleanCaps = scrubCredentials(rawCaps);

    // SECURITY: Trusted identity fields MUST be written LAST so untrusted JSON keys cannot elevate source/provider
    const trustedSource = r.source === "manual" ? "manual" : r.source === "auto:discovery" ? "auto:discovery" : "unknown";
    if (trustedSource === "unknown") continue; // unknown sources do not enter manual or auto layers

    const item = {
      ...cleanCaps,
      capabilities: cleanCaps,
      id: r.id,
      provider: r.provider || null,
      modelId: r.model_id || null,
      modelPattern: r.model_pattern || null,
      source: trustedSource,
    };

    const isManual = trustedSource === "manual";
    const targetList = isManual ? manualList : autoList;
    const targetMap = isManual ? manualMap : autoMap;

    targetList.push(item);

    const p = item.provider;
    const m = item.modelId || item.modelPattern;
    if (p && m) {
      if (!targetMap.has(`${p}/${m}`)) targetMap.set(`${p}/${m}`, item);
    } else if (m) {
      if (!targetMap.has(m)) targetMap.set(m, item);
    }
  }

  // Process context overrides
  for (const r of ctxRows) {
    const trustedSource = r.source === "manual" ? "manual" : r.source === "auto:discovery" ? "auto:discovery" : "unknown";
    if (trustedSource === "unknown") continue;

    const item = {
      id: r.id,
      provider: r.provider || null,
      modelId: r.model_id || null,
      modelPattern: r.model_pattern || null,
      source: trustedSource,
      contextWindow: r.context_window,
      maxOutputTokens: r.max_output_tokens,
    };

    const isManual = trustedSource === "manual";
    const targetList = isManual ? manualList : autoList;
    const targetMap = isManual ? manualMap : autoMap;

    targetList.push(item);

    const p = item.provider;
    const m = item.modelId || item.modelPattern;
    if (p && m) {
      if (!targetMap.has(`${p}/${m}`)) targetMap.set(`${p}/${m}`, item);
    } else if (m) {
      if (!targetMap.has(m)) targetMap.set(m, item);
    }
  }

  // Process active imported models
  const importedList = [];
  for (const r of impRows) {
    const rawCaps = parseJson(r.capabilities_json, {});
    const cleanCaps = scrubCredentials(rawCaps);
    const cleanMeta = scrubCredentials(parseJson(r.metadata_json, {}));

    const item = {
      ...cleanCaps,
      capabilities: cleanCaps,
      id: r.id,
      provider: r.provider,
      connectionId: r.connection_id,
      modelId: r.model_id,
      modelPattern: r.model_id,
      source: "auto:discovery", // In resolver cascade, active imports participate at Layer 2
      provenance: "imported",
      metadata: cleanMeta,
    };

    importedList.push(item);
    autoList.push(item);

    if (r.provider && r.model_id && !autoMap.has(`${r.provider}/${r.model_id}`)) {
      autoMap.set(`${r.provider}/${r.model_id}`, item);
    }
  }

  currentSnapshot = {
    ready: true,
    generation: cacheGeneration,
    loadedAt: Date.now(),
    manualOverrides: manualList,
    autoOverrides: autoList,
    manualMap,
    autoMap,
    importedModels: importedList,
  };

  lastLoadedGeneration = cacheGeneration;
  lastLoadedTime = Date.now();
  isReady = true;

  return currentSnapshot;
}

let initPromise = null;

/**
 * Initializes override cache by ensuring DB is ready, then returns clean snapshot.
 * Coalesces concurrent in-flight initialization promises.
 * If cache is already valid and clean, returns immediately without database queries.
 */
export async function initializeOverrideCache() {
  const now = Date.now();
  if (
    currentSnapshot !== null &&
    cacheGeneration === lastLoadedGeneration &&
    now - lastLoadedTime <= MAX_CACHE_TTL_MS
  ) {
    return currentSnapshot;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await getAdapter();
      return getOverrideSourcesSync();
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Synchronously invalidates cache generation.
 */
export function invalidateOverrideCache() {
  cacheGeneration++;
}

/**
 * Synchronously returns current override sources for resolveModelCapabilities.
 * Never executes DB I/O when clean. If dirty, reloads synchronously via getAdapterSync.
 * If adapter is not yet initialized or fails, retains previous good snapshot or returns unready.
 */
export function getOverrideSourcesSync() {
  const now = Date.now();

  // Return clean cached snapshot if not dirty and within TTL
  if (
    currentSnapshot !== null &&
    cacheGeneration === lastLoadedGeneration &&
    now - lastLoadedTime <= MAX_CACHE_TTL_MS
  ) {
    return currentSnapshot;
  }

  // Dirty or TTL expired: attempt synchronous reload
  let adapter;
  try {
    adapter = getAdapterSync();
  } catch {
    // DB not yet initialized; retain good snapshot if available, else fail-closed
    if (currentSnapshot !== null) return currentSnapshot;
    return getEmptySources(false);
  }

  if (!adapter) {
    if (currentSnapshot !== null) return currentSnapshot;
    return getEmptySources(false);
  }

  try {
    return loadSnapshotSync(adapter);
  } catch (err) {
    console.error("[overrideCache] Error loading snapshot synchronously:", err.message);
    // Retain previous good snapshot if available, otherwise return unready
    if (currentSnapshot !== null) {
      return currentSnapshot;
    }
    return getEmptySources(false);
  }
}

/**
 * Boolean readiness check helper.
 */
export function isOverrideCacheReady() {
  return isReady && currentSnapshot !== null && currentSnapshot.ready === true;
}

// Aliases matching prompt conventions
export const initialize = initializeOverrideCache;
export const invalidate = invalidateOverrideCache;
export const getSources = getOverrideSourcesSync;

/**
 * Subscribes to cluster CONFIG_RELOAD events to invalidate cache across replicas.
 */
try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
    if (
      !payload ||
      !payload.scope ||
      payload.scope === "settings" ||
      payload.scope === "all" ||
      payload.scope === "models" ||
      payload.scope === "overrides"
    ) {
      invalidateOverrideCache();
    }
  });
} catch {
  // Fail open if event bus is unavailable
}

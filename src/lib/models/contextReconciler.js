/**
 * Context window reconciler with manual pin protection (Wave 6).
 *
 * Compares each model's discovered usable context window against the override-free
 * catalog. When they diverge, it records the discovered limit as an `auto:discovery`
 * override so the true window is used by routing.
 *
 * Core Guarantees:
 * 1. NEVER overwrites or touches an operator's `manual` pin (skippedManual++).
 * 2. Self-heals: when the catalog catches up to the discovered value, the redundant
 *    auto:discovery override is automatically pruned (removed++).
 * 3. Invalid or omitted windows prune stale auto:discovery pins without touching manual pins.
 */

/**
 * Reconcile discovered context windows against catalog baselines.
 * Pure deterministic logic using injected dependencies.
 *
 * @param {Array<{ provider: string, modelId: string, contextWindow?: number, window?: number }>} discovered
 * @param {{
 *   getCatalogWindow: (provider: string, modelId: string) => number | null,
 *   getExistingSource: (provider: string, modelId: string) => string | null,
 *   writeAuto: (provider: string, modelId: string, window: number) => void,
 *   removeOverride: (provider: string, modelId: string) => void,
 * }} deps
 * @returns {{ scanned: number, written: number, removed: number, skippedManual: number }}
 */
export function reconcileContextWindows(discovered, deps) {
  const result = { scanned: 0, written: 0, removed: 0, skippedManual: 0 };
  if (!Array.isArray(discovered) || !deps) return result;

  for (const item of discovered) {
    result.scanned++;
    if (!item || typeof item !== "object") continue;

    const provider = item.provider || item.providerId || "";
    const modelId = item.modelId || item.model || item.id || "";
    if (!provider || !modelId) continue;

    const rawWindow = item.contextWindow ?? item.window ?? null;
    const window = typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.floor(rawWindow)
      : null;

    const existingSource = deps.getExistingSource?.(provider, modelId) || null;

    if (!window) {
      // Upstream discovery omitted a valid window limit.
      // Prune a stale auto:discovery pin so the catalog can win.
      if (existingSource === "auto:discovery") {
        deps.removeOverride?.(provider, modelId);
        result.removed++;
      }
      continue;
    }

    // Critical Invariant: NEVER clobber an operator's manual pin
    if (existingSource === "manual") {
      result.skippedManual++;
      continue;
    }

    const catalog = deps.getCatalogWindow?.(provider, modelId) ?? null;

    if (window !== catalog) {
      // Discovered limit diverges from catalog -> pin auto:discovery
      deps.writeAuto?.(provider, modelId, window);
      result.written++;
    } else if (existingSource === "auto:discovery") {
      // Catalog has caught up to the discovered value -> remove redundant auto override
      deps.removeOverride?.(provider, modelId);
      result.removed++;
    }
  }

  return result;
}

/**
 * Run reconcile directly against an active SQLite database adapter.
 *
 * @param {object} db - SQLite database adapter
 * @param {Array<object>} discovered
 * @param {Function} [getCatalogWindow] - function (provider, modelId) => number
 */
export async function runDatabaseContextReconcile(db, discovered, getCatalogWindow) {
  if (!db || !Array.isArray(discovered)) {
    return { scanned: 0, written: 0, removed: 0, skippedManual: 0 };
  }

  const { resolveModelCapabilities } = await import("./capabilities.js");

  const defaultCatalogWindow = (provider, modelId) => {
    const resolved = resolveModelCapabilities(
      { provider, model: modelId },
      {},
      { persistedOverrides: false } // Override-free catalog view
    );
    return resolved.contextWindow || null;
  };

  const catalogResolver = getCatalogWindow || defaultCatalogWindow;

  return reconcileContextWindows(discovered, {
    getCatalogWindow: catalogResolver,
    getExistingSource: (provider, modelId) => {
      try {
        const row = db.get(
          "SELECT source FROM model_context_overrides WHERE provider = ? AND model_id = ?",
          [provider, modelId]
        );
        if (row && row.source) return row.source;
        // Fallback check on model_pattern
        const patRow = db.get(
          "SELECT source FROM model_context_overrides WHERE model_pattern = ?",
          [modelId]
        );
        return patRow?.source || null;
      } catch {
        return null;
      }
    },
    writeAuto: (provider, modelId, window) => {
      try {
        const now = new Date().toISOString();
        const id = `auto:${provider}:${modelId}`;
        db.run(
          `INSERT OR REPLACE INTO model_context_overrides
            (id, model_pattern, provider, model_id, context_window, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'auto:discovery', ?, ?)`,
          [id, modelId, provider, modelId, window, now, now]
        );
      } catch (err) {
        console.warn(`[contextReconciler] Failed writing auto override: ${err.message}`);
      }
    },
    removeOverride: (provider, modelId) => {
      try {
        db.run(
          "DELETE FROM model_context_overrides WHERE provider = ? AND model_id = ? AND source = 'auto:discovery'",
          [provider, modelId]
        );
      } catch (err) {
        console.warn(`[contextReconciler] Failed removing auto override: ${err.message}`);
      }
    },
  });
}

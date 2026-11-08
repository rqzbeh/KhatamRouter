import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  publishKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

// Credential keys that must NEVER be persisted in metadata or capabilities
const SENSITIVE_KEY_REGEX = /^(api[_-]?key|token|secret|password|auth|authorization|private[_-]?key|client[_-]?secret)$/i;

/**
 * Deeply scrub credentials from an object or value.
 */
export function scrubCredentials(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(scrubCredentials);
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEY_REGEX.test(k)) continue;
    clean[k] = scrubCredentials(v);
  }
  return clean;
}

/**
 * Deterministic, bounded, collision-free key generator for overrides.
 * Uses URI encoding and length prefixing to avoid delimiter collision.
 */
export function buildOverrideId(source = "manual", provider = "", modelId = "") {
  const s = String(source || "manual").trim();
  const p = String(provider || "").trim();
  const m = String(modelId || "").trim();
  const encP = encodeURIComponent(p);
  const encM = encodeURIComponent(m);
  const key = `ovr::${s}::${encP.length}-${encP}::${encM.length}-${encM}`;
  if (key.length <= 384) return key;
  const hash = Bun.CryptoHasher.hash("sha256", `${p}\0${m}`, "hex").slice(0, 32);
  return `ovr::${s}::${encP.slice(0, 100)}::${hash}`;
}

/**
 * Deterministic, bounded, collision-free key generator for imported catalog models.
 */
export function buildImportedModelId(provider = "", connectionId = "", modelId = "") {
  const p = String(provider || "").trim();
  const c = String(connectionId || "").trim();
  const m = String(modelId || "").trim();
  const encP = encodeURIComponent(p);
  const encC = encodeURIComponent(c);
  const encM = encodeURIComponent(m);
  const key = `imp::${encP.length}-${encP}::${encC.length}-${encC}::${encM.length}-${encM}`;
  if (key.length <= 384) return key;
  const hash = Bun.CryptoHasher.hash("sha256", `${p}\0${c}\0${m}`, "hex").slice(0, 32);
  return `imp::${encP.slice(0, 60)}::${encC.slice(0, 60)}::${hash}`;
}

/**
 * Matches a modelId against a wildcard pattern (e.g. "claude-*", "*gpt-4*", exact).
 */
export function matchModelPattern(pattern, modelId) {
  if (!pattern || !modelId) return false;
  if (pattern === "*" || pattern === modelId) return true;
  if (!pattern.includes("*")) return pattern === modelId;
  const regexStr = "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  try {
    return new RegExp(regexStr, "i").test(modelId);
  } catch {
    return false;
  }
}

/**
 * Validates and normalizes capability fields.
 * Preserves null as unknown (never coerces null to false).
 */
export function normalizeCapabilities(caps) {
  if (!caps || typeof caps !== "object") return {};
  const cleaned = scrubCredentials(caps);
  const out = {};

  for (const [k, v] of Object.entries(cleaned)) {
    if (v === null) {
      out[k] = null; // explicitly unknown
    } else if (k === "reasoning" && typeof v === "object") {
      // Validated reasoning enum/structure
      out[k] = {
        supported: Boolean(v.supported),
        effortLevels: Array.isArray(v.effortLevels) ? v.effortLevels.map(String) : [],
      };
    } else if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "object") {
      out[k] = v;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability Overrides
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertCapabilityOverride({
  provider = null,
  modelId = null,
  modelPattern = null,
  capabilities = {},
  source = "manual",
  replace = false,
}) {
  const normSource = String(source || "manual").trim();
  const p = provider ? String(provider).trim() : null;
  const mId = modelId ? String(modelId).trim() : null;
  const pat = modelPattern ? String(modelPattern).trim() : (mId || "*");

  if (!pat && !mId) {
    throw new Error("modelId or modelPattern is required for capability override");
  }

  const normCaps = normalizeCapabilities(capabilities);
  const now = new Date().toISOString();
  const id = buildOverrideId(normSource, p || "", mId || pat);

  const db = await getAdapter();

  const record = db.immediate(() => {
    // Check if an existing row matches this scope
    let existingRow = null;
    if (p && mId) {
      existingRow = db.get(
        `SELECT * FROM model_capability_overrides WHERE provider = ? AND model_id = ? AND source = ?`,
        [p, mId, normSource]
      );
    } else if (p && pat) {
      existingRow = db.get(
        `SELECT * FROM model_capability_overrides WHERE provider = ? AND model_pattern = ? AND source = ?`,
        [p, pat, normSource]
      );
    } else {
      existingRow = db.get(
        `SELECT * FROM model_capability_overrides WHERE (provider IS NULL OR provider = '') AND model_pattern = ? AND source = ?`,
        [pat, normSource]
      );
    }

    let mergedCaps = normCaps;
    let createdAt = now;

    if (existingRow) {
      const prevCaps = parseJson(existingRow.capabilities_json, {});
      mergedCaps = replace ? normCaps : { ...prevCaps, ...normCaps };
      createdAt = existingRow.created_at || now;

      db.run(
        `UPDATE model_capability_overrides
         SET capabilities_json = ?, updated_at = ?, model_pattern = ?, provider = ?, model_id = ?, source = ?
         WHERE id = ?`,
        [stringifyJson(mergedCaps), now, pat, p, mId, normSource, existingRow.id]
      );

      return {
        id: existingRow.id,
        provider: p,
        modelId: mId,
        modelPattern: pat,
        capabilities: mergedCaps,
        source: normSource,
        createdAt,
        updatedAt: now,
      };
    }

    db.run(
      `INSERT INTO model_capability_overrides
        (id, model_pattern, provider, model_id, source, capabilities_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, pat, p, mId, normSource, stringifyJson(mergedCaps), createdAt, now]
    );

    return {
      id,
      provider: p,
      modelId: mId,
      modelPattern: pat,
      capabilities: mergedCaps,
      source: normSource,
      createdAt,
      updatedAt: now,
    };
  });

  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "settings",
      timestamp: Date.now(),
    });
  } catch {}

  return record;
}

export async function getCapabilityOverride({
  provider = null,
  modelId = null,
  modelPattern = null,
  source = "any",
}) {
  const db = await getAdapter();
  const p = provider ? String(provider).trim() : null;
  const mId = modelId ? String(modelId).trim() : null;
  const pat = modelPattern ? String(modelPattern).trim() : null;

  // 1. Exact scoped match by provider & model_id
  if (p && mId) {
    let query = `SELECT * FROM model_capability_overrides WHERE provider = ? AND model_id = ?`;
    const params = [p, mId];
    if (source && source !== "any") {
      query += ` AND source = ?`;
      params.push(source);
    }
    query += ` ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`;
    const row = db.get(query, params);
    if (row) {
      return {
        id: row.id,
        provider: row.provider,
        modelId: row.model_id,
        modelPattern: row.model_pattern,
        capabilities: parseJson(row.capabilities_json, {}),
        source: row.source || "manual",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
  }

  // 2. Exact match by provider & modelPattern
  if (p && pat) {
    let query = `SELECT * FROM model_capability_overrides WHERE provider = ? AND model_pattern = ?`;
    const params = [p, pat];
    if (source && source !== "any") {
      query += ` AND source = ?`;
      params.push(source);
    }
    query += ` ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`;
    const row = db.get(query, params);
    if (row) {
      return {
        id: row.id,
        provider: row.provider,
        modelId: row.model_id,
        modelPattern: row.model_pattern,
        capabilities: parseJson(row.capabilities_json, {}),
        source: row.source || "manual",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
  }

  // 3. Fallback to legacy wildcard rows (provider IS NULL or '')
  const legacyRows = db.all(
    `SELECT * FROM model_capability_overrides
     WHERE provider IS NULL OR provider = ''
     ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, updated_at DESC`
  );

  const targetModel = mId || pat;
  if (targetModel) {
    for (const r of legacyRows) {
      if (source && source !== "any" && (r.source || "manual") !== source) continue;
      if (matchModelPattern(r.model_pattern, targetModel)) {
        return {
          id: r.id,
          provider: null,
          modelId: null,
          modelPattern: r.model_pattern,
          capabilities: parseJson(r.capabilities_json, {}),
          source: r.source || "manual",
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }
    }
  }

  return null;
}

export async function listCapabilityOverrides({ provider = null, source = null, limit = 100, offset = 0 } = {}) {
  const db = await getAdapter();
  let sql = `SELECT * FROM model_capability_overrides WHERE 1=1`;
  const params = [];

  if (provider) {
    sql += ` AND provider = ?`;
    params.push(provider);
  }
  if (source) {
    sql += ` AND source = ?`;
    params.push(source);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit) || 100, Number(offset) || 0);

  const rows = db.all(sql, params) || [];
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    modelId: r.model_id,
    modelPattern: r.model_pattern,
    capabilities: parseJson(r.capabilities_json, {}),
    source: r.source || "manual",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function deleteCapabilityOverride({ provider = null, modelId = null, modelPattern = null, source = "manual" }) {
  const db = await getAdapter();
  const p = provider ? String(provider).trim() : null;
  const mId = modelId ? String(modelId).trim() : null;
  const pat = modelPattern ? String(modelPattern).trim() : (mId || "*");

  const deleted = db.immediate(() => {
    let result = null;
    if (p && mId) {
      result = db.run(
        `DELETE FROM model_capability_overrides WHERE provider = ? AND model_id = ? AND source = ?`,
        [p, mId, source]
      );
    } else if (p) {
      result = db.run(
        `DELETE FROM model_capability_overrides WHERE provider = ? AND model_pattern = ? AND source = ?`,
        [p, pat, source]
      );
    } else {
      result = db.run(
        `DELETE FROM model_capability_overrides WHERE (provider IS NULL OR provider = '') AND model_pattern = ? AND source = ?`,
        [pat, source]
      );
    }
    return (result?.changes || 0) > 0;
  });

  if (deleted) {
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "settings",
        timestamp: Date.now(),
      });
    } catch {}
  }

  return { deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Imported Catalog Membership & Pruning
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertImportedModel({
  provider,
  connectionId,
  modelId,
  capabilities = null,
  metadata = null,
  provenance = "imported",
  lifecycle = "active",
}) {
  if (!provider || !connectionId || !modelId) {
    throw new Error("provider, connectionId, and modelId are strictly required");
  }

  const p = String(provider).trim();
  const c = String(connectionId).trim();
  const m = String(modelId).trim();
  const id = buildImportedModelId(p, c, m);
  const now = new Date().toISOString();

  const cleanCaps = capabilities ? normalizeCapabilities(capabilities) : null;
  const cleanMeta = metadata ? scrubCredentials(metadata) : null;

  const db = await getAdapter();

  return db.immediate(() => {
    db.run(
      `INSERT INTO imported_models
        (id, provider, connection_id, model_id, provenance, lifecycle, capabilities_json, metadata_json, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, connection_id, model_id) DO UPDATE SET
        lifecycle = excluded.lifecycle,
        capabilities_json = COALESCE(excluded.capabilities_json, imported_models.capabilities_json),
        metadata_json = COALESCE(excluded.metadata_json, imported_models.metadata_json),
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at`,
      [
        id,
        p,
        c,
        m,
        provenance || "imported",
        lifecycle || "active",
        cleanCaps ? stringifyJson(cleanCaps) : null,
        cleanMeta ? stringifyJson(cleanMeta) : null,
        now,
        now,
        now,
      ]
    );

    return {
      id,
      provider: p,
      connectionId: c,
      modelId: m,
      provenance: provenance || "imported",
      lifecycle: lifecycle || "active",
      capabilities: cleanCaps,
      metadata: cleanMeta,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
  });

  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "settings",
      timestamp: Date.now(),
    });
  } catch {}

  return record;
}

export async function batchUpsertImportedModels({
  provider,
  connectionId,
  models,
  provenance = "imported",
}) {
  if (!provider || !connectionId || !Array.isArray(models)) {
    throw new Error("Invalid parameters for batchUpsertImportedModels");
  }

  // Pre-validate all models upfront
  for (let i = 0; i < models.length; i++) {
    const item = models[i];
    if (!item || !item.modelId || typeof item.modelId !== "string" || !item.modelId.trim()) {
      throw new Error(`Model at index ${i} is missing a valid modelId`);
    }
  }

  const p = String(provider).trim();
  const c = String(connectionId).trim();
  const now = new Date().toISOString();

  const db = await getAdapter();

  const result = db.immediate(() => {
    let added = 0;
    let updated = 0;

    for (const item of models) {
      const m = item.modelId.trim();
      const id = buildImportedModelId(p, c, m);
      const cleanCaps = item.capabilities ? normalizeCapabilities(item.capabilities) : null;
      const cleanMeta = item.metadata ? scrubCredentials(item.metadata) : null;

      const existing = db.get(
        `SELECT id FROM imported_models WHERE provider = ? AND connection_id = ? AND model_id = ?`,
        [p, c, m]
      );

      if (existing) {
        db.run(
          `UPDATE imported_models
           SET lifecycle = 'active',
               capabilities_json = COALESCE(?, capabilities_json),
               metadata_json = COALESCE(?, metadata_json),
               updated_at = ?,
               last_seen_at = ?
           WHERE id = ?`,
          [
            cleanCaps ? stringifyJson(cleanCaps) : null,
            cleanMeta ? stringifyJson(cleanMeta) : null,
            now,
            now,
            existing.id,
          ]
        );
        updated++;
      } else {
        db.run(
          `INSERT INTO imported_models
            (id, provider, connection_id, model_id, provenance, lifecycle, capabilities_json, metadata_json, created_at, updated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          [
            id,
            p,
            c,
            m,
            provenance || "imported",
            cleanCaps ? stringifyJson(cleanCaps) : null,
            cleanMeta ? stringifyJson(cleanMeta) : null,
            now,
            now,
            now,
          ]
        );
        added++;
      }
    }

    return { added, updated, total: models.length };
  });

  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "settings",
      timestamp: Date.now(),
    });
  } catch {}

  return result;
}

export async function listImportedModels({
  provider = null,
  connectionId = null,
  lifecycle = null,
  limit = 500,
  offset = 0,
} = {}) {
  const db = await getAdapter();
  let sql = `SELECT * FROM imported_models WHERE 1=1`;
  const params = [];

  if (provider) {
    sql += ` AND provider = ?`;
    params.push(provider);
  }
  if (connectionId) {
    sql += ` AND connection_id = ?`;
    params.push(connectionId);
  }
  if (lifecycle) {
    sql += ` AND lifecycle = ?`;
    params.push(lifecycle);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit) || 500, Number(offset) || 0);

  const rows = db.all(sql, params) || [];
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    connectionId: r.connection_id,
    modelId: r.model_id,
    provenance: r.provenance,
    lifecycle: r.lifecycle,
    capabilities: parseJson(r.capabilities_json, null),
    metadata: parseJson(r.metadata_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Reconciles snapshot pruning within source/connection scope.
 * Complete snapshot is required; partial listings skip pruning.
 * Preserves manual entries, manual overrides, and shared-source memberships.
 */
export async function pruneImportedSnapshot({
  provider,
  connectionId,
  activeModelIds = [],
  options = {},
}) {
  const { complete = false, authoritativeEmpty = false } = options;

  if (!complete) {
    return { pruned: 0, retainedShared: 0, skipped: true, reason: "incomplete_snapshot" };
  }

  if ((!activeModelIds || activeModelIds.length === 0) && !authoritativeEmpty) {
    return { pruned: 0, retainedShared: 0, skipped: true, reason: "authoritative_empty_required" };
  }

  const p = String(provider).trim();
  const c = String(connectionId).trim();
  const activeSet = new Set(activeModelIds.map(String));
  const now = new Date().toISOString();

  const db = await getAdapter();

  const result = db.immediate(() => {
    // Select all active models for this source that were imported (not manual)
    const existing = db.all(
      `SELECT id, model_id FROM imported_models
       WHERE provider = ? AND connection_id = ? AND lifecycle = 'active' AND provenance != 'manual'`,
      [p, c]
    ) || [];

    const obsolete = existing.filter((r) => !activeSet.has(r.model_id));
    if (obsolete.length === 0) {
      return { pruned: 0, retainedShared: 0, skipped: false, reason: null };
    }

    let pruned = 0;
    let retainedShared = 0;

    for (const item of obsolete) {
      // Check if another active connection advertises this model
      const sharedCheck = db.get(
        `SELECT COUNT(*) as cnt FROM imported_models
         WHERE provider = ? AND model_id = ? AND connection_id != ? AND lifecycle = 'active'`,
        [p, item.model_id, c]
      );

      if (sharedCheck && sharedCheck.cnt > 0) {
        retainedShared++;
      }

      // Mark this connection's record as stale
      db.run(
        `UPDATE imported_models SET lifecycle = 'stale', updated_at = ? WHERE id = ?`,
        [now, item.id]
      );
      pruned++;
    }

    return { pruned, retainedShared, skipped: false, reason: null };
  });

  if (result.pruned > 0) {
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "settings",
        timestamp: Date.now(),
      });
    } catch {}
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved Model Metadata Cascade
// ─────────────────────────────────────────────────────────────────────────────

export async function getResolvedModelMetadata({ provider, modelId }) {
  if (!provider || !modelId) {
    throw new Error("provider and modelId are required for getResolvedModelMetadata");
  }

  const p = String(provider).trim();
  const m = String(modelId).trim();

  const db = await getAdapter();

  // 1. Fetch manual capability overrides
  const manualOvr = await getCapabilityOverride({ provider: p, modelId: m, source: "manual" });

  // 2. Fetch auto:discovery capability overrides
  const autoOvr = await getCapabilityOverride({ provider: p, modelId: m, source: "auto:discovery" });

  // 3. Fetch active imported model record
  const impRow = db.get(
    `SELECT capabilities_json, metadata_json FROM imported_models
     WHERE provider = ? AND model_id = ? AND lifecycle = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [p, m]
  );
  const impCaps = impRow ? parseJson(impRow.capabilities_json, {}) : {};
  const impMeta = impRow ? parseJson(impRow.metadata_json, {}) : {};

  // Per-field merge cascade: manual > auto:discovery > imported
  const resolvedCaps = {};
  const provenance = {};

  const allFields = new Set([
    ...Object.keys(impCaps || {}),
    ...Object.keys(autoOvr?.capabilities || {}),
    ...Object.keys(manualOvr?.capabilities || {}),
  ]);

  for (const field of allFields) {
    if (manualOvr && manualOvr.capabilities && field in manualOvr.capabilities) {
      resolvedCaps[field] = manualOvr.capabilities[field];
      provenance[field] = "manual";
    } else if (autoOvr && autoOvr.capabilities && field in autoOvr.capabilities) {
      resolvedCaps[field] = autoOvr.capabilities[field];
      provenance[field] = "auto:discovery";
    } else if (impCaps && field in impCaps) {
      resolvedCaps[field] = impCaps[field];
      provenance[field] = "imported";
    }
  }

  return {
    provider: p,
    modelId: m,
    capabilities: resolvedCaps,
    provenance,
    metadata: scrubCredentials(impMeta),
  };
}

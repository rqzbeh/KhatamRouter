import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

export const COMBOS_CACHE_TTL_MS = 5000;
// Bounded: keys are client-supplied model ids, so negative results alone could grow without limit.
export const COMBOS_CACHE_MAX_ENTRIES = 512;

// Map keeps insertion order; re-inserting on hit makes it LRU. Oldest key evicted on overflow.
const comboByNameCache = new Map();
let combosGeneration = 0;

export function invalidateCombosCache() {
  combosGeneration++;
  comboByNameCache.clear();
}

try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
    if (
      !payload ||
      payload.scope === "combos" ||
      payload.scope === "settings" ||
      payload.scope === "all"
    ) {
      invalidateCombosCache();
    }
  });
} catch {
  // Safe fail-open if events bus cannot hook
}

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const now = Date.now();
  const cached = comboByNameCache.get(name);
  if (cached && now < cached.expiresAt) {
    comboByNameCache.delete(name);
    comboByNameCache.set(name, cached);
    return structuredClone(cached.data);
  }

  const gen = combosGeneration;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  const combo = rowToCombo(row);

  if (gen === combosGeneration) {
    comboByNameCache.delete(name);
    comboByNameCache.set(name, { data: combo, expiresAt: now + COMBOS_CACHE_TTL_MS });
    if (comboByNameCache.size > COMBOS_CACHE_MAX_ENTRIES) {
      comboByNameCache.delete(comboByNameCache.keys().next().value);
    }
  }

  return structuredClone(combo);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
  );
  invalidateCombosCache();
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "combos",
      timestamp: Date.now(),
    });
  } catch {}
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    result = merged;
  });
  if (result) {
    invalidateCombosCache();
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "combos",
        timestamp: Date.now(),
      });
    } catch {}
  }
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  const ok = (res?.changes ?? 0) > 0;
  if (ok) {
    invalidateCombosCache();
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "combos",
        timestamp: Date.now(),
      });
    } catch {}
  }
  return ok;
}

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

export const ALIASES_CACHE_TTL_MS = 5000;

let aliasesCache = {
  data: null,
  expiresAt: 0,
};

export function invalidateAliasesCache() {
  aliasesCache.data = null;
  aliasesCache.expiresAt = 0;
}

try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
    if (!payload || payload.scope === "aliases" || payload.scope === "modelAliases" || payload.scope === "all") {
      invalidateAliasesCache();
    }
  });
} catch {
  // Safe fail-open if events bus cannot hook
}

async function ensureDbHook() {
  try {
    const db = await getAdapter();
    if (db && !db._aliasHooked) {
      db._aliasHooked = true;
      const origRun = db.run.bind(db);
      db.run = (sql, ...args) => {
        if (typeof sql === "string" && sql.includes("DELETE FROM kv WHERE scope IN")) {
          invalidateAliasesCache();
        }
        return origRun(sql, ...args);
      };
    }
  } catch {}
}

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  const now = Date.now();
  if (aliasesCache.data && now < aliasesCache.expiresAt) {
    return structuredClone(aliasesCache.data);
  }
  await ensureDbHook();
  const raw = await aliasKv.getAll();
  aliasesCache.data = raw || {};
  aliasesCache.expiresAt = now + ALIASES_CACHE_TTL_MS;
  return structuredClone(aliasesCache.data);
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  invalidateAliasesCache();
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "aliases",
      timestamp: Date.now(),
    });
  } catch {}
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  invalidateAliasesCache();
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "aliases",
      timestamp: Date.now(),
    });
  } catch {}
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, transport }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}

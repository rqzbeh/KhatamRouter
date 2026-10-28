import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

export const NODES_CACHE_TTL_MS = 5000;
// Bounded by distinct filter keys; filters are type-only in practice.
export const NODES_CACHE_MAX_ENTRIES = 64;

const nodesCache = new Map();
let nodesGeneration = 0;

export function invalidateNodesCache() {
  nodesGeneration++;
  nodesCache.clear();
}

function publishNodesChanged() {
  invalidateNodesCache();
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "nodes",
      timestamp: Date.now(),
    });
  } catch {}
}

try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
    if (
      !payload ||
      payload.scope === "nodes" ||
      payload.scope === "providerNodes" ||
      payload.scope === "settings" ||
      payload.scope === "all"
    ) {
      invalidateNodesCache();
    }
  });
} catch {
  // Safe fail-open if events bus cannot hook
}

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProviderNodes(filter = {}) {
  const key = filter.type ? `type:${filter.type}` : "all";
  const now = Date.now();
  const cached = nodesCache.get(key);
  if (cached && now < cached.expiresAt) {
    nodesCache.delete(key);
    nodesCache.set(key, cached);
    return structuredClone(cached.data);
  }

  const gen = nodesGeneration;
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const data = db.all(sql, params).map(rowToNode);

  if (gen === nodesGeneration) {
    nodesCache.delete(key);
    nodesCache.set(key, { data, expiresAt: now + NODES_CACHE_TTL_MS });
    if (nodesCache.size > NODES_CACHE_MAX_ENTRIES) {
      nodesCache.delete(nodesCache.keys().next().value);
    }
  }
  return structuredClone(data);
}

export async function getProviderNodeById(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

export async function createProviderNode(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  publishNodesChanged();
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  if (result) {
    publishNodesChanged();
  }
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
    // Custom models are keyed `${providerAlias}|${id}|${type}` and their
    // disabled lists `${providerAlias}`; a compatible node stores both under its
    // own id, so leaving them behind keeps a deleted node's models in /v1/models.
    db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?`, [`${id}|%`]);
    db.run(`DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?`, [id]);
  });
  if (removed) {
    publishNodesChanged();
  }
  return removed;
}

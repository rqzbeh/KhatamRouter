import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

export const NODES_CACHE_TTL_MS = 5000;

const nodesCache = new Map();

export function invalidateNodesCache() {
  nodesCache.clear();
}

try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload) => {
    if (
      !payload ||
      payload.scope === "nodes" ||
      payload.scope === "providerNodes" ||
      payload.scope === "all"
    ) {
      invalidateNodesCache();
    }
  });
} catch {
  // Safe fail-open if events bus cannot hook
}

async function ensureDbHook() {
  try {
    const db = await getAdapter();
    if (db && !db._nodesHooked) {
      db._nodesHooked = true;
      const origRun = db.run.bind(db);
      db.run = (sql, ...args) => {
        if (typeof sql === "string" && sql.trim() === "DELETE FROM providerNodes") {
          invalidateNodesCache();
        }
        return origRun(sql, ...args);
      };
    }
  } catch {}
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
  const cacheKey = filter?.type ? String(filter.type) : "*";
  const now = Date.now();
  const cached = nodesCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return structuredClone(cached.data);
  }

  await ensureDbHook();
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter?.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const nodes = db.all(sql, params).map(rowToNode);

  nodesCache.set(cacheKey, {
    data: nodes,
    expiresAt: now + NODES_CACHE_TTL_MS,
  });

  return structuredClone(nodes);
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
  invalidateNodesCache();
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "nodes",
      timestamp: Date.now(),
    });
  } catch {}
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
    invalidateNodesCache();
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "nodes",
        timestamp: Date.now(),
      });
    } catch {}
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
    invalidateNodesCache();
    try {
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope: "nodes",
        timestamp: Date.now(),
      });
    } catch {}
  }
  return removed;
}

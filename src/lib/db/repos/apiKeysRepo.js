import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

function parseJsonArrayOrNull(val) {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function serializeJson(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
    allowedKinds: row.allowedKinds !== undefined ? parseJsonArrayOrNull(row.allowedKinds) : null,
    allowedProviders: row.allowedProviders !== undefined ? parseJsonArrayOrNull(row.allowedProviders) : null,
    allowedCombos: row.allowedCombos !== undefined ? parseJsonArrayOrNull(row.allowedCombos) : null,
    allowedModels: row.allowedModels !== undefined ? parseJsonArrayOrNull(row.allowedModels) : null,
    rate_limits: row.rate_limits ?? null,
    throttle_delay_ms: row.throttle_delay_ms ?? 0,
    usage_limit_enabled: row.usage_limit_enabled ?? 0,
    daily_usage_limit_usd: row.daily_usage_limit_usd ?? null,
    weekly_usage_limit_usd: row.weekly_usage_limit_usd ?? null,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);

    const tableInfo = db.all(`PRAGMA table_info(apiKeys)`) || [];
    const colNames = new Set(tableInfo.map((c) => c.name));

    if (colNames.has("allowedKinds")) {
      db.run(
        `UPDATE apiKeys SET
           key = ?, name = ?, machineId = ?, isActive = ?,
           accessRestricted = ?, accessAllow = ?,
           allowedProviders = ?, allowedCombos = ?, allowedKinds = ?, allowedModels = ?,
           rate_limits = ?, throttle_delay_ms = ?, usage_limit_enabled = ?,
           daily_usage_limit_usd = ?, weekly_usage_limit_usd = ?
         WHERE id = ?`,
        [
          merged.key,
          merged.name,
          merged.machineId,
          merged.isActive ? 1 : 0,
          cols.accessRestricted,
          cols.accessAllow,
          serializeJson(merged.allowedProviders),
          serializeJson(merged.allowedCombos),
          serializeJson(merged.allowedKinds),
          serializeJson(merged.allowedModels),
          typeof merged.rate_limits === "string" ? merged.rate_limits : (merged.rate_limits ? JSON.stringify(merged.rate_limits) : null),
          merged.throttle_delay_ms ?? 0,
          merged.usage_limit_enabled ? 1 : 0,
          merged.daily_usage_limit_usd ?? null,
          merged.weekly_usage_limit_usd ?? null,
          id,
        ]
      );
    } else {
      db.run(
        `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
        [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
      );
    }
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

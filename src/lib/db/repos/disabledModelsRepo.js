import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "disabledModels";
const AUDIT_SCOPE = "disabledModelAudit";
const MAX_AUDIT_ENTRIES = 1000;

export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  if (!providerAlias) return [];
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  return row ? (parseJson(row.value, []) || []) : [];
}

export async function getDisabledModelAudit(providerAlias) {
  if (!providerAlias) return [];
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [AUDIT_SCOPE, providerAlias]);
  return row ? (parseJson(row.value, []) || []) : [];
}

export const getDisabledModelAuditByProvider = getDisabledModelAudit;

export async function disableModels(providerAlias, ids, audit = null) {
  if (!providerAlias || !Array.isArray(ids) || ids.length === 0) return;
  const db = await getAdapter();
  const runTx = db.immediate ? db.immediate.bind(db) : db.transaction.bind(db);
  runTx(() => {
    // 1. Update disabled models list
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const merged = [...new Set([...current, ...ids])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson(merged)]
    );

    // 2. Append to audit log if audit metadata is provided
    if (audit && typeof audit === "object") {
      const auditRow = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [AUDIT_SCOPE, providerAlias]);
      const currentAudit = auditRow ? (parseJson(auditRow.value, []) || []) : [];
      const disabledAt = audit.disabledAt || new Date().toISOString();
      const newEntries = ids.map((id) => ({
        id,
        reason: audit.reason || "model_not_found",
        disabledAt,
        batchId: audit.batchId || null,
        reenabledAt: null,
      }));
      const combined = [...currentAudit, ...newEntries].slice(-MAX_AUDIT_ENTRIES);
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [AUDIT_SCOPE, providerAlias, stringifyJson(combined)]
      );
    }
  });
}

export async function disableModelsWithAudit(providerAlias, ids, audit = {}) {
  return disableModels(providerAlias, ids, audit);
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  const runTx = db.immediate ? db.immediate.bind(db) : db.transaction.bind(db);
  runTx(() => {
    const isAll = !Array.isArray(ids) || ids.length === 0;
    const removeSet = isAll ? null : new Set(ids);

    // 1. Update disabledModels scope
    if (isAll) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    } else {
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      const current = row ? (parseJson(row.value, []) || []) : [];
      const next = current.filter((id) => !removeSet.has(id));
      if (next.length === 0) {
        db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      } else {
        db.run(
          `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
          [SCOPE, providerAlias, stringifyJson(next)]
        );
      }
    }

    // 2. Update audit log marking reenabledAt
    const auditRow = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [AUDIT_SCOPE, providerAlias]);
    if (auditRow) {
      const currentAudit = parseJson(auditRow.value, []) || [];
      const now = new Date().toISOString();
      let changed = false;
      const updatedAudit = currentAudit.map((entry) => {
        if (!entry.reenabledAt && (isAll || removeSet.has(entry.id))) {
          changed = true;
          return { ...entry, reenabledAt: now };
        }
        return entry;
      });
      if (changed) {
        db.run(
          `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
          [AUDIT_SCOPE, providerAlias, stringifyJson(updatedAudit)]
        );
      }
    }
  });
}

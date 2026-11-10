/**
 * Pure helpers for combo updates, strategy migration on rename, and compensating rollbacks.
 * Note: Since operations span separate HTTP endpoints (/api/combos and /api/settings),
 * true cross-service ACID atomicity is not guaranteed over the wire. Instead, compensating
 * updates are executed on failure, with truthful reporting of whether the recovery succeeded.
 */

import {
  MEMBER_COOLDOWN_PRESETS_MS,
  MIN_MEMBER_COOLDOWN_MS,
  MAX_MEMBER_COOLDOWN_MS,
  COOLDOWN_PRESET_OPTIONS,
  normalizeMemberCooldownMs,
  isValidMemberCooldown,
  isComboCooldownDisabled,
} from "open-sse/config/comboCooldown.js";

export {
  MEMBER_COOLDOWN_PRESETS_MS,
  MIN_MEMBER_COOLDOWN_MS,
  MAX_MEMBER_COOLDOWN_MS,
  COOLDOWN_PRESET_OPTIONS,
  normalizeMemberCooldownMs,
  isValidMemberCooldown,
  isComboCooldownDisabled,
};

/**
 * Capture full mutable state of a combo for compensating rollbacks.
 */
export function snapshotMutableCombo(combo) {
  if (!combo) return null;
  const snapshot = {
    name: combo.name,
    models: Array.isArray(combo.models) ? [...combo.models] : [],
  };
  if (combo.kind !== undefined) {
    snapshot.kind = combo.kind;
  }
  return snapshot;
}

/**
 * Calculate the updated comboStrategies object when updating or renaming a combo.
 * Migrates existing configuration from oldName to newName if renamed.
 * Applies or prunes memberCooldownMs and disableCooldown.
 */
export function calculateComboStrategyUpdate(currentStrategies = {}, oldName, newName, memberCooldownMs, disableCooldown) {
  const updated = { ...currentStrategies };
  let strategiesChanged = false;

  // Maintain mapping on rename: move oldName config to newName
  if (oldName && newName && oldName !== newName && updated[oldName]) {
    updated[newName] = { ...updated[oldName] };
    delete updated[oldName];
    strategiesChanged = true;
  }

  // Apply memberCooldownMs and/or disableCooldown if updated in form
  if (memberCooldownMs !== undefined || disableCooldown !== undefined) {
    const targetKey = newName || oldName;
    const target = updated[targetKey] ? { ...updated[targetKey] } : {};

    if (disableCooldown !== undefined) {
      if (disableCooldown === true) {
        target.disableCooldown = true;
      } else {
        delete target.disableCooldown;
      }
    }

    if (memberCooldownMs !== undefined) {
      if (isComboCooldownDisabled(false, memberCooldownMs)) {
        target.disableCooldown = true;
        delete target.memberCooldownMs;
      } else if (memberCooldownMs === null || memberCooldownMs === "") {
        delete target.memberCooldownMs;
      } else {
        target.memberCooldownMs = memberCooldownMs;
        if (disableCooldown === undefined) {
          delete target.disableCooldown;
        }
      }
    }

    const hasConfig = Object.keys(target).some(
      (k) => target[k] !== undefined && target[k] !== null && target[k] !== "" && target[k] !== false
    );
    if (hasConfig) {
      updated[targetKey] = target;
    } else {
      delete updated[targetKey];
    }
    strategiesChanged = true;
  }

  return { updated, strategiesChanged };
}

/**
 * Executes a combo update with strategy migration and compensating rollback on settings failure.
 *
 * Sequence:
 * 1. Renames/updates combo in DB first via updateComboApi.
 * 2. If combo update fails, returns failure without touching settings.
 * 3. Migrates and updates strategies via persistStrategiesApi.
 * 4. If persistStrategiesApi fails, executes compensating update on the combo to restore old snapshot.
 * 5. Truthfully reports whether the rollback succeeded or failed.
 */
export async function executeComboUpdateTransaction({
  id,
  oldCombo,
  newComboData,
  memberCooldownMs,
  disableCooldown,
  comboStrategies,
  updateComboApi,
  persistStrategiesApi,
}) {
  const oldName = oldCombo?.name;

  let updateResult;
  try {
    updateResult = await updateComboApi(id, newComboData);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Failed to update combo",
      rolledBack: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
    };
  }

  if (!updateResult || updateResult.ok === false) {
    return {
      ok: false,
      error: updateResult?.error || "Failed to update combo",
      rolledBack: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
    };
  }

  const { updated, strategiesChanged } = calculateComboStrategyUpdate(
    comboStrategies,
    oldName,
    newComboData.name,
    memberCooldownMs,
    disableCooldown
  );

  if (strategiesChanged) {
    try {
      await persistStrategiesApi(updated);
    } catch (settingsErr) {
      let rollbackSucceeded = false;
      let rollbackError = null;

      if (oldCombo) {
        try {
          const snapshot = snapshotMutableCombo(oldCombo);
          const rollbackRes = await updateComboApi(id, snapshot);
          if (rollbackRes && rollbackRes.ok === false) {
            rollbackError = rollbackRes.error || "Rollback update rejected";
          } else {
            rollbackSucceeded = true;
          }
        } catch (rbErr) {
          rollbackError = rbErr?.message || "Rollback update threw";
        }
      }

      if (rollbackSucceeded) {
        return {
          ok: false,
          error: `Failed to persist combo settings; combo update rolled back: ${settingsErr.message || "Unknown settings error"}`,
          rolledBack: true,
          rollbackAttempted: true,
          rollbackSucceeded: true,
        };
      }

      return {
        ok: false,
        error: `Failed to persist combo settings and rollback recovery failed (${rollbackError || "no snapshot"}); combo remains in inconsistent partial state: ${settingsErr.message || "Unknown error"}`,
        rolledBack: false,
        rollbackAttempted: true,
        rollbackSucceeded: false,
        rollbackError,
      };
    }
  }

  return { ok: true, updatedStrategies: updated, rolledBack: false };
}

/**
 * Executes combo creation with settings persistence and compensating delete rollback on failure.
 */
export async function executeComboCreateTransaction({
  comboData,
  memberCooldownMs,
  disableCooldown,
  comboStrategies,
  createComboApi,
  deleteComboApi,
  persistStrategiesApi,
}) {
  let createResult;
  try {
    createResult = await createComboApi(comboData);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Failed to create combo",
      rolledBack: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
    };
  }

  if (!createResult || createResult.ok === false) {
    return {
      ok: false,
      error: createResult?.error || "Failed to create combo",
      rolledBack: false,
      rollbackAttempted: false,
      rollbackSucceeded: false,
    };
  }

  const created = createResult.data;
  const isDisabled = isComboCooldownDisabled(disableCooldown, memberCooldownMs);
  const hasCooldownMs = !isDisabled && memberCooldownMs !== undefined && memberCooldownMs !== null && memberCooldownMs !== "";
  if (isDisabled || hasCooldownMs) {
    const updated = { ...comboStrategies };
    const entry = { ...(updated[comboData.name] || {}) };
    if (isDisabled) {
      entry.disableCooldown = true;
      delete entry.memberCooldownMs;
    } else if (hasCooldownMs) {
      entry.memberCooldownMs = memberCooldownMs;
      delete entry.disableCooldown;
    }
    updated[comboData.name] = entry;

    try {
      await persistStrategiesApi(updated);
    } catch (settingsErr) {
      let rollbackSucceeded = false;
      let rollbackError = null;

      if (created?.id) {
        try {
          const deleteRes = await deleteComboApi(created.id);
          if (deleteRes && deleteRes.ok === false) {
            rollbackError = deleteRes.error || "Rollback delete rejected";
          } else {
            rollbackSucceeded = true;
          }
        } catch (delErr) {
          rollbackError = delErr?.message || "Rollback delete threw";
        }
      }

      if (rollbackSucceeded) {
        return {
          ok: false,
          error: `Failed to persist combo settings; combo creation rolled back: ${settingsErr.message || "Unknown settings error"}`,
          rolledBack: true,
          rollbackAttempted: true,
          rollbackSucceeded: true,
        };
      }

      return {
        ok: false,
        error: `Failed to persist combo settings and rollback recovery failed (${rollbackError || "no id"}); created combo remains in inconsistent partial state: ${settingsErr.message || "Unknown error"}`,
        rolledBack: false,
        rollbackAttempted: true,
        rollbackSucceeded: false,
        rollbackError,
      };
    }
    return { ok: true, created, updatedStrategies: updated, rolledBack: false };
  }

  return { ok: true, created, updatedStrategies: comboStrategies, rolledBack: false };
}

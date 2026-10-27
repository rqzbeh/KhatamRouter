// NOTE: driver.js → migrate.js → metaStore.js → driver.js forms a static import cycle,
// but all cross-module references use dynamic `await import()` which breaks the cycle at runtime.
//
// In Wave 7.5, KhatamRouter standardizes exclusively on bun:sqlite with WAL journal mode.
// No Node-runtime SQLite fallback drivers remain — this is the only adapter.
//
// MIGRATED_MARKER: The legacy JSON migration marker in src/lib/db/migrate.js is preserved
// per US7 Acceptance Scenario 14 to prevent duplicate migration passes if legacy JSON files exist.
import fs from "node:fs";
import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
function getState() {
  if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
  return global._dbAdapter;
}

/**
 * Open an existing database read-only using bun:sqlite, without treating driver
 * failures as corruption. The integrity preflight must run on a connection that
 * cannot write, so a corrupt file is never "repaired" into existence by the check itself.
 */
async function openIntegrityDatabase(file) {
  if (!process.versions.bun) {
    throw new Error("[DB] KhatamRouter requires the Bun runtime (bun:sqlite). Please run with 'bun'.");
  }
  const { Database } = await import("bun:sqlite");
  return new Database(file, { readonly: true });
}

/**
 * Fail closed on any preflight error; backup restoration must be an explicit
 * action. Returns true when an existing database file was found and passed
 * `PRAGMA quick_check`, false when the file does not exist yet.
 */
export async function verifyDatabaseIntegrity(file) {
  try {
    fs.statSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  const db = await openIntegrityDatabase(file);
  try {
    const rows = db.prepare("PRAGMA quick_check;").all();
    // Drivers disagree on the result shape (`quick_check` vs `integrity_check`).
    const results = (rows || []).map((row) => Object.values(row)[0]);
    if (!results.length || results.some((value) => value !== "ok")) {
      throw new Error(
        `[DB] Integrity check failed for ${file}: ${results.join("; ") || "no result"}. ` +
          `Database files were left in place.`
      );
    }
  } finally {
    try { db.close(); } catch {}
  }
  return true;
}

async function initAdapter() {
  if (!process.versions.bun) {
    throw new Error("[DB] KhatamRouter requires the Bun runtime (bun:sqlite). Please run with 'bun'.");
  }

  ensureDirs();

  // Preflight before driver opens the file for writing: a corrupt database
  // must stop the boot, not be silently replaced by an empty one.
  await verifyDatabaseIntegrity(DATA_FILE);

  const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
  const adapter = await createBunSqliteAdapter(DATA_FILE);

  const state = getState();
  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  // During Next.js production build, skip running migrations against a real file to keep static prerendering safe without disk mutation or worker races
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return adapter;
  }

  // In multi-worker cluster mode, the Primary process runs migrations once before forking workers.
  // Workers receive KHATAM_MIGRATIONS_DONE=1 and skip running redundant migrations or backups.
  if (process.env.KHATAM_MIGRATIONS_DONE === "1") {
    return adapter;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  try {
    await runMigrationOnce(adapter);
    return adapter;
  } catch (error) {
    try { adapter.close?.(); } catch {}
    throw error;
  }
}

export async function getAdapter() {
  const state = getState();
  if (state.instance) return state.instance;
  if (!state.initPromise) {
    state.initPromise = initAdapter()
      .then((a) => { state.instance = a; return a; })
      .catch((error) => {
        // Keep a failed init retryable instead of caching the rejection forever.
        state.initPromise = null;
        throw error;
      });
  }
  return state.initPromise;
}

export function getAdapterSync() {
  const state = getState();
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}

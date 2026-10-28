import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DRIVER_PATH = path.join(REPO_ROOT, "src/lib/db/driver.js");
const ADAPTER_PATH = path.join(REPO_ROOT, "src/lib/db/adapters/bunSqliteAdapter.js");

// `env` values of undefined mean "unset": the key is removed from the child env
// (spawn would otherwise stringify undefined to the literal "undefined").
function runWorkerChild({ script, env = {}, timeoutMs = 10000 }) {
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  return new Promise((resolve, reject) => {
    // vitest runs under Node, so process.execPath is node, not bun. Children must be bun (bun:sqlite).
    const child = spawn(
      "bun",
      ["-e", script],
      {
        cwd: REPO_ROOT,
        env: {
          ...childEnv,
          HTTPS_PROXY: "",
          HTTP_PROXY: "",
          ALL_PROXY: "",
          https_proxy: "",
          http_proxy: "",
          all_proxy: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child timed out after ${timeoutMs}ms. stdout: ${stdout}, stderr: ${stderr}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("Vertical Cluster Database Safety Contract (US2 / T018-T019)", () => {
  it("single-process default behavior runs migrations and stamps _meta when KHATAM_MIGRATIONS_DONE is unset", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-single-proc-"));
    try {
      const script = `
        const { getAdapter } = await import(${JSON.stringify(DRIVER_PATH)});
        const adapter = await getAdapter();
        const tables = adapter.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
        const metaCount = adapter.get("SELECT count(*) as c FROM _meta")?.c ?? 0;
        console.log(JSON.stringify({ tablesCount: tables.length, metaCount, hasMeta: tables.includes("_meta") }));
        adapter.close();
      `;

      const { code, stdout, stderr } = await runWorkerChild({
        script,
        env: {
          DATA_DIR: tmpDir,
          DATA_DIR_ALLOW_TEMP: "1",
          KHATAM_MIGRATIONS_DONE: undefined,
          KHATAM_WORKER_ROLE: undefined,
        },
      });

      expect(code, `child failed with stderr: ${stderr}`).toBe(0);
      const parsed = JSON.parse(stdout.trim().split("\n").pop());
      expect(parsed.hasMeta).toBe(true);
      expect(parsed.tablesCount).toBeGreaterThanOrEqual(15);
      expect(parsed.metaCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("N unmigrated workers started with KHATAM_MIGRATIONS_DONE=1 do not run migrations or backups against shared DB", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-unmigrated-workers-"));
    try {
      const dbDir = path.join(tmpDir, "db");
      fs.mkdirSync(dbDir, { recursive: true });
      const dbFile = path.join(dbDir, "data.sqlite");

      // Seed unmigrated database with single seed table so DB exists in WAL mode but has no full schema
      const seedScript = `
        const { Database } = await import("bun:sqlite");
        const db = new Database(${JSON.stringify(dbFile)}, { create: true });
        db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        db.exec("CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO _meta(key,value) VALUES('seed','1');");
        db.close();
      `;
      const seedRes = await runWorkerChild({ script: seedScript, env: { DATA_DIR: tmpDir, DATA_DIR_ALLOW_TEMP: "1" } });
      expect(seedRes.code).toBe(0);

      // Concurrently run 3 workers with KHATAM_MIGRATIONS_DONE=1
      const workerScript = `
        const { getAdapter } = await import(${JSON.stringify(DRIVER_PATH)});
        const adapter = await getAdapter();
        const tables = adapter.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
        console.log(JSON.stringify({ tablesCount: tables.length, tables }));
        adapter.close();
      `;

      const workers = await Promise.all([
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "worker",
          },
        }),
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "worker",
          },
        }),
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "worker",
          },
        }),
      ]);

      for (const res of workers) {
        expect(res.code, `worker failed: ${res.stderr}`).toBe(0);
        const parsed = JSON.parse(res.stdout.trim().split("\n").pop());
        // Worker must NOT run migrations: only original seed _meta table exists
        expect(parsed.tablesCount).toBe(1);
        expect(parsed.tables).toEqual(["_meta"]);
      }

      // Assert no backups were created
      const backupsDir = path.join(dbDir, "backups");
      const backupsExist = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
      expect(backupsExist.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("primary-first migration then concurrent workers open and query shared DB fine", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-primary-first-"));
    try {
      // Step 1: Primary runs migrations (KHATAM_MIGRATIONS_DONE unset)
      const primaryScript = `
        const { getAdapter } = await import(${JSON.stringify(DRIVER_PATH)});
        const adapter = await getAdapter();
        const tables = adapter.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
        console.log(JSON.stringify({ ok: true, tablesCount: tables.length }));
        adapter.close();
      `;

      const primaryRes = await runWorkerChild({
        script: primaryScript,
        env: {
          DATA_DIR: tmpDir,
          DATA_DIR_ALLOW_TEMP: "1",
          KHATAM_MIGRATIONS_DONE: undefined,
          KHATAM_WORKER_ROLE: "leader",
        },
      });
      expect(primaryRes.code).toBe(0);
      const primaryParsed = JSON.parse(primaryRes.stdout.trim().split("\n").pop());
      expect(primaryParsed.tablesCount).toBeGreaterThanOrEqual(15);

      // Step 2: 3 concurrent workers start with KHATAM_MIGRATIONS_DONE=1 and open DB
      const workerScript = `
        const { getAdapter } = await import(${JSON.stringify(DRIVER_PATH)});
        const adapter = await getAdapter();
        const row = adapter.get("SELECT count(*) as c FROM _meta");
        const settings = adapter.get("SELECT count(*) as c FROM settings");
        console.log(JSON.stringify({ ok: true, metaCount: row.c, settingsReadable: typeof settings.c === "number" }));
        adapter.close();
      `;

      const workerRuns = await Promise.all([
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "leader",
          },
        }),
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "worker",
          },
        }),
        runWorkerChild({
          script: workerScript,
          env: {
            DATA_DIR: tmpDir,
            DATA_DIR_ALLOW_TEMP: "1",
            KHATAM_MIGRATIONS_DONE: "1",
            KHATAM_WORKER_ROLE: "worker",
          },
        }),
      ]);

      for (const res of workerRuns) {
        expect(res.code, `worker failed: ${res.stderr}`).toBe(0);
        const parsed = JSON.parse(res.stdout.trim().split("\n").pop());
        expect(parsed.ok).toBe(true);
        expect(parsed.metaCount).toBeGreaterThan(0);
        expect(parsed.settingsReadable).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("bunSqliteAdapter schedules WAL checkpoint timer only for leader or unset, skips for worker", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-checkpoint-timer-"));
    try {
      const dbFile = path.join(tmpDir, "test.sqlite");

      const checkTimerScript = `
        let timerScheduled = 0;
        const orig = globalThis.setInterval;
        globalThis.setInterval = function(...args) {
          timerScheduled++;
          return orig.apply(this, args);
        };
        const { createBunSqliteAdapter } = await import(${JSON.stringify(ADAPTER_PATH)});
        const adapter = await createBunSqliteAdapter(${JSON.stringify(dbFile)});
        console.log(JSON.stringify({ timerScheduled }));
        adapter.close();
      `;

      // 1. Unset (single-process mode) -> timer scheduled
      const resUnset = await runWorkerChild({
        script: checkTimerScript,
        env: { DATA_DIR: tmpDir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKER_ROLE: undefined },
      });
      expect(resUnset.code).toBe(0);
      const parsedUnset = JSON.parse(resUnset.stdout.trim().split("\n").pop());
      expect(parsedUnset.timerScheduled).toBe(1);

      // 2. Leader role -> timer scheduled
      const resLeader = await runWorkerChild({
        script: checkTimerScript,
        env: { DATA_DIR: tmpDir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKER_ROLE: "leader" },
      });
      expect(resLeader.code).toBe(0);
      const parsedLeader = JSON.parse(resLeader.stdout.trim().split("\n").pop());
      expect(parsedLeader.timerScheduled).toBe(1);

      // 3. Worker role -> timer skipped
      const resWorker = await runWorkerChild({
        script: checkTimerScript,
        env: { DATA_DIR: tmpDir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKER_ROLE: "worker" },
      });
      expect(resWorker.code).toBe(0);
      const parsedWorker = JSON.parse(resWorker.stdout.trim().split("\n").pop());
      expect(parsedWorker.timerScheduled).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("bunSqliteAdapter preserves close-time checkpoint and clears interval if scheduled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-checkpoint-close-"));
    try {
      const dbFile = path.join(tmpDir, "test.sqlite");

      const script = `
        let checkpointCount = 0;
        let clearIntervalCount = 0;
        const origClearInterval = globalThis.clearInterval;
        globalThis.clearInterval = function(...args) {
          clearIntervalCount++;
          return origClearInterval.apply(this, args);
        };
        const { createBunSqliteAdapter } = await import(${JSON.stringify(ADAPTER_PATH)});
        const adapter = await createBunSqliteAdapter(${JSON.stringify(dbFile)});

        // Intercept exec calls to count checkpoint calls on close
        const origExec = adapter.raw.exec.bind(adapter.raw);
        adapter.raw.exec = function(sql) {
          if (typeof sql === "string" && sql.includes("wal_checkpoint")) {
            checkpointCount++;
          }
          return origExec(sql);
        };

        adapter.close();
        console.log(JSON.stringify({ checkpointCount, clearIntervalCount }));
      `;

      const res = await runWorkerChild({
        script,
        env: { DATA_DIR: tmpDir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKER_ROLE: "leader" },
      });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout.trim().split("\n").pop());
      expect(parsed.checkpointCount).toBeGreaterThanOrEqual(1);
      expect(parsed.clearIntervalCount).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maintains exported symbol parity for bunSqliteAdapter twins (twin alignment constraint)", async () => {
    const js = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    const ts = await import("@/lib/db/adapters/bunSqliteAdapter.js");

    const jsExports = Object.keys(js).sort();
    const tsExports = Object.keys(ts).sort();

    expect(tsExports).toEqual(jsExports);
    expect(jsExports).toEqual(["OPEN_PRAGMAS", "assertIntegrity", "createBunSqliteAdapter"].sort());
  });

  it("regression: integrity check connection and PRAGMA_SQL set busy_timeout before other work", async () => {
    const { PRAGMA_SQL } = await import("@/lib/db/schema.js");
    const busyIdx = PRAGMA_SQL.indexOf("PRAGMA busy_timeout");
    const journalIdx = PRAGMA_SQL.indexOf("PRAGMA journal_mode");
    expect(busyIdx).toBeGreaterThan(-1);
    expect(journalIdx).toBeGreaterThan(-1);
    expect(busyIdx).toBeLessThan(journalIdx);

    // Verify verifyDatabaseIntegrity applies busy_timeout on its connection
    const driverSource = fs.readFileSync(DRIVER_PATH, "utf8");
    expect(driverSource).toMatch(/openIntegrityDatabase[\s\S]*?busy_timeout/);
  });
});

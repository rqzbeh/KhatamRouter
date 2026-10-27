import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

// Real OS processes (not workers-in-one-process) sharing one WAL database.
// Proves saveRequestUsage serializes writers via BEGIN IMMEDIATE: every row persists
// and no SQLITE_BUSY reaches the caller (saveRequestUsage logs "Failed to save usage stats" on error).

const repoRoot = path.resolve(import.meta.dirname, "../..");
const PROCESSES = 4;
const WRITES_PER_PROCESS = 50;

const workerCode = `
const [,, dataDir, workerId, countStr] = process.argv;
process.env.DATA_DIR = dataDir;
process.env.DATA_DIR_ALLOW_TEMP = "1";
const root = ${JSON.stringify(repoRoot)};
const { saveRequestUsage } = await import(root + "/src/lib/db/repos/usageRepo.js");
const count = parseInt(countStr, 10);
const errors = [];
const origError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(" ")); };
for (let i = 0; i < count; i++) {
  await saveRequestUsage({
    timestamp: new Date(Date.UTC(2026, 0, 1) + (Number(workerId) * 100000 + i) * 1000).toISOString(),
    provider: "prov-" + workerId,
    model: "model-" + workerId + "-" + i,
    connectionId: "conn-" + workerId,
    apiKey: "key-" + workerId + "-" + i,
    tokens: { prompt_tokens: 10 + i, completion_tokens: 5 + i },
    endpoint: "/v1/chat/completions",
    status: "ok",
  });
}
console.error = origError;
if (errors.length) { console.error(errors.join("\\n")); process.exit(3); }
process.exit(0);
`;

describe("usage concurrent writers (real child processes, shared WAL database)", () => {
  it("persists 100% of rows across N processes with zero SQLITE_BUSY escaping", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-usage-concurrent-"));
    try {
      const workerScript = path.join(tempDir, "usage-writer-worker.mjs");
      fs.writeFileSync(workerScript, workerCode);

      // Schema init happens inside each worker too; pre-create once to avoid racing migrations.
      const initScript = path.join(tempDir, "init.mjs");
      fs.writeFileSync(initScript, `
        process.env.DATA_DIR = ${JSON.stringify(tempDir)};
        process.env.DATA_DIR_ALLOW_TEMP = "1";
        const { initDb } = await import(${JSON.stringify(repoRoot + "/src/lib/db/index.js")});
        await initDb();
        process.exit(0);
      `);
      const init = Bun.spawnSync([process.execPath, initScript], { stdout: "pipe", stderr: "pipe" });
      expect(init.exitCode, new TextDecoder().decode(init.stderr)).toBe(0);

      const procs = Array.from({ length: PROCESSES }, (_, w) =>
        Bun.spawn([process.execPath, workerScript, tempDir, String(w + 1), String(WRITES_PER_PROCESS)], {
          stdout: "pipe",
          stderr: "pipe",
        })
      );
      const results = await Promise.all(
        procs.map(async (p) => ({
          exit: await p.exited,
          stderr: await new Response(p.stderr).text(),
        }))
      );

      for (const r of results) {
        expect(r.stderr, "no SQLITE_BUSY / failed-save output").not.toMatch(/SQLITE_BUSY|database is locked|Failed to save usage stats/);
        expect(r.exit).toBe(0);
      }

      const verifyScript = path.join(tempDir, "verify.mjs");
      fs.writeFileSync(verifyScript, `
        process.env.DATA_DIR = ${JSON.stringify(tempDir)};
        process.env.DATA_DIR_ALLOW_TEMP = "1";
        const { getAdapter } = await import(${JSON.stringify(repoRoot + "/src/lib/db/driver.js")});
        const db = await getAdapter();
        const rows = db.get("SELECT count(*) AS n FROM usageHistory").n;
        // Workers write to different dates; sum every daily row, not just one.
        const requests = db.all("SELECT data FROM usageDaily").reduce((sum, r) => sum + JSON.parse(r.data).requests, 0);
        console.log(JSON.stringify({ rows, requests }));
        process.exit(0);
      `);
      const verify = Bun.spawnSync([process.execPath, verifyScript], { stdout: "pipe", stderr: "pipe" });
      expect(verify.exitCode, new TextDecoder().decode(verify.stderr)).toBe(0);
      const stdoutText = new TextDecoder().decode(verify.stdout);
      const jsonLine = stdoutText.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      const { rows, requests } = JSON.parse(jsonLine);

      const expected = PROCESSES * WRITES_PER_PROCESS;
      expect(rows).toBe(expected);
      expect(requests).toBe(expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});

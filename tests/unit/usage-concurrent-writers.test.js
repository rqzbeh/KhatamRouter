import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
let tempDir;

// Resolve repo root relative to this test file
const repoRoot = path.resolve(__dirname, "../..");

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-concurrent-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
});

describe("Usage concurrent writers (two Bun processes on shared WAL)", () => {
  it("persists all usage rows without SQLITE_BUSY data loss under concurrent writers", async () => {
    // 1. Initialize schema in the temp DB
    const { initDb } = await import("@/lib/db/index.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    await initDb();

    // 2. Prepare worker script
    const workerScript = path.join(tempDir, "worker.mjs");
    const workerCode = `
import path from "node:path";

const [,, targetDir, workerId, countStr] = process.argv;
process.env.DATA_DIR = targetDir;
process.env.DATA_DIR_ALLOW_TEMP = "1";

const repoRoot = ${JSON.stringify(repoRoot)};
const { initDb } = await import(path.join(repoRoot, "src/lib/db/index.js"));
const { saveRequestUsage } = await import(path.join(repoRoot, "src/lib/db/repos/usageRepo.js"));

await initDb();

const count = parseInt(countStr, 10);
const promises = [];
for (let i = 0; i < count; i++) {
  const timestamp = new Date(Date.now() + i * 1000 + (workerId === "w1" ? 0 : 500)).toISOString();
  promises.push(
    saveRequestUsage({
      timestamp,
      provider: \`prov-\${workerId}\`,
      model: \`model-\${workerId}-\${i}\`,
      connectionId: \`conn-\${workerId}\`,
      apiKey: \`key-\${workerId}-\${i}\`,
      tokens: { prompt_tokens: 10 + i, completion_tokens: 5 + i },
      endpoint: "/v1/chat/completions",
      status: "ok",
    })
  );
}
await Promise.all(promises);
`;
    fs.writeFileSync(workerScript, workerCode);

    // 3. Spawn 2 concurrent Bun child processes hammering saveRequestUsage
    const countPerWorker = 500;
    const totalExpected = countPerWorker * 2;

    const p1 = Bun.spawn(["bun", workerScript, tempDir, "w1", String(countPerWorker)], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const p2 = Bun.spawn(["bun", workerScript, tempDir, "w2", String(countPerWorker)], {
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exit1, exit2] = await Promise.all([p1.exited, p2.exited]);
    const stderr1 = await new Response(p1.stderr).text();
    const stderr2 = await new Response(p2.stderr).text();

    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    // Assert (a): every call persists exactly one usageHistory row and usageDaily.requests == total
    const db = await getAdapter();
    const historyRows = db.all("SELECT count(*) as count FROM usageHistory");
    const count = historyRows[0]?.count ?? 0;

    const dailyRow = db.get("SELECT data FROM usageDaily");
    const dailyData = dailyRow ? JSON.parse(dailyRow.data) : null;

    console.log(`[TEST RESULT] totalExpected: ${totalExpected}, historyCount: ${count}, dailyRequests: ${dailyData?.requests}, lostRows: ${totalExpected - count}`);

    // Assert (b): no 'Failed to save usage stats' logged
    const errorsLogged = [stderr1, stderr2].filter((s) => s.includes("Failed to save usage stats"));
    expect(errorsLogged, `Expected no error logs but got: ${stderr1.slice(0, 500)}\n${stderr2.slice(0, 500)}`).toHaveLength(0);

    expect(count).toBe(totalExpected);
    expect(dailyData?.requests).toBe(totalExpected);

    const metaRow = db.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
    expect(Number(metaRow?.value)).toBe(totalExpected);
  }, 30000);
});

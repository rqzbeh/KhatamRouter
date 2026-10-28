// US2 root cause: bunSqliteAdapter registered SIGINT/SIGTERM -> process.exit(0) for any process
// without KHATAM_WORKER_ROLE, including the cluster primary (runMigrationsOnce creates and closes
// the adapter there). close() never removed those listeners, so the primary hard-exited on SIGTERM,
// dropping IPC; each worker's Bun cluster/child 'disconnect' handler then process.exit(0)'d mid-stream.
// Real child process, real adapter, no HTTP fixture.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER = pathToFileURL(join(REPO, "src/lib/db/adapters/bunSqliteAdapter.js")).href;
const STRIPPED_ENV = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
  "KHATAM_WORKERS", "WEB_CONCURRENCY", "KHATAM_WORKER_ROLE", "KHATAM_MIGRATIONS_DONE", "DATA_DIR",
];
const tempDirs = [];
afterAll(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function writePrimaryFixture(dir) {
  const file = join(dir, "primary-fixture.mjs");
  writeFileSync(
    file,
    `import { join } from "node:path";
import { createBunSqliteAdapter } from ${JSON.stringify(ADAPTER)};
const adapter = await createBunSqliteAdapter(join(process.env.DATA_DIR, "primary.sqlite"));
adapter.close(); // runMigrationsOnce() pattern: close so the primary holds no handle
process.on("SIGTERM", () => { console.log("PRIMARY_SIGTERM_SEEN"); setTimeout(() => { console.log("PRIMARY_DRAINED"); process.exit(0); }, 300); });
console.log("PRIMARY_READY " + process.pid);
setInterval(() => {}, 1000);
`,
  );
  return file;
}

describe("US2 root cause: adapter must not hard-exit the cluster primary on SIGTERM", () => {
  it("primary role: SIGTERM after adapter.close() reaches the app handler, adapter does not exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "khatam-drain-e2e-"));
    tempDirs.push(dir);
    const file = writePrimaryFixture(dir);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
    const child = spawn("bun", [file], { env: { ...base, DATA_DIR: dir, DATA_DIR_ALLOW_TEMP: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const closed = new Promise((r) => child.once("close", (code, signal) => r({ code, signal })));
    for (let i = 0; i < 300 && !out.includes("PRIMARY_READY"); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    const { code } = await closed;
    expect(out).toContain("PRIMARY_SIGTERM_SEEN");
    expect(out).toContain("PRIMARY_DRAINED");
    expect(code).toBe(0);
  }, 30000);
});

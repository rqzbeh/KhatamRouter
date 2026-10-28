// Defect 1 (high): a follower worker's exit must not run host-wide cleanup.
// Real child processes load the real initializeApp.js. The "tunnel" is a dummy `sleep` child
// whose pid is written to $DATA_DIR/tunnel/cloudflared.pid, the file the leader's tunnel uses.
// Covered (real): initializeApp.js exit hook -> killCloudflared(), killAllBridges(), DNS cleanup.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT_APP = pathToFileURL(join(REPO, "src/shared/services/initializeApp.js")).href;
const TEST_TIMEOUT = 60000;
const STRIPPED_ENV = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
  "KHATAM_WORKERS", "WEB_CONCURRENCY", "KHATAM_WORKER_ROLE", "KHATAM_MIGRATIONS_DONE",
  "KHATAM_DRAIN_TIMEOUT_MS", "PORT", "DASHBOARD_PORT", "DATA_DIR", "NODE_ENV", "NEXT_MANUAL_SIG_HANDLE",
  "JWT_SECRET", "REDIS_URL",
];

const children = new Set();
const tempDirs = [];

afterEach(() => {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch { /* gone */ }
  }
  children.clear();
});

afterAll(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

// Fixture: run the real initializeApp wiring, then exit (exit hook runs with the role's env).
function writeFixture(dir) {
  const file = join(dir, "fixture.mjs");
  writeFileSync(
    file,
    `import { initializeApp } from ${JSON.stringify(INIT_APP)};
await initializeApp();
console.log("FIXTURE_READY");
process.exit(0);
`,
  );
  return file;
}

// Dummy cloudflared: a real child process whose pid sits in the tunnel pid file.
function startDummyTunnel(dataDir) {
  const dummy = spawn("sleep", ["60"], { stdio: "ignore" });
  const exited = new Promise((r) => dummy.once("exit", () => r(true)));
  const tunnelDir = join(dataDir, "tunnel");
  mkdirSync(tunnelDir, { recursive: true });
  writeFileSync(join(tunnelDir, "cloudflared.pid"), String(dummy.pid));
  return { dummy, exited };
}

function runFixture(file, env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
  const child = spawn("bun", [file], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise((r) => child.once("close", (code, signal) => r({ code, signal, out })));
  return closed;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
}

describe("initializeApp exit hook: host-wide cleanup ownership", () => {
  it("follower (KHATAM_WORKER_ROLE=worker) exit leaves the leader's cloudflared tunnel running", async () => {
    const dataDir = tempDir("khatam-followerexit-");
    const dir = tempDir("khatam-followerexit-fx-");
    const { dummy, exited } = startDummyTunnel(dataDir);
    try {
      const result = await runFixture(writeFixture(dir), {
        DATA_DIR: dataDir,
        DATA_DIR_ALLOW_TEMP: "1",
        KHATAM_WORKER_ROLE: "worker",
        NEXT_MANUAL_SIG_HANDLE: "true",
      });
      expect(result.out).toContain("FIXTURE_READY");
      expect(result.code).toBe(0);
      // Give any (wrong) SIGTERM time to land before judging the dummy.
      const outcome = await withTimeout(exited, 1500);
      expect(outcome).toBe("timeout");
      expect(() => process.kill(dummy.pid, 0)).not.toThrow();
    } finally {
      try { dummy.kill("SIGKILL"); } catch { /* gone */ }
      await withTimeout(exited, 2000);
    }
  }, TEST_TIMEOUT);

  it("leader (KHATAM_WORKER_ROLE=leader) exit still stops the tunnel it owns", async () => {
    const dataDir = tempDir("khatam-leaderexit-");
    const dir = tempDir("khatam-leaderexit-fx-");
    const { dummy, exited } = startDummyTunnel(dataDir);
    try {
      const result = await runFixture(writeFixture(dir), {
        DATA_DIR: dataDir,
        DATA_DIR_ALLOW_TEMP: "1",
        KHATAM_WORKER_ROLE: "leader",
        NEXT_MANUAL_SIG_HANDLE: "true",
      });
      expect(result.code).toBe(0);
      expect(await withTimeout(exited, 10000)).toBe(true);
    } finally {
      try { dummy.kill("SIGKILL"); } catch { /* gone */ }
      await withTimeout(exited, 2000);
    }
  }, TEST_TIMEOUT);

  it("single-process (role unset, NEXT_MANUAL_SIG_HANDLE=true) exit still stops the tunnel it owns", async () => {
    const dataDir = tempDir("khatam-singleexit-");
    const dir = tempDir("khatam-singleexit-fx-");
    const { dummy, exited } = startDummyTunnel(dataDir);
    try {
      const result = await runFixture(writeFixture(dir), {
        DATA_DIR: dataDir,
        DATA_DIR_ALLOW_TEMP: "1",
        NEXT_MANUAL_SIG_HANDLE: "true",
      });
      expect(result.code).toBe(0);
      expect(await withTimeout(exited, 10000)).toBe(true);
    } finally {
      try { dummy.kill("SIGKILL"); } catch { /* gone */ }
      await withTimeout(exited, 2000);
    }
  }, TEST_TIMEOUT);
});

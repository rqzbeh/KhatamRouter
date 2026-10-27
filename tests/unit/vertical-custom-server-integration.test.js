// T022 integration: custom-server.js boots the vertical cluster supervisor.
//
// Coverage (real): custom-server.js wrapper (XFF trust, PEER token, EADDRINUSE handling),
// cluster primary/worker split, supervisor fork + role env, worker lifecycle SIGTERM drain,
// copy-standalone-assets.mjs output layout, relative imports from the copied src/lib/cluster.
//
// Test seams (documented, NOT covered here):
//   - `server.js` in the fixture stands in for Next's standalone server. It is a plain
//     http.createServer that listens on PORT. Real Next request handling is not exercised.
//   - `src/lib/db/driver.js` in the fixture is a counter stub. Real SQLite migrations are
//     covered by tests/unit/cluster-db-safety.test.js, not here.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import http from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_TIMEOUT = 90000;
const STRIPPED_ENV = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
  "KHATAM_WORKERS", "WEB_CONCURRENCY", "KHATAM_WORKER_ROLE", "KHATAM_MIGRATIONS_DONE",
  "KHATAM_DRAIN_TIMEOUT_MS", "PORT", "DASHBOARD_PORT", "DATA_DIR", "NODE_ENV",
];

// Stand-in for Next's standalone server.js. Goes through the real http.createServer wrapper.
const STUB_SERVER = `const http = require("http");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    pid: process.pid,
    role: process.env.KHATAM_WORKER_ROLE || null,
    realIp: req.headers["x-9r-real-ip"] || null,
  }));
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("STUB_READY " + process.pid));
`;

// Stand-in for src/lib/db/driver.js. Records one line per migration-phase call in DATA_DIR.
const STUB_DRIVER = `import fs from "node:fs";
import path from "node:path";
const adapter = { close() {} };
export async function getAdapter() {
  fs.appendFileSync(path.join(process.env.DATA_DIR, "migrations.log"), process.pid + "\\n");
  return adapter;
}
`;

const children = new Set();
const tempDirs = [];
const blockers = [];

afterEach(async () => {
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  children.clear();
  for (const srv of blockers.splice(0)) {
    await new Promise((r) => srv.close(() => r()));
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function pickPort() {
  return new Promise((resolveP, reject) => {
    const attempt = (left) => {
      const port = 31000 + Math.floor(Math.random() * 1000);
      const probe = createNetServer();
      probe.once("error", () => (left > 0 ? attempt(left - 1) : reject(new Error("no free port in 31000-31999"))));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveP(port)));
    };
    attempt(50);
  });
}

// Builds the standalone layout the way the production build does: copy-standalone-assets
// output with the real custom-server.js, runtime-secrets.cjs and src/lib/cluster/*.
function buildStandalone({ withDriver }) {
  const root = tempDir("khatam-vertical-proj-");
  const dataDir = tempDir("khatam-vertical-data-");
  cpSync(join(REPO, "custom-server.js"), join(root, "custom-server.js"));
  cpSync(join(REPO, "runtime-secrets.cjs"), join(root, "runtime-secrets.cjs"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  cpSync(join(REPO, "src", "lib", "cluster"), join(root, "src", "lib", "cluster"), { recursive: true });
  mkdirSync(join(root, ".next", "standalone"), { recursive: true });
  copyStandaloneAssets({ projectRoot: root, distDir: ".next" });

  const standalone = join(root, ".next", "standalone");
  writeFileSync(join(standalone, "server.js"), STUB_SERVER);
  if (withDriver) {
    mkdirSync(join(standalone, "src", "lib", "db"), { recursive: true });
    writeFileSync(join(standalone, "src", "lib", "db", "driver.js"), STUB_DRIVER);
  }
  return { standalone, dataDir };
}

function bootChild(standalone, env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
  const child = spawn("bun", [join(standalone, "custom-server.js")], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const closed = new Promise((r) => child.once("close", (code, signal) => r({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, closed };
}

async function waitFor(predicate, ms = 40000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

function hit(port, headers = {}) {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", agent: false, headers: { connection: "close", ...headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolveP(JSON.parse(body)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const countReady = (boot) => (boot.stdout().match(/STUB_READY/g) || []).length;

describe("custom-server vertical integration: static contract", () => {
  it("keeps loopback-only forwarding trust and adds no proxy CIDR list", () => {
    const src = readFileSync(join(REPO, "custom-server.js"), "utf8");

    expect(src).toContain("isLoopbackProxy");
    expect(src).toContain('socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1"');
    expect(src).not.toContain("TRUSTED_PROXY_CIDRS");
  });

  it("branches on cluster.isPrimary / isWorker and logs the EADDRINUSE message", () => {
    const src = readFileSync(join(REPO, "custom-server.js"), "utf8");

    expect(src).toContain("cluster.isPrimary");
    expect(src).toContain("cluster.isWorker");
    expect(src).toContain("[Server] Port ${PORT} already in use");
  });
});

describe("custom-server vertical integration: standalone layout", () => {
  it("copy script ships src/lib/cluster and the copy resolves relative imports", async () => {
    const { standalone } = buildStandalone({ withDriver: false });
    const dir = join(standalone, "src", "lib", "cluster");

    expect(existsSync(join(dir, "supervisor.js"))).toBe(true);
    expect(existsSync(join(dir, "worker.js"))).toBe(true);

    const supervisor = await import(pathToFileURL(join(dir, "supervisor.js")).href);
    const worker = await import(pathToFileURL(join(dir, "worker.js")).href);
    expect(supervisor.sizeWorkers(8, { KHATAM_WORKERS: "auto" })).toBe(6);
    expect(typeof worker.setupWorkerLifecycle).toBe("function");
  }, TEST_TIMEOUT);
});

describe("custom-server vertical integration: real child boot", () => {
  it("KHATAM_WORKERS=2: primary never serves, 2 workers (leader + worker), migrations once", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    await waitFor(() => countReady(boot) >= 2);
    const pids = new Set();
    const roles = new Set();
    for (let i = 0; i < 40; i += 1) {
      const body = await hit(port);
      pids.add(body.pid);
      roles.add(body.role);
    }

    expect(pids.has(boot.child.pid)).toBe(false);
    expect(pids.size).toBeGreaterThanOrEqual(2);
    expect(roles.has("leader")).toBe(true);
    expect(roles.has("worker")).toBe(true);

    const migrations = readFileSync(join(dataDir, "migrations.log"), "utf8").trim().split("\n");
    expect(migrations).toEqual([String(boot.child.pid)]);

    boot.child.kill("SIGTERM");
    const { code } = await boot.closed;
    expect(code).toBe(0);
  }, TEST_TIMEOUT);

  it("forwards X-Forwarded-For only from a loopback peer (client is loopback, so trusted)", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    try {
      await waitFor(() => countReady(boot) >= 2);
      const body = await hit(port, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
      expect(body.realIp).toBe("203.0.113.9");
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("KHATAM_WORKERS=1: single process, no role, no migration call from the primary path", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });

    try {
      await waitFor(() => countReady(boot) >= 1);
      const body = await hit(port);
      expect(body.pid).toBe(boot.child.pid);
      expect(body.role).toBeNull();
      expect(existsSync(join(dataDir, "migrations.log"))).toBe(false);
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("KHATAM_WORKERS=2 without a migration driver in standalone falls back to single process", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    try {
      await waitFor(() => countReady(boot) >= 1);
      const body = await hit(port);
      expect(body.pid).toBe(boot.child.pid);
      expect(body.role).toBeNull();
      expect(boot.stderr() + boot.stdout()).toContain("running single-process");
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("port already bound: logs '[Server] Port <p> already in use' and terminates with code 1", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const blocker = createNetServer();
    blockers.push(blocker);
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });

    const { code } = await boot.closed;
    expect(code).toBe(1);
    expect(boot.stderr()).toContain(`[Server] Port ${port} already in use`);
  }, TEST_TIMEOUT);

  it("port already bound in multi-worker mode: worker reports, supervisor logs once and exits 1", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const blocker = createNetServer();
    blockers.push(blocker);
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    const { code } = await boot.closed;
    expect(code).toBe(1);
    const err = boot.stderr();
    expect(err).toContain(`[Server] Port ${port} already in use`);
    const count = (err.match(/already in use/g) || []).length;
    expect(count).toBe(1);
  }, TEST_TIMEOUT);
});

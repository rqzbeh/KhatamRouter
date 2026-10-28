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
import { spawn, spawnSync } from "node:child_process";
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
  if (req.url === "/slow") {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ slow: "done" }));
    }, 1500);
    return;
  }
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
function buildStandalone({ withDriver, withCluster = true, realDriver = false }) {
  const root = tempDir("khatam-vertical-proj-");
  const dataDir = tempDir("khatam-vertical-data-");
  cpSync(join(REPO, "custom-server.js"), join(root, "custom-server.js"));
  cpSync(join(REPO, "runtime-secrets.cjs"), join(root, "runtime-secrets.cjs"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  if (withCluster) cpSync(join(REPO, "src", "lib", "cluster"), join(root, "src", "lib", "cluster"), { recursive: true });
  if (realDriver) {
    // Real migration graph, copied from the repo the way the production tree holds it.
    cpSync(join(REPO, "src", "lib", "db"), join(root, "src", "lib", "db"), { recursive: true });
    cpSync(join(REPO, "src", "lib", "dataDir.js"), join(root, "src", "lib", "dataDir.js"));
    cpSync(join(REPO, "jsconfig.json"), join(root, "jsconfig.json"));
  }
  mkdirSync(join(root, ".next", "standalone"), { recursive: true });
  copyStandaloneAssets({ projectRoot: root, distDir: ".next" });

  const standalone = join(root, ".next", "standalone");
  writeFileSync(join(standalone, "server.js"), STUB_SERVER);
  if (withDriver && !realDriver) {
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

// Single-process graceful drain (KHATAM_WORKERS=1 or no src/lib/cluster on disk). Real child
// processes booting the real custom-server.js with the stub Next server. Covered: http.createServer
// wrapper, signal ownership, drain/exit codes, DB-free. Not covered: real Next request handling.
describe("custom-server single-process graceful drain", () => {
  const waitListening = (boot) => waitFor(() => countReady(boot) >= 1);

  it("(a) idle SIGTERM exits 0 within 3 s", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });
    await waitListening(boot);
    const t0 = Date.now();
    boot.child.kill("SIGTERM");
    const { code } = await boot.closed;
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, TEST_TIMEOUT);

  it("(b) SIGTERM during an in-flight slow response: response completes, then exit 0", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });
    await waitListening(boot);
    const slow = new Promise((resolveP, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/slow", agent: false, headers: { connection: "close" } },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => resolveP({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 300));
    boot.child.kill("SIGTERM");
    const res = await slow;
    const { code } = await boot.closed;
    expect(res.body).toContain('"slow":"done"');
    expect(code).toBe(0);
  }, TEST_TIMEOUT);

  it("(c) second SIGTERM during drain forces exit 143 before the slow response finishes", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });
    await waitListening(boot);
    http.get({ host: "127.0.0.1", port, path: "/slow", agent: false }, () => {}).on("error", () => {});
    await new Promise((r) => setTimeout(r, 300));
    boot.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    boot.child.kill("SIGTERM");
    const { code } = await boot.closed;
    expect(code).toBe(143);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, TEST_TIMEOUT);

  it("(d) SIGINT behaves like SIGTERM: idle exits 0; second SIGINT forces 130", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });
    await waitListening(boot);
    boot.child.kill("SIGINT");
    const { code } = await boot.closed;
    expect(code).toBe(0);
  }, TEST_TIMEOUT);

  it("(d2) SIGINT during in-flight drain, then second SIGINT forces 130", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "1" });
    await waitListening(boot);
    http.get({ host: "127.0.0.1", port, path: "/slow", agent: false }, () => {}).on("error", () => {});
    await new Promise((r) => setTimeout(r, 300));
    boot.child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 200));
    boot.child.kill("SIGINT");
    const { code } = await boot.closed;
    expect(code).toBe(130);
  }, TEST_TIMEOUT);

  it("standalone fallback (no src/lib/cluster on disk): idle SIGTERM still exits 0 within 3 s", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false, withCluster: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir });
    await waitListening(boot);
    const t0 = Date.now();
    boot.child.kill("SIGTERM");
    const { code } = await boot.closed;
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, TEST_TIMEOUT);
});

describe("custom-server.js real child boot", () => {
  // Regression: Dockerfile.bun shipped no src/lib/db, so the primary found no
  // driver.js, skipped migrations and forked zero workers (single-process fallback).
  it("real driver.js closure in standalone: KHATAM_WORKERS=2 forks 2 workers, migrations applied once", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false, realDriver: true });
    // Same assertions the copy ships; guards the fixture itself.
    expect(existsSync(join(standalone, "src", "lib", "db", "driver.js"))).toBe(true);
    expect(existsSync(join(standalone, "jsconfig.json"))).toBe(true);
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKERS: "2" });

    try {
      await waitFor(() => countReady(boot) >= 2);
      const combined = boot.stdout() + boot.stderr();
      expect(combined).not.toContain("is not on disk");

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

      // Real migrations ran in the primary only, not in the workers.
      const dbPath = join(dataDir, "db", "data.sqlite");
      expect(existsSync(dbPath)).toBe(true);
      const applied = spawnSync("bun", ["-e",
        `import { Database } from "bun:sqlite";` +
        `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });` +
        `console.log(db.query("SELECT COUNT(*) AS n FROM _khatam_migrations").get().n);` +
        `db.close();`,
      ], { encoding: "utf8" });
      expect(applied.stderr).toBe("");
      expect(Number(applied.stdout.trim())).toBeGreaterThan(0);

      boot.child.kill("SIGTERM");
      const { code } = await boot.closed;
      expect(code).toBe(0);
    } finally {
      if (boot.child.exitCode === null) {
        boot.child.kill("SIGKILL");
        await boot.closed;
      }
    }
  }, TEST_TIMEOUT);

  it("real driver.js closure: KHATAM_WORKERS=2 with the closure absent still falls back to single-process", async () => {
    // Fallback path stays intact: no src/lib/db in the project, so the copy ships none.
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    expect(existsSync(join(standalone, "src", "lib", "db", "driver.js"))).toBe(false);
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    try {
      await waitFor(() => countReady(boot) >= 1);
      expect(boot.stderr()).toContain("running single-process");
      const body = await hit(port);
      expect(body.pid).toBe(boot.child.pid);
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("prints a compact [Cluster] trail: start line with resolved count, two fork lines with distinct pids, one leader", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: true });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });

    try {
      await waitFor(() => countReady(boot) >= 2);
      const out = boot.stdout();
      expect(out).toContain(`[Cluster] supervisor pid=${boot.child.pid} starting KHATAM_WORKERS=2 workers on port ${port}`);
      const forks = [...out.matchAll(/^\[Cluster\] fork worker=(\d+) pid=(\d+) role=(leader|worker)$/gm)];
      expect(forks.length).toBe(2);
      expect(new Set(forks.map((m) => m[2])).size).toBe(2);
      expect(forks.filter((m) => m[3] === "leader").length).toBe(1);
      expect(forks.some((m) => Number(m[2]) === boot.child.pid)).toBe(false);
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

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

  it("KHATAM_WORKERS=2 without driver fallback: idle SIGTERM exits 0 (not 15)", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });
    await waitFor(() => countReady(boot) >= 1);
    boot.child.kill("SIGTERM");
    const { code, signal } = await boot.closed;
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, TEST_TIMEOUT);

  it("KHATAM_WORKERS=2 without driver fallback: in-flight slow response completes before exit 0", async () => {
    const { standalone, dataDir } = buildStandalone({ withDriver: false });
    const port = await pickPort();
    const boot = bootChild(standalone, { PORT: String(port), DATA_DIR: dataDir, KHATAM_WORKERS: "2" });
    await waitFor(() => countReady(boot) >= 1);
    const slow = new Promise((resolveP, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/slow", agent: false, headers: { connection: "close" } },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => resolveP({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 300));
    boot.child.kill("SIGTERM");
    const res = await slow;
    const { code, signal } = await boot.closed;
    expect(res.body).toContain('"slow":"done"');
    expect(signal).toBeNull();
    expect(code).toBe(0);
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

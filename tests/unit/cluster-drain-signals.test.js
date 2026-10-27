// US2 defect 1 + 4 + 5: real child processes prove the cluster worker drain path.
//
// Covered (real): src/lib/db/adapters/bunSqliteAdapter.js (real SQLite file under DATA_DIR),
// src/shared/services/initializeApp.js (real signal wiring; deferred daemons never reached
// because the child is stopped before STARTUP_DEFER_MS), src/lib/cluster/worker.js drain.
// Seam: the child HTTP server is a local fixture, not Next request handling.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER = pathToFileURL(join(REPO, "src/lib/db/adapters/bunSqliteAdapter.js")).href;
const INIT_APP = pathToFileURL(join(REPO, "src/shared/services/initializeApp.js")).href;
const WORKER_LIB = pathToFileURL(join(REPO, "src/lib/cluster/worker.js")).href;
const SUPERVISOR_LIB = pathToFileURL(join(REPO, "src/lib/cluster/supervisor.js")).href;
const CUSTOM_SERVER_FILE = join(REPO, "custom-server.js");
const TEST_TIMEOUT = 60000;
const STRIPPED_ENV = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
  "KHATAM_WORKERS", "WEB_CONCURRENCY", "KHATAM_WORKER_ROLE", "KHATAM_MIGRATIONS_DONE",
  "KHATAM_DRAIN_TIMEOUT_MS", "PORT", "DASHBOARD_PORT", "DATA_DIR", "NODE_ENV",
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

// Worker fixture: real adapter + real initializeApp signal wiring + real setupWorkerLifecycle.
function writeWorkerFixture(dir) {
  const file = join(dir, "worker-fixture.mjs");
  writeFileSync(
    file,
    `import http from "node:http";
import { join } from "node:path";
import { createBunSqliteAdapter } from ${JSON.stringify(ADAPTER)};
import { initializeApp } from ${JSON.stringify(INIT_APP)};
import { setupWorkerLifecycle } from ${JSON.stringify(WORKER_LIB)};

const adapter = await createBunSqliteAdapter(join(process.env.DATA_DIR, "fixture.sqlite"));
await initializeApp();
const server = http.createServer((req, res) => {
  res.setHeader("Connection", "close");
  if (req.url === "/slow") {
    setTimeout(() => res.end("SLOW_DONE"), 1500);
    return;
  }
  res.end("OK");
});
setupWorkerLifecycle(server, { drainTimeoutMs: 10000 });
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("FIXTURE_READY " + process.pid));
void adapter;
`,
  );
  return file;
}

function spawnFixture(file, env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
  const child = spawn("bun", [file], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const state = { out: "", err: "", child };
  child.stdout.on("data", (d) => { state.out += d; });
  child.stderr.on("data", (d) => { state.err += d; });
  state.closed = new Promise((r) => child.once("close", (code, signal) => r({ code, signal })));
  return state;
}

async function waitFor(pred, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

function get(port, path) {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, agent: false, headers: { connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolveP({ status: res.statusCode, body, aborted: false }));
        res.on("aborted", () => resolveP({ status: res.statusCode, body, aborted: true }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("US2 defect 1: worker SIGTERM drains in-flight response before exit (real child)", () => {
  it("in-flight slow response completes, then the worker exits 0", async () => {
    const dir = tempDir("khatam-drain-");
    const port = await pickPort();
    const fixture = writeWorkerFixture(dir);
    const proc = spawnFixture(fixture, {
      PORT: String(port),
      DATA_DIR: dir,
      DATA_DIR_ALLOW_TEMP: "1",
      KHATAM_WORKER_ROLE: "worker",
    });

    await waitFor(() => proc.out.includes("FIXTURE_READY"));
    const slow = get(port, "/slow");
    await new Promise((r) => setTimeout(r, 300));
    proc.child.kill("SIGTERM");

    const res = await slow;
    const { code } = await proc.closed;
    expect(res.aborted).toBe(false);
    expect(res.body).toBe("SLOW_DONE");
    expect(code).toBe(0);
  }, TEST_TIMEOUT);
});

describe("US2 defect 2: NEXT_MANUAL_SIG_HANDLE prevents start-server exit(143)", () => {
  it("NEXT_MANUAL_SIG_HANDLE is set in custom-server.js and in workerEnv", async () => {
    const supervisor = await import(SUPERVISOR_LIB);
    const env = supervisor.workerEnv(1);
    expect(env.NEXT_MANUAL_SIG_HANDLE).toBe("true");

    const customServerSource = await import("node:fs").then((f) => f.readFileSync(CUSTOM_SERVER_FILE, "utf8"));
    expect(customServerSource).toContain('process.env.NEXT_MANUAL_SIG_HANDLE = "true"');
  });

  it("node_modules/next/dist/server/lib/start-server.js respects NEXT_MANUAL_SIG_HANDLE", async () => {
    const startServerPath = join(REPO, "node_modules/next/dist/server/lib/start-server.js");
    const source = await import("node:fs").then((f) => f.readFileSync(startServerPath, "utf8"));
    expect(source).toContain("if (!process.env.NEXT_MANUAL_SIG_HANDLE)");
    expect(source).toContain("process.on('SIGINT', cleanup)");
    expect(source).toContain("process.on('SIGTERM', cleanup)");
  });
});

describe("US2 defect 4: worker disconnect event drains worker on primary kill", () => {
  it("SIGKILL the primary: workers receive disconnect, drain, and exit without orphaning", async () => {
    const dir = tempDir("khatam-disconnect-");
    const port = await pickPort();
    const workerScript = join(dir, "worker.mjs");
    const primaryScript = join(dir, "primary.mjs");

    writeFileSync(
      workerScript,
      `import http from "node:http";
import { setupWorkerLifecycle } from ${JSON.stringify(WORKER_LIB)};
const server = http.createServer((req, res) => {
  res.setHeader("Connection", "close");
  res.end(JSON.stringify({ pid: process.pid }));
});
setupWorkerLifecycle(server, { drainTimeoutMs: 3000 });
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    );

    writeFileSync(
      primaryScript,
      `import { startSupervisor } from ${JSON.stringify(SUPERVISOR_LIB)};
const log = (o) => console.log(JSON.stringify(o));
await startSupervisor({
  env: process.env,
  workerScript: ${JSON.stringify(workerScript)},
  runMigrations: async () => {},
  log,
  signals: true,
});
`,
    );

    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
    const primaryChild = spawn("bun", [primaryScript], {
      env: { ...base, PORT: String(port), DATA_DIR: dir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKERS: "2" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(primaryChild);

    const workerPids = [];
    let readyCount = 0;
    primaryChild.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "fork" && evt.pid) workerPids.push(evt.pid);
          if (evt.event === "ready") readyCount += 1;
        } catch {}
      }
    });

    // Wait for both workers to be listening (the supervisor logs "ready" on listen), not just forked.
    await waitFor(() => workerPids.length >= 2 && readyCount >= 2, 25000);

    const res = await get(port, "/");
    expect(res.status).toBe(200);

    // SIGKILL the primary process
    primaryChild.kill("SIGKILL");

    // All workers should exit within drain deadline (3s drain + buffer = 8s)
    await waitFor(() => {
      return workerPids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false; // still alive
        } catch {
          return true; // dead
        }
      });
    }, 12000);

    // Confirm both are dead
    for (const pid of workerPids) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      expect(alive).toBe(false);
    }
  }, TEST_TIMEOUT);
});

describe("US2 defect 5: EADDRINUSE in multi-worker mode stops respawning and primary exits 1", () => {
  it("primary exits 1 and logs '[Server] Port <p> already in use' once when port is blocked", async () => {
    const dir = tempDir("khatam-eaddrinuse-");
    const port = await pickPort();

    // Occupy the port with a net blocker
    const blocker = createNetServer();
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));

    const workerScript = join(dir, "worker.mjs");
    const primaryScript = join(dir, "primary.mjs");

    writeFileSync(
      workerScript,
      `import http from "node:http";
import cluster from "node:cluster";
import { setupWorkerLifecycle } from ${JSON.stringify(WORKER_LIB)};

const server = http.createServer((req, res) => res.end("ok"));
server.prependListener("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    if (cluster.isWorker) {
      if (typeof process.send === "function") {
        try { process.send({ type: "address_in_use", port: Number(process.env.PORT) }); } catch {}
      }
      process.exit(98);
    }
    console.error("[Server] Port " + process.env.PORT + " already in use");
    process.exit(1);
  }
});
setupWorkerLifecycle(server, { drainTimeoutMs: 3000 });
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    );

    writeFileSync(
      primaryScript,
      `import { startSupervisor } from ${JSON.stringify(SUPERVISOR_LIB)};
const log = (o) => console.log(JSON.stringify(o));
await startSupervisor({
  env: process.env,
  workerScript: ${JSON.stringify(workerScript)},
  runMigrations: async () => {},
  log,
  signals: true,
});
`,
    );

    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
    const primaryChild = spawn("bun", [primaryScript], {
      env: { ...base, PORT: String(port), DATA_DIR: dir, DATA_DIR_ALLOW_TEMP: "1", KHATAM_WORKERS: "2" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(primaryChild);

    let stderr = "";
    primaryChild.stderr.on("data", (d) => { stderr += d.toString(); });
    const { code } = await new Promise((r) => primaryChild.on("close", (c, s) => r({ code: c, signal: s })));

    await new Promise((r) => blocker.close(r));

    expect(code).toBe(1);
    expect(stderr).toContain(`[Server] Port ${port} already in use`);
    // Ensure it logged ONCE, not infinitely looped
    const count = (stderr.match(/already in use/g) || []).length;
    expect(count).toBe(1);
  }, TEST_TIMEOUT);
});

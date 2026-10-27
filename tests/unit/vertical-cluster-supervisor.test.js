import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  sizeWorkers,
  restartPolicy,
  workerEnv,
  routeIpcMessage,
  drainDeadlineMs,
  supervisorKillMs,
  startSupervisor,
  CLUSTER_EXIT_EVENT,
  IPC_TYPES,
} from "../../src/lib/cluster/supervisor.js";
import { setupWorkerLifecycle } from "../../src/lib/cluster/worker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = path.resolve(HERE, "../../src/lib/cluster/supervisor.js");
const WORKER_LIB_PATH = path.resolve(HERE, "../../src/lib/cluster/worker.js");
const CUSTOM_SERVER_PATH = path.resolve(HERE, "../../custom-server.js");

// Fake node:cluster surface: setupPrimary/fork/workers plus a real EventEmitter bus.
function fakeCluster() {
  const c = new EventEmitter();
  c.isPrimary = true;
  c.workers = {};
  c.forked = [];
  c.setupPrimary = (opts) => {
    c.setup = opts;
  };
  c.fork = (env) => {
    const id = c.forked.length + 1;
    const w = new EventEmitter();
    w.id = id;
    w.process = { pid: 40000 + id };
    w.sent = [];
    w.signals = [];
    w.send = (msg) => w.sent.push(msg);
    w.kill = (sig) => w.signals.push(sig);
    c.workers[id] = w;
    c.forked.push({ id, env, worker: w });
    return w;
  };
  c.crash = (id) => {
    const w = c.workers[id];
    delete c.workers[id];
    c.emit(CLUSTER_EXIT_EVENT, w, 1, null);
  };
  return c;
}

function fakeClock() {
  const state = { t: 0, timers: [] };
  state.now = () => state.t;
  state.schedule = (fn, ms) => state.timers.push({ fn, ms });
  state.runTimers = () => {
    const pending = state.timers.splice(0);
    for (const t of pending) t.fn();
    return pending.map((t) => t.ms);
  };
  return state;
}

function pickFreePort() {
  // Ports 31000-31999 only; probe-bind before returning.
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOne = () => {
      attempts += 1;
      const port = 31000 + Math.floor(Math.random() * 1000);
      const probe = net.createServer();
      probe.once("error", () => {
        if (attempts > 25) reject(new Error("no free port in 31000-31999"));
        else tryOne();
      });
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(port)));
    };
    tryOne();
  });
}

function getJson(port, urlPath, { close = true, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", agent: false, headers: close ? { Connection: "close" } : {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function writeFixtures(dir) {
  const primaryPath = path.join(dir, "primary.mjs");
  const workerPath = path.join(dir, "worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import http from "node:http";
import { setupWorkerLifecycle } from ${JSON.stringify(WORKER_LIB_PATH)};
const server = http.createServer((req, res) => {
  res.setHeader("Connection", "close");
  if (req.url === "/slow") {
    setTimeout(() => res.end(JSON.stringify({ pid: process.pid, role: process.env.KHATAM_WORKER_ROLE ?? null, slow: true })), 2500);
    return;
  }
  res.end(JSON.stringify({ pid: process.pid, role: process.env.KHATAM_WORKER_ROLE ?? null }));
});
setupWorkerLifecycle(server, { drainTimeoutMs: Number(process.env.KHATAM_DRAIN_TIMEOUT_MS ?? 30000) });
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
  );
  fs.writeFileSync(
    primaryPath,
    `import { startSupervisor } from ${JSON.stringify(SUPERVISOR_PATH)};
const log = (o) => console.log(JSON.stringify(o));
await startSupervisor({
  env: process.env,
  workerScript: ${JSON.stringify(workerPath)},
  runMigrations: async () => log({ event: "migrations" }),
  log,
  signals: true,
});
`,
  );
  return { primaryPath, workerPath };
}

function startPrimary(dir, port, extraEnv = {}) {
  const { primaryPath } = writeFixtures(dir);
  const env = { ...process.env, ...extraEnv, PORT: String(port), DATA_DIR: dir, KHATAM_WORKERS: "2" };
  delete env.HTTPS_PROXY;
  delete env.HTTP_PROXY;
  delete env.ALL_PROXY;
  delete env.https_proxy;
  delete env.http_proxy;
  delete env.all_proxy;
  delete env.KHATAM_WORKER_ROLE;
  delete env.KHATAM_MIGRATIONS_DONE;
  const child = spawn(process.execPath, [primaryPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  const state = { events: [], stderr: "", closed: null };
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("{")) state.events.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (state.stderr += d));
  state.isClosed = false;
  state.closed = new Promise((resolve) =>
    child.on("close", (code, signal) => {
      state.isClosed = true;
      resolve({ code, signal });
    }),
  );
  state.child = child;
  return state;
}

async function waitFor(pred, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

describe("sizing and single-worker bypass", () => {
  it("sizes workers as Math.max(1, nproc - 2) with KHATAM_WORKERS and WEB_CONCURRENCY overrides", () => {
    expect(sizeWorkers(8, {})).toBe(6);
    expect(sizeWorkers(2, {})).toBe(1);
    expect(sizeWorkers(1, {})).toBe(1);
    expect(sizeWorkers(8, { KHATAM_WORKERS: "auto" })).toBe(6);
    expect(sizeWorkers(8, { KHATAM_WORKERS: "4" })).toBe(4);
    expect(sizeWorkers(8, { WEB_CONCURRENCY: "3" })).toBe(3);
    expect(sizeWorkers(8, { KHATAM_WORKERS: "4", WEB_CONCURRENCY: "3" })).toBe(4);
    expect(sizeWorkers(8, { KHATAM_WORKERS: "500" })).toBe(64);
  });

  it("KHATAM_WORKERS=1 bypasses the supervisor: no fork, no setupPrimary, no migration hook", async () => {
    const c = fakeCluster();
    const calls = [];
    const sup = await startSupervisor({
      cluster: c,
      nproc: 8,
      env: { KHATAM_WORKERS: "1" },
      workerScript: "/unused/worker.js",
      runMigrations: async () => calls.push("migrations"),
      signals: false,
    });
    expect(sup.mode).toBe("single");
    expect(c.forked.length).toBe(0);
    expect(c.setup).toBeUndefined();
    expect(calls.length).toBe(0);
  });
});

describe("worker role, env and one-time migrations", () => {
  it("runs migrations once before any fork and sets KHATAM_MIGRATIONS_DONE and 1-indexed roles", async () => {
    const c = fakeCluster();
    const order = [];
    const origFork = c.fork;
    c.fork = (env) => {
      order.push("fork");
      return origFork(env);
    };
    await startSupervisor({
      cluster: c,
      nproc: 8,
      env: { KHATAM_WORKERS: "3" },
      workerScript: "/unused/worker.js",
      runMigrations: async () => order.push("migrations"),
      signals: false,
    });
    expect(order).toEqual(["migrations", "fork", "fork", "fork"]);
    expect(c.forked.map((f) => f.env.KHATAM_WORKER_ROLE)).toEqual(["leader", "worker", "worker"]);
    expect(c.forked.every((f) => f.env.KHATAM_MIGRATIONS_DONE === "1")).toBe(true);
    expect(workerEnv(1)).toEqual({ KHATAM_WORKER_ROLE: "leader", KHATAM_MIGRATIONS_DONE: "1" });
    expect(workerEnv(2).KHATAM_WORKER_ROLE).toBe("worker");
  });
});

describe("crash detection and exponential backoff", () => {
  it("restartPolicy: rapid crash (<5000 ms) grows Math.min(250*2^n, 10000); healthy run resets", () => {
    expect(restartPolicy(0, 100)).toEqual({ crashes: 1, delayMs: 500, alert: false });
    expect(restartPolicy(1, 100)).toEqual({ crashes: 2, delayMs: 1000, alert: false });
    expect(restartPolicy(5, 100)).toEqual({ crashes: 6, delayMs: 10000, alert: true });
    expect(restartPolicy(3, 8000)).toEqual({ crashes: 3, delayMs: 0, alert: false });
    expect(restartPolicy(3, 60000)).toEqual({ crashes: 0, delayMs: 0, alert: false });
  });

  it("respawns a crashed slot after the backoff delay with the same leader/worker role", async () => {
    const c = fakeCluster();
    const clock = fakeClock();
    await startSupervisor({
      cluster: c,
      nproc: 8,
      env: { KHATAM_WORKERS: "2" },
      workerScript: "/unused/worker.js",
      runMigrations: async () => {},
      now: clock.now,
      schedule: clock.schedule,
      signals: false,
    });
    expect(c.forked.length).toBe(2);
    clock.t = 100;
    c.crash(1);
    expect(clock.timers.map((t) => t.ms)).toEqual([500]);
    clock.runTimers();
    expect(c.forked.length).toBe(3);
    expect(c.forked[2].env.KHATAM_WORKER_ROLE).toBe("leader");
  });
});

describe("IPC protocol and invalidation routing", () => {
  it("declares the ready/drain/config_reload/in_flight message types", () => {
    expect(IPC_TYPES).toEqual(["ready", "drain", "config_reload", "in_flight"]);
  });

  it("routeIpcMessage fans config_reload out to every worker except the sender, for allowed scopes only", () => {
    const ids = [1, 2, 3];
    expect(routeIpcMessage(2, { type: "config_reload", scope: "aliases" }, ids)).toEqual([1, 3]);
    expect(routeIpcMessage(1, { type: "config_reload", scope: "all" }, ids)).toEqual([2, 3]);
    expect(routeIpcMessage(1, { type: "config_reload", scope: "bogus" }, ids)).toEqual([]);
    expect(routeIpcMessage(1, { type: "ready" }, ids)).toEqual([]);
  });

  it("primary broker relays config_reload from a sender worker to its siblings via cluster message events", async () => {
    const c = fakeCluster();
    await startSupervisor({
      cluster: c,
      nproc: 8,
      env: { KHATAM_WORKERS: "3" },
      workerScript: "/unused/worker.js",
      runMigrations: async () => {},
      signals: false,
    });
    const msg = { type: "config_reload", scope: "combos" };
    c.emit("message", c.workers[2], msg);
    expect(c.workers[1].sent).toEqual([msg]);
    expect(c.workers[3].sent).toEqual([msg]);
    expect(c.workers[2].sent).toEqual([]);
  });
});

describe("graceful drain deadlines and SIGTERM handling", () => {
  it("drain deadline defaults to 30000 ms, honours KHATAM_DRAIN_TIMEOUT_MS, and SIGKILL escalates +5000 ms", () => {
    expect(drainDeadlineMs({})).toBe(30000);
    expect(drainDeadlineMs({ KHATAM_DRAIN_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(supervisorKillMs({})).toBe(35000);
    expect(supervisorKillMs({ KHATAM_DRAIN_TIMEOUT_MS: "5000" })).toBe(10000);
  });

  it("shutdown forwards SIGTERM to every worker and does not respawn a draining worker", async () => {
    const c = fakeCluster();
    const clock = fakeClock();
    const sup = await startSupervisor({
      cluster: c,
      nproc: 8,
      env: { KHATAM_WORKERS: "2" },
      workerScript: "/unused/worker.js",
      runMigrations: async () => {},
      now: clock.now,
      schedule: clock.schedule,
      signals: false,
    });
    sup.shutdown();
    expect(c.workers[1].signals).toEqual(["SIGTERM"]);
    expect(c.workers[2].signals).toEqual(["SIGTERM"]);
    const beforeCrashTimers = clock.timers.length;
    c.crash(1);
    expect(clock.timers.length).toBe(beforeCrashTimers);
    expect(c.forked.length).toBe(2);
  });
});

describe("loopback-only forwarded-header trust", () => {
  it("custom-server.js trusts forwarding headers only from loopback and adds no TRUSTED_PROXY_CIDRS", () => {
    const src = fs.readFileSync(CUSTOM_SERVER_PATH, "utf8");
    expect(src).toContain('socketIp === "127.0.0.1"');
    expect(src).toContain('socketIp === "::1"');
    expect(src).toContain('socketIp === "::ffff:127.0.0.1"');
    expect(src.includes("TRUSTED_PROXY_CIDRS")).toBe(false);
  });

  it("worker.js exports the lifecycle helper used by the real worker fixture", () => {
    expect(typeof setupWorkerLifecycle).toBe("function");
  });
});

describe("real primary and workers on a shared port", () => {
  it("two workers share one port, serve from >=2 distinct PIDs over 100 Connection: close requests, and roles are leader and worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-cluster-"));
    const port = await pickFreePort();
    const primary = startPrimary(dir, port);
    try {
      await waitFor(() => primary.events.filter((e) => e.event === "fork").length >= 2 && primary.events.some((e) => e.event === "ready"));
      const pids = new Set();
      const roles = new Set();
      for (let i = 0; i < 100; i += 10) {
        const batch = await Promise.all(Array.from({ length: 10 }, () => getJson(port, "/")));
        for (const r of batch) {
          expect(r.status).toBe(200);
          pids.add(r.body.pid);
          roles.add(r.body.role);
        }
      }
      expect(pids.size).toBeGreaterThanOrEqual(2);
      expect(roles).toEqual(new Set(["leader", "worker"]));
      const migrations = primary.events.filter((e) => e.event === "migrations");
      expect(migrations.length).toBe(1);
      expect(primary.events.findIndex((e) => e.event === "migrations")).toBeLessThan(primary.events.findIndex((e) => e.event === "fork"));
    } finally {
      primary.child.kill("SIGKILL");
      await primary.closed;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("SIGKILL of one worker triggers a respawn and the port keeps serving", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-cluster-"));
    const port = await pickFreePort();
    const primary = startPrimary(dir, port);
    try {
      await waitFor(
        () => primary.events.filter((e) => e.event === "fork").length >= 2 && primary.events.some((e) => e.event === "ready"),
      );
      const victim = primary.events.find((e) => e.event === "fork").pid;
      process.kill(victim, "SIGKILL");
      await waitFor(() => primary.events.filter((e) => e.event === "fork").length >= 3);
      expect(primary.events.some((e) => e.event === "crash" && e.pid === victim)).toBe(true);
      const r = await getJson(port, "/");
      expect(r.status).toBe(200);
    } finally {
      primary.child.kill("SIGKILL");
      await primary.closed;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("SIGTERM to the primary lets an in-flight slow response finish, then terminates with code 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-cluster-"));
    const port = await pickFreePort();
    const primary = startPrimary(dir, port, { KHATAM_DRAIN_TIMEOUT_MS: "10000" });
    try {
      await waitFor(
        () => primary.events.filter((e) => e.event === "fork").length >= 2 && primary.events.some((e) => e.event === "ready"),
      );
      const slow = getJson(port, "/slow", { timeoutMs: 20000 });
      await new Promise((r) => setTimeout(r, 300));
      primary.child.kill("SIGTERM");
      const res = await slow;
      expect(res.status).toBe(200);
      expect(res.body.slow).toBe(true);
      const done = await primary.closed;
      expect(done.code).toBe(0);
    } finally {
      if (!primary.isClosed) primary.child.kill("SIGKILL");
      await primary.closed;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

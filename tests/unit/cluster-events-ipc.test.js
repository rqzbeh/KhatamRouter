import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = path.resolve(HERE, "../../src/lib/redis/events.js");
const SUPERVISOR_PATH = path.resolve(HERE, "../../src/lib/cluster/supervisor.js");
const CONFIG_RELOAD = "khatam:events:config_reload";
const USAGE = "khatam:events:usage";
const IPC_LISTENER_KEY = Symbol.for("khatam.events.ipcListener");

const ENV_KEYS = ["REDIS_URL", "KHATAM_WORKER_ROLE", "DATA_DIR"];

let savedEnv;
let savedSend;
let tmpDir;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedSend = Object.getOwnPropertyDescriptor(process, "send");
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-events-ipc-"));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  const listener = globalThis[IPC_LISTENER_KEY];
  if (listener) process.off("message", listener);
  delete globalThis[IPC_LISTENER_KEY];
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedSend) Object.defineProperty(process, "send", savedSend);
  else delete process.send;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.doUnmock("../../src/lib/redis/client.js");
});

async function loadEvents() {
  vi.resetModules();
  return import("../../src/lib/redis/events.js");
}

/** Simulate a cluster worker: role env set by the supervisor plus an IPC channel. */
function asWorker(role = "worker", send) {
  process.env.KHATAM_WORKER_ROLE = role;
  const sent = [];
  process.send = send ?? ((msg) => { sent.push(msg); return true; });
  return sent;
}

describe("single-process mode (no cluster role)", () => {
  it("delivers locally and never calls process.send", async () => {
    const sendSpy = vi.fn(() => true);
    process.send = sendSpy;
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    const result = events.publishKhatamEvent(CONFIG_RELOAD, { scope: "aliases" });

    expect(result).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ scope: "aliases" });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("cluster worker with REDIS_URL unset", () => {
  it("sends config_reload to the Primary once and still delivers locally", async () => {
    const sent = asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    events.publishKhatamEvent(CONFIG_RELOAD, { scope: "aliases", timestamp: 1 });

    expect(sent).toEqual([{ type: "config_reload", scope: "aliases" }]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ scope: "aliases", timestamp: 1 });
  });

  it("swallows a throwing process.send and keeps local delivery", async () => {
    asWorker("leader", () => {
      throw new Error("channel closed");
    });
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    expect(() => events.publishKhatamEvent(CONFIG_RELOAD, { scope: "all" })).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not relay non-config_reload channels over IPC", async () => {
    const sent = asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(USAGE, handler);

    events.publishKhatamEvent(USAGE, { scope: "aliases" });

    expect(sent).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("validates scope: unknown or missing scope is delivered locally but not sent", async () => {
    const sent = asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    events.publishKhatamEvent(CONFIG_RELOAD, { scope: "bogus" });
    events.publishKhatamEvent(CONFIG_RELOAD, null);

    expect(sent).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("emits a Primary message locally without re-sending it (no echo loop)", async () => {
    const sent = asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    process.emit("message", { type: "config_reload", scope: "combos" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ scope: "combos" });
    expect(sent).toEqual([]);
  });

  it("blocks re-send when a subscriber republishes while applying a Primary message", async () => {
    const sent = asWorker("worker");
    const events = await loadEvents();
    let republished = false;
    events.subscribeKhatamEvent(CONFIG_RELOAD, () => {
      if (republished) return;
      republished = true;
      events.publishKhatamEvent(CONFIG_RELOAD, { scope: "nodes" });
    });

    process.emit("message", { type: "config_reload", scope: "aliases" });

    expect(sent).toEqual([]);
  });

  it("ignores unknown IPC message types and invalid IPC scopes", async () => {
    asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    process.emit("message", { type: "ready" });
    process.emit("message", { type: "drain" });
    process.emit("message", { type: "unknown", scope: "all" });
    process.emit("message", { type: "config_reload", scope: "bogus" });
    // Non-object payload: Vitest's own worker IPC handler reads msg.t, so null would crash it.
    process.emit("message", "not-an-object");

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("cluster worker with Redis configured", () => {
  it("keeps the Redis path unchanged: no IPC relay even inside a worker", async () => {
    vi.doMock("../../src/lib/redis/client.js", () => ({
      isRedisConfigured: () => true,
      isRedisAvailable: () => false,
      getRedisClient: () => null,
      getRedisSubscriber: () => null,
    }));
    const sent = asWorker("worker");
    const events = await loadEvents();
    const handler = vi.fn();
    events.subscribeKhatamEvent(CONFIG_RELOAD, handler);

    const result = events.publishKhatamEvent(CONFIG_RELOAD, { scope: "aliases" });

    expect(result).toBe(false);
    expect(sent).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("real cluster processes (supervisor routing)", () => {
  it("Primary routes a leader publish to the sibling only, with no echo", async () => {
    const workerPath = path.join(tmpDir, "worker-child.mjs");
    const primaryPath = path.join(tmpDir, "primary-child.mjs");
    const { pathToFileURL } = await import("node:url");
    const eventsUrl = pathToFileURL(EVENTS_PATH).href;
    const supervisorUrl = pathToFileURL(SUPERVISOR_PATH).href;

    fs.writeFileSync(
      workerPath,
      `import { subscribeKhatamEvent, publishKhatamEvent } from ${JSON.stringify(eventsUrl)};
const CH = ${JSON.stringify(CONFIG_RELOAD)};
const role = process.env.KHATAM_WORKER_ROLE;
subscribeKhatamEvent(CH, (p) => { console.log("RECV " + role + " " + p.scope); });
process.on("message", (m) => {
  if (m && m.type === "go") { publishKhatamEvent(CH, { scope: "aliases" }); console.log("PUBLISHED " + role); }
});
process.send({ type: "ready" });
`,
    );

    fs.writeFileSync(
      primaryPath,
      `import cluster from "node:cluster";
import { startSupervisor } from ${JSON.stringify(supervisorUrl)};
const env = { ...process.env, KHATAM_WORKERS: "2" };
delete env.REDIS_URL;
const ready = new Set();
const handle = await startSupervisor({ cluster, env, nproc: 4, workerScript: ${JSON.stringify(workerPath)}, signals: false });
cluster.on("message", (w, msg) => {
  if (msg && msg.type === "ready") {
    ready.add(w.id);
    if (ready.size === 2) cluster.workers[1].send({ type: "go" });
  }
});
setTimeout(() => { console.log("DONE"); handle.shutdown(); }, 2500);
`,
    );

    const bin = process.versions.bun ? process.execPath : "bun";
    const childEnv = { ...process.env, DATA_DIR: tmpDir };
    delete childEnv.REDIS_URL;
    delete childEnv.KHATAM_WORKER_ROLE;

    const child = spawn(bin, [primaryPath], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cluster child timed out:\n${out}`)), 45000);
        child.on("close", () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // process closed
      }
    }

    const recv = out.split("\n").filter((l) => l.startsWith("RECV "));
    expect(recv.filter((l) => l === "RECV leader aliases")).toHaveLength(1);
    expect(recv.filter((l) => l === "RECV worker aliases")).toHaveLength(1);
    expect(recv).toHaveLength(2);
  }, 60000);
});

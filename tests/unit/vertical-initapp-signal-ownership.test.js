// US2 defect 2b: initializeApp's SIGINT/SIGTERM handler must not pre-empt a drain owned by
// custom-server.js (NEXT_MANUAL_SIG_HANDLE=true). Real child processes load the real
// initializeApp.js wiring; the drain owner is a fixture stand-in for custom-server.js.
//
// Covered (real): src/shared/services/initializeApp.js signal + exit wiring.
// Seam: the child's HTTP server and drain owner are fixtures; deferred daemons never run
// because the child is stopped before STARTUP_DEFER_MS.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// `owner` = true: the fixture plays custom-server.js. It owns SIGTERM, closes the server,
// waits for in-flight responses, then exits 0. `owner` = false: no drain owner (legacy).
function writeFixture(dir, { owner }) {
  const file = join(dir, "fixture.mjs");
  writeFileSync(
    file,
    `import http from "node:http";
import { initializeApp } from ${JSON.stringify(INIT_APP)};

await initializeApp();
let inFlight = 0;
const server = http.createServer((req, res) => {
  inFlight += 1;
  res.once("finish", () => { inFlight -= 1; });
  res.once("close", () => { inFlight = Math.max(0, inFlight); });
  res.setHeader("Connection", "close");
  if (req.url === "/slow") {
    setTimeout(() => res.end("SLOW_DONE"), 1500);
    return;
  }
  res.end("OK");
});
${owner
  ? `process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});`
  : ""}
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("FIXTURE_READY " + process.pid));
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

function slowRequest(port) {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/slow", agent: false, headers: { connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolveP({ body, aborted: false }));
        res.on("aborted", () => resolveP({ body, aborted: true }));
      },
    );
    req.on("error", () => resolveP({ body: "", aborted: true }));
    req.end();
  });
}

describe("initializeApp signal ownership (NEXT_MANUAL_SIG_HANDLE)", () => {
  it("NEXT_MANUAL_SIG_HANDLE=true: SIGTERM does not pre-empt an in-flight response owned by the drain", async () => {
    const dir = tempDir("khatam-initapp-owned-");
    const port = await pickPort();
    const proc = spawnFixture(writeFixture(dir, { owner: true }), {
      PORT: String(port),
      DATA_DIR: dir,
      DATA_DIR_ALLOW_TEMP: "1",
      NEXT_MANUAL_SIG_HANDLE: "true",
    });
    await waitFor(() => proc.out.includes("FIXTURE_READY"));
    const slow = slowRequest(port);
    await new Promise((r) => setTimeout(r, 300));
    proc.child.kill("SIGTERM");

    const res = await slow;
    const { code, signal } = await proc.closed;
    expect(res.aborted).toBe(false);
    expect(res.body).toBe("SLOW_DONE");
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, TEST_TIMEOUT);

  it("NEXT_MANUAL_SIG_HANDLE unset: legacy immediate exit on SIGTERM is unchanged (no owner)", async () => {
    const dir = tempDir("khatam-initapp-legacy-");
    const port = await pickPort();
    const proc = spawnFixture(writeFixture(dir, { owner: false }), {
      PORT: String(port),
      DATA_DIR: dir,
      DATA_DIR_ALLOW_TEMP: "1",
    });
    await waitFor(() => proc.out.includes("FIXTURE_READY"));
    const slow = slowRequest(port);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    proc.child.kill("SIGTERM");

    const { code } = await proc.closed;
    const res = await slow;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(code).toBe(0);
    expect(res.body).not.toBe("SLOW_DONE");
  }, TEST_TIMEOUT);
});

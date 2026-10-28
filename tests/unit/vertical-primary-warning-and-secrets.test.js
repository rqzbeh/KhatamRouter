// Defect 2a & 3: custom-server startPrimary resolves secrets before forking and warns
// when REDIS_URL is unset in multi-worker mode.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

function pickPort() {
  return new Promise((resolveP, reject) => {
    const attempt = (left) => {
      const port = 31000 + Math.floor(Math.random() * 1000);
      const probe = createNetServer();
      probe.once("error", () => (left > 0 ? attempt(left - 1) : reject(new Error("no free port"))));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveP(port)));
    };
    attempt(50);
  });
}

const AUTH_PATH = join(REPO, "src", "lib", "auth", "dashboardSession.js");

// Stand-in for the Next server. /sign and /verify call the REAL dashboardSession.js sign/verify
// functions in each worker, so a token minted by one worker is checked by the module in another.
const STUB_SERVER = `const http = require("http");
const { pathToFileURL } = require("url");
const AUTH = pathToFileURL(${JSON.stringify(AUTH_PATH)}).href;
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const m = await import(AUTH);
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/sign") {
    const token = await m.createDashboardAuthToken({ signer: process.pid });
    res.end(JSON.stringify({ pid: process.pid, role: process.env.KHATAM_WORKER_ROLE || null, token }));
    return;
  }
  if (url.pathname === "/verify") {
    const ok = await m.verifyDashboardAuthToken(url.searchParams.get("token"));
    res.end(JSON.stringify({ pid: process.pid, ok }));
    return;
  }
  res.end(JSON.stringify({ pid: process.pid, role: process.env.KHATAM_WORKER_ROLE || null }));
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("WORKER_READY " + process.pid));
`;

const STUB_DRIVER = `const adapter = { close() {} };
export async function getAdapter() { return adapter; }
`;

function buildStandalone(root) {
  cpSync(join(REPO, "custom-server.js"), join(root, "custom-server.js"));
  cpSync(join(REPO, "runtime-secrets.cjs"), join(root, "runtime-secrets.cjs"));
  mkdirSync(join(root, "src", "lib", "cluster"), { recursive: true });
  cpSync(join(REPO, "src", "lib", "cluster"), join(root, "src", "lib", "cluster"), { recursive: true });
  mkdirSync(join(root, ".next", "standalone"), { recursive: true });
  copyStandaloneAssets({ projectRoot: root, distDir: ".next" });
  const standalone = join(root, ".next", "standalone");
  writeFileSync(join(standalone, "server.js"), STUB_SERVER);
  mkdirSync(join(standalone, "src", "lib", "db"), { recursive: true });
  writeFileSync(join(standalone, "src", "lib", "db", "driver.js"), STUB_DRIVER);
  return standalone;
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

async function waitFor(predicate, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

describe("custom-server startPrimary startup checks", () => {
  it("warns about per-worker login lockout when KHATAM_WORKERS>1 and REDIS_URL is unset", async () => {
    const root = tempDir("khatam-warn-root-");
    const dataDir = tempDir("khatam-warn-data-");
    const standalone = buildStandalone(root);
    const port = await pickPort();
    const boot = bootChild(standalone, {
      PORT: String(port),
      DATA_DIR: dataDir,
      DATA_DIR_ALLOW_TEMP: "1",
      KHATAM_WORKERS: "2",
    });

    try {
      await waitFor(() => (boot.stdout().match(/WORKER_READY/g) || []).length >= 2);
      const err = boot.stderr();
      expect(err).toContain("[Cluster] REDIS_URL is not set: login lockout and rate limits are per worker (limits are effectively multiplied by the worker count)");
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("a token signed by one KHATAM_WORKERS=2 worker verifies in the other worker (module sign/verify)", async () => {
    const root = tempDir("khatam-share-root-");
    const dataDir = tempDir("khatam-share-data-");
    const standalone = buildStandalone(root);
    const port = await pickPort();
    const boot = bootChild(standalone, {
      PORT: String(port),
      DATA_DIR: dataDir,
      DATA_DIR_ALLOW_TEMP: "1",
      KHATAM_WORKERS: "2",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    const getJson = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: "close" } })).json();
    try {
      await waitFor(() => (boot.stdout().match(/WORKER_READY/g) || []).length >= 2);
      const signed = [];
      for (let i = 0; i < 60 && new Set(signed.map((s) => s.pid)).size < 2; i += 1) {
        signed.push(await getJson("/sign"));
      }
      expect(new Set(signed.map((s) => s.pid)).size).toBeGreaterThanOrEqual(2);

      let crossChecks = 0;
      for (const s of signed.slice(0, 6)) {
        for (let i = 0; i < 30; i += 1) {
          const v = await getJson(`/verify?token=${encodeURIComponent(s.token)}`);
          expect(v.ok).toBe(true);
          if (v.pid !== s.pid) crossChecks += 1;
        }
      }
      expect(crossChecks).toBeGreaterThan(0);
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("does not warn about per-worker lockout when REDIS_URL is set", async () => {
    const root = tempDir("khatam-nowarn-root-");
    const dataDir = tempDir("khatam-nowarn-data-");
    const standalone = buildStandalone(root);
    const port = await pickPort();
    const boot = bootChild(standalone, {
      PORT: String(port),
      DATA_DIR: dataDir,
      DATA_DIR_ALLOW_TEMP: "1",
      KHATAM_WORKERS: "2",
      REDIS_URL: "redis://127.0.0.1:6379",
    });

    try {
      await waitFor(() => (boot.stdout().match(/WORKER_READY/g) || []).length >= 2);
      const err = boot.stderr();
      expect(err).not.toContain("login lockout and rate limits are per worker");
    } finally {
      boot.child.kill("SIGKILL");
      await boot.closed;
    }
  }, TEST_TIMEOUT);

  it("resolveRuntimeSecretsOnce populates process.env.JWT_SECRET and on-disk files once", async () => {
    const dataDir = tempDir("khatam-resolve-secrets-");
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
    const child = spawn(
      "bun",
      [
        "-e",
        `const { resolveRuntimeSecretsOnce } = require("./custom-server.js");
         await resolveRuntimeSecretsOnce();
         console.log(JSON.stringify({
           hasEnvSecret: Boolean(process.env.JWT_SECRET),
           hasDiskSecret: require("fs").existsSync(require("path").join(process.env.DATA_DIR, "jwt-secret")),
           hasDiskMachine: require("fs").existsSync(require("path").join(process.env.DATA_DIR, "machine-id")),
           hasDiskCliSecret: require("fs").existsSync(require("path").join(process.env.DATA_DIR, "auth", "cli-secret")),
         }));`,
      ],
      {
        cwd: REPO,
        env: { ...base, DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise((r) => child.once("close", r));
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.hasEnvSecret).toBe(true);
    expect(parsed.hasDiskSecret).toBe(true);
    expect(parsed.hasDiskMachine).toBe(true);
    expect(parsed.hasDiskCliSecret).toBe(true);
  }, TEST_TIMEOUT);
});

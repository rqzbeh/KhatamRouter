// Defect 2 (high): cold-start race on JWT secret, machine-id and cli-secret.
// When JWT_SECRET (etc.) is unset and DATA_DIR is cold, N concurrent processes must converge
// on the same secret. Tokens signed by one worker must verify in another.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTH_MOD = pathToFileURL(join(REPO, "src/lib/auth/dashboardSession.js")).href;
const MACH_MOD = pathToFileURL(join(REPO, "src/shared/utils/machineId.js")).href;
const TEST_TIMEOUT = 60000;
const STRIPPED_ENV = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
  "KHATAM_WORKERS", "WEB_CONCURRENCY", "KHATAM_WORKER_ROLE", "KHATAM_MIGRATIONS_DONE",
  "KHATAM_DRAIN_TIMEOUT_MS", "PORT", "DASHBOARD_PORT", "DATA_DIR", "NODE_ENV", "NEXT_MANUAL_SIG_HANDLE",
  "JWT_SECRET", "MACHINE_ID_SALT",
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

function runChild(code, env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.includes(k)));
  const child = spawn("bun", ["-e", code], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  return new Promise((resolveP) => {
    child.once("close", (code, signal) => resolveP({ code, signal, out: out.trim(), err: err.trim() }));
  });
}

describe("cold-start secrets convergence", () => {
  it("8 concurrent processes cold-booting on empty DATA_DIR converge on identical JWT secret", async () => {
    const dataDir = tempDir("khatam-jwt-race-");
    const go = join(dataDir, "go");
    const code = `
      await import("jose"); await import("bcryptjs"); await import("@/lib/dataDir"); await import("@/lib/localDb");
      while (!require("fs").existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 0));
      const m = await import(${JSON.stringify(AUTH_MOD)});
      const token = await m.createDashboardAuthToken({ probe: 1 });
      console.log(token);
    `;
    const env = { DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1" };
    const runs = Array.from({ length: 8 }, () => runChild(code, env));
    // Brief settle to ensure all 8 children reach the barrier spin.
    await new Promise((r) => setTimeout(r, 6000));
    writeFileSync(go, "1");
    const results = await Promise.all(runs);

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^eyJ/);
    }
    const tokens = results.map((r) => r.out);
    const sigs = new Set(tokens.map((t) => t.split(".")[2]));
    // All 8 must have signed with the exact same secret (one signature across all).
    expect(sigs.size).toBe(1);

    // Verify all 8 tokens in a fresh process that only reads the winner file.
    const verifyCode = `
      const m = await import(${JSON.stringify(AUTH_MOD)});
      const toks = ${JSON.stringify(tokens)};
      const res = await Promise.all(toks.map(t => m.verifyDashboardAuthToken(t)));
      console.log(res.filter(Boolean).length);
    `;
    const v = await runChild(verifyCode, env);
    expect(v.out).toBe("8");
  }, TEST_TIMEOUT);

  it("8 concurrent processes cold-booting converge on identical raw machine-id and cli-secret", async () => {
    const dataDir = tempDir("khatam-mach-race-");
    const go = join(dataDir, "go");
    const code = `
      while (!require("fs").existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 0));
      const m = await import(${JSON.stringify(MACH_MOD)});
      const raw = await m.getRawMachineId();
      const cli = await m.getConsistentMachineId("9r-cli-auth");
      console.log(JSON.stringify({ raw, cli }));
    `;
    const env = { DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1" };
    const runs = Array.from({ length: 8 }, () => runChild(code, env));
    await new Promise((r) => setTimeout(r, 3000));
    writeFileSync(go, "1");
    const results = await Promise.all(runs);

    for (const r of results) expect(r.code).toBe(0);
    const parsed = results.map((r) => JSON.parse(r.out));
    const rawIds = new Set(parsed.map((p) => p.raw));
    const cliTokens = new Set(parsed.map((p) => p.cli));
    expect(rawIds.size).toBe(1);
    expect(cliTokens.size).toBe(1);
  }, TEST_TIMEOUT);

  it("token signed in worker role verifies in a sibling worker role (same mkdtemp)", async () => {
    const dataDir = tempDir("khatam-cross-worker-");
    const env = { DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1" };

    // Worker 1 signs
    const signResult = await runChild(`
      const m = await import(${JSON.stringify(AUTH_MOD)});
      console.log(await m.createDashboardAuthToken({ user: "admin" }));
    `, { ...env, KHATAM_WORKER_ROLE: "leader" });
    expect(signResult.code).toBe(0);
    const token = signResult.out;

    // Worker 2 verifies
    const verifyResult = await runChild(`
      const m = await import(${JSON.stringify(AUTH_MOD)});
      console.log(await m.verifyDashboardAuthToken(${JSON.stringify(token)}));
    `, { ...env, KHATAM_WORKER_ROLE: "worker" });
    expect(verifyResult.code).toBe(0);
    expect(verifyResult.out).toBe("true");
  }, TEST_TIMEOUT);
});

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HARNESS_SCRIPT = path.join(REPO_ROOT, "scripts/perf-l1-harness.mjs");

// Every spawned harness gets a throwaway HOME so nothing can touch the real ~/.9router.
function runHarness(args, extraEnv = {}, home) {
  return spawnSync("bun", [HARNESS_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    encoding: "utf8",
    timeout: 180000,
  });
}

describe("perf-l1-harness contract and safety guards", () => {
  it("refuses DATA_DIR under ~/.9router with 'refusing production DATA_DIR' and non-zero code", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9r-home-test-"));
    const prodDir = path.join(tempHome, ".9router");
    fs.mkdirSync(prodDir, { recursive: true });
    try {
      const res = runHarness(["--runs", "1", "--warmup", "1", "--requests", "1"], { DATA_DIR: prodDir }, tempHome);
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toMatch(/refusing production DATA_DIR/);
      expect(fs.existsSync(path.join(prodDir, "db"))).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("refuses a nested DATA_DIR under ~/.9router as well", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9r-home-test-"));
    const nested = path.join(tempHome, ".9router", "nested");
    fs.mkdirSync(nested, { recursive: true });
    try {
      const res = runHarness(["--runs", "1", "--warmup", "1", "--requests", "1"], { DATA_DIR: nested }, tempHome);
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toMatch(/refusing production DATA_DIR/);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("smoke run uses an ephemeral mkdtemp DATA_DIR, prints PERF_L1_OK <label>, emits khatam.perf.l1/1 JSON", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9r-home-test-"));
    const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-perf-out-"));
    const outFile = path.join(tempOutDir, "profile.json");
    try {
      const res = runHarness(
        ["--label", "smoke-test", "--runs", "1", "--warmup", "1", "--requests", "5", "--out", outFile],
        {},
        tempHome
      );
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(res.status, combined).toBe(0);
      expect(res.stdout).toContain("PERF_L1_OK smoke-test");

      // Ephemeral DATA_DIR: mkdtemp prefix under tmp, reported on stdout, removed after the run.
      const dataDirLine = res.stdout.split("\n").find((l) => l.startsWith("perf-l1 data_dir="));
      expect(dataDirLine, "harness must report its temp DATA_DIR").toBeDefined();
      const usedDataDir = dataDirLine.slice("perf-l1 data_dir=".length).trim();
      expect(usedDataDir.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(usedDataDir).startsWith("khatam-perf-data-")).toBe(true);
      expect(fs.existsSync(usedDataDir)).toBe(false);

      // Nothing written under the (throwaway) home's .9router.
      expect(fs.existsSync(path.join(tempHome, ".9router", "db", "data.sqlite"))).toBe(false);

      expect(fs.existsSync(outFile)).toBe(true);
      const profile = JSON.parse(fs.readFileSync(outFile, "utf8"));
      expect(profile.schema).toBe("khatam.perf.l1/1");
      expect(profile.label).toBe("smoke-test");
      expect(typeof profile.git_sha).toBe("string");
      expect(typeof profile.bun_version).toBe("string");
      expect(profile.env.data_dir).toBe("temp");
      expect(profile.env.redis).toBe("off");
      expect(profile.workload).toMatchObject({ requests: 5, warmup: 1, runs: 1 });
      expect(profile.workload.mix).toMatchObject({ direct: 0.4, translated: 0.4, combo: 0.2 });
      for (const phase of ["auth_acl", "model_info", "translate", "dispatch_glue"]) {
        expect(typeof profile.phases_ms[phase].p50, phase).toBe("number");
        expect(typeof profile.phases_ms[phase].p95, phase).toBe("number");
        expect(typeof profile.phases_ms[phase].p99, phase).toBe("number");
        expect(typeof profile.phases_ms[phase].mean, phase).toBe("number");
      }
      expect(typeof profile.total_ms.p50).toBe("number");
      expect(typeof profile.total_ms.p95).toBe("number");
      expect(profile.run_means_ms).toHaveLength(1);
      expect(profile.db_queries_per_req).toBeGreaterThan(0);
      expect(typeof profile.noisy).toBe("boolean");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempOutDir, { recursive: true, force: true });
    }
  }, 240000);

  it("default workload meets runs >= 5 and warmup >= 50", async () => {
    const mod = await import("../../scripts/perf-l1-harness.mjs");
    const defaults = mod.parseArgs([]);
    expect(defaults.runs).toBeGreaterThanOrEqual(5);
    expect(defaults.warmup).toBeGreaterThanOrEqual(50);
    expect(defaults.label).toBe("baseline");
    const custom = mod.parseArgs(["--label", "after-slim", "--runs", "7", "--warmup", "60", "--requests", "9", "--out", "x.json"]);
    expect(custom).toMatchObject({ label: "after-slim", runs: 7, warmup: 60, requests: 9, out: "x.json" });
  });

  it("flags runs with CV > 15% as noisy and leaves stable runs unflagged", async () => {
    const mod = await import("../../scripts/perf-l1-harness.mjs");
    const stable = mod.computeCV([10.0, 10.2, 9.8, 10.1, 9.9]);
    expect(stable.noisy).toBe(false);
    expect(stable.cv_pct).toBeLessThan(15);
    const noisy = mod.computeCV([5.0, 15.0, 25.0, 8.0, 30.0]);
    expect(noisy.noisy).toBe(true);
    expect(noisy.cv_pct).toBeGreaterThan(15);
  });

  it("computeStats yields p50/p95/p99/mean over a 1..100 sample", async () => {
    const mod = await import("../../scripts/perf-l1-harness.mjs");
    const stats = mod.computeStats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(stats.p50).toBe(51);
    expect(stats.p95).toBe(96);
    expect(stats.p99).toBe(100);
    expect(stats.mean).toBe(50.5);
  });
});

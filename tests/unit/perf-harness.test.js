import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const HARNESS_SCRIPT = path.join(REPO_ROOT, "scripts/perf-l1-harness.mjs");

describe("perf-l1-harness contract and safety guards", () => {
  it("refuses to start when DATA_DIR resolves under ~/.9router", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9r-home-test-"));
    const prodDir = path.join(tempHome, ".9router");
    fs.mkdirSync(prodDir, { recursive: true });

    try {
      const res = spawnSync("bun", [
        HARNESS_SCRIPT,
        "--runs", "1",
        "--warmup", "1",
        "--requests", "1",
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: tempHome,
          DATA_DIR: prodDir,
        },
        encoding: "utf8",
      });

      expect(res.status).not.toBe(0);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toMatch(/refus|cannot|production|\.9router/i);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("completes a smoke run in isolated temp DATA_DIR, prints PERF_L1_OK, and emits valid khatam.perf.l1/1 JSON", () => {
    const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-perf-out-"));
    const outFile = path.join(tempOutDir, "profile.json");

    try {
      const res = spawnSync("bun", [
        HARNESS_SCRIPT,
        "--label", "smoke-test",
        "--runs", "1",
        "--warmup", "1",
        "--requests", "5",
        "--out", outFile,
      ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 60000,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("PERF_L1_OK smoke-test");
      expect(fs.existsSync(outFile)).toBe(true);

      const profile = JSON.parse(fs.readFileSync(outFile, "utf8"));

      // Contract: schema & label
      expect(profile.schema).toBe("khatam.perf.l1/1");
      expect(profile.label).toBe("smoke-test");
      expect(typeof profile.git_sha).toBe("string");
      expect(profile.git_sha.length).toBeGreaterThan(0);
      expect(typeof profile.bun_version).toBe("string");

      // Contract: env object
      expect(profile.env).toBeDefined();
      expect(profile.env.data_dir).toBe("temp");
      expect(typeof profile.env.cpu_model).toBe("string");
      expect(typeof profile.env.cpus).toBe("number");
      expect(profile.env.redis).toBe("off");

      // Contract: workload object
      expect(profile.workload).toBeDefined();
      expect(profile.workload.requests).toBe(5);
      expect(profile.workload.warmup).toBe(1);
      expect(profile.workload.runs).toBe(1);
      expect(profile.workload.mix).toMatchObject({
        direct: 0.4,
        translated_tools: 0.4,
        combo: 0.2,
      });

      // Contract: per-phase measurements
      expect(profile.phases_ms).toBeDefined();
      for (const phase of ["auth_acl", "model_info", "translate", "dispatch_glue", "stream_drain", "bookkeeping"]) {
        expect(profile.phases_ms[phase], `Missing phase ${phase}`).toBeDefined();
        expect(typeof profile.phases_ms[phase].p50).toBe("number");
        expect(typeof profile.phases_ms[phase].p95).toBe("number");
        expect(typeof profile.phases_ms[phase].p99).toBe("number");
        expect(typeof profile.phases_ms[phase].mean).toBe("number");
      }

      // Contract: total latency percentiles & run means
      expect(profile.total_ms).toBeDefined();
      expect(typeof profile.total_ms.p50).toBe("number");
      expect(typeof profile.total_ms.p95).toBe("number");
      expect(typeof profile.total_ms.p99).toBe("number");
      expect(typeof profile.total_ms.mean).toBe("number");
      expect(Array.isArray(profile.run_means_ms)).toBe(true);
      expect(profile.run_means_ms.length).toBe(1);

      // Contract: db queries per req counted via adapter wrapper
      expect(typeof profile.db_queries_per_req).toBe("number");
      expect(profile.db_queries_per_req).toBeGreaterThan(0);

      // Contract: CV and noisy flag
      expect(typeof profile.noisy).toBe("boolean");
    } finally {
      fs.rmSync(tempOutDir, { recursive: true, force: true });
    }
  });

  it("flags runs with CV > 15% as noisy", async () => {
    const mod = await import("../../scripts/perf-l1-harness.mjs");
    expect(typeof mod.computeCV).toBe("function");

    // Stable runs: means close together (e.g. 10.0, 10.2, 9.8, 10.1, 9.9) -> CV ~ 1.5%
    const stable = mod.computeCV([10.0, 10.2, 9.8, 10.1, 9.9]);
    expect(stable.noisy).toBe(false);
    expect(stable.cv_pct).toBeLessThan(15);

    // Noisy runs: high variance (e.g. 5.0, 15.0, 25.0, 8.0, 30.0) -> CV >> 15%
    const noisy = mod.computeCV([5.0, 15.0, 25.0, 8.0, 30.0]);
    expect(noisy.noisy).toBe(true);
    expect(noisy.cv_pct).toBeGreaterThan(15);
  });

  it("exports helper for statistical percentiles matching p50/p95/p99/mean", async () => {
    const mod = await import("../../scripts/perf-l1-harness.mjs");
    expect(typeof mod.computeStats).toBe("function");

    const sample = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const stats = mod.computeStats(sample);
    expect(stats.p50).toBe(51);
    expect(stats.p95).toBe(96);
    expect(stats.p99).toBe(100);
    expect(stats.mean).toBe(50.5);
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LADDER_SCRIPT = path.join(REPO_ROOT, "scripts/perf-ladder.sh");
const LIB_PATH = path.join(REPO_ROOT, "scripts/perf-ladder-lib.mjs");
const MOCK_UPSTREAM_PATH = path.join(REPO_ROOT, "scripts/perf-mock-upstream.mjs");

function runScriptAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", args, {
      cwd: REPO_ROOT,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("perf-ladder-contract test suite", () => {
  describe("scripts/perf-ladder-lib.mjs pure math and LadderRow formatting", () => {
    it("computeStats calculates p50, p95, p99, and mean correctly", async () => {
      const { computeStats } = await import(LIB_PATH);
      const latencies = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
      const stats = computeStats(latencies);
      expect(stats.p50).toBe(51);
      expect(stats.p95).toBe(96);
      expect(stats.p99).toBe(100);
      expect(stats.mean).toBe(50.5);
    });

    it("computeCV calculates coefficient of variation and flags noisy if CV > 15%", async () => {
      const { computeCV } = await import(LIB_PATH);
      // Low variance: [100, 102, 98, 101, 99] -> CV ~ 1.6%
      const stable = computeCV([100, 102, 98, 101, 99]);
      expect(stable.noisy).toBe(false);
      expect(stable.cv_pct).toBeLessThan(15);

      // High variance: [100, 200, 50, 150, 80] -> CV > 15%
      const noisy = computeCV([100, 200, 50, 150, 80]);
      expect(noisy.noisy).toBe(true);
      expect(noisy.cv_pct).toBeGreaterThan(15);
    });

    it("selectMedianRun drops high and low from 5 runs and picks the median of remaining 3", async () => {
      const { selectMedianRun } = await import(LIB_PATH);
      const runs = [
        { run: 1, mean_ms: 10.0, p50_ms: 9.0 },
        { run: 2, mean_ms: 50.0, p50_ms: 45.0 }, // high
        { run: 3, mean_ms: 2.0, p50_ms: 1.5 },   // low
        { run: 4, mean_ms: 25.0, p50_ms: 22.0 },
        { run: 5, mean_ms: 30.0, p50_ms: 28.0 },
      ];
      // Sorted by mean_ms: 2.0, 10.0, 25.0, 30.0, 50.0
      // Drops 2.0 and 50.0 -> middle three are [10.0, 25.0, 30.0]
      // Median of middle three is 25.0 (run 4)
      const selected = selectMedianRun(runs, "mean_ms");
      expect(selected.run).toBe(4);
      expect(selected.mean_ms).toBe(25.0);
    });

    it("evaluateLadderCertification certifies clean runs and refuses invalid/noisy runs with UNMEASURED", async () => {
      const { evaluateLadderCertification } = await import(LIB_PATH);

      // Case 1: Clean run
      const clean = evaluateLadderCertification({
        medianRun: { p50_ms: 3.5, p95_ms: 7.2, p99_ms: 12.0, req_per_s: 450.0 },
        cv: { cv_pct: 4.2, noisy: false },
        errorRate: 0.001, // 0.1% <= 0.5%
        targetReachable: true,
      });
      expect(clean.certified).toBe(true);
      expect(clean.p50_ms).toBe(3.5);
      expect(clean.p95_ms).toBe(7.2);
      expect(clean.p99_ms).toBe(12.0);
      expect(clean.req_per_s).toBe(450.0);
      expect(clean.cause).toBe("-");

      // Case 2: Target unreachable
      const unreachable = evaluateLadderCertification({
        medianRun: null,
        cv: { cv_pct: 0, noisy: false },
        errorRate: 1.0,
        targetReachable: false,
        unreachableCause: "Connection refused to http://127.0.0.1:9999",
      });
      expect(unreachable.certified).toBe(false);
      expect(unreachable.p50_ms).toBe("UNMEASURED");
      expect(unreachable.req_per_s).toBe("UNMEASURED");
      expect(unreachable.cause).toContain("Connection refused");

      // Case 3: Error rate > 0.5%
      const highError = evaluateLadderCertification({
        medianRun: { p50_ms: 3.5, p95_ms: 7.2, p99_ms: 12.0, req_per_s: 450.0 },
        cv: { cv_pct: 4.2, noisy: false },
        errorRate: 0.015, // 1.5% > 0.5%
        targetReachable: true,
      });
      expect(highError.certified).toBe(false);
      expect(highError.p50_ms).toBe("UNMEASURED");
      expect(highError.req_per_s).toBe("UNMEASURED");
      expect(highError.cause).toMatch(/error rate/i);

      // Case 4: Noisy CV > 15%
      const noisyRun = evaluateLadderCertification({
        medianRun: { p50_ms: 3.5, p95_ms: 7.2, p99_ms: 12.0, req_per_s: 450.0 },
        cv: { cv_pct: 18.5, noisy: true },
        errorRate: 0.0,
        targetReachable: true,
      });
      expect(noisyRun.certified).toBe(false);
      expect(noisyRun.p50_ms).toBe("UNMEASURED");
      expect(noisyRun.req_per_s).toBe("UNMEASURED");
      expect(noisyRun.cause).toMatch(/noisy|coefficient of variation/i);
    });

    it("formatLadderRow generates markdown row conforming to LadderRow schema", async () => {
      const { formatLadderRow } = await import(LIB_PATH);
      const row = formatLadderRow({
        tier: "L2",
        replicas: 1,
        p50_ms: 2.45,
        p95_ms: 5.12,
        p99_ms: 8.90,
        req_per_s: 820.5,
        mode: "normal",
        cv_pct: 3.5,
        errors: 0,
        env: "Linux x86_64 host Bun 1.4.3",
        command: "scripts/perf-ladder.sh 1 --url http://127.0.0.1:20128",
        cause: "-",
      });

      expect(row).toContain("| L2 | 1 | 2.45 | 5.12 | 8.9 | 820.5 |");
      expect(row).toContain("normal");
      expect(row).toContain("Linux x86_64 host Bun 1.4.3");

      const unmeasuredRow = formatLadderRow({
        tier: "L3",
        replicas: 2,
        p50_ms: "UNMEASURED",
        p95_ms: "UNMEASURED",
        p99_ms: "UNMEASURED",
        req_per_s: "UNMEASURED",
        mode: "normal",
        cv_pct: "18.2%",
        errors: 12,
        env: "Linux x86_64 guest Bun 1.4.3",
        command: "scripts/perf-ladder.sh 2",
        cause: "Coefficient of variation 18.2% > 15% threshold (noisy)",
      });

      expect(unmeasuredRow).toContain("| L3 | 2 | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |");
      expect(unmeasuredRow).toContain("Coefficient of variation 18.2% > 15% threshold (noisy)");
    });
  });

  describe("scripts/perf-mock-upstream.mjs in-process server", () => {
    let mockServer;

    afterEach(async () => {
      if (mockServer && mockServer.close) {
        await mockServer.close();
        mockServer = null;
      }
    });

    it("starts and serves streaming SSE and non-streaming chat completions", async () => {
      const { startMockServer } = await import(MOCK_UPSTREAM_PATH);
      mockServer = await startMockServer({ port: 0, host: "127.0.0.1" });

      expect(mockServer.port).toBeGreaterThan(0);
      expect(mockServer.url).toContain(`127.0.0.1:${mockServer.port}`);

      // Test 1: GET /health
      const healthRes = await fetch(`${mockServer.url}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.status).toBe("ok");

      // Test 2: GET /v1/models
      const modelsRes = await fetch(`${mockServer.url}/v1/models`);
      expect(modelsRes.status).toBe(200);
      const modelsData = await modelsRes.json();
      expect(modelsData.data).toBeDefined();
      expect(modelsData.data.some((m) => m.id === "gpt-4o-mini")).toBe(true);

      // Test 3: POST /v1/chat/completions non-streaming
      const jsonRes = await fetch(`${mockServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });
      expect(jsonRes.status).toBe(200);
      const jsonData = await jsonRes.json();
      expect(jsonData.choices[0].message.content).toBeDefined();

      // Test 4: POST /v1/chat/completions streaming SSE
      const sseRes = await fetch(`${mockServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const sseText = await sseRes.text();
      expect(sseText).toContain("data: {");
      expect(sseText).toContain("data: [DONE]");
    });
  });

  describe("scripts/perf-ladder.sh contract and safety invariants", () => {
    it("script exists, is executable, and contains NO docker command invocations (FR-009)", () => {
      expect(fs.existsSync(LADDER_SCRIPT)).toBe(true);
      const content = fs.readFileSync(LADDER_SCRIPT, "utf8");

      // Shebang check
      expect(content).toMatch(/^#!.*\b(bash|sh)\b/);

      // Invariant: NEVER invoke docker, and script text must not contain 'docker' (FR-009)
      expect(/docker/i.test(content)).toBe(false);

      // Metrics & keywords check for leaf-e-ladder gate
      expect(content).toMatch(/p50|p95/);
      expect(content).toMatch(/req\/?s|throughput|rps/i);
      expect(content).toMatch(/UNMEASURED/);
      expect(content).toMatch(/\$\{?1|REPLICAS|replicas/);
    });

    it("passes bash -n syntax check", () => {
      const res = spawnSync("bash", ["-n", LADDER_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
    });

    it("runs successfully against mock upstream with small counts and emits valid LadderRow", async () => {
      const { startMockServer } = await import(MOCK_UPSTREAM_PATH);
      const mockServer = await startMockServer({ port: 0, host: "127.0.0.1" });

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-ladder-test-"));
      const outFile = path.join(tempDir, "ladder-row.md");

      try {
        const res = await runScriptAsync([
          LADDER_SCRIPT,
          "1",
          "--url", mockServer.url,
          "--key", "sk-mock-perf-key",
          "--model", "gpt-4o-mini",
          "--warmup", "2",
          "--requests", "5",
          "--runs", "5",
          "--concurrency", "2",
          "--out", outFile,
        ]);

        expect(res.status).toBe(0);
        const output = res.stdout;
        expect(output).toContain("| L2 | 1 |");
        expect(res.stderr).toMatch(/p50|p95/i);
        expect(output).not.toContain("UNMEASURED");

        expect(fs.existsSync(outFile)).toBe(true);
        const fileContent = fs.readFileSync(outFile, "utf8");
        expect(fileContent).toContain("| L2 | 1 |");
        expect(fileContent).toMatch(/p50|p95/i);
      } finally {
        await mockServer.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("emits UNMEASURED with cause when target server is unreachable", async () => {
      // Port 59999 is intentionally unused on loopback
      const res = await runScriptAsync([
        LADDER_SCRIPT,
        "1",
        "--url", "http://127.0.0.1:59999",
        "--warmup", "1",
        "--requests", "2",
        "--runs", "1",
        "--concurrency", "1",
      ]);

      expect(res.stdout).toContain("UNMEASURED");
      expect(res.stdout).toMatch(/unreachable|connection refused|failed to connect/i);
    }, 15000);

    it("emits UNMEASURED with cause when error rate exceeds 0.5%", async () => {
      const { startMockServer } = await import(MOCK_UPSTREAM_PATH);
      // Mock server returning 100% 500 errors
      const mockServer = await startMockServer({ port: 0, host: "127.0.0.1", errorRate: 1.0 });

      try {
        const res = await runScriptAsync([
          LADDER_SCRIPT,
          "1",
          "--url", mockServer.url,
          "--key", "sk-mock-perf-key",
          "--model", "gpt-4o-mini",
          "--warmup", "1",
          "--requests", "5",
          "--runs", "5",
          "--concurrency", "2",
        ]);

        expect(res.stdout).toContain("UNMEASURED");
        expect(res.stdout).toMatch(/error rate|threshold/i);
      } finally {
        await mockServer.close();
      }
    });
  });
});

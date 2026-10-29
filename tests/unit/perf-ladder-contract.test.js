import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStats,
  computeCV,
  summarizeRuns,
  formatVerticalRow,
  VERTICAL_HEADER,
  parseArgs,
  assertDataDirAllowed,
} from "../../scripts/perf-ladder-lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LADDER_SH = path.join(REPO_ROOT, "scripts/perf-ladder.sh");
const LADDER_LIB = path.join(REPO_ROOT, "scripts/perf-ladder-lib.mjs");
const LADDER_SEED = path.join(REPO_ROOT, "scripts/perf-ladder-seed.mjs");

const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());

describe("perf-ladder pure math", () => {
  it("computeStats uses floor-index percentiles and mean", () => {
    const s = computeStats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s.p50).toBe(51);
    expect(s.p95).toBe(96);
    expect(s.p99).toBe(100);
    expect(s.mean).toBe(50.5);
  });

  it("computeCV flags CV >= 15% as noisy and passes stable series", () => {
    expect(computeCV([100, 102, 98, 101, 99]).noisy).toBe(false);
    expect(computeCV([100, 200]).noisy).toBe(true);
    expect(computeCV([100, 200]).cv_pct).toBeGreaterThanOrEqual(15);
  });
});

describe("perf-ladder run summary and honest flags", () => {
  const run = (req, errors = 0) => ({ p50_ms: 2, p95_ms: 5, p99_ms: 9, req_per_s: req, errors });

  it("summarizeRuns reports median metrics, summed errors, and noisy=false for stable runs", () => {
    const row = summarizeRuns([run(1000), run(1010), run(990)]);
    expect(row.req_per_s).toBe(1000);
    expect(row.errors).toBe(0);
    expect(row.noisy).toBe(false);
    expect(row.invalid).toBe(false);
  });

  it("summarizeRuns flags noisy runs but keeps the numbers", () => {
    const row = summarizeRuns([run(100), run(200), run(50)]);
    expect(row.noisy).toBe(true);
    expect(row.cause).toMatch(/noisy/);
    expect(row.req_per_s).toBe(100);
  });

  it("summarizeRuns marks any error as invalid and leaves metrics UNMEASURED", () => {
    const row = summarizeRuns([run(1000, 0), run(1000, 3), run(1000, 0)]);
    expect(row.invalid).toBe(true);
    expect(row.errors).toBe(3);
    expect(row.p50_ms).toBe("UNMEASURED");
    expect(row.req_per_s).toBe("UNMEASURED");
    expect(row.cause).toMatch(/invalid.*3 errors/);
  });
});

describe("perf-ladder row formatting", () => {
  it("formatVerticalRow emits 13 cells labelled Vertical <n>-worker and matches the header width", () => {
    const row = formatVerticalRow({
      workers: 2, p50_ms: 1.5, p95_ms: 4, p99_ms: 8, req_per_s: 900, rss_mb: 120,
      mode: "normal", cv_pct: "5.39%", errors: 0, env: "host", command: "cmd", cause: "-",
    });
    const c = cells(row);
    expect(c[0]).toBe("Vertical 2-worker");
    expect(c[1]).toBe("2");
    expect(c[9]).toBe("0");
    expect(c.length).toBe(13);
    expect(cells(VERTICAL_HEADER.split("\n")[0]).length).toBe(13);
  });

  it("formatVerticalRow renders UNMEASURED cells verbatim", () => {
    const row = formatVerticalRow({ workers: 4, p50_ms: "UNMEASURED", cause: "invalid: 2 errors" });
    expect(row).toContain("| UNMEASURED |");
    expect(row).toContain("invalid: 2 errors");
  });
});

describe("perf-ladder argument parsing", () => {
  it("parses workers, url, concurrency and connection mode", () => {
    const a = parseArgs(["2", "--url", "http://127.0.0.1:31001", "--concurrency", "8", "--connection-mode", "close"]);
    expect(a.workers).toBe(2);
    expect(a.url).toBe("http://127.0.0.1:31001");
    expect(a.concurrency).toBe(8);
    expect(a.connectionMode).toBe("close");
  });

  it("parses --redis-down as a boolean flag", () => {
    expect(parseArgs(["1", "--redis-down"]).redisDown).toBe(true);
    expect(parseArgs(["1"]).redisDown).toBe(false);
  });

  it("rejects worker counts outside 1..64 and unknown connection modes", () => {
    expect(() => parseArgs(["0"])).toThrow(/workers/);
    expect(() => parseArgs(["65"])).toThrow(/workers/);
    expect(() => parseArgs([])).toThrow(/workers/);
    expect(() => parseArgs(["2", "--connection-mode", "pipeline"])).toThrow(/connection-mode/);
  });
});

describe("perf-ladder DATA_DIR safety", () => {
  it("refuses a DATA_DIR under ~/.9router with the production refusal message", () => {
    const prod = path.join(os.homedir(), ".9router", "db");
    expect(() => assertDataDirAllowed(prod)).toThrow(/refusing production DATA_DIR/);
  });

  it("accepts a fresh temp DATA_DIR", () => {
    expect(() => assertDataDirAllowed(fs.mkdtempSync("/tmp/khatam-ladder-unit-"))).not.toThrow();
  });
});

describe("perf-ladder script hygiene", () => {
  it("contains no docker tokens in any ladder file", () => {
    for (const f of [LADDER_SH, LADDER_LIB, LADDER_SEED]) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/docker/i);
    }
  });

  it("the driver is a bash script that passes bash -n", () => {
    const r = spawnSync("bash", ["-n", LADDER_SH], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

describe("perf-ladder real smoke (2 workers, tiny workload)", () => {
  const hasBuild = fs.existsSync(path.join(REPO_ROOT, ".next/BUILD_ID"));
  // The smoke ladder needs a production .next build; CI / clean worktrees have none.
  const noBuildReason =
    "skipping real smoke: no .next/BUILD_ID — run `bun run build:bun` first to include this test";
  if (!hasBuild) process.stderr.write(`[perf-ladder] ${noBuildReason}\n`);

  it.skipIf(!hasBuild)("boots 2 workers, runs a tiny load, emits a well-formed Vertical 2-worker row with zero errors", () => {
    const r = spawnSync(
      "bash",
      [LADDER_SH, "2", "--requests", "40", "--warmup", "5", "--runs", "2", "--concurrency", "4", "--connection-mode", "keep-alive"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 170000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out.slice(-2000)).toBe(0);
    const row = out.split("\n").find((l) => l.startsWith("| Vertical 2-worker |"));
    expect(row, out.slice(-2000)).toBeDefined();
    const c = cells(row);
    expect(c.length).toBe(13);
    expect(c[9]).toBe("0");
    expect(row).not.toMatch(/UNMEASURED/);
  }, 180000);
});

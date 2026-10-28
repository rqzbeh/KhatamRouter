import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERTICAL_HEADER = [
  "| tier | workers | p50_ms | p95_ms | p99_ms | req_per_s | rss_mb | mode | cv_pct | errors | env | command | cause |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
].join("\n");

export function assertDataDirAllowed(targetPath) {
  if (!targetPath) {
    throw new Error("refusing production DATA_DIR: DATA_DIR must be explicitly specified");
  }
  const resolved = path.resolve(String(targetPath));
  const home9router = path.resolve(os.homedir(), ".9router");
  if (resolved === home9router || resolved.startsWith(home9router + path.sep)) {
    throw new Error(`refusing production DATA_DIR: ${resolved} resolves under ~/.9router`);
  }
}

export function computeStats(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const p = (q) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return Number(sorted[idx].toFixed(2));
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / n).toFixed(2));
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean,
  };
}

export function computeCV(numbers) {
  if (!numbers || numbers.length <= 1) {
    return { cv_pct: 0, noisy: false };
  }
  const n = numbers.length;
  const mean = numbers.reduce((acc, v) => acc + v, 0) / n;
  if (mean === 0) return { cv_pct: 0, noisy: false };
  const variance = numbers.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const cvPct = (stdDev / mean) * 100;
  return {
    cv_pct: Number(cvPct.toFixed(2)),
    noisy: cvPct >= 15,
  };
}

export function selectMedianRun(runs, sortKey = "p50_ms") {
  if (!runs || runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => (a[sortKey] ?? 0) - (b[sortKey] ?? 0));
  const midIndex = Math.floor(sorted.length / 2);
  return sorted[midIndex];
}

export function summarizeRuns(runs) {
  if (!runs || runs.length === 0) {
    return {
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      rss_mb: "UNMEASURED",
      cv_pct: "0%",
      errors: 0,
      noisy: false,
      invalid: true,
      cause: "no runs executed",
    };
  }

  const totalErrors = runs.reduce((sum, r) => sum + (r.errors || 0), 0);
  const throughputs = runs.map((r) => r.req_per_s || 0);
  const cv = computeCV(throughputs);
  const median = selectMedianRun(runs, "req_per_s") || runs[0];

  if (totalErrors > 0) {
    return {
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      rss_mb: median.rss_mb ?? "UNMEASURED",
      cv_pct: `${cv.cv_pct}%`,
      errors: totalErrors,
      noisy: cv.noisy,
      invalid: true,
      cause: `invalid: ${totalErrors} errors during run`,
    };
  }

  let cause = "-";
  if (cv.noisy) {
    cause = `noisy: CV ${cv.cv_pct}% >= 15%`;
  }

  return {
    p50_ms: median.p50_ms,
    p95_ms: median.p95_ms,
    p99_ms: median.p99_ms,
    req_per_s: median.req_per_s,
    rss_mb: median.rss_mb ?? "UNMEASURED",
    cv_pct: `${cv.cv_pct}%`,
    errors: 0,
    noisy: cv.noisy,
    invalid: false,
    cause,
  };
}

export function formatVerticalRow({
  tier,
  workers,
  p50_ms = "UNMEASURED",
  p95_ms = "UNMEASURED",
  p99_ms = "UNMEASURED",
  req_per_s = "UNMEASURED",
  rss_mb = "UNMEASURED",
  mode = "normal",
  cv_pct = "0%",
  errors = 0,
  env = "host",
  command = "",
  cause = "-",
}) {
  const rowTier = tier || `Vertical ${workers}-worker`;
  const formatCell = (v) => (v === undefined || v === null ? "-" : String(v));
  const formatCv = (v) => (typeof v === "number" ? `${v}%` : String(v));

  return `| ${rowTier} | ${workers} | ${formatCell(p50_ms)} | ${formatCell(p95_ms)} | ${formatCell(p99_ms)} | ${formatCell(req_per_s)} | ${formatCell(rss_mb)} | ${mode} | ${formatCv(cv_pct)} | ${errors} | ${env} | ${command} | ${cause} |`;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let workers;
  let url = process.env.PERF_URL || "";
  let concurrency = 10;
  let requests = 1000;
  let runs = 5;
  let warmup = 100;
  let key = process.env.PERF_API_KEY || "sk-mock-perf-key";
  let model = "perf-mock/gpt-4o-mini";
  let mode = "normal";
  let redisDown = false;
  let connectionMode = "keep-alive";
  let out = "";
  let envDesc = "";
  let dataDir = "";

  let i = 0;
  if (args.length > 0 && /^[0-9]+$/.test(args[0])) {
    workers = parseInt(args[0], 10);
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--workers" && i + 1 < args.length) {
      workers = parseInt(args[++i], 10);
    } else if (arg === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (arg === "--concurrency" && i + 1 < args.length) {
      concurrency = parseInt(args[++i], 10);
    } else if (arg === "--requests" && i + 1 < args.length) {
      requests = parseInt(args[++i], 10);
    } else if (arg === "--runs" && i + 1 < args.length) {
      runs = parseInt(args[++i], 10);
    } else if (arg === "--warmup" && i + 1 < args.length) {
      warmup = parseInt(args[++i], 10);
    } else if (arg === "--key" && i + 1 < args.length) {
      key = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === "--mode" && i + 1 < args.length) {
      mode = args[++i];
    } else if (arg === "--redis-down") {
      redisDown = true;
    } else if (arg === "--connection-mode" && i + 1 < args.length) {
      connectionMode = args[++i];
    } else if (arg === "--out" && i + 1 < args.length) {
      out = args[++i];
    } else if (arg === "--env" && i + 1 < args.length) {
      envDesc = args[++i];
    } else if (arg === "--data-dir" && i + 1 < args.length) {
      dataDir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: perf-ladder.sh <workers> [options]");
      process.exit(0);
    }
    i++;
  }

  if (workers === undefined || isNaN(workers) || workers < 1 || workers > 64) {
    throw new Error(`workers must be an integer between 1 and 64, got: ${workers}`);
  }
  if (connectionMode !== "keep-alive" && connectionMode !== "close") {
    throw new Error(`connection-mode must be 'keep-alive' or 'close', got: ${connectionMode}`);
  }

  return {
    workers,
    url,
    concurrency,
    requests,
    runs,
    warmup,
    key,
    model,
    mode: redisDown ? "degraded" : mode,
    redisDown,
    connectionMode,
    out,
    env: envDesc || `WSL2 ${os.cpus().length}c Bun ${typeof Bun !== "undefined" ? Bun.version : process.version}`,
    dataDir,
  };
}

export function sampleWorkerRss(workerPids) {
  if (!workerPids || workerPids.length === 0) return 0;
  let totalKb = 0;
  for (const pid of workerPids) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (match) {
        totalKb += parseInt(match[1], 10);
      }
    } catch {
      // process may have exited or /proc unavailable
    }
  }
  return Number((totalKb / 1024).toFixed(1));
}

export function sampleCpuStat() {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const firstLine = stat.split("\n")[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return { idle: 0, total: 0 };
  }
}

export function computeCpuUtilization(start, end) {
  if (!start || !end || end.total <= start.total) return 0;
  const totalDelta = end.total - start.total;
  const idleDelta = end.idle - start.idle;
  const usedDelta = totalDelta - idleDelta;
  return Number(((usedDelta / totalDelta) * 100).toFixed(1));
}

export async function runLoadPhase({
  url,
  key,
  model,
  requests,
  concurrency,
  connectionMode = "keep-alive",
  workerPids = [],
}) {
  const target = `${url.replace(/\/$/, "")}/v1/chat/completions`;
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "perf benchmark request" }],
    stream: false,
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    Connection: connectionMode === "close" ? "close" : "keep-alive",
  };

  let completed = 0;
  let errors = 0;
  const latencies = [];
  let peakRss = sampleWorkerRss(workerPids);

  const startCpu = sampleCpuStat();
  const startTime = performance.now();

  async function workerLoop() {
    while (true) {
      const current = completed;
      if (current >= requests) break;
      completed++;

      const t0 = performance.now();
      try {
        const res = await fetch(target, {
          method: "POST",
          headers,
          body: payload,
        });
        const elapsed = performance.now() - t0;
        if (res.ok) {
          latencies.push(elapsed);
        } else {
          errors++;
        }
        await res.text();
      } catch {
        errors++;
      }

      if (workerPids.length > 0 && completed % 20 === 0) {
        const currentRss = sampleWorkerRss(workerPids);
        if (currentRss > peakRss) peakRss = currentRss;
      }
    }
  }

  const workersList = [];
  for (let c = 0; c < concurrency; c++) {
    workersList.push(workerLoop());
  }
  await Promise.all(workersList);

  const totalTimeSec = (performance.now() - startTime) / 1000;
  const endCpu = sampleCpuStat();
  const cpuPct = computeCpuUtilization(startCpu, endCpu);
  const stats = computeStats(latencies);
  const throughput = totalTimeSec > 0 ? Number(((requests - errors) / totalTimeSec).toFixed(1)) : 0;

  return {
    requests,
    errors,
    p50_ms: stats.p50,
    p95_ms: stats.p95,
    p99_ms: stats.p99,
    mean_ms: stats.mean,
    req_per_s: throughput,
    rss_mb: peakRss,
    cpu_pct: cpuPct,
    duration_s: Number(totalTimeSec.toFixed(2)),
  };
}

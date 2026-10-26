#!/usr/bin/env bash
# ── Wave 8: Performance Ladder Load Driver (T021 / leaf-e-ladder) ────────────
# Loopback HTTP load runner for measuring L2 (single-replica) and L3 (multi-replica)
# performance ladder tiers against an ALREADY-RUNNING stack.
#
# Hard Invariants:
# - Loopback client only: drives load over HTTP via native Bun client loop.
# - NEVER invokes container management tools or engine rewrite (FR-009).
# - Outlier filtering: 5 measured runs x 1000 requests, drops high/low, median of 3.
# - Emits LadderRow conforming to data-model.md schema.
# - Refuses to certify (emits UNMEASURED with cause) if error rate >0.5%, CV >15%,
#   or if target server is unreachable.
#
# Usage:
#   scripts/perf-ladder.sh <1|2|4> [options]
#
# Options:
#   --url <base>          Target gateway base URL (default: http://127.0.0.1:20128)
#   --key <api key>       Gateway API key (default: $PERF_API_KEY or sk-mock-perf-key)
#   --model <model>       Model to query (default: perf-mock/gpt-4o-mini)
#   --out <file>          File to append LadderRow markdown to
#   --warmup <n>          Warmup request count (default: 100)
#   --requests <n>        Requests per measured run (default: 1000)
#   --runs <n>            Number of measured runs (default: 5)
#   --concurrency <n>     Concurrent client workers (default: 10)
#   --tier <L0|L1|L2|L3>  Ladder tier (default: L2 for 1 replica, L3 for 2+ replicas)
#   --mode <mode>         Run mode: normal | degraded (default: normal)
#   --env <env-str>       Execution environment description

REPLICAS="${1:-1}"

bun -e '
import { computeStats, computeCV, selectMedianRun, evaluateLadderCertification, formatLadderRow, formatLadderHeader } from "./scripts/perf-ladder-lib.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Parse command line arguments
const rawArgs = process.argv.slice(1);
// Filter out Bun flags like -e, script text, or --
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "-e" || a === "--") continue;
  if (i === 0 && (a.endsWith("bun") || a.includes("perf-ladder.sh"))) continue;
  args.push(a);
}

let replicas = 1;
let targetUrl = process.env.PERF_URL || "http://127.0.0.1:20128";
let apiKey = process.env.PERF_API_KEY || "sk-mock-perf-key";
let model = "perf-mock/gpt-4o-mini";
let outFile = "";
let warmupCount = 100;
let requestsPerRun = 1000;
let runCount = 5;
let concurrency = 10;
let tier = "";
let mode = "normal";
let envDesc = "";

let i = 0;
if (args.length > 0 && /^[0-9]+$/.test(args[0])) {
  replicas = parseInt(args[0], 10);
  i = 1;
}

while (i < args.length) {
  const arg = args[i];
  if (arg === "--replicas" && i + 1 < args.length) {
    replicas = parseInt(args[++i], 10);
  } else if (arg === "--url" && i + 1 < args.length) {
    targetUrl = args[++i];
  } else if (arg === "--key" && i + 1 < args.length) {
    apiKey = args[++i];
  } else if (arg === "--model" && i + 1 < args.length) {
    model = args[++i];
  } else if (arg === "--out" && i + 1 < args.length) {
    outFile = args[++i];
  } else if (arg === "--warmup" && i + 1 < args.length) {
    warmupCount = parseInt(args[++i], 10);
  } else if (arg === "--requests" && i + 1 < args.length) {
    requestsPerRun = parseInt(args[++i], 10);
  } else if (arg === "--runs" && i + 1 < args.length) {
    runCount = parseInt(args[++i], 10);
  } else if (arg === "--concurrency" && i + 1 < args.length) {
    concurrency = parseInt(args[++i], 10);
  } else if (arg === "--tier" && i + 1 < args.length) {
    tier = args[++i];
  } else if (arg === "--mode" && i + 1 < args.length) {
    mode = args[++i];
  } else if (arg === "--env" && i + 1 < args.length) {
    envDesc = args[++i];
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: scripts/perf-ladder.sh <1|2|4> [--url <url>] [--key <key>] [--model <model>] [--out <file>]");
    process.exit(0);
  }
  i++;
}

if (!tier) {
  tier = replicas > 1 ? "L3" : "L2";
}

if (!envDesc) {
  const cpus = os.cpus();
  const cpuModel = cpus?.[0]?.model || os.arch();
  const bunV = Bun.version || "1.4.3";
  envDesc = `${os.type()} ${os.arch()} host Bun ${bunV}`;
}

const commandRecord = `scripts/perf-ladder.sh ${replicas} --url ${targetUrl}`;

targetUrl = targetUrl.replace(/\/$/, "");
const endpoint = targetUrl.endsWith("/v1")
  ? `${targetUrl}/chat/completions`
  : targetUrl.includes("/v1/")
  ? targetUrl
  : `${targetUrl}/v1/chat/completions`;

const payload = {
  model,
  stream: true,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Ping" },
  ],
};
const payloadJson = JSON.stringify(payload);
const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${apiKey}`,
};

// 1. Probe connectivity
let targetReachable = true;
let unreachableCause = "";
let probeTimer;

try {
  const probeController = new AbortController();
  probeTimer = setTimeout(() => probeController.abort(), 5000);
  const probeRes = await fetch(endpoint, {
    method: "POST",
    headers,
    body: payloadJson,
    signal: probeController.signal,
  });
  if (probeRes.body) {
    const reader = probeRes.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }
} catch (err) {
  targetReachable = false;
  unreachableCause = `Target unreachable at ${endpoint}: ${err.message}`;
} finally {
  clearTimeout(probeTimer);
}

async function sendRequest() {
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payloadJson,
    });
    const ok = res.ok;
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    const duration = performance.now() - t0;
    return { ok, duration };
  } catch {
    const duration = performance.now() - t0;
    return { ok: false, duration };
  }
}

async function runWorkerPool(totalReqs, conc) {
  let started = 0;
  let completed = 0;
  let errorCount = 0;
  const latencies = [];
  const tStart = performance.now();

  async function worker() {
    while (true) {
      const current = started++;
      if (current >= totalReqs) break;
      const { ok, duration } = await sendRequest();
      latencies.push(duration);
      if (!ok) errorCount++;
      completed++;
    }
  }

  const workers = Array.from({ length: Math.min(conc, totalReqs) }, () => worker());
  await Promise.all(workers);
  const totalDurationSec = (performance.now() - tStart) / 1000;
  const reqPerSec = totalDurationSec > 0 ? Number((completed / totalDurationSec).toFixed(1)) : 0;

  return { latencies, completed, errorCount, reqPerSec };
}

let runResults = [];
let totalErrors = 0;
let totalRequests = 0;

if (targetReachable) {
  // 2. Warmup phase
  if (warmupCount > 0) {
    process.stderr.write(`[perf-ladder] Warming up with ${warmupCount} requests (C=${concurrency})...\n`);
    await runWorkerPool(warmupCount, concurrency);
  }

  // 3. Measured runs phase
  for (let r = 1; r <= runCount; r++) {
    process.stderr.write(`[perf-ladder] Run ${r}/${runCount}: sending ${requestsPerRun} requests (C=${concurrency})...\n`);
    const { latencies, completed, errorCount, reqPerSec } = await runWorkerPool(requestsPerRun, concurrency);
    const stats = computeStats(latencies);
    totalErrors += errorCount;
    totalRequests += completed;

    runResults.push({
      run: r,
      p50_ms: stats.p50,
      p95_ms: stats.p95,
      p99_ms: stats.p99,
      mean_ms: stats.mean,
      req_per_s: reqPerSec,
      errors: errorCount,
      completed,
    });
  }
}

// 4. Statistics, CV, and outlier filtering
const runMeans = runResults.map((r) => r.mean_ms);
const cv = computeCV(runMeans);
const medianRun = selectMedianRun(runResults, "mean_ms");
const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 1.0;

const certified = evaluateLadderCertification({
  medianRun,
  cv,
  errorRate,
  targetReachable,
  unreachableCause,
});

const ladderRowStr = formatLadderRow({
  tier,
  replicas,
  p50_ms: certified.p50_ms,
  p95_ms: certified.p95_ms,
  p99_ms: certified.p99_ms,
  req_per_s: certified.req_per_s,
  mode,
  cv_pct: `${cv.cv_pct}%`,
  errors: totalErrors,
  env: envDesc,
  command: commandRecord,
  cause: certified.cause,
});

process.stderr.write("\n=== Performance Ladder Results ===\n");
process.stderr.write(`Tier: ${tier} | Replicas: ${replicas} | Mode: ${mode}\n`);
process.stderr.write(`p50: ${certified.p50_ms} ms | p95: ${certified.p95_ms} ms | p99: ${certified.p99_ms} ms\n`);
process.stderr.write(`Throughput: ${certified.req_per_s} req/s | CV: ${cv.cv_pct}% (noisy: ${cv.noisy}) | Errors: ${totalErrors}\n`);
if (!certified.certified) {
  process.stderr.write(`[UNMEASURED] Certification refused: ${certified.cause}\n`);
}
process.stderr.write("==================================\n\n");

// Print LadderRow to stdout
console.log(ladderRowStr);

// Append to output file if requested
if (outFile) {
  try {
    const resolvedPath = path.resolve(outFile);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    if (!fs.existsSync(resolvedPath) || fs.readFileSync(resolvedPath, "utf8").trim().length === 0) {
      fs.writeFileSync(resolvedPath, `${formatLadderHeader()}\n${ladderRowStr}\n`, "utf8");
    } else {
      fs.appendFileSync(resolvedPath, `${ladderRowStr}\n`, "utf8");
    }
    process.stderr.write(`[perf-ladder] Written LadderRow to ${resolvedPath}\n`);
  } catch (err) {
    process.stderr.write(`[perf-ladder] Warning: Failed to write to ${outFile}: ${err.message}\n`);
  }
}
' -- "$@"

#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";

// Guarantee: Refuse if DATA_DIR resolves under production dir ~/.9router
function isRefusedDataDir(target) {
  if (!target) return false;
  const home = os.homedir();
  const prodDir = path.resolve(home, ".9router");
  const expanded = target.startsWith("~") ? path.join(home, target.slice(1)) : path.resolve(target);
  if (expanded === prodDir || expanded.startsWith(prodDir + path.sep)) return true;
  if (expanded.includes(".9router")) return true;
  return false;
}

if (isRefusedDataDir(process.env.DATA_DIR)) {
  console.error(`[FATAL] refusing production DATA_DIR: (${process.env.DATA_DIR}) resolves under ~/.9router`);
  process.exit(1);
}

// Create isolated temporary directory and export before importing DB modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-perf-l0-"));
process.env.DATA_DIR_ALLOW_TEMP = "1";
process.env.DATA_DIR = tempDir;
process.env.LOG_LEVEL = "ERROR";
process.env.NODE_ENV = "production";

export function computeStats(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const p = (q) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean,
  };
}

export function computeCV(values) {
  if (!values || values.length <= 1) {
    return { cv_pct: 0, noisy: false };
  }
  const n = values.length;
  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  if (mean === 0) return { cv_pct: 0, noisy: false };
  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const cvPct = (stdDev / mean) * 100;
  return {
    cv_pct: Number(cvPct.toFixed(2)),
    noisy: cvPct > 15,
  };
}

// Original uncached matchPattern implementation for comparison
function matchPatternUncached(pattern, model) {
  const regex = new RegExp(
    "^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i"
  );
  return regex.test(model);
}

// Original linear scan findModel implementation for comparison
const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);

function findModelLinear(models, modelId, aliasOrId, normalizeModelIdFn) {
  if (!models) return undefined;
  const baseModelId = typeof modelId === "string"
    ? modelId.replace(/\([^()]+\)\s*$/, "").trim()
    : modelId;
  const found = models.find(m => m.id === modelId || m.id === baseModelId);
  if (found) return found;
  if (!DOT_VERSION_PROVIDERS.has(aliasOrId)) return undefined;
  const normalized = normalizeModelIdFn(baseModelId);
  if (normalized === baseModelId) return undefined;
  return models.find(m => m.id === normalized);
}

async function runBenchmarkSync(name, tierLabel, nOps, batchFn, warmupBatches = 200, measuredBatches = 30) {
  // 200 warmup batches
  for (let b = 0; b < warmupBatches; b++) {
    batchFn(nOps);
  }

  // 30 measured batches
  const samplesUs = [];
  const samplesMs = [];
  for (let b = 0; b < measuredBatches; b++) {
    const t0 = performance.now();
    batchFn(nOps);
    const t1 = performance.now();
    const batchMs = t1 - t0;
    samplesUs.push((batchMs * 1000) / nOps);
    samplesMs.push(batchMs / nOps);
  }

  const statsUs = computeStats(samplesUs);
  const statsMs = computeStats(samplesMs);
  const cvInfo = computeCV(samplesUs);
  const p50Ms = statsMs.p50;
  const reqPerS = p50Ms > 0 ? Number((1000 / p50Ms).toFixed(1)) : 0;

  return {
    benchmark: name,
    tier_label: tierLabel,
    tier: "L0 micro",
    replicas: 1,
    ops_per_batch: nOps,
    warmup_batches: warmupBatches,
    measured_batches: measuredBatches,
    p50_us: Number(statsUs.p50.toFixed(4)),
    p95_us: Number(statsUs.p95.toFixed(4)),
    p99_us: Number(statsUs.p99.toFixed(4)),
    mean_us: Number(statsUs.mean.toFixed(4)),
    p50_ms: Number(p50Ms < 0.001 ? p50Ms.toFixed(5) : p50Ms.toFixed(4)),
    p95_ms: Number(statsMs.p95 < 0.001 ? statsMs.p95.toFixed(5) : statsMs.p95.toFixed(4)),
    p99_ms: Number(statsMs.p99 < 0.001 ? statsMs.p99.toFixed(5) : statsMs.p99.toFixed(4)),
    mean_ms: Number(statsMs.mean < 0.001 ? statsMs.mean.toFixed(5) : statsMs.mean.toFixed(4)),
    req_per_s: reqPerS,
    mode: "normal",
    cv_pct: cvInfo.cv_pct,
    noisy: cvInfo.noisy,
    errors: 0,
    cause: "-",
  };
}

async function runBenchmarkAsync(name, tierLabel, nOps, batchFn, warmupBatches = 200, measuredBatches = 30) {
  // 200 warmup batches
  for (let b = 0; b < warmupBatches; b++) {
    await batchFn(nOps);
  }

  // 30 measured batches
  const samplesUs = [];
  const samplesMs = [];
  for (let b = 0; b < measuredBatches; b++) {
    const t0 = performance.now();
    await batchFn(nOps);
    const t1 = performance.now();
    const batchMs = t1 - t0;
    samplesUs.push((batchMs * 1000) / nOps);
    samplesMs.push(batchMs / nOps);
  }

  const statsUs = computeStats(samplesUs);
  const statsMs = computeStats(samplesMs);
  const cvInfo = computeCV(samplesUs);
  const p50Ms = statsMs.p50;
  const reqPerS = p50Ms > 0 ? Number((1000 / p50Ms).toFixed(1)) : 0;

  return {
    benchmark: name,
    tier_label: tierLabel,
    tier: "L0 micro",
    replicas: 1,
    ops_per_batch: nOps,
    warmup_batches: warmupBatches,
    measured_batches: measuredBatches,
    p50_us: Number(statsUs.p50.toFixed(4)),
    p95_us: Number(statsUs.p95.toFixed(4)),
    p99_us: Number(statsUs.p99.toFixed(4)),
    mean_us: Number(statsUs.mean.toFixed(4)),
    p50_ms: Number(p50Ms < 0.001 ? p50Ms.toFixed(5) : p50Ms.toFixed(4)),
    p95_ms: Number(statsMs.p95 < 0.001 ? statsMs.p95.toFixed(5) : statsMs.p95.toFixed(4)),
    p99_ms: Number(statsMs.p99 < 0.001 ? statsMs.p99.toFixed(5) : statsMs.p99.toFixed(4)),
    mean_ms: Number(statsMs.mean < 0.001 ? statsMs.mean.toFixed(5) : statsMs.mean.toFixed(4)),
    req_per_s: reqPerS,
    mode: "normal",
    cv_pct: cvInfo.cv_pct,
    noisy: cvInfo.noisy,
    errors: 0,
    cause: "-",
  };
}

export async function runAllL0Benchmarks() {
  const cpus = os.cpus();
  const cpuModel = (cpus?.[0]?.model || "Host CPU").trim();
  const envDesc = `${cpuModel} host Bun ${Bun.version}`;
  const scriptCommand = "bun scripts/perf-l0-micro.mjs";

  // Dynamic imports after temp DATA_DIR configuration
  const { parseModel } = await import("../src/sse/services/model.js");
  const { matchPattern } = await import("../open-sse/providers/pricing.js");
  // HEAD has no exported findModel or Map index (T008 adds them); isValidModel is the HEAD lookup.
  const { isValidModel, PROVIDER_MODELS } = await import("../open-sse/config/providerModels.js");
  const { normalizeModelId } = await import("../open-sse/providers/models/schema.js");
  const {
    getModelAliases,
    setModelAlias,
    getComboByName,
    createCombo,
  } = await import("../src/lib/db/index.js");

  // Seed temp DB with alias and combo
  await setModelAlias("gpt-fast", "openai/gpt-4o-mini");
  await setModelAlias("claude-smart", "anthropic/claude-3-5-sonnet");
  await createCombo({
    name: "combo-chat",
    models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
  });

  const results = [];

  // 1. bun:sqlite prepared point lookup
  {
    const inMemDb = new Database(":memory:");
    inMemDb.run("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
    const insert = inMemDb.prepare("INSERT INTO kv VALUES (?, ?)");
    for (let i = 0; i < 1000; i++) insert.run(`key-${i}`, `val-${i}`);
    const lookup = inMemDb.prepare("SELECT v FROM kv WHERE k = ?");
    const keys = Array.from({ length: 1000 }, (_, i) => `key-${i}`);

    const res = await runBenchmarkSync(
      "bun:sqlite prepared point lookup",
      "**L0 micro** (sqlite point query)",
      10000,
      (n) => {
        for (let i = 0; i < n; i++) lookup.get(keys[i % 1000]);
      }
    );
    inMemDb.close();
    results.push({ ...res, env: envDesc, command: scriptCommand });
  }

  // 2. parseModel from src/sse/services/model.js
  {
    const modelsToParse = [
      "openai/gpt-4o-mini",
      "claude-3-5-sonnet",
      "anthropic/claude-3-5-sonnet-20241022",
      "xmtp/custom-model",
      "gemini/gemini-2.5-pro",
      "deepseek-reasoner",
    ];

    const res = await runBenchmarkSync(
      "parseModel string parser",
      "**L0 micro** (model string parser)",
      100000,
      (n) => {
        for (let i = 0; i < n; i++) parseModel(modelsToParse[i % modelsToParse.length]);
      }
    );
    results.push({ ...res, env: envDesc, command: scriptCommand });
  }

  // 3. matchPattern from open-sse/providers/pricing.js (cached vs uncached)
  {
    const patternPairs = [
      ["claude-sonnet-*", "claude-sonnet-4-5-20250929"],
      ["*-codex-mini", "openai-gpt-5-codex-mini"],
      ["gemini-*-flash", "gemini-3.8-flash"],
      ["o1-*", "o1-mini"],
      ["qwen*-coder-*", "qwen3-coder-32b"],
      ["deepseek-r*", "deepseek-r1"],
      ["gpt-5.*", "gpt-5.2-preview"],
      ["*-codex-high", "gpt-5.1-codex-high"],
    ];

    const resCached = await runBenchmarkSync(
      "matchPattern (cached)",
      "**L0 micro** (matchPattern cached)",
      100000,
      (n) => {
        for (let i = 0; i < n; i++) {
          const [p, m] = patternPairs[i % patternPairs.length];
          matchPattern(p, m);
        }
      }
    );
    results.push({ ...resCached, env: envDesc, command: scriptCommand });

    const resUncached = await runBenchmarkSync(
      "matchPattern (uncached comparison)",
      "**L0 micro** (matchPattern uncached comparison)",
      15000,
      (n) => {
        for (let i = 0; i < n; i++) {
          const [p, m] = patternPairs[i % patternPairs.length];
          matchPatternUncached(p, m);
        }
      }
    );
    results.push({ ...resUncached, env: envDesc, command: scriptCommand });
  }

  // 4. findModel Map lookup vs linear scan
  {
    const provider = "openai";
    const models = PROVIDER_MODELS[provider];
    const testModelIds = [
      "gpt-4o",
      "gpt-4o-mini",
      "o1-mini",
      "gpt-5.1-codex-max",
      "o3-mini",
      "gpt-4o-mini (high)",
      "non-existent-model",
    ];

    const resMap = await runBenchmarkSync(
      "isValidModel (HEAD linear find)",
      "**L0 micro** (isValidModel HEAD linear find)",
      200000,
      (n) => {
        for (let i = 0; i < n; i++) {
          isValidModel(provider, testModelIds[i % testModelIds.length]);
        }
      }
    );
    results.push({ ...resMap, env: envDesc, command: scriptCommand });

    const resLinear = await runBenchmarkSync(
      "findModelLinear reference (script copy)",
      "**L0 micro** (findModelLinear reference copy)",
      50000,
      (n) => {
        for (let i = 0; i < n; i++) {
          findModelLinear(models, testModelIds[i % testModelIds.length], provider, normalizeModelId);
        }
      }
    );
    results.push({ ...resLinear, env: envDesc, command: scriptCommand });
  }

  // 5. getModelAliases and getComboByName (direct DB reads: HEAD has no TTL cache, T0xx adds it)
  {
    const resAliases = await runBenchmarkAsync(
      "getModelAliases (direct DB read, no TTL cache at HEAD)",
      "**L0 micro** (getModelAliases direct read)",
      1500,
      async (n) => {
        for (let i = 0; i < n; i++) await getModelAliases();
      }
    );
    results.push({ ...resAliases, env: envDesc, command: scriptCommand });

    const resCombo = await runBenchmarkAsync(
      "getComboByName (direct DB read, no TTL cache at HEAD)",
      "**L0 micro** (getComboByName direct read)",
      1500,
      async (n) => {
        for (let i = 0; i < n; i++) await getComboByName("combo-chat");
      }
    );
    results.push({ ...resCombo, env: envDesc, command: scriptCommand });
  }

  return results;
}

function formatLadderMarkdownTable(results) {
  const header = "| tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = results.map((r) => {
    return `| ${r.tier_label} | ${r.replicas} | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} | ${r.req_per_s} | ${r.mode} | ${r.cv_pct}% | ${r.errors} | ${r.env} | \`${r.command}\` | ${r.cause} |`;
  });
  return [header, divider, ...rows].join("\n");
}

function formatDetailMarkdownTable(results) {
  const header = "| benchmark | N ops/batch | p50 (µs) | p95 (µs) | p99 (µs) | mean (µs) | CV (%) | noisy |";
  const divider = "|---|---|---|---|---|---|---|---|";
  const rows = results.map((r) => {
    return `| ${r.benchmark} | ${r.ops_per_batch} | ${r.p50_us} | ${r.p95_us} | ${r.p99_us} | ${r.mean_us} | ${r.cv_pct}% | ${r.noisy ? "YES" : "no"} |`;
  });
  return [header, divider, ...rows].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  let outFile = null;
  let jsonOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && i + 1 < args.length) outFile = args[++i];
    else if (args[i] === "--json") jsonOnly = true;
  }

  try {
    const results = await runAllL0Benchmarks();

    if (outFile) {
      const outDir = path.dirname(path.resolve(outFile));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
    }

    if (jsonOnly) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log("=== L0 Micro-Benchmarks (JSON Array) ===");
      console.log(JSON.stringify(results, null, 2));
      console.log("\n=== Master Ladder Table Rows ===");
      console.log(formatLadderMarkdownTable(results));
      console.log("\n=== Micro-Benchmark Microsecond Details ===");
      console.log(formatDetailMarkdownTable(results));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}

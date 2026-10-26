#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

// Hard Guarantee 1: Check DATA_DIR safety before anything else.
// Refuse if DATA_DIR resolves under ~/.9router or $HOME/.9router.
function isRefusedDataDir(target) {
  if (!target) return false;
  const home = os.homedir();
  const prodDir = path.resolve(home, ".9router");
  const expanded = target.startsWith("~") ? path.join(home, target.slice(1)) : path.resolve(target);
  if (expanded === prodDir || expanded.startsWith(prodDir + path.sep)) return true;
  if (expanded.includes(".9router")) return true;
  return false;
}

export function computeStats(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const p = (q) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return Number(sorted[idx].toFixed(4));
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / n).toFixed(4));
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean,
  };
}

export function computeCV(runMeans) {
  if (!runMeans || runMeans.length <= 1) {
    return { cv_pct: 0, noisy: false };
  }
  const n = runMeans.length;
  const mean = runMeans.reduce((acc, v) => acc + v, 0) / n;
  if (mean === 0) return { cv_pct: 0, noisy: false };
  const variance = runMeans.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const cvPct = (stdDev / mean) * 100;
  return {
    cv_pct: Number(cvPct.toFixed(2)),
    noisy: cvPct > 15,
  };
}

export function parseArgs(args) {
  const options = {
    label: "baseline",
    runs: 5,
    warmup: 100,
    requests: 1000,
    out: null,
    redis: "off",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--label" && i + 1 < args.length) options.label = args[++i];
    else if (arg === "--runs" && i + 1 < args.length) options.runs = parseInt(args[++i], 10);
    else if (arg === "--warmup" && i + 1 < args.length) options.warmup = parseInt(args[++i], 10);
    else if (arg === "--requests" && i + 1 < args.length) options.requests = parseInt(args[++i], 10);
    else if (arg === "--out" && i + 1 < args.length) options.out = args[++i];
    else if (arg === "--redis" && i + 1 < args.length) options.redis = args[++i];
  }
  return options;
}

export async function runHarness(argv = []) {
  if (isRefusedDataDir(process.env.DATA_DIR)) {
    console.error(`[FATAL] Refusing to run: DATA_DIR (${process.env.DATA_DIR}) resolves under production dir ~/.9router`);
    process.exit(1);
  }

  const options = parseArgs(argv);

  if (options.redis === "on" && !process.env.REDIS_URL) {
    console.error("[FATAL] --redis on requires REDIS_URL environment variable");
    process.exit(1);
  }

  // Create isolated temp DATA_DIR and export it BEFORE importing any DB modules
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-perf-data-"));
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  process.env.DATA_DIR = tempDir;
  // Suppress dev/debug logging to prevent console I/O from skewing timing
  process.env.LOG_LEVEL = "ERROR";
  process.env.NODE_ENV = "production";

  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // ignore git lookup errors in isolated environments
  }

  const cpus = os.cpus();
  const cpu_model = cpus?.[0]?.model || "unknown";
  const cpus_count = cpus?.length || 1;

  // Dynamic imports after DATA_DIR is exported
  const { getAdapter } = await import("../src/lib/db/driver.js");
  const adapter = await getAdapter();

  // DB Query tracking & per-phase query latency
  let queryCountingEnabled = false;
  let totalMeasuredQueries = 0;
  let activeRequestTimers = null;

  const origGet = adapter.get.bind(adapter);
  const origAll = adapter.all.bind(adapter);
  const origRun = adapter.run.bind(adapter);
  const origExec = adapter.exec.bind(adapter);

  function recordQuery(sql, duration) {
    if (!queryCountingEnabled) return;
    totalMeasuredQueries++;
    if (!activeRequestTimers) return;

    if (sql.includes("apiKeys")) {
      activeRequestTimers.auth_acl += duration;
    } else if (sql.includes("combos") || sql.includes("kv") || sql.includes("providerNodes") || sql.includes("providerConnections")) {
      activeRequestTimers.model_info += duration;
    } else {
      activeRequestTimers.dispatch_glue += duration;
    }
  }

  adapter.get = function(sql, ...args) {
    const t0 = performance.now();
    const res = origGet(sql, ...args);
    recordQuery(sql, performance.now() - t0);
    return res;
  };
  adapter.all = function(sql, ...args) {
    const t0 = performance.now();
    const res = origAll(sql, ...args);
    recordQuery(sql, performance.now() - t0);
    return res;
  };
  adapter.run = function(sql, ...args) {
    const t0 = performance.now();
    const res = origRun(sql, ...args);
    recordQuery(sql, performance.now() - t0);
    return res;
  };
  adapter.exec = function(sql, ...args) {
    const t0 = performance.now();
    const res = origExec(sql, ...args);
    recordQuery(sql, performance.now() - t0);
    return res;
  };

  // Seed DB with API key, combo, and provider connections
  const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
  const { createCombo } = await import("../src/lib/db/repos/combosRepo.js");
  const { createProviderConnection } = await import("../src/lib/db/repos/connectionsRepo.js");
  const { BaseExecutor } = await import("../open-sse/executors/base.js");
  const { handleChat } = await import("../src/sse/handlers/chat.js");
  const { register } = await import("../open-sse/translator/index.js");
  const { FORMATS } = await import("../open-sse/translator/formats.js");
  const { openaiToClaudeRequest } = await import("../open-sse/translator/request/openai-to-claude.js");
  const { claudeToOpenAIResponse } = await import("../open-sse/translator/response/claude-to-openai.js");

  const seededKey = await createApiKey("Perf Harness Key", "perf-harness-machine-01");
  await createProviderConnection({
    id: "conn-perf-openai",
    provider: "openai",
    authType: "apikey",
    name: "OpenAI Mock Connection",
    apiKey: "sk-mock-openai-key",
    isActive: true,
    priority: 1,
  });
  await createProviderConnection({
    id: "conn-perf-anthropic",
    provider: "anthropic",
    authType: "apikey",
    name: "Anthropic Mock Connection",
    apiKey: "sk-ant-mock-key",
    isActive: true,
    priority: 1,
  });
  await createProviderConnection({
    id: "conn-perf-compat",
    provider: "openai-compatible",
    authType: "apikey",
    name: "OpenAI-Compatible Mock Connection",
    apiKey: "sk-mock-compat-key",
    isActive: true,
    priority: 1,
  });
  await createCombo({
    name: "smart-combo",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3-5-sonnet"],
  });

  // Instrument translators to record translate_request and translate_response
  register(FORMATS.OPENAI, FORMATS.CLAUDE, function(model, body, stream, credentials) {
    const t0 = performance.now();
    try {
      return openaiToClaudeRequest(model, body, stream, credentials);
    } finally {
      if (activeRequestTimers) {
        activeRequestTimers.translate_request += (performance.now() - t0);
      }
    }
  }, null);

  register(FORMATS.CLAUDE, FORMATS.OPENAI, null, function(chunk, state) {
    const t0 = performance.now();
    try {
      return claudeToOpenAIResponse(chunk, state);
    } finally {
      if (activeRequestTimers) {
        activeRequestTimers.translate_response += (performance.now() - t0);
      }
    }
  });

  // In-process mock executor: makes no network calls, returns valid synthetic responses
  BaseExecutor.prototype.execute = async function({ model, body }) {
    const t0 = performance.now();
    try {
      const isAnthropic = this.provider === "anthropic";
      const sseData = isAnthropic
        ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_mock\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-3-5-sonnet\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Mock response\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        : "data: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Mock response\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

      return {
        response: new Response(sseData, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        url: isAnthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions",
        headers: { "content-type": "text/event-stream" },
        transformedBody: body,
      };
    } finally {
      if (activeRequestTimers) {
        activeRequestTimers.executor_mock += (performance.now() - t0);
      }
    }
  };

  // Workload mix templates: 40% direct, 40% translated with tools, 20% combo
  const makeRequest = (slot) => {
    let payload;
    if (slot < 4) {
      // 40% direct passthrough
      payload = {
        model: "openai/gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello, provide a quick status check." },
        ],
      };
    } else if (slot < 8) {
      // 40% cross-format translation with tools
      payload = {
        model: "anthropic/claude-3-5-sonnet",
        stream: true,
        messages: [
          { role: "system", content: "You are an assistant with calculation tools." },
          { role: "user", content: "Calculate 12 * 12." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "calculate",
              description: "Perform calculation",
              parameters: {
                type: "object",
                properties: { expr: { type: "string" } },
                required: ["expr"],
              },
            },
          },
        ],
      };
    } else {
      // 20% combo / alias resolution
      payload = {
        model: "smart-combo",
        stream: true,
        messages: [{ role: "user", content: "Combo request routing check." }],
      };
    }

    return new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${seededKey.key}`,
      },
      body: JSON.stringify(payload),
    });
  };

  try {
    // Warmup phase: prime JIT, DB schemas, connection state
    for (let w = 0; w < options.warmup; w++) {
      const req = makeRequest(w % 10);
      const res = await handleChat(req);
      await res.text();
    }
    // Allow any pending microtasks from warmup to settle
    await new Promise((r) => setTimeout(r, 10));

    // Measurement phase
    queryCountingEnabled = true;
    totalMeasuredQueries = 0;

    const allTotals = [];
    const allPhases = {
      auth_acl: [],
      model_info: [],
      translate: [],
      translate_request: [],
      translate_response: [],
      executor_mock: [],
      dispatch_glue: [],
      other: [],
    };
    const run_means_ms = [];

    for (let r = 0; r < options.runs; r++) {
      const runTotals = [];

      for (let i = 0; i < options.requests; i++) {
        activeRequestTimers = {
          auth_acl: 0,
          model_info: 0,
          translate_request: 0,
          translate_response: 0,
          executor_mock: 0,
          dispatch_glue: 0,
        };

        const req = makeRequest(i % 10);
        const t0 = performance.now();
        const res = await handleChat(req);
        if (!res.ok) {
          throw new Error(`Request failed with status ${res.status}`);
        }
        await res.text();
        const totalReq = performance.now() - t0;

        const translate = activeRequestTimers.translate_request + activeRequestTimers.translate_response;
        const measuredSum = activeRequestTimers.auth_acl +
          activeRequestTimers.model_info +
          activeRequestTimers.translate_request +
          activeRequestTimers.translate_response +
          activeRequestTimers.executor_mock +
          activeRequestTimers.dispatch_glue;
        const other = Math.max(0, totalReq - measuredSum);

        allTotals.push(totalReq);
        runTotals.push(totalReq);

        allPhases.auth_acl.push(activeRequestTimers.auth_acl);
        allPhases.model_info.push(activeRequestTimers.model_info);
        allPhases.translate.push(translate);
        allPhases.translate_request.push(activeRequestTimers.translate_request);
        allPhases.translate_response.push(activeRequestTimers.translate_response);
        allPhases.executor_mock.push(activeRequestTimers.executor_mock);
        allPhases.dispatch_glue.push(activeRequestTimers.dispatch_glue);
        allPhases.other.push(other);
      }

      // Allow microtasks to complete
      await new Promise((resolve) => setTimeout(resolve, 5));

      const runMean = runTotals.reduce((a, b) => a + b, 0) / runTotals.length;
      run_means_ms.push(Number(runMean.toFixed(4)));
    }

    const totalRequests = options.runs * options.requests;
    const db_queries_per_req = Number((totalMeasuredQueries / totalRequests).toFixed(2));
    const cvInfo = computeCV(run_means_ms);

    const phases_ms = {};
    for (const [phaseKey, values] of Object.entries(allPhases)) {
      phases_ms[phaseKey] = computeStats(values);
    }

    const profile = {
      schema: "khatam.perf.l1/1",
      label: options.label,
      git_sha: gitSha,
      bun_version: Bun.version,
      env: {
        cpu_model,
        cpus: cpus_count,
        node_env: process.env.NODE_ENV,
        redis: options.redis,
        data_dir: "temp",
      },
      workload: {
        requests: options.requests,
        warmup: options.warmup,
        runs: options.runs,
        mix: {
          direct: 0.4,
          translated: 0.4,
          tools: 0.4,
          combo: 0.2,
        },
      },
      phases_ms,
      total_ms: computeStats(allTotals),
      db_queries_per_req,
      run_means_ms,
      cv_pct: cvInfo.cv_pct,
      noisy: cvInfo.noisy,
    };

    if (options.out) {
      const outDir = path.dirname(path.resolve(options.out));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(options.out, JSON.stringify(profile, null, 2), "utf8");
      console.log(`Profile written to ${options.out}`);
      console.log(`L1 Summary: p50=${profile.total_ms.p50}ms, p95=${profile.total_ms.p95}ms, db_queries_per_req=${profile.db_queries_per_req}, CV=${profile.cv_pct}%`);
    } else {
      console.log(JSON.stringify(profile, null, 2));
    }

    console.log(`PERF_L1_OK ${options.label}`);
    return profile;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// CLI entrypoint execution guard
const isMain = (typeof Bun !== "undefined" && import.meta.main) ||
  (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));

if (isMain) {
  if (isRefusedDataDir(process.env.DATA_DIR)) {
    console.error(`[FATAL] Refusing to run: DATA_DIR (${process.env.DATA_DIR}) resolves under production dir ~/.9router`);
    process.exit(1);
  }
  runHarness(process.argv.slice(2)).catch((err) => {
    console.error("[FATAL] Harness error:", err);
    process.exit(1);
  });
}

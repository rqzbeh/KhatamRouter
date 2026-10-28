#!/usr/bin/env bash
# Vertical ladder load driver (T025 / leaf-e-ladder)
# Drives loopback load across 1, 2, 4, 6 vertical workers.
#
# Usage:
#   scripts/perf-ladder.sh <workers> [options]
#
# Options:
#   --url <url>              Target gateway URL (if omitted, boots a local cluster)
#   --concurrency <c>        Client concurrency loops (default: 10)
#   --requests <n>           Requests per measured run (default: 1000)
#   --runs <n>               Measured run iterations (default: 5)
#   --warmup <n>             Warmup requests before runs (default: 100)
#   --connection-mode <mode> keep-alive | close (default: keep-alive)
#   --redis-down             Point REDIS_URL at unreachable address (degraded mode)
#   --key <key>              Bearer API token (default: sk-mock-perf-key)
#   --model <model>          Target model (default: perf-mock/gpt-4o-mini)
#   --data-dir <dir>         Override temporary data directory
#   --out <file>             Append markdown table row to file
#   --json                   Print raw JSON result in addition to markdown

set -uo pipefail

WORKERS="${1:-}"
if [ -z "$WORKERS" ] || ! [[ "$WORKERS" =~ ^[0-9]+$ ]] || [ "$WORKERS" -lt 1 ] || [ "$WORKERS" -gt 64 ]; then
  echo "Usage: scripts/perf-ladder.sh <workers> [options]" >&2
  echo "  workers: 1..64" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

REAL_DB="$HOME/.9router"
BOOTED=0
GW_PID=""
MOCK_PID=""
TMP_DIR=""
PORT=""
MOCK_PORT=""
OUT_FILE=""
JSON_OUTPUT=0
URL=""
KEY="sk-mock-perf-key"
MODEL="perf-mock/gpt-4o-mini"
CONCURRENCY=10
REQUESTS=1000
RUNS=5
WARMUP=100
CONN_MODE="keep-alive"
REDIS_DOWN=0
OVERRIDE_DATA_DIR=""

args=("$@")
i=1
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --url)
      URL="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --concurrency)
      CONCURRENCY="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --requests)
      REQUESTS="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --runs)
      RUNS="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --warmup)
      WARMUP="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --connection-mode)
      CONN_MODE="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --redis-down)
      REDIS_DOWN=1
      ;;
    --key)
      KEY="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --model)
      MODEL="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --data-dir)
      OVERRIDE_DATA_DIR="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --out)
      OUT_FILE="${args[$((i+1))]}"
      i=$((i+1))
      ;;
    --json)
      JSON_OUTPUT=1
      ;;
  esac
  i=$((i+1))
done

if [ -n "$OVERRIDE_DATA_DIR" ]; then
  case "$OVERRIDE_DATA_DIR" in
    "$REAL_DB"*|*"/.9router"*)
      echo "refusing production DATA_DIR: $OVERRIDE_DATA_DIR resolves under ~/.9router" >&2
      exit 1
      ;;
  esac
fi

cleanup() {
  local rc=$?
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
    for c in $(pgrep -P "$GW_PID" 2>/dev/null); do kill -KILL "$c" 2>/dev/null || true; done
    kill -KILL "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pick_free_port() {
  local p attempt
  for attempt in $(seq 1 200); do
    p=$((31000 + RANDOM % 1000))
    if [ -z "$(ss -Htln "sport = :$p" 2>/dev/null)" ]; then
      echo "$p"
      return 0
    fi
  done
  echo "could not allocate free port in 31000-31999" >&2
  return 1
}

if [ -z "$URL" ]; then
  BOOTED=1
  TMP_DIR="$(mktemp -d /tmp/khatam-ladder-XXXXXX)"
  DATA_DIR="${OVERRIDE_DATA_DIR:-$TMP_DIR/data}"
  mkdir -p "$DATA_DIR"

  MOCK_PORT="$(pick_free_port)" || exit 1
  bun scripts/perf-mock-upstream.mjs --port "$MOCK_PORT" > "$TMP_DIR/mock.log" 2>&1 &
  MOCK_PID=$!

  for _ in $(seq 1 50); do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$MOCK_PORT/health" 2>/dev/null | grep -q "200"; then
      break
    fi
    sleep 0.1
  done

  bun scripts/perf-ladder-seed.mjs \
    --data-dir "$DATA_DIR" \
    --upstream "http://127.0.0.1:$MOCK_PORT/v1" \
    --prefix "perf-mock" \
    --model "gpt-4o-mini" \
    --combo "perf-combo" \
    --key "$KEY" > "$TMP_DIR/seed.log" 2>&1

  PORT="$(pick_free_port)" || exit 1
  URL="http://127.0.0.1:$PORT"

  ENV_VARS=(
    env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy
    DATA_DIR="$DATA_DIR"
    DATA_DIR_ALLOW_TEMP=1
    PORT="$PORT"
    KHATAM_WORKERS="$WORKERS"
  )

  if [ "$REDIS_DOWN" -eq 1 ]; then
    ENV_VARS+=(REDIS_URL="redis://127.0.0.1:59999")
  fi

  "${ENV_VARS[@]}" bun custom-server.js > "$TMP_DIR/gateway.log" 2>&1 &
  GW_PID=$!

  BOOT_OK=0
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null -w "%{http_code}" "$URL/api/health" 2>/dev/null | grep -q "200"; then
      BOOT_OK=1
      break
    fi
    if ! kill -0 "$GW_PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done

  if [ "$BOOT_OK" -ne 1 ]; then
    echo "Failed to boot gateway on $URL" >&2
    tail -n 30 "$TMP_DIR/gateway.log" >&2
    ROW="| Vertical ${WORKERS}-worker | ${WORKERS} | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | normal | 0% | 1 | host | scripts/perf-ladder.sh $WORKERS | failed to boot gateway |"
    echo "tier=Vertical ${WORKERS}-worker columns: p50/p95/p99 latency ms, throughput req/s"
    echo "$ROW"
    [ -n "$OUT_FILE" ] && echo "$ROW" >> "$OUT_FILE"
    exit 1
  fi
fi

CMD_STR="scripts/perf-ladder.sh ${WORKERS} --concurrency ${CONCURRENCY} --requests ${REQUESTS} --runs ${RUNS}"

RUNNER_SCRIPT="$(cat << 'EOF'
import { runLoadPhase, summarizeRuns, formatVerticalRow, parseArgs } from "./scripts/perf-ladder-lib.mjs";
import fs from "node:fs";

const rawArgs = process.argv.slice(1);
const filteredArgs = rawArgs[0] && (rawArgs[0].endsWith("bun") || rawArgs[0].endsWith("bun.exe"))
  ? rawArgs.slice(1)
  : rawArgs;
const args = parseArgs(filteredArgs);
const workerPidsStr = process.env.PERF_WORKER_PIDS || "";
const workerPids = workerPidsStr.split(",").map(Number).filter(Boolean);

let reached = false;
try {
  const probe = await fetch(`${args.url.replace(/\/$/, "")}/api/health`);
  reached = probe.ok;
} catch {
  reached = false;
}

if (!reached) {
  const row = formatVerticalRow({
    workers: args.workers,
    p50_ms: "UNMEASURED",
    p95_ms: "UNMEASURED",
    p99_ms: "UNMEASURED",
    req_per_s: "UNMEASURED",
    rss_mb: "UNMEASURED",
    mode: args.mode,
    cv_pct: "0%",
    errors: 1,
    env: args.env,
    command: process.env.PERF_CMD || "",
    cause: "target gateway unreachable",
  });
  console.log(row);
  if (args.out) {
    fs.appendFileSync(args.out, `${row}\n`);
  }
  process.exit(1);
}

if (args.warmup > 0) {
  await runLoadPhase({
    url: args.url,
    key: args.key,
    model: args.model,
    requests: args.warmup,
    concurrency: Math.min(args.concurrency, 4),
    connectionMode: args.connectionMode,
    workerPids,
  });
}

const runs = [];
for (let r = 0; r < args.runs; r++) {
  const res = await runLoadPhase({
    url: args.url,
    key: args.key,
    model: args.model,
    requests: args.requests,
    concurrency: args.concurrency,
    connectionMode: args.connectionMode,
    workerPids,
  });
  runs.push(res);
}

const summary = summarizeRuns(runs);
const mode = args.mode;

const row = formatVerticalRow({
  workers: args.workers,
  p50_ms: summary.p50_ms,
  p95_ms: summary.p95_ms,
  p99_ms: summary.p99_ms,
  req_per_s: summary.req_per_s,
  rss_mb: summary.rss_mb,
  mode,
  cv_pct: summary.cv_pct,
  errors: summary.errors,
  env: args.env,
  command: process.env.PERF_CMD || "",
  cause: summary.cause,
});

console.log(row);

if (process.env.PERF_EMIT_JSON === "1") {
  console.log(JSON.stringify({
    tier: `Vertical ${args.workers}-worker`,
    workers: args.workers,
    p50_ms: summary.p50_ms,
    p95_ms: summary.p95_ms,
    p99_ms: summary.p99_ms,
    req_per_s: summary.req_per_s,
    rss_mb: summary.rss_mb,
    mode,
    cv_pct: summary.cv_pct,
    errors: summary.errors,
    runs,
  }));
}

if (args.out) {
  fs.appendFileSync(args.out, `${row}\n`);
}

if (summary.invalid) {
  process.exit(1);
}
EOF
)"

WORKER_PIDS=""
if [ -n "$GW_PID" ]; then
  WORKER_PIDS="$(pgrep -P "$GW_PID" 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  if [ -z "$WORKER_PIDS" ]; then
    WORKER_PIDS="$GW_PID"
  fi
fi

DRIVER_ARGS=(
  "$WORKERS"
  --url "$URL"
  --concurrency "$CONCURRENCY"
  --requests "$REQUESTS"
  --runs "$RUNS"
  --warmup "$WARMUP"
  --connection-mode "$CONN_MODE"
  --key "$KEY"
  --model "$MODEL"
)

if [ "$REDIS_DOWN" -eq 1 ]; then
  DRIVER_ARGS+=(--redis-down)
fi
if [ -n "$OUT_FILE" ]; then
  DRIVER_ARGS+=(--out "$OUT_FILE")
fi

PERF_CMD="$CMD_STR" \
PERF_WORKER_PIDS="$WORKER_PIDS" \
PERF_EMIT_JSON="$JSON_OUTPUT" \
bun -e "$RUNNER_SCRIPT" -- "${DRIVER_ARGS[@]}"

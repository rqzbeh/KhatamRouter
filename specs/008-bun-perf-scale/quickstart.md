# Quickstart: Validate Wave 8 — Bun Hot-Path Slim and Vertical Scale

**Prerequisites**: Native Bun v1.4.3+, dependencies installed (`bun install && cd tests && bun install`).  
**Safety Invariant**: All benchmark commands automatically isolate databases using temporary `DATA_DIR` scratchpads. Production `~/.9router/` is never modified. Live Docker commands are executed exclusively by delegated container subagents (never the main agent, no prune commands).

---

## 1. Hot-Path Baseline Measurement (Before Any Code Change)

```bash
bun scripts/perf-l1-harness.mjs --label baseline --out /tmp/l1-baseline.json
# Expect output: PERF_L1_OK baseline
```

Inspect output telemetry:
- Verify `phases_ms` breakdown across `auth_acl`, `model_info`, `translate`, `dispatch_glue`.
- Verify `db_queries_per_req` baseline is recorded (reference target: ~15.2 queries/req on this tree).

---

## 2. Regression Guard (Run Before and After Every Code Change)

```bash
# Baseline snapshot checks
bun tests/__baseline__/verify-alias.mjs \
  && bun tests/__baseline__/verify-providers.mjs \
  && bun tests/__baseline__/verify-oauth-urls.mjs

# Golden translator and unit regression suite
cd tests && bun x vitest run \
  translator/golden-request.test.js \
  translator/golden-translator-concerns.test.js \
  translator/golden-url-header.test.js \
  translator/golden-response-stream.test.js \
  unit/capabilities.test.js \
  unit/key-access.test.js \
  unit/translator-request-normalization.test.js \
  unit/translator-helpers-edge.test.js
```

---

## 3. After Hot-Path Slimming (Re-landed Optimizations)

```bash
bun scripts/perf-l1-harness.mjs --label after-slim --out /tmp/l1-after.json
# Expect output: PERF_L1_OK after-slim
```

Verify:
- `db_queries_per_req` drops to $\le 11.0$ (reference historical target: 15.2 down to ~10.8, -29% reduction).
- p95 latency drops by $\ge 25\%$ (reference historical target: ~48% reduction).
- p50 latency reported honestly against Research D7 target (reference historical target: -24% to -29% reduction).

---

## 4. Run Multi-Worker Standalone Server

Start KhatamRouter on this host with 4 vertical worker processes sharing port 20128:

```bash
# Automatic core sizing: Math.max(1, nproc - 2)
KHATAM_WORKERS=4 PORT=20128 bun run start:bun
```

Verify:
- Primary process runs migrations once, then outputs: `[Cluster] Supervisor running on PID <pid>. Forking 4 workers on port 20128...`
- Worker 1 outputs: `[Worker 1] Leader role active (KHATAM_WORKER_ROLE=leader). Background token refresh + startup daemons registered.`
- Sibling workers output: `[Worker N] Ready (KHATAM_WORKER_ROLE=worker). Skipping leader-only background refresh + startup daemons.`
- Worker logs confirm `KHATAM_MIGRATIONS_DONE=1` observed (migration step skipped in every worker).

---

## 5. Vertical Smoke Validation (Host-Only)

```bash
# Validates port sharing, graceful stream drain, crash restart, and IPC invalidation
scripts/vertical-smoke.sh
```

Distribution reality (Bun 1.4.3): each worker binds its own `SO_REUSEPORT` socket, so the kernel hashes new TCP connections by 4-tuple. With `Connection: close` and enough requests the load spreads; the smoke oracle only requires **>= 2 distinct worker PIDs** (never exact per-worker evenness). `cluster.schedulingPolicy` is ignored by Bun.

---

## 6. Single-Container Multi-Worker Verification (Delegated Subagent Only)

```bash
# Verify the Dockerfile.bun image boots cleanly with multi-worker support inside one container
docker run --rm -d -p 20128:20128 -e KHATAM_WORKERS=2 --name kr-vertical-test khatamrouter:local
curl -f http://localhost:20128/api/health
docker stop kr-vertical-test
```

---

## 7. Vertical Ladder Benchmark Re-Run

Drive loopback load across ascending worker counts on THIS host:

```bash
# 1-worker baseline
scripts/perf-ladder.sh 1 --url http://127.0.0.1:20128 --concurrency 10

# 2-worker scaling
scripts/perf-ladder.sh 2 --url http://127.0.0.1:20128 --concurrency 20

# 4-worker scaling
scripts/perf-ladder.sh 4 --url http://127.0.0.1:20128 --concurrency 40

# 6-worker host capacity
scripts/perf-ladder.sh 6 --url http://127.0.0.1:20128 --concurrency 60
```

Record results in `specs/008-bun-perf-scale/ladder-results.md`.

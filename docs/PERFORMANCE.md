# Performance & Scale Guide (Wave 8)

This document provides an operational guide for reproducing, interpreting, and extending the performance and scaling benchmarks established in Wave 8 (`specs/008-bun-perf-scale`).

The complete, unabridged master benchmark ladder containing all measurement rows, hardware topologies, statistical distributions, and attribution logs is published at:
👉 [`specs/008-bun-perf-scale/ladder-results.md`](../specs/008-bun-perf-scale/ladder-results.md)

---

## 1. How to Run the Benchmark Tools

All benchmark scripts are native to the repository and execute under Bun v1.4.3+.

### 1.1 In-Process Micro-Benchmarks (L0)
Measures raw runtime operations in sub-microsecond isolation (SQLite prepared statement lookups, model string resolution, regex memoization, and repo cache reads):

```bash
bun scripts/perf-l0-micro.mjs
```

*Note: Uses an isolated temporary `DATA_DIR` automatically. Guarded to refuse execution if `DATA_DIR` points to production `~/.9router`.*

### 1.2 In-Process Gateway Harness (L1)
Executes end-to-end in-process requests through the full gateway routing and translation pipeline (`chatCore.js`, `chat.js`, SQLite repositories, RTK token compression) without network socket overhead:

```bash
# Run baseline or candidate evaluation (outputs summary percentiles and query counts)
bun scripts/perf-l1-harness.mjs --label after-slim --out results/l1-after.json
```

*Key options:*
- `--warmup <n>`: Warmup requests before measurement (default: 50).
- `--requests <n>`: Measured requests per run (default: 200).
- `--runs <n>`: Number of measurement iterations (default: 5).
- `--out <file>`: Save granular per-phase latency breakdown JSON.

### 1.3 Performance Ladder Load Driver (L2/L3 HTTP)
Drives closed-loop HTTP load against an already-running KhatamRouter instance or multi-replica cluster:

```bash
# Drive load against single-replica or cluster ingress (defaults to port 20128)
scripts/perf-ladder.sh 1 --url http://127.0.0.1:20128 --concurrency 10

# Test against the multi-replica Nginx load balancer
scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 20
```

*Key options:*
- `--concurrency <n>`: Concurrent worker loops (default: 10).
- `--requests <n>`: Requests per run (default: 1000).
- `--runs <n>`: Number of measured runs (default: 5, drops high/low and takes median of 3).
- `--key <key>`: API key (default: `sk-mock-perf-key`).

### 1.4 Mock Zero-Latency Upstream Server
Runs an ephemeral mock upstream server emulating OpenAI, Anthropic, and Gemini SSE streaming endpoints in ~0.5–1.0 ms:

```bash
bun scripts/perf-mock-upstream.mjs
```

### 1.5 Multi-Replica Compose Scale Overlay
Deploys a multi-instance KhatamRouter topology behind an Nginx round-robin ingress load balancer with shared Redis and SQLite state:

```bash
# Launch 2 gateway replicas with Nginx on port 30128
docker compose -f docker-compose.yml -f docker-compose.scale.yml up --scale 9router=2 -d

# Verify cluster synchronization and proxy IP preservation
scripts/scale-smoke.sh
```

---

## 2. Benchmark Artifacts Inventory

All raw measurement outputs and analysis reports from Wave 8 are committed in `specs/008-bun-perf-scale/results/`:

| Artifact Path | Description |
|---|---|
| `preflight.md` | Host hardware topology, OS kernel, CPU core counts, and baseline thermal validation. |
| `guard-before.txt` | Pre-slimming 27-provider regression guard test output. |
| `guard-after.txt` | Post-slimming 27-provider regression guard test output (0 functional regressions). |
| `l1-baseline.json` | Raw telemetry JSON from baseline pre-slim L1 harness run. |
| `l1-after.json` | Raw telemetry JSON from post-slim L1 harness run. |
| `l1-compare.md` | Detailed comparison of L1 in-process harness metrics against Research D7 targets. |
| `l1-hotspots.md` | Profiling trace and execution phase latency breakdown. |
| `ladder-host.md` | Host-tier benchmarks: L0 micro-benchmarks, L1 harness runs, same-session A/B runs, and L2 rationale. |
| `ladder-l3.md` | Container multi-replica benchmarks: 1, 2, and 4 replicas, Redis outage drill, attribution experiments, and controlled 3-repeat trials. |
| `scale-smoke.md` | Container smoke verification log validating round-robin load distribution, Redis Pub/Sub sync, and `X-Forwarded-For` preservation. |
| `../ladder-results.md` | Integrated master performance ladder synthesizing all tiers and defining the formal verdict. |

---

## 3. Honest Performance Verdict on Research D7 Targets

To preserve rigorous engineering integrity, benchmark outcomes are evaluated strictly against the Research D7 targets defined prior to implementation.

### 3.1 In-Process Latency & Query Reduction (L1 Tier)

| Metric | Baseline | Post-Slim (Same-Session) | Reduction Delta | D7 Target | Verdict |
|---|---|---|---|---|---|
| **p50 Latency** | 1.3505 – 1.3692 ms | 1.0123 – 1.0224 ms | **-24.29% to -26.07%** | $\ge 35.0\%$ lower | **MISSED TARGET** |
| **p95 Latency** | 4.8192 – 5.0413 ms | 2.5898 – 2.6440 ms | **-45.13% to -48.63%** | $\ge 25.0\%$ lower | **MET & EXCEEDED** |
| **Database Queries / Request** | 15.20 | 10.78 – 10.82 | **-29.08%** | Strict decrease | **MET** |
| **Stability (CV %)** | 5.39% – 6.33% | 9.48% – 10.18% | Controlled | $< 15.0\%$ noise ceiling | **MET** |

**Analysis & Findings**:
1. **Authoritative Same-Session A/B Comparison**: Alternating runs ($A_1 \to B_1 \to A_2 \to B_2$) in the same terminal session confirm that p50 latency dropped by **~24% to 29%**, missing the ambitious 35% target.
2. **p95 Tail Latency Win**: Tail latency was reduced by **~45% to 49%** (saving > 2.4 ms/req). This was driven by O(1) Map lookups in `findModel`, RegExp memoization in `matchPattern`, 5s TTL caches for aliases/combos/nodes, and request-scoped `keyRecord` reuse.
3. **Run 1 Warm-up Behavior**: Across all test series, Run 1 is consistently warm-up-high (~20–25% higher latency than runs 2–5) due to initial JavaScriptCore JIT compilation and connection pooling. Coefficient of variation (CV) remained tightly bounded between 9% and 11%, well below the 15% noise ceiling.

### 3.2 Multi-Replica Horizontal Scaling (L3 Tier)

| Configuration / Path | Comparison Pair | Mean Ratio | Min-Max Spread | D7 Target | Certification Verdict |
|---|---|---|---|---|---|
| **Shipped Nginx LB Overlay** | Controlled R3 ($2\times C=20$) / R1 ($1\times C=20$) | $\mathbf{1.58\times}$ | $[1.51\times, 1.65\times]$ | $\ge 1.60\times$ | **NOT CERTIFIED** (mean 1.58x, range 1.51–1.65x) |
| **Direct LB Bypass (Exploratory)** | Controlled R6 ($2\times C=20$) / R4b ($2\times C=10$) | $\mathbf{1.63\times}$ | $[1.57\times, 1.72\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** (not product path) |
| **Tuned Nginx Keepalive (Exploratory)** | Controlled R7 ($2\times C=20$) / R1 ($1\times C=20$) | $\mathbf{1.64\times}$ | $[1.55\times, 1.71\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** (not product path) |

**Analysis & Findings**:
1. **Shipped Product Path**: Under the shipped Nginx overlay configuration (`deploy/nginx-scale.conf`), 2-replica scaling achieved a mean throughput ratio of **1.58x** (310.2 req/s vs 196.1 req/s) with a spread of **1.51x–1.65x**.
   - **Verdict**: **NOT CERTIFIED (mean 1.58x, range 1.51–1.65x)**.
   - The mean is below the 1.60x target and the min-max spread straddles it. We do not write MET and do not write MISSED by a wide margin; we state factually that the target is not certified under the shipped configuration.
2. **Exploratory Variants Are NOT the Product Path**:
   - Direct-to-replica bypass (1.63x [1.57, 1.72]) and tuned Nginx keepalive (1.64x [1.55, 1.71]) also straddle 1.60x.
   - R6/R4b is not a perfectly matched concurrency pairing. None of the exploratory variants certifies the target.
3. **Nginx Variable `proxy_pass` Trade-Off**:
   - The shipped overlay employs dynamic DNS re-resolution via `set $khatam_upstream http://9router:20128; proxy_pass $khatam_upstream;` so scaled container replicas can register and deregister dynamically.
   - In Nginx, using a variable in `proxy_pass` prevents upstream HTTP keepalive connection pooling.
   - The connection churn costs approximately **4%** (R3 310.2 req/s vs R7 321.4 req/s) to **10%** (initial attribution) in throughput, with overlapping spreads.
   - This is reported as a modest, not precisely measured cost and an intentional architectural trade-off: dynamic DNS re-resolution is required for scaled replicas, whereas a static upstream with keepalive cannot dynamically discover scaled containers without external service mesh tooling.

---

## 4. Corrections to Earlier Claims & Live SQLite Fix

Two hypotheses from early benchmark passes were empirically tested and formally corrected:

### 4.1 Correction 1: Refutation of "Client Concurrency ($C=10$) is the Primary Limiter"
- **Earlier Claim**: The client load driver concurrency ($C=10$) was hypothesized to be the primary limiter capping multi-replica throughput below 1.60x.
- **Empirical Refutation**: Offered concurrency was quadrupled from $C=10$ to $C=40$. Throughput shifted by only **+1.6%** on 1 replica (183.5 $\to$ 186.5 req/s) and **+0.9%** on 2 replicas (273.4 $\to$ 275.9 req/s), while queueing latency quadrupled. In controlled follow-up trials, adding a second independent driver process shifted throughput by only **~1%**.
- **Correction**: The client driver was never the primary throughput bottleneck; the replicas were operating near capacity.

### 4.2 Correction 2: SQLite Write Contention & `BEGIN IMMEDIATE` Fix
- **Earlier Claim**: SQLite write contention was initially dismissed as a minor secondary factor because client HTTP requests returned 200 OK.
- **Empirical Discovery**: Investigation revealed **silent usage-row loss**: ~114 occurrences of `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` per ~5,000 requests caused background usage persistence to fail under concurrent write bursts. In default deferred transactions (`BEGIN DEFERRED`), multiple replicas acquire read locks simultaneously, then fail with `SQLITE_BUSY_SNAPSHOT` when attempting concurrent write lock upgrades.
- **Live Fix & Verification**: Commit `4375977f` implemented upfront write lock acquisition via `BEGIN IMMEDIATE` (`db.immediate()`) in `src/lib/db/repos/usageRepo.js` (`saveRequestUsage`).
- **Live Container Verification**: Tested under 3,000 concurrent streaming requests ($C=40$) across 2 replicas:
  - Logged occurrences of `SQLITE_BUSY`: **0** (down from 114).
  - Logged occurrences of `SQLITE_BUSY_SNAPSHOT`: **0** (down from 114).
  - Financial ledger persistence: **3,000 / 3,000 rows (100.0% integrity, 0 lost records)**.

---

## 5. Physical Environment Caveats & Boundary Conditions

1. **Single-Host Co-Location**:
   - The test client (`scripts/perf-ladder.sh`), Nginx load balancer, mock upstream server, and all `9router` replicas were co-located on a single physical host: AMD Ryzen 7 4800H (8 physical cores / 16 threads) under WSL2 Linux.
   - During 2-replica runs, active CPU utilization reached ~2.7–3.0 physical cores. Context switching and CPU cache thrashing on the shared host impact multi-replica scaling. Absolute numbers do not represent distributed production capacity.
2. **Ceiling Statement Boundary**:
   - The performance ceiling claim is strictly limited to this host: **the in-process gateway overhead per request dropped substantially (p95 reduced ~48%), but the end-to-end multi-replica throughput ceiling through Nginx on this host did not change by a certified amount (mean 1.58x vs target 1.60x)**.
3. **Mock Zero-Latency Upstream**:
   - The mock upstream server responds in ~0.5–1.0 ms with static JSON/SSE chunks. This benchmark measures the **pure overhead of the KhatamRouter gateway engine**, not real-world LLM provider latency.
4. **UNMEASURED Cells**:
   - **L2 Loopback (Single-Replica Host HTTP)**: Marked `UNMEASURED`. The host checkout lacks a prebuilt `.next/standalone` bundle because building it on the host would violate the CPU load < 1.0 test invariant, while running unbundled `dev:bun` incurs Webpack HMR compilation overhead. Standalone HTTP measurement was handed off to containerized L3.

---

## 6. Next Architectural Bottlenecks

Based on granular attribution profiling (`l1-after.json`) and container telemetry:

### 6.1 In-Process Latency Bottlenecks
1. **Gateway Dispatch Glue (~0.62 ms p50)**: Request orchestration, model routing resolution, combo expansion, format detection, and connection semaphores consume ~0.62 ms (> 60% of remaining p50 latency).
2. **Synchronous Post-Response Bookkeeping Writes (~0.16 ms p50)**: Synchronous calls to `insertRequestCostLedger` and `saveRequestUsage` execute unbatched writes on SQLite after streaming completes.
3. **Web Streams Machinery (~0.11 ms p50)**: `TransformStream` pipeline setup, chunk decoding, and `pipeWithDisconnect` impose a fixed runtime allocation floor of ~0.11 ms per streaming request.

### 6.2 Scaling Bottlenecks
1. **Per-Request CPU Consumption (~6–7 ms CPU-time per request)**: Each replica consumes ~5.2–6.9 ms of raw CPU core time per request, physically bounding a single CPU core at ~150 req/s.
2. **Nginx Upstream Connection Churn**: Lack of keepalive connection pooling in dynamic DNS `proxy_pass` adds connection handshake latency and burns additional Nginx CPU.
3. **Single Shared SQLite Writer Serialization**: While `BEGIN IMMEDIATE` resolved lock upgrade deadlocks and eliminated data loss, it forces all concurrent replica write transactions into serial queueing. Under intense write bursts, replica event loops can block waiting on the write lock up to `busy_timeout = 5000ms`. For larger scale clusters, asynchronous write batching or offloading usage logging to Redis/PostgreSQL is the next architectural frontier.

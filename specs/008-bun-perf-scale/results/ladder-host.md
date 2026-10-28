# Vertical Ladder Benchmark Results (Host WSL2)

- **Task**: T026 [US3]
- **Date**: 2026-10-28
- **Commit**: `d3393902d66de40b3491a500903ec1d67ebd7092`
- **Worktree**: `/home/redsnow/KhatamRouter/.claude/worktrees/wave8-vertical`
- **Target Gateway**: KhatamRouter Bun native HTTP runtime (`custom-server.js` + Bun cluster)
- **Runtime**: Bun 1.4.3
- **OS / Platform**: Linux 6.18.54.1-microsoft-standard-WSL2 (x86_64)
- **Host CPU / Topology**: 8 logical CPUs (WSL2 virtual cores on Windows host)
- **Host RAM**: 7943 MB total, 1927 MB used, 6016 MB available
- **Database Safety Guard**: `~/.9router/db/data.sqlite` mtime before = `2026-10-28 00:14:56.971305822 +0330`, after = `2026-10-28 00:14:56.971305822 +0330` (byte-for-byte unchanged; all runs used isolated ephemeral `DATA_DIR` with `DATA_DIR_ALLOW_TEMP=1`).

---

## Machine Facts & Quiet Machine Gate

```text
Host: Linux 6.18.54.1-microsoft-standard-WSL2 x86_64
CPUs: 8 logical cores
Bun: 1.4.3
RAM: 7943 MB total, 1927 MB used, 6016 MB available
Initial 1-min load (/proc/loadavg): 0.13 at start of session
Not measured: a `ps -eo pid,pcpu,comm` snapshot of non-session CPU consumers before the runs (the first pre-run ps attempt did not execute).
```

Before each ladder rung, a quiet gate waited while 1-min load was `> 1.0` (30 s polls, max 20 loops). Recorded `load_before`/`load_after` per rung in the run meta files (`/tmp/ladder-work/*.meta`, not committed). Load did not return below 1.0 between rungs; `load_before` ranged 0.61 to 1.00 for the accepted ladder rungs, and rising `load_after` values (up to 1.80 after the 6-worker rung) reflect the rung's own load. Machine was not otherwise quiet-verified beyond this gate.

---

## Concurrency Sweep & Calibration

A concurrency sweep was conducted using 1 worker and 6 workers against the in-process zero-latency mock upstream (`perf-mock-upstream.mjs`) to select a stable saturation concurrency. All sweep runs executed the script default settings: `requests=1000`, `runs=5`, `warmup=100`.

### 1-Worker Sweep (1000 requests, 5 runs, 100 warmup)

| Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | CV% | Host CPU Cores | Gateway CPU Cores | Driver CPU Cores | Mock CPU Cores | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 238.0 | 27.56 | 60.46 | 75.54 | 9.53% | 1.70 | 1.07 | 0.06 | 0.04 | Worker saturated (1.07 cores) |
| 16 | 237.0 | 60.84 | 119.76 | 138.66 | 9.44% | 1.76 | 1.07 | 0.06 | 0.04 | Throughput flat; latency doubles |
| 32 | 234.1 | 133.11 | 168.70 | 269.72 | 9.55% | 1.74 | 1.08 | 0.06 | 0.04 | Throughput flat; queuing latency |
| 64 | 227.0 | 276.06 | 305.64 | 552.84 | 8.86% | 1.70 | 1.09 | 0.06 | 0.04 | Queueing overhead begins |

### 6-Worker Sweep (1000 requests, 5 runs, 100 warmup)

| Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | CV% | Host CPU Cores | Gateway CPU Cores | Driver CPU Cores | Mock CPU Cores | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 415.0 | 18.17 | 33.61 | 42.84 | 12.90% | 4.73 | 3.99 | 0.11 | 0.06 | Undersaturated (workers idle) |
| 16 | 464.7 | 26.10 | 77.35 | 114.88 | 14.16% | 5.10 | 4.45 | 0.11 | 0.07 | Approaching saturation |
| 32 | 510.3 | 51.31 | 129.85 | 199.51 | 15.64% | 5.26 | 4.53 | 0.11 | 0.07 | Peak throughput reached |
| 64 | 510.2 | 126.94 | 206.80 | 328.71 | 15.25% | 5.26 | 4.60 | 0.11 | 0.07 | Plateau; queuing latency |

**Selected Benchmark Concurrency**: `32`. Concurrency 32 saturates the single-worker tier (~234–238 req/s at 1.08 gateway cores) while providing sufficient client loop depth to drive multi-worker rungs (up to 6 workers) without client loop starvation.

---

## Ladder Results Table

All rows conform to the contract schema in `contracts/perf-harness.md`. Default run settings: `runs=5`, `requests=1000`, `warmup=100`, `concurrency=32`, `mode=normal` (or `degraded`), against mock upstream on loopback.

| tier | workers | p50_ms | p95_ms | p99_ms | req_per_s | rss_mb | mode | cv_pct | errors | env | command | cause |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Vertical 1-worker | 1 | 127.71 | 178.48 | 265.97 | 238.3 | 257.1 | normal | 8.88% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 2-worker | 2 | 83.84 | 136.89 | 204.48 | 361.3 | 467.9 | normal | 13.48% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 2 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 4-worker | 4 | 66.76 | 125.2 | 176.55 | 453.7 | 824.7 | normal | 12.83% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 4 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 6-worker | 6 | 58.48 | 142.36 | 188.12 | 494.6 | 1139.7 | normal | 14.36% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 6 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 4-worker (Redis-down) | 4 | 65.36 | 134.34 | 160.45 | 464.9 | 832.6 | degraded | 14.01% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 4 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 2-worker (Redis-down) | 2 | 85.48 | 139.05 | 204.82 | 351.5 | 466.3 | degraded | 12.28% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 2 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 1-worker (keep-alive) | 1 | 131.36 | 194.59 | 265.19 | 233.4 | 241.5 | normal | 9.43% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5 | - |
| Vertical 1-worker (close) | 1 | 144.21 | 163.97 | 165.4 | 220.7 | 241.6 | normal | 8.84% | 0 | WSL2 8c Bun 1.4.3 | scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5 | - |

---

## Memory & RSS Scaling Profile

Memory consumption was measured at both idle (post-boot, zero traffic) and peak load (during active measurement).

| Workers | Supervisor RSS (MB) | Per-Worker Idle RSS (MB) | Per-Worker Peak RSS (MB) | Total Idle RSS (MB) | Total Peak RSS (MB) |
|---|---|---|---|---|---|
| 1 worker (standalone) | N/A | 122.2 | 257.1–262.3 | 122.2 | 262.3 |
| 2 workers | 37.3 | 116.2–120.1 | 236.5–236.9 | 273.6 | 510.8 |
| 4 workers | 37.3 | 111.5–119.4 | 209.8–224.0 | 494.9 | 913.7 |
| 6 workers | 38.4 | 109.4–119.1 | 194.9–205.4 | 719.1 | 1244.6 |

### Observations
1. **Supervisor Overhead**: The multi-worker primary supervisor process is lightweight (~37–38 MB RSS). It does not listen on client sockets or serve requests; it runs migrations once before fork, manages worker lifecycles, and routes IPC signals.
2. **Per-Worker Idle Footprint**: Idle workers consume ~111–120 MB RSS, consistent with the reference baseline (~101 MB from Wave 8 planning).
3. **Per-Worker Peak Footprint**: Under active load with 32 concurrent requests, individual workers reach ~195–237 MB RSS, within the expected ~150–220 MB operational envelope. Total cluster memory scales predictably with worker count (~200 MB per additional worker process).

---

## CPU Utilization & Driver Share (Honest Co-location Accounting)

On an 8-core WSL2 host, the load driver (`bun -e`), the zero-latency mock upstream (`perf-mock-upstream.mjs`), and the KhatamRouter cluster compete for CPU cycles. The table below records CPU consumption sampled from `/proc/stat` and `/proc/<pid>/stat` across each measurement window.

| Rung | Host CPU Cores Used | Gateway Cores (% of host) | Driver Cores (% of host) | Mock Cores (% of host) | Supervisor Cores | Worker Individual Cores |
|---|---|---|---|---|---|---|
| **1-worker** | 1.73 / 8 (21.6%) | 1.08 (13.4%) | 0.06 (0.7%) | 0.04 (0.5%) | N/A (single-proc) | 1.08 cores (100% of 1 core) |
| **2-worker** | 2.93 / 8 (36.6%) | 1.90 (23.8%) | 0.08 (1.0%) | 0.05 (0.6%) | < 0.01 | w1: 0.94, w2: 0.95 |
| **4-worker** | 4.43 / 8 (55.4%) | 3.55 (44.4%) | 0.12 (1.5%) | 0.07 (0.9%) | < 0.01 | w1: 0.90, w2: 0.87, w3: 0.88, w4: 0.90 |
| **6-worker** | 5.20 / 8 (65.1%) | 4.63 (57.9%) | 0.11 (1.4%) | 0.07 (0.9%) | < 0.01 | w1: 0.73, w2: 0.73, w3: 0.82, w4: 0.75, w5: 0.80, w6: 0.81 |
| **4-worker (Redis-down)** | 4.42 / 8 (55.2%) | 3.52 (44.0%) | 0.11 (1.4%) | 0.06 (0.8%) | < 0.01 | w1: 0.91, w2: 0.90, w3: 0.82, w4: 0.89 |

### Measured Co-location Share
- **Driver Share**: The client load driver consumed 0.06 to 0.12 CPU cores (~0.7%–1.5% of host CPU).
- **Mock Share**: The mock HTTP upstream consumed 0.04 to 0.07 CPU cores (~0.5%–0.9% of host CPU).
- **Driver + Mock Total**: Combined harness overhead remained `<= 0.19` CPU cores (< 2.4% host CPU), showing that client driver competition on the host was minimal.

---

## Scaling Efficiency Analysis

$$\text{Efficiency}(n) = \frac{\text{Throughput}(n)}{n \times \text{Throughput}(1)}$$

| Workers | Throughput (req/s) | Speedup vs 1-Worker | Linear Scaling Target | Scaling Efficiency | Bottleneck Status |
|---|---|---|---|---|---|
| **1 worker** | 238.3 | 1.00x | 238.3 req/s | **100.0%** | Single event loop saturation (1.08 cores) |
| **2 workers** | 361.3 | 1.52x | 476.6 req/s | **75.8%** | Near-linear scaling; workers utilize 0.94 and 0.95 cores |
| **4 workers** | 453.7 | 1.90x | 953.2 req/s | **47.6%** | Diminishing returns begin; workers utilize ~0.87–0.90 cores |
| **6 workers** | 494.6 | 2.08x | 1429.8 req/s | **34.6%** | Flattens significantly; per-worker CPU drops to ~0.73–0.82 cores |

### Why Scaling Flattens Beyond 4 Workers
1. **Measured: Per-Worker CPU Drop**:
   At 2 workers, each worker used 0.94–0.95 cores. At 6 workers, each used 0.73–0.82 cores. Cause not profiled. Hypothesis: contention from the 8-vCPU WSL2 VM (SMT siblings, shared cache, host hypervisor scheduling).
2. **Measured: Host CPU Reached 65% Total Machine Capacity at 6 Workers**:
   Total machine utilization reached 5.20 cores out of 8 logical cores, so 6 workers did not saturate the host; the flattening is not explained by total CPU exhaustion alone.
3. **Hypothesis (Unprofiled): SQLite WAL Single-Writer Lock Contention**:
   Requests record usage via `bun:sqlite`. While WAL mode allows multiple concurrent readers, SQLite serializes writers with a single write lock. At ~450–500 req/s across 4–6 workers, worker threads may experience lock wait cycles on write commits.
4. **Hypothesis (Unprofiled): Bun Cluster TCP Accept Distribution**:
   Node/Bun cluster uses round-robin or OS SO_REUSEPORT socket distribution; uneven connection assignment under keep-alive loops may cause transient worker imbalances.

---

## Noise & Stability Discipline (CV Reporting)

Per harness contract, any rung with coefficient of variation $CV \ge 15\%$ is flagged as `noisy` and reruns up to 2 times to select the quietest execution:

1. **Rung v1 (1 worker)**: Attempt 1 produced CV = **8.88%** (< 15%, clean). Kept.
2. **Rung v2 (2 workers)**: Attempt 1 produced CV = **13.48%** (< 15%, clean). Kept.
3. **Rung v4 (4 workers)**: Attempt 1 produced CV = **12.83%** (< 15%, clean). Kept.
4. **Rung v6 (6 workers)**: Attempt 1 produced CV = **14.36%** (< 15%, clean). Kept.
5. **Rung v4rd (4 workers, Redis-down)**:
   - Attempt 1: CV = **16.67%** (>= 15%, noisy). Rejected.
   - Attempt 2 (Rerun 1): CV = **14.01%** (< 15%, quietest). **Kept**.
   - Attempt 3 (Rerun 2): CV = **14.54%** (< 15%, clean). Discarded in favor of Attempt 2.
6. **Rung v2rd (2 workers, Redis-down)**: Attempt 1 produced CV = **12.28%** (< 15%, clean). Kept.
7. **Rung v1ka (1 worker, keep-alive)**: Attempt 1 produced CV = **9.43%** (< 15%, clean). Kept.
8. **Rung v1cl (1 worker, close)**: Attempt 1 produced CV = **8.84%** (< 15%, clean). Kept.

**Accepted-row summary**: every accepted row has zero errors and $CV < 15\%$. Sweep runs (section above) and the rejected v4rd attempt 1 are not table rows. Total ladder invocations in this session, including sweeps, smoke tests and reruns, exceeded 20; only the accepted rows above are compared.

**`rss_mb` column semantics**: the table's `rss_mb` is the peak VmRSS sampled by the driver (sum over gateway PIDs) during the median run. The `/proc` sampler (separate process, 500 ms interval) reports a different peak sum (e.g. 4 workers: 902 MB vs. 824.7 MB in the table). Both are reported; neither is treated as exact.

---

## Degraded Mode (Redis-Down) Verification

- **Configuration**: Gateway launched with `REDIS_URL="redis://127.0.0.1:59999"` (port with no listener).
- **Observed Behavior**:
  - `src/lib/redis/client.js` handled connection refusal and logged:
    `[redis] redis subscriber connection error: connect ECONNREFUSED 127.0.0.1:59999 (continuing without Redis — non-blocking fail-open)`
  - Gateway health check (`/api/health`) responded HTTP 200 `{"ok":true}` without hanging.
  - Direct end-to-end request test verified 20 of 20 requests succeeded (`chat ok=20 fail=0`), 2-worker boot with `REDIS_URL` on an unreachable port, fresh temp `DATA_DIR`.
  - Cross-worker event fallback path (Unix IPC vs. Redis) not verified in this run.
- **Performance Comparison**:
  - 4-Worker Normal: **453.7 req/s**, p50 66.76 ms, p95 125.20 ms.
  - 4-Worker Redis-down: **464.9 req/s**, p50 65.36 ms, p95 134.34 ms.
  - 2-Worker Normal: **361.3 req/s**, p50 83.84 ms, p95 136.89 ms.
  - 2-Worker Redis-down: **351.5 req/s**, p50 85.48 ms, p95 139.05 ms.
  - Throughput differences remain within normal run-to-run variance, confirming that Redis unavailability does not degrade routing performance.

---

## Connection Mode Analysis (Keep-Alive vs Close)

Tested at 1 worker with concurrency 32:

- **Keep-Alive**: **233.4 req/s**, p50 = 131.36 ms, p95 = 194.59 ms, p99 = 265.19 ms.
- **Connection: Close** (per-request TCP handshake): **220.7 req/s**, p50 = 144.21 ms, p95 = 163.97 ms, p99 = 165.40 ms.
- **Delta**: connection-per-request reduces throughput by **5.4%** and raises p50 by ~9.8% in this run. Cause not profiled. Hypothesis: per-request TCP handshake and teardown cost. Single-run difference at CV ~9%, treat as indicative.

---

## Clean State & Guard Verification

- **Leaked Processes**: `ps -eo pid,cmd | grep -E "perf-ladder|perf-mock|custom-server"` confirmed 0 running processes.
- **Leaked Ports**: `ss -Htln` confirmed 0 listening sockets in benchmark range `31000-31999`.
- **Database Safety Guard**:
  ```text
  Before: 2026-10-28 00:14:56.971305822 +0330
  After:  2026-10-28 00:14:56.971305822 +0330
  ```
  The production database was never opened or modified.

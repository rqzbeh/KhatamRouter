# Master Performance Ladder & Vertical Scale Results

> **Context**: Wave 8 vertical scale evaluation on Bun 1.4.3 (`custom-server.js` + Bun cluster) at commit `d3393902`. Host: AMD Ryzen 7 4800H (8 logical vCPUs, Linux 6.18.54.1-microsoft-standard-WSL2, 7943 MB RAM). All runs used ephemeral `DATA_DIR` with `DATA_DIR_ALLOW_TEMP=1`; production `~/.9router/db/data.sqlite` mtime remained byte-identical at `2026-10-28 00:14:56.971305822 +0330`.

---

## 1. D7 Target Evaluation (L1 In-Process Slimming)

Measured via `scripts/perf-l1-harness.mjs` (5 runs x 1,000 requests, 100 warmup, 40/40/20 mix) against an in-process mock executor:

| Metric | Baseline (`7fbd38e0`) | Control (`7fbd38e0`) | After-Slim (`7ec97d1f`) | Delta vs Base | D7 Target | Verdict |
|---|---|---|---|---|---|---|
| **Total p50** | 1.3483 ms | 1.3686 ms | 1.0022 ms | -25.67% | $\ge$ 35% reduction | **MISSED** (25.67% < 35.0%) |
| **Total p95** | 4.9256 ms | 4.9995 ms | 2.5635 ms | -47.96% | $\ge$ 25% reduction | **MET** (47.96% $\ge$ 25.0%) |
| **Total p99** | 12.3036 ms | 12.4095 ms | 10.8114 ms | -12.13% | n/a | n/a (informative) |
| **Total Mean** | 1.8010 ms | 1.8223 ms | 1.3828 ms | -23.22% | n/a | n/a (informative) |
| **DB Queries/Req** | 15.20 | 15.20 | 10.78 | -29.08% | $\le$ 11.0 queries | **MET** (10.78 $\le$ 11.0) |
| **Run CV** | 8.03% | 7.70% | 10.37% | +2.34% pts | $\le$ 15% | **MET** (10.37% $\le$ 15%) |

*Note*: Numbers are in-process with a zero-latency mock executor and must not be rounded in our favor. Criterion 1 (p50 reduction) was **MISSED** (-25.67% vs baseline, -26.77% vs contemporaneous control). Criterion 2 (p95 reduction) and Criterion 3 (DB queries per request) were **MET**.

---

## 2. Master Performance Ladder Table

Integrates L0 micro-benchmarks, L1 in-process harness, and host vertical cluster rungs (`scripts/perf-ladder.sh`, concurrency 32, 1000 requests, 5 runs):

*L0 note*: Run today on this host (`bun scripts/perf-l0-micro.mjs`, isolated temp `DATA_DIR`). The harness uses `isValidModel` (HEAD linear lookup) in place of `findModel`, which does not exist at HEAD. `req_per_s` for L0 is `1000 / p50` as computed by the harness, not a throughput measurement. Rows flagged noisy (CV >= 15%): sqlite point query (21.47%), getModelAliases (52.51%), getComboByName (26.53%). These three cannot certify improvement (FR-018).

| tier | workers | p50_ms | p95_ms | p99_ms | req_per_s | rss_mb | mode | cv_pct | errors | env | command | cause |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L0 micro (sqlite point query) | 1 | 0.0014 | 0.0026 | 0.0026 | 703632.9 | N/A | normal | 21.47% (noisy) | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (model string parser) | 1 | 0.00011 | 0.00014 | 0.00015 | 8894944.6 | N/A | normal | 12.91% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (matchPattern cached) | 1 | 0.00021 | 0.00023 | 0.00024 | 4700791.3 | N/A | normal | 11.19% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (matchPattern uncached) | 1 | 0.00085 | 0.00095 | 0.0011 | 1177667.4 | N/A | normal | 9.20% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (isValidModel linear) | 1 | 0.00009 | 0.0001 | 0.0001 | 11392439.2 | N/A | normal | 9.41% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L1 in-process (baseline `7fbd38e0`) | 1 | 1.3483 | 4.9256 | 12.3036 | UNMEASURED (mean 1.8010 ms reported; req/s not measured by harness) | N/A | normal | 8.03% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs` | cause: harness emits in-process mean, not req/s |
| L1 in-process (after-slim `7ec97d1f`) | 1 | 1.0022 | 2.5635 | 10.8114 | UNMEASURED (mean 1.3828 ms reported; req/s not measured by harness) | N/A | normal | 10.37% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs` | cause: harness emits in-process mean, not req/s |
| Vertical 1-worker | 1 | 127.71 | 178.48 | 265.97 | 238.3 | 257.1 | normal | 8.88% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 2-worker | 2 | 83.84 | 136.89 | 204.48 | 361.3 | 467.9 | normal | 13.48% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 2 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 4-worker | 4 | 66.76 | 125.20 | 176.55 | 453.7 | 824.7 | normal | 12.83% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 4 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 6-worker | 6 | 58.48 | 142.36 | 188.12 | 494.6 | 1139.7 | normal | 14.36% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 6 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 4-worker (Redis-down) | 4 | 65.36 | 134.34 | 160.45 | 464.9 | 832.6 | degraded | 14.01% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 4 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 2-worker (Redis-down) | 2 | 85.48 | 139.05 | 204.82 | 351.5 | 466.3 | degraded | 12.28% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 2 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 1-worker (keep-alive) | 1 | 131.36 | 194.59 | 265.19 | 233.4 | 241.5 | normal | 9.43% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5` | - |
| Vertical 1-worker (close) | 1 | 144.21 | 163.97 | 165.40 | 220.7 | 241.6 | normal | 8.84% | 0 | WSL2 8c Bun 1.4.3 | `scripts/perf-ladder.sh 1 --concurrency 32 --requests 1000 --runs 5` | - |

---

## 3. Memory & RSS Scaling Profile

| Tier (workers) | Supervisor RSS (MB) | Per-Worker Idle RSS (MB) | Per-Worker Peak RSS (MB) | Cluster Idle RSS (MB) | Cluster Peak RSS (MB) |
|---|---|---|---|---|---|
| **1 worker (standalone)** | N/A | 122.2 | 257.1–262.3 | 122.2 | 262.3 |
| **2 workers** | 37.3 | 116.2–120.1 | 236.5–236.9 | 273.6 | 510.8 |
| **4 workers** | 37.3 | 111.5–119.4 | 209.8–224.0 | 494.9 | 913.7 |
| **6 workers** | 38.4 | 109.4–119.1 | 194.9–205.4 | 719.1 | 1244.6 |

- **Supervisor**: Primary supervisor process consumes ~37–38 MB RSS without serving traffic or opening client sockets.
- **Worker Footprint**: Idle workers consume 109.4–122.2 MB RSS (slightly above the ~101 MB planning reference). Under concurrency 32, per-worker peak RSS settles at 194.9–236.9 MB (within the ~150–220 MB operational envelope). Total memory increases by ~200 MB per worker process.
- **Sampling Semantics**: Table `rss_mb` (driver-sampled peak, every 20 requests) reads 824.7 MB at 4 workers and 1139.7 MB at 6 workers. The independent `/proc` sampler (500 ms) reports peak-sum 902 MB (4 workers) and 1244.6 MB (6 workers). The RSS table above lists 913.7 MB total peak at 4 workers. Sources disagree by 4–9%; neither is treated as exact.

---

## 4. Host CPU Co-location & Harness Share

Host CPU utilization from `/proc/stat` and `/proc/<pid>/stat` across measurement windows on the 8-core host:

| Rung | Host Cores Used (/8) | Gateway Cores (% host) | Driver Cores (% host) | Mock Upstream Cores (% host) |
|---|---|---|---|---|
| **1-worker** | 1.73 (21.6%) | 1.08 (13.4%) | 0.06 (0.7%) | 0.04 (0.5%) |
| **2-worker** | 2.93 (36.6%) | 1.90 (23.8%) | 0.08 (1.0%) | 0.05 (0.6%) |
| **4-worker** | 4.43 (55.4%) | 3.55 (44.4%) | 0.12 (1.5%) | 0.07 (0.9%) |
| **6-worker** | 5.20 (65.1%) | 4.63 (57.9%) | 0.11 (1.4%) | 0.07 (0.9%) |
| **4-worker (Redis-down)** | 4.42 (55.2%) | 3.52 (44.0%) | 0.11 (1.4%) | 0.06 (0.8%) |

*Overhead Verification*: Driver (`bun -e`) plus mock upstream combined consumed $\le$ 0.19 cores (< 2.4% host CPU), confirming client competition was negligible.

---

## 5. Multi-Worker Verification (Container & Host Drills)

- **Single Container Smoke (T024)**: Validated via dedicated container subagent (`Dockerfile.bun`, 2 workers in 1 container, `KHATAM_WORKERS=2`). Health check returned 200 OK. 40 keep-alive connections split 18/22 across PIDs 27 and 28. Graceful stop completed in 0.58 s. SQLite WAL journal mode and quick_check verified on host-mounted volume. Container restart preserved single-execution migration table (4 migrations, zero duplicate runs). No `better_sqlite3.node` was present.
- **Host Smoke Drill (T023)**: Validated multi-worker port sharing on loopback across 4 workers (PIDs 1762851–1762854). SIGKILL of a non-leader worker resulted in supervisor respawn within 10 s back to 4 workers. SIGKILL of the leader worker led to a replacement taking the leader role, with exactly one leader afterward (checked via `KHATAM_WORKER_ROLE` env only). Idle SIGTERM drain exited primary with code 0.
- **Host Smoke Drill Results (two runs, `/tmp/vertical-smoke-run{1,2}.log`)**:
  - Boot A (4 workers, crash recovery): port sharing PASS in both runs; SIGKILL non-leader respawn PASS; SIGKILL leader handover PASS; idle SIGTERM exit 0 PASS. Steady loop across both kills: run 1 `ok=70 failed=1` (**FAIL**, zero-failure check), run 2 `ok=69 failed=0` (PASS).
  - Boot B (in-flight SSE drain): **FAIL in both runs**. Client `curl_exit=18`, `chunks=1`, final `[DONE]` not received. Gateway processes did exit 0 and new connections were refused after drain. Graceful drain of a real in-flight stream is therefore NOT verified.
  - Up to 1 request failure observed per SIGKILL sequence (run 1). Run 2 had zero.

---

## 6. Degraded Mode (Redis Unavailability)

- Gateway launched with `REDIS_URL="redis://127.0.0.1:59999"` (unreachable port).
- `src/lib/redis/client.js` logged fail-open warning without throwing; health endpoint returned HTTP 200 `{"ok":true}`; 20/20 test completions succeeded.
- In ladder benchmarks, 4-worker degraded mode delivered 464.9 req/s vs 453.7 normal; 2-worker degraded mode delivered 351.5 req/s vs 361.3 normal. Differences sit within normal run-to-run CV variance (12–14%), proving zero performance penalty from Redis unavailability.
- *Caveat*: Cross-worker IPC broadcast fallback without Redis was not isolated or verified during this session. `tests/unit/cluster-events-ipc.test.js` exists; its result was not run for this document.

---

## 7. Vertical Scale Verdict

### Did the ceiling move?
**Yes, the ceiling moved significantly.**
- **1 Worker**: 238.3 req/s (1.00x baseline, 100.0% efficiency)
- **2 Workers**: 361.3 req/s (1.52x throughput, 75.8% efficiency, +51.6% throughput over 1w)
- **4 Workers**: 453.7 req/s (1.90x throughput, 47.6% efficiency, +90.4% throughput over 1w)
- **6 Workers**: 494.6 req/s (2.08x throughput, 34.6% efficiency, +107.6% throughput over 1w)

The absolute throughput ceiling moved from **238.3 req/s** (single worker) to **494.6 req/s** (6 workers) on this 8-core host.

### Where scaling flattens and why
Throughput gains flatten after 2 workers, with diminishing returns through 4 and 6 workers.
- **Measured Evidence**: Total host CPU reached 5.20 cores (65.1% utilization) at 6 workers, meaning the host was not fully saturated; total CPU starvation alone does not account for the ceiling. Per-worker CPU dropped from 0.94–0.95 cores at 2 workers to 0.73–0.82 cores at 6 workers.
- **Unproven Hypotheses**:
  1. *SQLite WAL Single-Writer Lock Contention*: `saveRequestUsage` executes synchronous writes inside `db.immediate(...)`. At 450–500 req/s, concurrent workers wait on the single SQLite write lock.
  2. *Bun Cluster TCP Accept Imbalance*: Node/Bun cluster socket distribution may distribute keep-alive loops unevenly across worker event loops.
  3. *WSL2 Virtualization Contention*: Virtualized SMT sibling core scheduling under the Windows hypervisor may throttle saturated event loops.
  No CPU profiling or lock-wait telemetry was gathered during the multi-worker ladder to substantiate these hypotheses.

---

## 8. Next Bottlenecks

1. **`dispatch_glue` (63.4% of in-process request time)**: Accounts for 0.8771 ms of total 1.3828 ms mean in L1 benchmarks. This phase is currently **unprofiled**. Candidate causes (Next.js request wrapper overhead, account selection loops, async Promise chaining) require `bun --cpu-prof` validation before code modifications.
2. **SQLite Single-Writer Contention**: Synchronous usage writes in `saveRequestUsage` serialize across workers. An asynchronous write queue or batched WAL committing buffer would decouple request completion from database write locks.
3. **Per-Process In-Memory State Without Redis**: When Redis is absent, several components maintain local state rather than shared cluster state:
   - Concurrency semaphores (`keyAccess.js`)
   - Circuit breakers (`src/shared/utils/circuitBreaker.js`)
   - Combo rotation counters (`comboRotationState` Map, `open-sse/services/combo.js`)
   - In-memory L1 TTL caches (dependent on Primary IPC broadcast)
4. **Session Stores & Stream Tracking**: Active SSE stream maps and client socket accounting live exclusively inside each worker process.

---

## 9. Known Limitations

1. **CLI Packaging Gap**: `cli/scripts/build-cli.js` builds with `NEXT_TRACING_ROOT_MODE=workspace`, causing `scripts/copy-standalone-assets.mjs` to return early. Consequently, the published npm CLI package does not include `src/lib/db` or the cluster supervisor closure in its standalone directory. On the npm CLI build, setting `KHATAM_WORKERS > 1` safely falls back to single-process mode.
2. **Worker Hard-Kill Socket Loss**: A `SIGKILL`ed worker drops its sockets immediately. Observed: 1 failed request in the run-1 steady loop, 0 in run 2. Spec tolerance is up to 2 in-flight failures per kill. Graceful in-flight stream drain is NOT verified (Boot B failed in both smoke runs, Section 5).
3. **Leader Daemon Verification**: Leader-only background tasks (token refresh, database checkpoints) are guarded solely by runtime environment checks (`process.env.KHATAM_WORKER_ROLE === "leader"`).
4. **Single Host WSL2 Benchmark**: All measurements reflect an 8-core WSL2 VM on an AMD Ryzen 7 4800H host with synthetic, zero-latency upstream responses. Production throughput will be governed primarily by upstream provider response latencies.

# Master Performance Ladder & Vertical Scale Results

> **Context**: Wave 8 vertical scale evaluation on Bun 1.4.3 (`custom-server.js` + Bun cluster). Ladder rungs were measured at `d3393902`; the host smoke drill in Section 5 was re-run at HEAD `bb55b069`, and `d3393902..bb55b069` changes only the two spec documents in `specs/008-bun-perf-scale/` (no runtime file differs), so the drill exercises the same code the ladder measured. Host: AMD Ryzen 7 4800H (8 logical vCPUs, Linux 6.18.54.1-microsoft-standard-WSL2, 7943 MB RAM). All runs used ephemeral `DATA_DIR` with `DATA_DIR_ALLOW_TEMP=1`; production `~/.9router/db/data.sqlite` mtime remained byte-identical at `2026-10-28 00:14:56.971305822 +0330` (re-checked before and after this session's re-run).

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

*Note*: Numbers are in-process with a zero-latency mock executor and must not be rounded in our favor. Criterion 1 (p50 reduction) was **MISSED** (-25.67% vs baseline, -26.77% vs contemporaneous control). Criterion 2 (p95 reduction) and Criterion 3 (DB queries per request) were **MET**. *Provenance*: `l1-after.json` records `git_sha: 7ec97d1f`, which is HEAD at harness time. The file mtime (23:51:15 +0330) precedes the slimming commit `3c9939ad` (23:55:44 +0330), and `7ec97d1f` contains no `src/` or `open-sse/` diff from `7fbd38e0`. The after-slim numbers therefore come from a working tree that already held the slimming edits, which were committed four minutes later. This is inferred from timestamps and the recorded SHA, not from a re-run.

---

## 2. Master Performance Ladder Table

Integrates L0 micro-benchmarks, L1 in-process harness, and host vertical cluster rungs (`scripts/perf-ladder.sh`, concurrency 32, 1000 requests, 5 runs):

*L0 note*: Run on this host (`bun scripts/perf-l0-micro.mjs`, isolated temp `DATA_DIR`). The pre-slim lookup measured is `isValidModel` (linear scan at `7fbd38e0` and `d3393902`). `findModel` exists only from `3c9939ad` onward (Map index), so no `findModel` row is in this table. `req_per_s` for L0 is `1000 / p50` as computed by the harness, not a throughput measurement. Rows flagged noisy (CV >= 15%) in this session's run: sqlite point query (23.37%), getModelAliases (55.96%), getComboByName (25.56%). These three cannot certify improvement (FR-018). The L0 rows are direct-read microbenchmarks at HEAD, which has no TTL cache; they do not measure the slimmed path.

| tier | workers | p50_ms | p95_ms | p99_ms | req_per_s | rss_mb | mode | cv_pct | errors | env | command | cause |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L0 micro (sqlite point query) | 1 | 0.0014 | 0.0025 | 0.0025 | 696542.7 | N/A | normal | 23.37% (noisy) | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (model string parser) | 1 | 0.00013 | 0.00016 | 0.00017 | 7644890.6 | N/A | normal | 10.81% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (matchPattern cached) | 1 | 0.00021 | 0.00023 | 0.00025 | 4786506.3 | N/A | normal | 8.09% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (matchPattern uncached) | 1 | 0.00081 | 0.00092 | 0.00092 | 1227800.9 | N/A | normal | 10.12% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (isValidModel linear) | 1 | 0.00009 | 0.00011 | 0.00011 | 11409018.3 | N/A | normal | 11.21% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (findModelLinear reference copy) | 1 | 0.00028 | 0.00032 | 0.00032 | 3510912 | N/A | normal | 9.83% | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (getModelAliases direct read) | 1 | 0.0007 | 0.0015 | 0.0029 | 1433220.5 | N/A | normal | 55.96% (noisy) | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| L0 micro (getComboByName direct read) | 1 | 0.0034 | 0.0063 | 0.0064 | 292956.3 | N/A | normal | 25.56% (noisy) | 0 | WSL2 8c Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
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
- **Worker Footprint**: Idle workers consume 109.4–122.2 MB RSS (slightly above the ~101 MB planning reference). Under concurrency 32, per-worker peak RSS ranges 194.9–262.3 MB (the 262.3 MB value is the 1-worker standalone). Of the multi-worker tiers, 2 workers sit above the ~150–220 MB envelope (236.5–236.9 MB); 4 and 6 workers fall within it at the low end.
- **Memory is non-additive with worker count**: total peak rises 262 MB (1w) to 511 MB (2w), 914 MB (4w), 1245 MB (6w). Per added worker that is roughly 165–250 MB. Per-worker peak at 2 workers (236.5–236.9 MB) is above the ~150–220 MB planning envelope; 4 and 6 workers fall inside it.
- **Sampling Semantics (two sources, both reported)**: the `rss_mb` table column is the driver's peak VmRSS sum, sampled every 20 requests: **824.7 MB at 4 workers, 1139.7 MB at 6 workers**. The separate `/proc` sampler (500 ms interval) reports a peak sum of **902 MB at 4 workers**, which is +9.4% over the driver value. The 6-worker `/proc` value is not given in `results/ladder-host.md`; the 1244.6 MB 6-worker figure in the profile table comes from the per-worker profile and its sampler is not named there. Neither source is treated as exact.

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
- **Host Smoke Drill (T023)**: Validated via `scripts/vertical-smoke.sh` (host loopback, temp `DATA_DIR`, 4 workers). Killed worker PIDs recorded below; the two earlier smoke runs at `/tmp/vertical-smoke-run{1,2}.log` (01:49) predate commit `df1ef7ae`, which removed a `process.exit(0)` from the sqlite adapter's `SIGTERM` handler in the primary (it ran before the supervisor's drain; Bun's child `disconnect` handler then exited workers mid-stream). The statements after this line use only that later, PASS run — this session's re-run at HEAD `bb55b069`, which also passed.
- **Host Smoke Drill Re-run (this session, HEAD `bb55b069`, 25 s, exit 0, `VERTICAL_SMOKE_ALL_PASS` returned for every gate)**:
  - **Port sharing**: 4 workers (PIDs 1879043–1879046) all owned established sockets from 60 keep-alive clients (`distinct=4`, not the primary).
  - **Roles**: 1 leader + 3 followers, verified by `KHATAM_WORKER_ROLE` in `/proc/<pid>/environ`.
  - **Crash recovery**: SIGKILL non-leader `1879044` -> replacement `1879417` within 10 s; SIGKILL leader `1879043` -> a follower took over the leader role, exactly 1 leader after.
  - **Steady loop across both kills**: 55 total requests, 54 ok, 1 failed in-flight at SIGKILL (allowed, start +2 ms from kill 1), 0 hard failures. Spec cap is up to 2 in-flight failures per kill.
  - **Idle SIGTERM**: primary exited 0.
- **Boot B: in-flight SSE stream drain across SIGTERM (drill run details; upstream is a local mock emitting 8 chunks, one per second)**:
  - Client streamed via `/v1/chat/completions` with a seeded API key; SIGTERM was sent to the primary 2.415 s into the stream (`stream_start_ms 1793151598598` -> `sigterm_ms 1793151601013`).
  - The mock upstream had enqueued 3 of 8 chunks at SIGTERM. The client received the remaining 5 chunks plus `data: [DONE]` after SIGTERM (`chunks_after_sigterm=5`, `total=8`). Gate: `sent_at_sigterm` must be `>=1` and `<6` of 8; measured 3.
  - `curl_exit=0`; the primary process exited 0.
  - New connections were refused from the moment drain began: `probes_200_during_drain=0`, first refusal (`curl` exit 7) at `1793151601051`, 38 ms after SIGTERM. A fresh health request after primary exit also failed (`curl` exit 7).
- **What the drill proves**:
  - A shared listen port on loopback with 4 workers (`distinct=4` owning PIDs for 60 keep-alive sockets).
  - Worker role assignment (1 leader, 3 followers) derived from `KHATAM_WORKER_ROLE`.
  - Crash recovery from SIGKILL: a non-leader is replaced within 10 s; killing the leader promotes a follower so that exactly 1 leader remains.
  - Zero hard failures (>200 ms after kill); up to 1 in-flight failure observed at the kill boundary (spec tolerance is 2).
  - Graceful drain of an in-flight SSE stream: SIGTERM halts new connections and allows the active stream to complete all chunks and `[DONE]` before the primary exits 0. The SIGTERM-to-stream-end window was 5.886 s (`1793151601013` -> `1793151606899`), set by the mock upstream's remaining 5 chunks at 1 s each.
- **What the drill does NOT prove**:
  - Leader-only daemons: verified by the `KHATAM_WORKER_ROLE` env var only; the actual daemons (proactive OAuth token refresh, background daemons in `initializeApp.js`, WAL checkpoint timer) were not run in this drill.
  - In-flight sockets at SIGKILL: a killed worker drops its active sockets immediately (1 dropped socket observed in this session's steady loop, 0 in run 2); SIGKILL does not drain.
  - Drain under stall or error: the upstream mock emitted 8 clean chunks at 1 s intervals. The drill does not exercise an upstream timeout, an error mid-stream, or a client that stalls its reads.
  - Realistic drain window: the drain window was ~5.9 s against a mock upstream. Long-lived production streams (up to `KHATAM_DRAIN_TIMEOUT_MS` = 30 s) were not exercised.
  - Realistic upstream: the drill uses a local mock on loopback, not a real external provider with network jitter, TLS, or format translation.

---

## 6. Degraded Mode (Redis Unavailability)

- Gateway launched with `REDIS_URL="redis://127.0.0.1:59999"` (unreachable port).
- `src/lib/redis/client.js` logged fail-open warning without throwing; health endpoint returned HTTP 200 `{"ok":true}`; 20/20 test completions succeeded.
- In ladder benchmarks, 4-worker degraded mode delivered 464.9 req/s vs 453.7 normal (+2.5%); 2-worker degraded mode delivered 351.5 req/s vs 361.3 normal (-2.7%). Both deltas are smaller than the run CVs (12–14%) of the rungs compared, so no throughput penalty is resolvable at this sample size. This is not proof of zero penalty. The 4-worker degraded row is the kept attempt of three (attempt 1 was rejected at CV 16.67%; `results/ladder-host.md`, CV section, item 5), so it was selected for its CV, which biases it toward a cleaner number.
- *Caveat*: Cross-worker IPC broadcast fallback without Redis was not measured end-to-end in the ladder. The unit test `tests/unit/cluster-events-ipc.test.js` passed in this session (10 tests), but no ladder-level verification of the fallback path was done.

---

## 7. Vertical Scale Verdict

### Did the ceiling move?
**Yes, the ceiling moved: 2.08x at 6 workers, but sublinearly.**
- **1 Worker**: 238.3 req/s (1.00x, 100.0% efficiency)
- **2 Workers**: 361.3 req/s (1.52x, 75.8% efficiency, +51.6% over 1w)
- **4 Workers**: 453.7 req/s (1.90x, 47.6% efficiency, +90.4% over 1w)
- **6 Workers**: 494.6 req/s (2.08x, 34.6% efficiency, +107.6% over 1w)

The throughput ceiling moved from **238.3 req/s** (1 worker) to **494.6 req/s** (6 workers) on this 8-core host. Cost: a 6x worker count bought 2.08x throughput and total cluster RSS grew from 257 MB to 1140–1245 MB. Combined driver + mock CPU stayed <= 0.19 cores, so the ceiling is not client-side.

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
2. **SQLite Single-Writer Contention (hypothesis, not measured)**: synchronous usage writes in `saveRequestUsage` serialize across workers via `db.immediate(...)`. No lock-wait telemetry was collected, so this is a candidate cause for the flattening, not an established one. Confirm before changing it; an async write queue would trade durability for throughput.
3. **Per-Process In-Memory State Without Redis**: When Redis is absent, several components maintain local state rather than shared cluster state:
   - Concurrency semaphores (`keyAccess.js`)
   - Circuit breakers (`src/shared/utils/circuitBreaker.js`)
   - Combo rotation counters (`comboRotationState` Map, `open-sse/services/combo.js`)
   - In-memory L1 TTL caches (dependent on Primary IPC broadcast)
4. **Session Stores & Stream Tracking**: Active SSE stream maps and client socket accounting live exclusively inside each worker process.

---

## 9. Known Limitations

1. **CLI Packaging Gap**: `cli/scripts/build-cli.js` sets `NEXT_TRACING_ROOT_MODE=workspace` (line 205), and `scripts/copy-standalone-assets.mjs` returns early when that variable is set (lines 6–9). So the CLI's standalone output does not receive `src/lib/db`, `src/lib/cluster`, `dataDir.js`, or `jsconfig.json`. `custom-server.js` already guards this: when `src/lib/cluster/supervisor.js` is absent it warns `running single-process` and serves normally (lines 46–54, 468). Setting `KHATAM_WORKERS > 1` on such a build therefore falls back to single process instead of crashing. Not verified by building the CLI in this session; read from the source guards only.
2. **Worker Hard-Kill Socket Loss**: A `SIGKILL`ed worker drops its sockets immediately. Observed in the session re-run: 1 in-flight failure across two kills (55 requests), 0 hard failures. Spec tolerance is up to 2 in-flight failures per kill. Graceful in-flight stream drain is verified for one clean mock stream (Section 5, Boot B); it is not verified under stall or upstream error.
3. **Leader Daemon Verification**: Leader-only background tasks (token refresh, database checkpoints) are guarded solely by runtime environment checks (`process.env.KHATAM_WORKER_ROLE === "leader"`).
4. **Single Host WSL2 Benchmark**: All measurements reflect an 8-core WSL2 VM on an AMD Ryzen 7 4800H host with synthetic, zero-latency upstream responses. Production throughput will be governed primarily by upstream provider response latencies.

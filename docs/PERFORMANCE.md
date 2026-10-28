# KhatamRouter Performance & Vertical Scaling Guide

> **Status**: Implemented on branch `wave8/vertical-scale`, pending merge.  
> **Target Runtime**: Bun 1.4.3 on Linux x86_64 / arm64.  
> **Scope**: Strictly **vertical scaling on a single Bun host** (multi-core / multi-process via Bun `node:cluster`). Horizontal multi-replica container overlays and Nginx reverse proxies were formally reverted in PR #77 and are **not** part of KhatamRouter architecture.

---

## 1. Executive Summary

KhatamRouter is an OpenAI-compatible AI routing gateway (`/v1/*`) and Next.js control-plane dashboard. Prior to Wave 8, the server operated as a single Bun process pinned to a single CPU core, while incurring an in-process control-plane overhead of ~1.8 ms (p95 ~4.9 ms) across redundant SQLite reads, linear model scans, and uncached regular expressions.

Wave 8 delivers:
1. **Hot-Path In-Process Slimming (US1)**: Re-landed process-level TTL caches, bounded LRU combo caching, module-load `Map` indexing for model lookups, regex memoization, request-scoped key context reuse, and SQLite `db.immediate(...)` (`BEGIN IMMEDIATE`) transaction write serialization. Database queries dropped by **29.08%** (15.20 → 10.78 queries/req), and tail latency (p95) dropped by **47.96%** (4.93 ms → 2.56 ms). Median latency (p50) improved by **25.67%** (1.35 ms → 1.00 ms), which **misses** the Research D7 target of $\ge 35\%$ reduction. The cause of the remaining p50 time is not profiled.
2. **Multi-Process Vertical Cluster Runtime (US2)**: Utilizes all available host CPU cores via Bun 1.4.3 native `node:cluster` kernel port sharing. A primary supervisor manages $N$ worker processes that each bind their own `SO_REUSEPORT` socket on port 20128. Includes the canonical host-sizing formula `Math.max(1, nproc - 2)` (configurable via `KHATAM_WORKERS`), one-time supervisor startup migrations (`KHATAM_MIGRATIONS_DONE=1`), single-leader daemons (`KHATAM_WORKER_ROLE === "leader"`), IPC cache invalidation without Redis / Redis Pub/Sub with it, graceful connection drain on `SIGTERM` (30s timeout), and crash backoff. Forwarding headers (`X-Forwarded-For`) remain strictly trusted from loopback addresses only; no `TRUSTED_PROXY_CIDRS` exists.
3. **Vertical Performance Ladder (US3)**: On an 8-logical-CPU WSL2 host with an in-process zero-latency mock upstream, throughput scaled from **238.3 req/s** (1 worker, 100% efficiency) to **361.3 req/s** (2 workers, 75.8% efficiency), **453.7 req/s** (4 workers, 47.6% efficiency), and **494.6 req/s** (6 workers, 34.6% efficiency). Throughput flattens beyond 2 workers; scaling is **not linear**.

---

## 2. In-Process Hot-Path Slimming (US1)

### 2.1 Optimizations Re-Landed

- **5-Second Process TTL Caches**: Applied to `aliasRepo.js`, `combosRepo.js`, and `nodesRepo.js`. Avoids repeating identical SQLite queries during high-concurrency request bursts while bounding staleness to 5 seconds.
- **Bounded LRU Combo Cache**: `comboByNameCache` in `combosRepo.js` is capped at 512 entries with oldest-entry eviction, preventing memory leaks under high-cardinality combo lookups.
- **$O(1)$ Model Indexing**: Module-load `Map<modelId, entry>` in `open-sse/config/providerModels.js` replaces linear array scans during model resolution.
- **Regex Memoization**: Caches compiled glob patterns for `matchPattern` in `open-sse/providers/pricing.js`.
- **Request-Scoped Context Reuse**: Reuses resolved `keyRecord` and combo metadata throughout the request lifecycle in `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, and `src/sse/services/model.js`.
- **`BEGIN IMMEDIATE` Write Serialization**: All write transactions in `src/lib/db/repos/usageRepo.js` execute via `db.immediate(...)`, acquiring the SQLite write lock upfront to prevent `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks.
- **Security Invariant — Auth Is Never Cached**: API key lookups and ACL validations query SQLite directly on every incoming request. Revoked, expired, or banned keys are rejected immediately without cache delay.
- **Settings-Scoped Invalidation**: Administrative configuration updates (`settingsRepo.js`) publish `khatam:events:config_reload` across scopes `aliases`, `combos`, `nodes`, `settings`, and `all`, immediately purging in-memory caches across all processes.

### 2.2 In-Process Benchmark Results

Measured via `scripts/perf-l1-harness.mjs` (5 runs × 1,000 requests, 100 warmup, 40% direct / 40% translated / 20% combo mix) against an in-process zero-latency mock executor on Bun 1.4.3 (AMD Ryzen 7 4800H, 8 cores):

| Metric | Baseline (`7fbd38e0`) | Control (`7fbd38e0`) | After-Slim (`7ec97d1f`) | Delta vs Base (%) | Research D7 Target | Verdict |
|---|---|---|---|---|---|---|
| **Total p50** | 1.3483 ms | 1.3686 ms | 1.0022 ms | **-25.67%** | $\ge$ 35% reduction | **MISSED** (-25.67% < 35.0%) |
| **Total p95** | 4.9256 ms | 4.9995 ms | 2.5635 ms | **-47.96%** | $\ge$ 25% reduction | **MET** (-47.96% $\ge$ 25.0%) |
| **Total p99** | 12.3036 ms | 12.4095 ms | 10.8114 ms | **-12.13%** | Informative | Informative |
| **Total Mean** | 1.8010 ms | 1.8223 ms | 1.3828 ms | **-23.22%** | Informative | Informative |
| **DB Queries/Req** | 15.20 | 15.20 | 10.78 | **-29.08%** | $\le$ 11.0 queries | **MET** (10.78 $\le$ 11.0) |
| **Run CV** | 8.03% | 7.70% | 10.37% | +2.34% pts | $\le$ 15% | **MET** (10.37% $\le$ 15%) |

*Assessment*: D7 Criterion 1 (p50 reduction) was **MISSED** (-25.67% vs baseline, -26.77% vs control). Tail latency (p95) and database query targets were **MET**.

### 2.3 Per-Phase Breakdown (Means in ms)

| Phase | Baseline Mean | After-Slim Mean | Delta vs Base (%) | Notes |
|---|---|---|---|---|
| `auth_acl` | 0.0963 ms | 0.0343 ms | -64.38% | Largest relative drop; cause not profiled |
| `model_info` | 0.0484 ms | 0.0503 ms | +3.93% | Flat within noise |
| `translate` (combined) | 0.0280 ms | 0.0133 ms | -52.50% | Cause not profiled |
| `translate_request` | 0.0238 ms | 0.0088 ms | -63.03% | Cause not profiled |
| `translate_response`| 0.0041 ms | 0.0045 ms | +9.76% | Sub-0.01 ms; within noise |
| `executor_mock` | 0.0117 ms | 0.0103 ms | -11.97% | Mock executor |
| `dispatch_glue` | 1.2073 ms | 0.8771 ms | -27.35% | Largest phase (63.4% of after-slim mean); **unprofiled** |
| `stream_drain` | 0.1616 ms | 0.1505 ms | -6.87% | Stream reader consumption |
| `bookkeeping` | 0.2489 ms | 0.2484 ms | -0.20% | Usage logging + `db.immediate` transaction |

---

## 3. Multi-Process Cluster Architecture (US2)

### 3.1 Process Supervision & Kernel Port Sharing

KhatamRouter scales vertically on a single host by running multiple operating system worker processes managed by a supervising primary process via Bun's built-in `node:cluster` module.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Primary Supervisor Process                      │
│   • Evaluates host CPU sizing: Math.max(1, nproc - 2)                  │
│   • Executes SQLite schema migrations ONCE before cluster.fork()       │
│   • Sets KHATAM_MIGRATIONS_DONE=1 in worker environment                │
│   • Sets KHATAM_WORKER_ROLE="leader" for Worker 1, "worker" for others │
│   • Monitors lifecycle: crash backoff and graceful drain forwarding    │
│   • IPC Message Broker: relays config_reload between workers           │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 │ (SO_REUSEPORT Kernel Port Sharing)    │
                 ▼                                       ▼
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  Worker 1 (role: "leader")      │     │  Worker N (role: "worker")      │
│  • Binds PORT (20128)           │     │  • Binds PORT (20128)           │
│  • Skips DB migrations          │     │  • Skips DB migrations          │
│  • In-process L1 TTL caches     │     │  • In-process L1 TTL caches     │
│  • WAL reader / immediate writer│     │  • WAL reader / immediate writer│
│  • LEADER DAEMONS ACTIVE:       │     │  • LEADER DAEMONS SKIPPED:      │
│    - initializeApp.js daemons   │     │    - No tunnel/Tailscale/MITM   │
│    - OAuth proactive token loop │     │    - No background token loop   │
│    - Periodic WAL checkpoint    │     │    - No periodic checkpoint     │
│  • Graceful drain on SIGTERM    │     │  • Graceful drain on SIGTERM    │
└─────────────────────────────────┘     └─────────────────────────────────┘
```

### 3.2 Bun `SO_REUSEPORT` Reality (Not Round-Robin)

1. **Kernel Port Sharing**: Under Bun 1.4.3, `node:cluster` intercepts `server.listen()` in worker processes. Each worker process binds its **own `SO_REUSEPORT` socket** to the configured port (`PORT`, default `20128`).
2. **No Master Socket Passing**: Bun does **not** implement Node's master socket passing and does **not** implement `SCHED_RR` connection handoff. `cluster.schedulingPolicy` is ignored by Bun at runtime.
3. **4-Tuple Kernel Hashing**: The Linux kernel distributes incoming TCP connections across listening workers using a hash over `(src_ip, src_port, dst_ip, dst_port)`. Distribution is balanced over many independent connections, but is **not guaranteed round-robin**. Keep-alive connections remain with the worker that accepted the TCP socket.
4. **Primary Does Not Listen**: The primary supervisor never opens a listening socket; it manages process lifecycles and routes IPC messages.

### 3.3 Loopback-Only Reverse Proxy Trust

KhatamRouter strictly preserves loopback-only trust for forwarding headers:
- `custom-server.js` derives client IP from `X-Forwarded-For` or `X-Real-IP` **strictly when the TCP peer address is a loopback address** (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
- Direct sockets from non-loopback clients are keyed strictly by the TCP socket peer address; any client-supplied `X-Forwarded-For` headers are stripped.
- No external proxy CIDR trust (`TRUSTED_PROXY_CIDRS`) exists.

### 3.4 Single-Leader Background Tasks

To prevent duplicate upstream API calls, token invalidation races, and lock contention, background tasks run strictly in **one** process:
1. **OAuth Proactive Token Refresh**: `startBackgroundTokenRefreshFromCustomServer()` runs only in Worker 1 (`KHATAM_WORKER_ROLE === "leader"`). Sibling workers skip the timer.
2. **Background Daemons (`initializeApp.js`)**: Deferred routines in `runHeavyStartup()` (`safeRestartTunnel`, `safeRestartTailscale`, `autoStartMitm`, `configureTunnelMonitoring`, `startQuotaAutoPing`) run only in Worker 1 (`KHATAM_WORKER_ROLE === "leader"`).
3. **Periodic WAL Checkpoints**: The 60-second `PRAGMA wal_checkpoint(TRUNCATE)` timer runs only in the leader worker.
4. **Single-Process Mode**: When `KHATAM_WORKERS=1` or role is unset, all background tasks run in-process as before.

### 3.5 One-Time Startup Migrations

The primary supervisor executes SQLite schema migrations and backup preflights (`src/lib/db/driver.js`) **once** before calling `cluster.fork()`. It exports `KHATAM_MIGRATIONS_DONE=1` into the worker environment. Workers check this variable and bypass redundant migration runners, preventing concurrent DDL locking.

### 3.6 Cross-Worker Invalidation & IPC Broker

When routing settings, aliases, combos, or nodes change:
- **With Redis**: Changes publish to `khatam:events:config_reload` via Redis Pub/Sub, which invalidates caches across workers. The sub-millisecond propagation in the spec is a design target and was not measured.
- **Without Redis (Standalone SQLite)**: The worker publishing the change sends an IPC message to the supervisor via `process.send({ type: "config_reload", scope })`. The supervisor re-broadcasts the event to all sibling workers (skipping the sender). Sibling workers emit the event locally on `localBus`, purging their in-process caches. If IPC fails, the 5-second TTL bounds staleness. The IPC path is covered by unit tests, not by a measured end-to-end run.

### 3.7 Graceful Drain & Crash Backoff

- **Graceful Drain**: Upon receiving `SIGTERM` or `SIGINT`, the primary forwards the signal to all workers. Each worker immediately calls `server.close()` to stop accepting new connections, tracks `inFlightRequests`, and allows active streaming completions up to `KHATAM_DRAIN_TIMEOUT_MS` (default 30,000 ms). The supervisor enforces a hard kill timeout of `KHATAM_DRAIN_TIMEOUT_MS + 5000` ms before issuing `SIGKILL`. Verified: idle `SIGTERM` exits with code 0; a 2-worker container stop completed in 0.58 s (`docker stop`), and `docker kill --signal=SIGTERM` in 1.2 s. In-flight SSE drain is verified in the host drill (`scripts/vertical-smoke.sh`, `VERTICAL_SMOKE_ALL_PASS`): at least 3 of 8 chunks were unsent at `SIGTERM`, the client received the remaining chunks plus `[DONE]`, the primary exited 0 after stream end (~5.9 s SIGTERM-to-stream-end window), and new connections were refused. The earlier failure was fixed in `df1ef7ae`: the sqlite adapter's `SIGTERM` handler called `process.exit(0)` in the primary, which let Bun's cluster child exit workers on IPC disconnect. Still unverified: drain under upstream stall or error, and long-lived streams approaching `KHATAM_DRAIN_TIMEOUT_MS`. See `specs/008-bun-perf-scale/ladder-results.md` section 5.
- **Crash Backoff**: If a worker exits within 5,000 ms of booting, the supervisor increments `crashCount` and delays respawn via exponential backoff: `delayMs = Math.min(250 * Math.pow(2, crashCount), 10000)`. Once a worker runs continuously for `KHATAM_CRASH_RESET_MS` (default 30,000 ms), its consecutive crash counter resets to 0.

---

## 4. Vertical Performance Ladder & Sizing Guide (US3)

### 4.1 Master Performance Ladder Table

Benchmarked on an 8-logical-CPU host (Linux 6.18 WSL2, AMD Ryzen 7 4800H, roughly 8 GB RAM) using `scripts/perf-ladder.sh` (concurrency 32, 1,000 requests, 100 warmup, 5 runs) against a zero-latency mock upstream:

| Tier | Workers | p50 (ms) | p95 (ms) | p99 (ms) | Throughput (req/s) | Speedup | Scaling Efficiency | Driver-Sampled Peak RSS (MB) | Mode | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| **Vertical 1-worker** | 1 | 127.71 | 178.48 | 265.97 | **238.3** | 1.00x | **100.0%** | 257.1 | normal | 0 |
| **Vertical 2-worker** | 2 | 83.84 | 136.89 | 204.48 | **361.3** | 1.52x | **75.8%** | 467.9 | normal | 0 |
| **Vertical 4-worker** | 4 | 66.76 | 125.20 | 176.55 | **453.7** | 1.90x | **47.6%** | 824.7 | normal | 0 |
| **Vertical 6-worker** | 6 | 58.48 | 142.36 | 188.12 | **494.6** | 2.08x | **34.6%** | 1139.7 | normal | 0 |
| **Vertical 4-worker (Redis-down)** | 4 | 65.36 | 134.34 | 160.45 | **464.9** | 1.95x | 48.8% | 832.6 | degraded | 0 |
| **Vertical 2-worker (Redis-down)** | 2 | 85.48 | 139.05 | 204.82 | **351.5** | 1.48x | 73.8% | 466.3 | degraded | 0 |
| **Vertical 1-worker (keep-alive)** | 1 | 131.36 | 194.59 | 265.19 | **233.4** | 0.98x | 98.0% | 241.5 | normal | 0 |
| **Vertical 1-worker (close)** | 1 | 144.21 | 163.97 | 165.40 | **220.7** | 0.93x | 92.6% | 241.6 | normal | 0 |

*Ladder Verification*: All accepted benchmark rungs executed with zero errors and coefficient of variation $CV < 15\%$. Redis-down rows differ from the normal rows by less than run-to-run variance (4 workers: 464.9 vs 453.7 req/s; 2 workers: 351.5 vs 361.3 req/s). This shows the fail-open path did not measurably slow the gateway in this run. It does not prove cross-worker IPC invalidation under Redis outage: that fallback was not isolated or verified.

### 4.2 Scaling Efficiency & Flattening Analysis

$$\text{Efficiency}(n) = \frac{\text{Throughput}(n)}{n \times \text{Throughput}(1)}$$

Scaling efficiency drops from **100.0%** at 1 worker to **75.8%** at 2 workers, **47.6%** at 4 workers, and **34.6%** at 6 workers. Throughput increases from 238.3 req/s to 494.6 req/s (+107.6% overall), but gains flatten significantly beyond 2 workers.

**Analysis of Diminishing Returns**:
1. **Host CPU Utilization**: At 6 workers, host CPU utilization reached 5.20 out of 8 logical cores (65.1%). The host was not completely saturated; CPU exhaustion alone does not explain the throughput plateau. Individual per-worker CPU dropped from 0.94–0.95 cores at 2 workers to 0.73–0.82 cores at 6 workers.
2. **Unprofiled Hypotheses**:
   - *SQLite WAL Single-Writer Lock Contention*: `saveRequestUsage` executes synchronous writes inside `db.immediate(...)`. At 450–500 req/s, concurrent workers serialize on the single SQLite write lock.
   - *Bun Cluster TCP Accept Imbalance*: Uneven distribution of persistent keep-alive connections across worker event loops.
   - *WSL2 Virtualization Contention*: Virtualized SMT sibling core scheduling under the Windows hypervisor throttles saturated worker threads.

### 4.3 Memory & RSS Footprint

| Tier (workers) | Supervisor RSS | Per-Worker Idle RSS | Per-Worker Peak RSS | Cluster Idle RSS | Cluster Peak RSS |
|---|---|---|---|---|---|
| **1 worker (standalone)** | N/A | 122.2 MB | 257.1–262.3 MB | 122.2 MB | 262.3 MB |
| **2 workers** | 37.3 MB | 116.2–120.1 MB | 236.5–236.9 MB | 273.6 MB | 510.8 MB |
| **4 workers** | 37.3 MB | 111.5–119.4 MB | 209.8–224.0 MB | 494.9 MB | 913.7 MB |
| **6 workers** | 38.4 MB | 109.4–119.1 MB | 194.9–205.4 MB | 719.1 MB | 1244.6 MB |

- **Supervisor**: Primary supervisor process consumes ~37–38 MB RSS without serving traffic or opening client sockets.
- **Worker Footprint**: Idle workers consume ~110–120 MB RSS. Under load (concurrency 32), per-worker peak RSS settles at ~195–237 MB. Total cluster memory scales predictably by ~200 MB per additional worker.

### 4.4 Canonical Host Sizing Guide

To prevent CPU starvation of kernel networking, epoll, SQLite WAL writer fsyncs, local Redis, and Bun JSC garbage collection, worker count must **never** allocate 100% of logical CPU cores.

KhatamRouter enforces a single canonical host-sizing formula:

$$\text{defaultWorkers} = \max\left(1,\; nproc - 2\right)$$

| Host Logical Cores | Formula Result (`KHATAM_WORKERS=auto`) | Notes |
|---|---|---|
| **1 or 2 cores** | 1 (single-process mode) | `Math.max(1, nproc - 2)` |
| **4 cores** | 2 workers | Formula only; not measured |
| **8 cores** | 6 workers | Measured on the WSL2 8-vCPU host (section 4.1) |

Sizing rules for this host class, based on the measured ladder:
- Throughput gains flatten after 2 workers on the measured host. Start at `auto` for a quick baseline, then compare against `KHATAM_WORKERS=2` under your own load. Higher counts were not tested under real upstream latency.
- Memory: plan roughly 110–120 MB per idle worker and 195–237 MB per worker under load (section 4.3), plus the ~37 MB supervisor. Measured cluster peak was 1244.6 MB at 6 workers. The `/proc` sampler and the driver sampler disagree by 4–9%.

---

## 5. Deployment Guide

### 5.1 Docker Deployment (Single Container)

KhatamRouter runs multi-worker vertical clustering inside a **single container** using `Dockerfile.bun`:

```bash
# Run 4 workers inside one container
docker run -d \
  --name khatamrouter \
  -e KHATAM_WORKERS=4 \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -p 20128:20128 \
  -v /var/lib/khatam/data:/app/data \
  khatamrouter:latest
```

- **Graceful Shutdown**: Always allow at least 35 seconds for workers to drain in-flight streams before Docker sends `SIGKILL`:
  ```bash
  docker stop -t 35 khatamrouter
  ```
- **Single Volume**: Mount SQLite storage to `/app/data`. Never attempt to mount the same SQLite volume across multiple physical host instances.

### 5.2 VPS / Bare Metal Deployment

```bash
# Install dependencies with Bun
bun install

# Run production build
bun run build:bun

# Start multi-worker cluster (auto sizes to nproc - 2)
PORT=20128 HOSTNAME=0.0.0.0 KHATAM_WORKERS=auto bun run start:bun
```

To run as a systemd service, configure `TimeoutStopSec=35` to match `KHATAM_DRAIN_TIMEOUT_MS`.

---

## 6. Environment Variables Reference

| Variable | Type / Default | Description |
|---|---|---|
| `KHATAM_WORKERS` | `string \| number`<br>Default: `auto` | Configures worker count.<br>• `auto` / unset: Automatically calculates worker count via `Math.max(1, nproc - 2)`.<br>• `1`: Single-process mode. Completely bypasses cluster supervisor; runs identical to legacy runtime.<br>• `2..64`: Explicit number of worker processes to spawn. |
| `WEB_CONCURRENCY` | `string \| number`<br>Default: unset | Standard 12-factor fallback alias for `KHATAM_WORKERS` (used only when `KHATAM_WORKERS` is unset). |
| `KHATAM_DRAIN_TIMEOUT_MS` | `number`<br>Default: `30000` (30s) | Maximum time worker processes allow in-flight streaming requests to finish after `SIGTERM` before terminating. |
| `KHATAM_CRASH_RESET_MS` | `number`<br>Default: `30000` (30s) | Minimum uptime before a worker process is marked healthy and its consecutive crash counter resets to 0. |

*Internal Variables (set by supervisor, not for operator configuration)*:
- `KHATAM_WORKER_ROLE`: Set by supervisor to `"leader"` (Worker 1) or `"worker"` (followers). Unset in single-process mode.
- `KHATAM_MIGRATIONS_DONE`: Set to `"1"` by supervisor before forking. Workers detect this and skip running database migrations.

---

## 7. Known Limitations & Operational Realities

1. **Per-Process In-Memory State Without Redis**: When `REDIS_URL` is omitted, several subsystems maintain local in-process state rather than shared cluster state:
   - Concurrency semaphores (`src/sse/services/keyAccess.js`)
   - 4-state circuit breakers (`src/shared/utils/circuitBreaker.js`)
   - Combo rotation state (`comboRotationState` Map, `open-sse/services/combo.js`)
   - Active SSE stream maps and client socket accounting
   For cluster-wide coordination of the first four items, configure `REDIS_URL`.
   - Login lockout (`src/lib/auth/loginLimiter.js`, in-memory `attempts` Map) and rate limits are per worker in the same way. Effective limits multiply by worker count (e.g. a lockout threshold applies to each worker separately). Set `REDIS_URL` for multi-worker deployments.
2. **`requestDetails` Buffer Lost on `SIGKILL`**: Detailed observability records (`src/lib/db/repos/requestDetailsRepo.js`) buffer in memory for up to 5,000 ms (`OBSERVABILITY_FLUSH_INTERVAL_MS`). If a worker receives an abrupt `SIGKILL`, buffered records that have not yet flushed to SQLite are lost. Standard usage metrics (`usageRepo.js`) are written synchronously via `db.immediate` and are unaffected.
3. **In-Flight Sockets Dropped on `SIGKILL`**: If a worker process is abruptly terminated with `SIGKILL`, up to ~2 in-flight requests on that worker's sockets are dropped before the supervisor respawns a replacement. `SIGKILL` does not drain; graceful drain applies only to `SIGTERM`/`SIGINT` (verified for one clean mock stream, see section 3.7).
4. **npm CLI Bundle Runs Single-Process**: `cli/scripts/build-cli.js` builds with `NEXT_TRACING_ROOT_MODE=workspace`, which causes `scripts/copy-standalone-assets.mjs` to return early. As a result, the standalone CLI distribution omits the cluster supervisor closure. Setting `KHATAM_WORKERS > 1` on the npm CLI build falls back cleanly to single-process mode.
5. **`dispatch_glue` Is Unprofiled**: `dispatch_glue` accounts for 63.4% of in-process request time (0.8771 ms of 1.3828 ms mean). It has not been broken down into sub-components via CPU profiling.
6. **Leader Daemon Verification**: Leader-only background tasks (token refresh, database checkpoints) are guarded solely by runtime environment checks (`process.env.KHATAM_WORKER_ROLE === "leader"`).
7. **Synthetic Zero-Latency Benchmark Context**: All ladder measurements reflect an 8-core WSL2 VM with synthetic, zero-latency upstream responses. Production throughput will be governed primarily by upstream provider response latencies.

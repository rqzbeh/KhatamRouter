# Phase 0 Research: Wave 8 — Bun Hot-Path Slim and Vertical Scale

**Scope**: Architectural decisions for Wave 8 (US1: Hot-path slim & re-land, US2: Vertical multi-process scale on one host, US3: Vertical ladder benchmark).  
**Inputs**: `research-profile.md`, `research-vertical-runtime.md`, `research-ladder.md`, `research-index.md`, and reverted commit `6768fb82`.  
**Runtime Reality**: Bun-only (`bun:sqlite` sole driver with WAL `busy_timeout = 5000`, Redis default `khatam:` prefix, Linux x86_64 WSL2 8 cores).

---

## D1 — Harness Naming & Re-Land Scope

- **Decision**: Re-land the independent hot-path performance work from reverted commit `6768fb82`:
  - `scripts/perf-l1-harness.mjs` (in-process L1 gateway harness), `scripts/perf-l0-micro.mjs` (sub-microsecond micro-benchmarks), and `scripts/perf-mock-upstream.mjs` (mock streaming upstream).
  - Process-level TTL caches for aliases, combos, and provider nodes (`src/lib/db/repos/aliasRepo.js`, `combosRepo.js`, `nodesRepo.js`, `src/lib/db/index.js`) with write-invalidation, `settings`-scope invalidation, and 5-second hard TTL. `comboByNameCache` MUST be a bounded LRU (max 512 entries, oldest eviction) because negative results are cached for arbitrary client-supplied model ids; an unbounded Map grows without limit.
  - Module-load `Map<modelId, entry>` in `open-sse/config/providerModels.js` for O(1) `findModel` lookups.
  - Memoized RegExp compilation cache in `open-sse/providers/pricing.js` (`matchPattern`).
  - Request-scoped reuse in `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, and `src/sse/services/model.js` (resolve `keyRecord` once, pass resolved combo to avoid duplicate queries).
  - Transport memoization in `open-sse/handlers/chatCore.js`.
  - SQLite write serialization via `db.immediate()` (`BEGIN IMMEDIATE`) in `src/lib/db/repos/usageRepo.js:258` (`saveRequestUsage`); note the reverted commit used `db.transaction()` (deferred) and the adapter already exposes `immediate` at `bunSqliteAdapter.js:137`.
  - Golden test suites, unit tests, and performance documentation (`docs/PERFORMANCE.md`).
- **Rationale**: These optimizations are entirely independent of horizontal scaling, verified by 4,100+ passing tests, and historically reduced query count by ~29% and p95 tail latency by ~48% (reference historical targets, to be re-measured on the current tree — see D10).

---

## D2 — Vertical Concurrency Runtime: `node:cluster` Primary + Workers

- **Decision**: Standardize on **`node:cluster`** built into Bun 1.4.3 for vertical multi-process scaling on a single host.
- **Evaluation & Experimental Evidence** (`research-vertical-runtime.md`):
  1. *`Bun.serve({ reusePort: true })`*: Enables Linux kernel `SO_REUSEPORT` across separate processes (measured 48, 56, 48, 48 across 4 workers). However, Next.js standalone server creates its HTTP listener via Node's `http.createServer()` and `server.listen()`. Bun's `node:http` compatibility layer does not expose `reusePort` on independent processes, throwing `EADDRINUSE`.
  2. *`node:cluster`*: Bun 1.4.3 natively intercepts `server.listen()` in worker processes and coordinates kernel-level socket sharing. Tested directly against `.next/standalone/custom-server.js`: 2 workers booted in 0 ms and responded with 200 OK on port 20298 with zero port conflicts. Bidirectional IPC and exit detection work flawlessly.
  3. *Worker Threads (`node:worker_threads`)*: Rejected due to fatal lack of fault isolation. A native crash in `wreq-js` or `bun:sqlite` terminates the entire OS process, dropping all active SSE streams across all threads. Additionally, Next.js relies on process-wide globals and is not thread-safe within a single process.
- **Consequence**: The primary process acts as a supervisor; worker processes run Next.js and handle HTTP traffic over the shared listen socket.

---

## D3 — Host-Sizing Guidance & Worker Sizing Formula

- **Decision**: Compute default worker processes via the canonical scalar formula:
  $$\text{defaultWorkers} = \max\left(1,\; nproc - 2\right)$$
  - `nproc <= 3` clamps to `1` (single-process mode).
  - `nproc = 8` (this host) yields **6 workers**.
  - This one formula is authoritative across `spec.md`, `plan.md`, `tasks.md`, `research.md`, `research-vertical-runtime.md`, `research-index.md`, `contracts/vertical-workers.md`, `quickstart.md`, and `data-model.md`. The earlier piecewise variant (with an `nproc > 8` 75%-of-cores branch) is retired everywhere.
- **Rationale**: Never allocate 100% of logical CPU cores to worker processes. Dedicated cores must remain available for:
  1. Linux kernel network stack (epoll, `ksoftirqd`, TCP SYN processing).
  2. Bun JavaScriptCore GC threads and libuv/epoll background I/O threads.
  3. SQLite WAL writer thread and periodic WAL checkpoint fsync.
  4. Local Redis server event loop and background persistence (`bgsave`).
- **Configuration**:
  - `KHATAM_WORKERS`: Positive integer (`1`, `2`, `4`, `6`, etc.) or `auto`.
  - `WEB_CONCURRENCY`: Standard 12-factor fallback alias (used only when `KHATAM_WORKERS` is unset).
  - `KHATAM_WORKERS=1` (or 1-core machine) runs single-process mode, completely bypassing the cluster supervisor with zero overhead.

---

## D4 — Cache Strategy & Cross-Process Invalidation

- **Decision**: Combine request-scoped memoization, in-process TTL caches, and cross-process invalidation:
  1. *Request-Scoped Reuse*: Resolve `keyRecord` once in `handleChat` and pass it into `handleSingleModelChat` and `getKeyAccessContext`. Pass the resolved combo into `getModelInfo` and `getComboModels`. Zero cross-process risk.
  2. *Auth Invariant*: **Auth/API-key validity is NEVER cached across requests**. A revoked, expired, or deleted key must fail the next request. SQLite stays authoritative on every request.
  3. *In-Process TTL Caches*: `modelAliases`, `providerNodes` by type, and `getComboByName` use in-process Map caches with a **5-second hard TTL cap**.
     - `comboByNameCache` in `combosRepo.js` MUST be a bounded LRU cache (maximum 512 entries, oldest eviction on insert) because negative lookup results are cached for arbitrary client-supplied model strings; an unbounded Map would leak memory under attacker probing.
     - `combosRepo`, `aliasRepo`, and `nodesRepo` caches MUST also invalidate on `config_reload` events with scope `'settings'` or `'all'` (`settingsRepo.js:168` publishes scope `'settings'`) so routing-setting changes take effect immediately across all processes.
  4. *Cross-Process Invalidation*:
     - When Redis is available: Writes publish `khatam:events:config_reload` via Redis Pub/Sub, invalidating all workers in $< 1\text{ ms}$.
     - When Redis is absent (standalone local SQLite): Worker write sends IPC message `{ type: "config_reload", scope }` via `process.send` to the Primary, which re-broadcasts to all sibling workers (skipping the sending worker to avoid echo loops). Sibling workers receive the message and emit it on the local `EventEmitter` bus (`localBus`).
     - **NOT `PRAGMA data_version` polling**: Invalidation relies exclusively on push notifications (Redis Pub/Sub or Primary IPC broadcast); the 5-second hard TTL serves as a backstop. No database polling is introduced.
     - Fallback: The 5-second hard TTL cap bounds staleness if a message is lost.

---

## D5 — Graceful Drain & Streaming SSE Semantics

- **Decision**: Implement a two-phase graceful shutdown for long-lived AI streaming completions:
  1. *Stop Accepting Connections*: On `SIGTERM` / `SIGINT`, each worker immediately invokes `server.close()`. The Linux kernel removes the worker from the accept queue; incoming requests route to sibling workers.
  2. *Drain In-Flight Streams*: Workers maintain an active stream counter (`inFlightRequests`). If `inFlightRequests === 0`, the worker exits immediately (code 0).
  3. *Drain Deadline*: Configurable via `KHATAM_DRAIN_TIMEOUT_MS` (default: `30000` / 30 seconds). If streams remain after 30s, sockets are forcefully destroyed and the worker exits.
  4. *Supervisor Escalation*: Supervisor enforces `SUPERVISOR_DRAIN_TIMEOUT_MS = KHATAM_DRAIN_TIMEOUT_MS + 5000`. If a child process is still alive after 35s, supervisor issues `SIGKILL`.

---

## D6 — Crash-Restart Backoff Algorithm

- **Decision**: Supervisor monitors child exits via `cluster.on('exit')` with exponential backoff:
  - *Healthy Run Reset*: If a worker runs continuously for $> 30\text{ seconds}$, reset its consecutive crash counter to 0.
  - *Rapid Crash Backoff*: If a worker exits within $< 5000\text{ ms}$ of starting:
    - Increment `crashCount++`.
    - Delay restart by `delayMs = Math.min(250 * Math.pow(2, crashCount), 10000)`.
  - *Circuit Breaker Alert*: If a worker crashes 5 consecutive times rapidly, log an error alert. Sibling workers continue serving traffic.

---

## D7 — Single-Leader Background Tasks

- **Decision**: Background tasks that interact with upstream providers or manipulate shared files must run in exactly ONE process (or the Primary when the code path is entry-point specific):
  1. *OAuth Token Proactive Refresh*: `startBackgroundTokenRefreshFromCustomServer()` in `custom-server.js:151-153` runs only when `process.env.KHATAM_WORKER_ROLE === "leader"` (1-indexed Worker 1) or when the role is unset (single-process mode). The `startBackgroundTokenRefresh()` call inside `initializeApp.js` `runHeavyStartup()` is also leader-gated, preventing duplicate refresh loops across all workers.
  2. *WAL Checkpoint Timer*: The 60-second `PRAGMA wal_checkpoint(TRUNCATE)` timer at `src/lib/db/adapters/bunSqliteAdapter.js:87-90` runs only in the leader worker (`KHATAM_WORKER_ROLE === "leader"` or unset in single-process mode).

## D7a — One-Time Primary Migrations

- **Decision**: SQLite migration and backup preflights run exactly once in the Primary before any worker is forked.
- **Verified problem**: `src/lib/db/driver.js:86-90` `getAdapter()` currently unconditionally awaits `runMigrationOnce(adapter)` in every process — under a 6-worker cluster, each worker would race the same DDL against the freshly-forked shared file.
- **Fix design**: The Primary supervisor executes migration + backup preflight in-process, then forks workers with `KHATAM_MIGRATIONS_DONE=1`. `src/lib/db/driver.js` short-circuits the `runMigrationOnce(adapter)` call when that env variable is present (workers inherit it). Single-process mode (`KHATAM_MIGRATIONS_DONE` unset) preserves the current behaviour unchanged.

---

## D8 — SQLite Multi-Writer Safety: `db.immediate()` and Multi-Process Concurrency Proof

- **Decision**: Serialize concurrent multi-process write transactions using `db.immediate(...)` (`BEGIN IMMEDIATE`) in `src/lib/db/repos/usageRepo.js:258` (`saveRequestUsage`). The adapter already exposes `immediate` alongside `transaction` at `src/lib/db/adapters/bunSqliteAdapter.js:137`, so this is a call-site swap from the currently-used deferred `db.transaction(...)` to `db.immediate(...)`.
- **Rationale & Audit Evidence**: In default deferred transactions (`BEGIN DEFERRED`), multiple worker processes acquire shared read locks simultaneously, then attempt to upgrade to exclusive write locks when persisting usage records. Under concurrent write bursts, this causes `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks and silent usage record loss. The audit spike measured **90% `SQLITE_BUSY` failure rate under deferred transactions vs 99.5% success under `BEGIN IMMEDIATE`** across 4 concurrent processes (200 ops, 500 ms busy_timeout). This is audit-level evidence that will be re-proven on the real repo by `tests/unit/usage-concurrent-writers.test.js` using real child processes (not just in-process mocks).
- **One-Time Startup Migrations**: SQLite schema migrations (`src/lib/db/migrate.js`) run strictly once in the Primary process before workers are forked, with `KHATAM_MIGRATIONS_DONE=1` exported to workers (see D7a).

---

## D9 — Security Invariant: Loopback-Only XFF Trust Strictly Preserved

- **Decision**: Retain the existing loopback-only reverse proxy trust check in `custom-server.js` byte-for-byte:
  ```javascript
  const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
  ```
- **Security Rationale**: In vertical multi-process scaling, all worker processes run on the single local host and bind the host port directly. There is NO intermediate container load balancer or reverse proxy container between the host network and the worker. Therefore, `TRUSTED_PROXY_CIDRS` is NOT needed and is NOT introduced. Preserving loopback-only trust ensures zero expansion of attack surface and zero risk of IP spoofing or login limiter evasion.

---

## D10 — Performance Verdict Targets & Reference Numbers

- **Naming note**: throughout `spec.md`, `plan.md`, `tasks.md`, `research-ladder.md`, `checklists/requirements.md`, and the contracts, the acceptance thresholds are called the **"Research D7 thresholds"** because that is how Research D7 originally framed them. They are formally adopted here as decision **D10**; "D7 thresholds" always means this table ($p50 \ge -35\%$, $p95 \ge -25\%$, `db_queries_per_req` $\le 11.0$), never the leader-only background-task rule in D7 above.
- **Decision**: Adopt the Research D7 gating thresholds as formal evaluation criteria and report outcomes with complete scientific honesty:

| Criterion | Gating Threshold (D7) | Reference Historical Figure from `6768fb82` (reference only, not asserted as achieved) |
|---|---|---|
| **L1 p95 Tail Latency** | $\ge 25.0\%$ reduction | ~48% reduction (5.04 ms -> 2.59 ms via regex memoization and map indexing) |
| **L1 p50 Median Latency** | $\ge 35.0\%$ reduction | ~24% to ~29% reduction (1.37 ms -> 1.01 ms) |
| **Database Queries / Req** | $\le 11.0$ queries/req (SC-001) | ~10.8 queries/req from 15.20 (-29%) |
| **Stability (CV %)** | $< 15.0\%$ noise ceiling | ~9.5% – 10.9% |
| **Redis Outage Degradation** | Zero request-path throw | Fail-open gracefully to in-process/IPC handling |
| **Regression Guard** | 100% green | All goldens and baselines green |

- **Rule**: Reference figures from `6768fb82` are historical reference targets only. Every metric MUST be re-measured on the current tree. Any unmeasured, invalid, or noisy run cannot certify improvement. Missed targets are reported plainly as missed, never massaged or obscured.

## D11 — Leader Assignment, Role Semantics & Bun 1.4.3 Distribution Reality

- **Leader assignment**: Workers are **1-indexed**. Worker 1 receives `KHATAM_WORKER_ROLE="leader"`. Workers 2..N receive `KHATAM_WORKER_ROLE="worker"`. In single-process mode `KHATAM_WORKER_ROLE` is unset, and every leader-only gate is satisfied for backward compatibility. There is no "Worker 0".
- **Bun distribution reality (Bun 1.4.3, Linux)**: `node:cluster` works, but Bun does NOT use Node's master socket passing and does NOT implement `SCHED_RR`. Each worker binds its own `SO_REUSEPORT` socket, so distribution is kernel 4-tuple hashing (balanced over many connections, NOT guaranteed round-robin). A small number of keep-alive connections can land unevenly on a subset of workers. `cluster.schedulingPolicy` is reported but ignored. Smoke/ladder oracles must therefore drive many `Connection: close` requests and assert only `distinctWorkerPids >= 2` for a 4-worker smoke, not exact per-worker evenness.

---

## Explicit Out of Scope (Reverted Architecture)

The following items were implemented in PR #76, evaluated, and formally **REVERTED in PR #77**:
1. Horizontal Docker Compose replica scaling (`--scale 9router=2`, `docker-compose.scale.yml`).
2. Nginx reverse proxy load balancer (`deploy/nginx-scale.conf`).
3. External CIDR proxy trust configuration (`TRUSTED_PROXY_CIDRS`, `trusted-proxy.cjs`).
4. Multi-container scale smoke testing scripts (`scripts/scale-smoke.sh`).

None of these items shall be re-introduced. All Wave 8 scaling is strictly vertical on ONE Bun host.

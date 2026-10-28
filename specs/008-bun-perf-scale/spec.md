# Feature Specification: Wave 8 — Bun Hot-Path Slim and Vertical Scale (multi-core / multi-process on one host)

**Feature Branch**: `spec/008-vertical-scale`  
**Classification**: Runtime Concurrency, In-Process Performance, and Vertical Scalability  
**Status**: Implemented; T011, T020, T022, T028 oracles pass (word-bounded `\bxit\b` fixes the substring match on `exit`); T029, T030 open (Phase 6 closeout)  

---

## 1. Executive Summary & Problem Statement

KhatamRouter operates as an AI routing gateway exposing an OpenAI-compatible API (`/v1/*`) and routing requests across 40+ upstream providers. Running under Bun 1.4.3 on a dedicated host (such as an 8-core / 16-thread machine), the gateway historically executed as a **single Bun process limited to a single CPU core**, while incurring an in-process dispatch overhead of ~1.8 ms (with p95 tail latency spiking to ~5.0 ms) due to redundant SQLite reads, linear array searches, and uncached regular expression compilations.

An earlier attempt to scale horizontally via Docker Compose replicas behind an Nginx load balancer introduced external complexity, required CIDR proxy trust (`TRUSTED_PROXY_CIDRS`), and was formally **reverted in PR #77**.

This specification defines **Wave 8 as strictly VERTICAL scaling on ONE Bun host**:
1. **Re-Landing Hot-Path Slimming (US1)**: Re-landing the independent, high-yield performance optimizations from commit `6768fb82` (process-level TTL caches for aliases/combos/nodes with bounded LRU eviction and settings-scope invalidation, module-load `Map` index for model lookups, regex memoization in pricing/capabilities, request-scoped context reuse, and SQLite `db.immediate()` write serialization), targeting a reduction of database queries to $\le 11.0$ queries/req (reference historical target: 15.2 down to 10.8, -29%) and a p95 tail latency reduction of $\ge 25\%$ (reference historical target: ~48% reduction) while guaranteeing zero request/response behavioral regressions. Reference historical metrics from commit `6768fb82` are reference targets only to be re-measured on the current tree.
2. **Vertical Multi-Process Concurrency (US2)**: Unlocking all available host CPU cores via a supervising primary process managing N worker processes through Bun 1.4.3's built-in `node:cluster` kernel port sharing. Workers share a single listen port (`PORT=20128`) via individual `SO_REUSEPORT` sockets without proxy hops or port conflicts. Includes the canonical host-sizing formula `Math.max(1, nproc - 2)` (configurable via `KHATAM_WORKERS` with `WEB_CONCURRENCY` fallback), one-time primary startup migrations (`KHATAM_MIGRATIONS_DONE=1`), graceful connection drain on `SIGTERM` (30s timeout for long-lived AI streaming tokens), crash recovery with exponential backoff (`Math.min(250 * 2^restarts, 10000)ms` if crash < 5000 ms), leader-only background tasks (Worker 1 / `KHATAM_WORKER_ROLE === "leader"` executes proactive OAuth token refresh, background daemons in `initializeApp.js`, and WAL checkpoint timers), cross-worker cache invalidation via Redis Pub/Sub or Primary IPC broadcast, multi-process SQLite write serialization (`db.immediate()`), and strict preservation of loopback-only reverse proxy trust (no `TRUSTED_PROXY_CIDRS`).
3. **Vertical Performance Ladder (US3)**: Benchmarking 1 vs 2 vs 4 vs N vertical workers on THIS host using a loopback load driver (`scripts/perf-ladder.sh`), reporting throughput scaling, latency percentiles, per-worker RSS (reference: ~101 MB idle, ~150–220 MB peak), host CPU saturation, and Redis-down degraded performance with complete scientific honesty against Research D7 thresholds.

---

## 2. User Scenarios & Acceptance Criteria

### User Story 1 — Hot-Path Slimming & Re-Land (Priority: P1, MVP)

An operator serving chat completions through KhatamRouter observes that control-plane latency overhead is slimmed down, redundant database queries are eliminated, and before/after L1 measurements prove the savings with zero behavior regressions.

**Why this priority**: Hot-path efficiency maximizes per-core throughput. Every vertical worker process benefits directly from a leaner execution path.

**Independent Test**: Execute `scripts/perf-l1-harness.mjs` before and after slimming under identical workload (5 runs × 1,000 requests, 100 warmup, 40% direct / 40% translated / 20% combo). Output JSON confirms `db_queries_per_req` drops to $\le 11.0$ queries/req (reference historical: ~15.2 down to 10.8) and p95 latency drops by $\ge 25\%$, while all four golden translator suites and baseline snapshots remain 100% green.

**Acceptance Scenarios**:
1. **Given** an in-process L1 benchmark workload, **When** baseline profiling runs, **Then** it records granular latency across phases (`auth_acl`, `model_info`, `translate`, `dispatch_glue`) and confirms baseline database query count (reference target: ~15.2 queries/req).
2. **Given** the re-landed hot-path optimizations (TTL caches in `aliasRepo.js`, `combosRepo.js`, `nodesRepo.js` with bounded LRU max 512 for `comboByNameCache`; `Map` index in `providerModels.js`; regex memoization in `pricing.js`; request-scoped reuse in `chat.js`; `db.immediate()` in `usageRepo.js`), **When** the harness re-runs, **Then** `db_queries_per_req` drops to $\le 11.0$ queries/req and p95 tail latency drops by $\ge 25\%$ (reference historical target: ~48% reduction). Historical numbers from `6768fb82` serve as reference targets to be re-measured on the current tree.
3. **Given** the Research D7 median latency target ($\ge 35\%$ p50 reduction), **When** evaluated against measured data (reference historical: ~24% to 29% reduction), **Then** the report acknowledges the p50 shortfall honestly due to runtime stream allocation floors, while celebrating the p95 win.
4. **Given** any API key that is revoked, expired, or banned in SQLite, **When** an inference request arrives, **Then** the request is rejected immediately (auth is NEVER cached across requests; SQLite is authoritative on every request).
5. **Given** any candidate optimization that modifies translator output, **When** golden suites run (`tests/translator/golden-*.test.js`), **Then** any byte difference immediately rejects the change.
6. **Given** an administrative update to routing settings (`settingsRepo.js:168`), **When** `publishKhatamEvent` publishes `khatam:events:config_reload` with scope `'settings'` or `'all'`, **Then** cached aliases, combos, and nodes are invalidated immediately across all processes so new settings take effect without delay.

---

### User Story 2 — Vertical Multi-Process Concurrency on One Host (Priority: P2)

An operator running KhatamRouter on a multi-core server (e.g. 4, 8, or 16 cores) configures the gateway to spawn N worker processes sharing port 20128 without external proxies or container overlays. The system automatically sizes workers, executes database migrations once in the Primary, restarts crashed workers with backoff, drains active streaming connections cleanly on `SIGTERM`, executes background daemons and token refreshes strictly in the leader worker, synchronizes cache invalidation across workers via IPC broadcast or Redis Pub/Sub, and preserves loopback-only security.

**Why this priority**: Unlocks the remaining 85%+ idle CPU capacity of multi-core servers for LLM inference routing without introducing external networking dependencies.

**Independent Test**: Start KhatamRouter with `KHATAM_WORKERS=4` on a multi-core machine; verify all 4 workers bind port 20128 via `node:cluster`; drive 200 concurrent HTTP requests with `Connection: close` and confirm requests distribute across workers (at least 2 distinct worker PIDs verified under kernel 4-tuple hashing); send `SIGTERM` during active streaming and verify in-flight streams finish before workers exit; kill a worker with `SIGKILL` and confirm supervisor restarts it within backoff limits while sibling workers serve traffic uninterrupted.

**Acceptance Scenarios**:
1. **Given** a host with $N$ logical CPU cores, **When** `KHATAM_WORKERS` is unset or `auto`, **Then** the system computes worker count using the canonical host-sizing formula `Math.max(1, nproc - 2)` (e.g. 6 workers on 8 cores), leaving dedicated cores for Linux network stack, SQLite WAL checkpointing, Redis, and Bun GC.
2. **Given** `KHATAM_WORKERS=1` or a 1-core machine, **When** KhatamRouter starts, **Then** it completely bypasses the cluster supervisor and executes as a single process with zero overhead, identical to legacy behavior.
3. **Given** multiple active workers, **When** an operating system `SIGTERM` or `SIGINT` signal is received, **Then** each worker immediately calls `server.close()` to stop accepting new connections, allows in-flight streaming requests to finish up to `KHATAM_DRAIN_TIMEOUT_MS` (default 30s), and exits cleanly (exit code 0).
4. **Given** a worker process that crashes unexpectedly (uncaught exception or native panic), **When** the supervisor detects process exit, **Then** it logs the crash, calculates restart backoff (`Math.min(250 * 2^restarts, 10000)ms` if uptime < 5000 ms), and spawns a replacement worker while surviving workers continue serving requests with zero dropped turns.
5. **Given** database migrations and backup preflights (`src/lib/db/driver.js:86-90`), **When** cluster mode boots, **Then** the Primary supervisor runs `runMigrationOnce(adapter)` ONCE before calling `cluster.fork()` and sets `KHATAM_MIGRATIONS_DONE=1` in the worker environment; workers detect `KHATAM_MIGRATIONS_DONE=1` and skip duplicate migration execution.
6. **Given** background daemons in `src/shared/services/initializeApp.js` (`safeRestartTunnel`, `safeRestartTailscale`, `ensureCloudflared`, `autoStartMitm`, `configureTunnelMonitoring`, `startQuotaAutoPing`, `startBackgroundTokenRefresh`) and `custom-server.js:151-153` (`startBackgroundTokenRefreshFromCustomServer`), **When** multi-worker mode is active, **Then** these daemons execute ONLY in Worker 1 (`KHATAM_WORKER_ROLE === "leader"` or role unset in single-process mode); follower workers (`KHATAM_WORKER_ROLE === "worker"`) skip daemon execution.
7. **Given** periodic WAL checkpoints in `src/lib/db/adapters/bunSqliteAdapter.js:87-90`, **When** multi-worker mode is active, **Then** the 60-second `PRAGMA wal_checkpoint(TRUNCATE)` timer runs ONLY in the leader worker (or role unset in single-process mode); follower workers skip starting the checkpoint interval.
8. **Given** multiple workers concurrently writing request usage to SQLite, **When** transactions execute in `usageRepo.saveRequestUsage` (`src/lib/db/repos/usageRepo.js:258`), **Then** `db.immediate(...)` (`BEGIN IMMEDIATE`) acquires the write lock upfront, preventing `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks (spike measured 90% busies with deferred vs 99.5% success with immediate across 4 processes, 200 ops, 500 ms busy_timeout).
9. **Given** an update to model aliases, combos, or nodes, **When** a write occurs on Worker A, **Then** invalidation propagates to all sibling workers via Redis Pub/Sub (`khatam:events:config_reload`) in $< 1\text{ ms}$, or via Primary IPC broadcast when Redis is unconfigured (Worker A `process.send({type:'config_reload', scope})` -> Primary broadcasts to siblings skipping Worker A -> sibling workers emit locally on `localBus`), bounded by a 5-second hard TTL.
10. **Given** inbound HTTP requests with `X-Forwarded-For` or `X-Real-IP`, **When** evaluated in `custom-server.js`, **Then** forwarding headers are trusted **strictly from loopback addresses** (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Direct sockets remain keyed strictly by the TCP peer address; no `TRUSTED_PROXY_CIDRS` is accepted.

---

### User Story 3 — Vertical Performance Ladder Benchmark & Verdict (Priority: P3)

An operator or reviewer reviews a single vertical ladder benchmark table comparing 1 vs 2 vs 4 vs N vertical workers on THIS host (latency percentiles, throughput, per-worker RSS, CPU core saturation), evaluated against Research D7 targets, with an honest verdict on how vertical scaling moved the system ceiling.

**Why this priority**: Rigorous empirical proof verifies that multi-worker scaling delivers near-linear throughput gains up to host saturation without degrading tail latency or exhausting memory.

**Independent Test**: Execute `scripts/perf-ladder.sh` across worker counts 1, 2, 4, and 6 on this machine against the mock upstream server; record latency percentiles ($p50, p95, p99$), throughput ($req/s$), per-worker RSS, CV%, and errors into `specs/008-bun-perf-scale/ladder-results.md`.

**Acceptance Scenarios**:
1. **Given** the loopback load driver `scripts/perf-ladder.sh`, **When** run against 1 worker baseline, **Then** it records baseline throughput (reference: ~180–200 req/s) and latency percentiles with 0 errors and $CV < 15\%$.
2. **Given** the same load driver, **When** run against 2 and 4 vertical workers, **Then** throughput scales with worker count up to host CPU core saturation.
3. **Given** a simulated Redis outage during multi-worker execution, **When** traffic flows, **Then** workers degrade gracefully to in-process/IPC coordination without request-path exceptions, recording a valid degraded ladder row.
4. **Given** host CPU saturation on WSL2 (8 cores), **When** evaluated, **Then** the report documents host saturation plainly rather than claiming workers don't scale.
5. **Given** a single container execution, **When** delegated to a dedicated container subagent, **Then** it proves the `Dockerfile.bun` image boots with `KHATAM_WORKERS=2` inside one container and serves requests cleanly (never multi-container compose, no prune commands).

---

## 3. Functional Requirements

### Hot-Path Slimming (US1)
- **FR-001**: The gateway MUST implement in-process TTL caching (5s hard cap) for `getModelAliases`, `getComboByName`, and `getProviderNodes`. `comboByNameCache` MUST be a bounded LRU cache (maximum 512 entries, oldest eviction) to prevent unbounded memory growth from arbitrary client model IDs. All three caches MUST invalidate on write methods, on `importDb`, and on `config_reload` events across scopes `aliases`, `combos`, `nodes`, `settings`, and `all`.
- **FR-002**: The gateway MUST initialize an O(1) `Map<modelId, entry>` index for model definitions in `providerModels.js` at module load time, eliminating linear scans in `findModel`.
- **FR-003**: The gateway MUST memoize compiled regular expressions in `matchPattern` (`pricing.js`) using a bounded LRU cache, eliminating dynamic regex compilation during model capability matching and pricing resolution.
- **FR-004**: The gateway MUST resolve `keyRecord` once in `handleChat` and pass it into `handleSingleModelChat` and `getKeyAccessContext`, eliminating redundant `apiKeys` database lookups, and pass resolved combos into `getModelInfo` and `getComboModels`.
- **FR-005**: Auth/API-key lookups MUST NEVER be cached across requests. If a key is revoked, expired, or deleted in SQLite, subsequent requests MUST be rejected immediately (fail-closed; SQLite is authoritative on every request).
- **FR-006**: Hot-path slimming MUST NOT change request/response behavior (all four translator golden test suites and baseline snapshot scripts MUST remain 100% green).

### Vertical Multi-Process Runtime (US2)
- **FR-007**: The runtime MUST support vertical multi-process scaling on a single host via Bun 1.4.3's built-in `node:cluster` module, sharing one TCP listen port (`PORT`, default 20128) across worker processes via kernel `SO_REUSEPORT` socket binding without port conflicts or proxy hops.
- **FR-008**: The runtime MUST determine default worker process count via the canonical scalar formula `Math.max(1, nproc - 2)`, configurable via `KHATAM_WORKERS` (with `WEB_CONCURRENCY` as fallback). Setting `KHATAM_WORKERS=1` or running on a 1-core host MUST bypass the supervisor and execute as a single process identically to legacy runtime.
- **FR-009**: On `SIGTERM` or `SIGINT`, worker processes MUST invoke `server.close()` to stop accepting connections, drain active streaming connections up to `KHATAM_DRAIN_TIMEOUT_MS` (default 30,000 ms), and exit cleanly (code 0). The supervisor MUST escalate to `SIGKILL` only after `KHATAM_DRAIN_TIMEOUT_MS + 5000ms`.
- **FR-010**: The supervisor MUST detect worker process exits via `cluster.on('exit')` and restart workers with exponential backoff (`Math.min(250 * 2^restarts, 10000)ms`) if crashes occur in $< 5000\text{ ms}$, logging an alert after 5 consecutive rapid crashes.
- **FR-011**: SQLite schema migrations and backup integrity preflights MUST execute strictly ONCE in the Primary supervisor process before workers are forked. The Primary MUST pass `KHATAM_MIGRATIONS_DONE=1` to workers, and `src/lib/db/driver.js` MUST skip `runMigrationOnce(adapter)` when `KHATAM_MIGRATIONS_DONE=1` is set (single-process mode behavior remains unchanged when unset).
- **FR-012**: Background daemons and timers that communicate with upstream providers or manage tunnels (`safeRestartTunnel`, `safeRestartTailscale`, `ensureCloudflared`, `autoStartMitm`, `configureTunnelMonitoring`, `startQuotaAutoPing`, `startBackgroundTokenRefresh` in `src/shared/services/initializeApp.js` and `startBackgroundTokenRefreshFromCustomServer` in `custom-server.js`) MUST execute ONLY in the designated leader worker (`KHATAM_WORKER_ROLE === "leader"` / Worker 1) or in single-process mode when the role is unset. Follower workers MUST skip daemon initialization.
- **FR-013**: Periodic SQLite WAL checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)` every 60 s in `src/lib/db/adapters/bunSqliteAdapter.js:87-90`) MUST execute ONLY in the leader worker (`KHATAM_WORKER_ROLE === "leader"`) or in single-process mode when unset. Follower workers MUST NOT register the checkpoint interval.
- **FR-014**: Concurrent SQLite write transactions persisting request usage in `src/lib/db/repos/usageRepo.js:258` (`saveRequestUsage`) MUST acquire write locks upfront via `db.immediate(...)` (`BEGIN IMMEDIATE`), eliminating `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks across worker processes.
- **FR-015**: In-process TTL cache invalidations MUST propagate across worker processes via Redis Pub/Sub (`khatam:events:config_reload`) when Redis is configured, or via Primary IPC broadcast when Redis is unset (`src/lib/redis/events.js` sends `{type:'config_reload', scope}` via `process.send` to the Primary, which broadcasts to sibling workers skipping the sender, and workers emit locally on `localBus`).
- **FR-016**: Inbound reverse proxy trust in `custom-server.js` MUST remain strictly loopback-only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). No external CIDR trust (`TRUSTED_PROXY_CIDRS`) shall be introduced. Direct sockets remain keyed strictly by the TCP peer address.

### Vertical Ladder & Measurement (US3)
- **FR-017**: The performance ladder MUST report single-worker baseline and multi-worker results (1, 2, 4, 6 workers) on THIS host with identical metrics ($p50, p95, p99$, throughput, per-worker RSS, CV%, and errors).
- **FR-018**: The performance report MUST evaluate outcomes against Research D7 targets honestly (reporting missed targets as missed, never claiming targets were met if unmet). Any unmeasured, invalid, or noisy run ($CV \ge 15\%$) cannot certify improvement.
- **FR-019**: Live container validation MUST be delegated to dedicated container subagents (never main agent, never `docker system prune` or `volume prune`), validating only that the single container image (`Dockerfile.bun`) boots with multi-worker support (`KHATAM_WORKERS=2`).

---

## 4. Key Entities & Definitions

- **Primary Supervisor Process**: The lightweight parent process that evaluates CPU sizing, runs database migrations once, forks workers, monitors lifecycle, and brokers IPC messages. Does not bind or serve HTTP traffic.
- **Worker Process**: An independent OS process running the Next.js standalone server and gateway engine, binding the shared port via `node:cluster` kernel `SO_REUSEPORT` socket sharing.
- **Leader Worker**: Worker 1 (`KHATAM_WORKER_ROLE === "leader"`), designated to run single-instance background tasks (OAuth token refresh, startup daemons, and WAL checkpointing).
- **Follower Worker**: Worker $N > 1$ (`KHATAM_WORKER_ROLE === "worker"`), handles HTTP inference traffic, maintains local L1 caches, and skips leader-only background daemons.
- **In-Flight Stream Drain**: The shutdown protocol allowing active SSE token streams to complete before terminating the process.
- **Vertical Ladder Table**: Master benchmark table recording latency percentiles, throughput, per-worker RSS, and honest verdict across worker counts on this host.

---

## 5. Success Criteria & Measurable Oracles

- **SC-001**: Database queries per request in `scripts/perf-l1-harness.mjs` drop to $\le 11.0$ queries/req (reference historical baseline ~15.2 down to ~10.8, $\ge 25\%$ reduction).
- **SC-002**: L1 in-process tail latency ($p95$) drops by $\ge 25.0\%$ (reference historical target ~48% reduction from 5.04 ms to 2.59 ms).
- **SC-003**: 4 vertical workers boot in $< 500\text{ ms}$ on Bun 1.4.3, share port 20128 via `node:cluster` socket sharing, and serve concurrent requests across workers (verified by $\ge 2$ distinct worker PIDs under connection load).
- **SC-004**: During a graceful shutdown drill (`SIGTERM`), an active 10-second streaming completion completes without truncation or dropped chunks.
- **SC-005**: Killing a worker process with `SIGKILL` triggers supervisor restart within 50 ms while sibling workers maintain 100% 200 OK responses on concurrent traffic.
- **SC-006**: Master ladder table in `ladder-results.md` integrates host L0, L1, vertical workers (1, 2, 4, 6), and Redis-down rows with honest D7 evaluation and names next bottlenecks.

---

## 6. Edge Cases & Resilience Behaviors

- **Worker crash mid-stream**: If a worker crashes while streaming tokens, that single socket drops, but the supervisor immediately detects exit code 1 and respawns a replacement worker within backoff limits (`Math.min(250 * 2^restarts, 10000)ms`). Sibling workers continue serving other clients with zero dropped connections.
- **SIGTERM during streaming**: The worker stops accepting new TCP connections (`server.close()`), keeps active sockets alive, and drains tokens up to `KHATAM_DRAIN_TIMEOUT_MS` (30s). Clean exit 0 upon stream completion.
- **Port already bound**: If port 20128 is bound by an external process prior to startup, the Primary or Worker 1 catches `EADDRINUSE`, logs an actionable diagnostic (`[Server] Port 20128 already in use`), and exits with code 1.
- **Redis unavailable**: All worker processes degrade gracefully: concurrency semaphores fall back to in-process limits, circuit breakers fall back to local state, rotation counters fall back to local Map, and cache invalidation falls back to Primary IPC broadcast and 5s hard TTL. Zero request-path exceptions.
- **1-core host**: On a single-core machine or when `KHATAM_WORKERS=1`, the cluster supervisor is completely bypassed, executing single-process mode with zero cluster memory or CPU overhead.
- **SQLite locked during burst**: Under heavy concurrent writes across workers, `busy_timeout = 5000` queues write transactions up to 5 seconds. `db.immediate(...)` prevents `SQLITE_BUSY_SNAPSHOT` lock upgrade aborts, ensuring 100% accounting ledger persistence.
- **Unbounded client model IDs**: Arbitrary client model strings querying `getComboByName` are bounded by the 512-entry LRU cache, preventing memory leaks on negative lookup caching.
- **Routing settings modified**: When admin updates settings, `config_reload` with scope `'settings'` or `'all'` clears combo, alias, and node caches across all workers within $< 1\text{ ms}$ (Redis) or next IPC tick.

---

## 7. Explicit Out of Scope (Reverted Architecture)

The following architectural concepts were merged in PR #76, evaluated, and formally **REVERTED in PR #77**:
- **Horizontal Multi-Replica Compose**: Multi-container scaling via Docker Compose (`--scale 9router=2`, `docker-compose.scale.yml`) is completely out of scope.
- **Nginx Reverse Proxy Load Balancer**: Running an Nginx container (`deploy/nginx-scale.conf`) to balance across containers is out of scope.
- **External Proxy CIDR Trust (`TRUSTED_PROXY_CIDRS`)**: Adding CIDR parsing or trusting non-loopback forwarding headers is out of scope. Security invariant: loopback-only XFF trust is preserved.
- **Multi-Container Smoke Scripts**: Scripts driving multi-container compose scale (`scripts/scale-smoke.sh`) are out of scope.

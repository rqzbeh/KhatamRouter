# Contract: Vertical Multi-Process Worker Architecture & Supervisor Runtime

**Spec**: `specs/008-bun-perf-scale/spec.md` (US2 / FR-007..FR-016)  
**Target Runtime**: Bun 1.4.3 (Linux x86_64 / arm64)  
**Classification**: Runtime Concurrency & Multi-Process Contract

---

## 1. Process Model & Concurrency Contract

KhatamRouter scales vertically on a single host by utilizing multiple operating system worker processes managed by a supervising primary process via Bun's built-in `node:cluster` module.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Primary Supervisor Process                      │
│   • Executes SQLite schema migrations + backup preflight ONCE          │
│     (driver.js runMigrationOnce) BEFORE cluster.fork()                 │
│   • Exports KHATAM_MIGRATIONS_DONE=1 in the worker environment         │
│   • Exports KHATAM_WORKER_ROLE: "leader" for Worker 1, "worker" for N  │
│   • Evaluates host CPU core sizing: Math.max(1, nproc - 2)             │
│   • Forks N worker processes via cluster.setupPrimary({ exec })        │
│   • Monitors worker lifecycle: crash detection with exponential backoff│
│   • IPC Message Bus: broadcasts config_reload across workers           │
│   • Signal forwarding: propagates SIGTERM / SIGINT for graceful drain  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 │ (Bidirectional IPC & Process Fork)    │
                 ▼                                       ▼
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  Worker 1 (KHATAM_WORKER_ROLE   │     │  Worker N (KHATAM_WORKER_ROLE   │
│             = "leader")         │     │             = "worker")         │
│  • Binds PORT (20128) via       │     │  • Binds PORT (20128) via       │
│    own SO_REUSEPORT socket      │     │    own SO_REUSEPORT socket      │
│  • Skips migrations             │     │  • Skips migrations             │
│    (KHATAM_MIGRATIONS_DONE=1)   │     │    (KHATAM_MIGRATIONS_DONE=1)   │
│  • Next.js standalone HTTP app  │     │  • Next.js standalone HTTP app  │
│  • In-process L1 TTL Caches     │     │  • In-process L1 TTL Caches     │
│  • WAL reader/immediate writer  │     │  • WAL reader/immediate writer  │
│  • BACKGROUND TASKS ACTIVE:     │     │  • BACKGROUND TASKS INACTIVE:   │
│    - initializeApp.js daemons   │     │    - Skips initializeApp.js     │
│      (tunnel/tailscale/MITM/    │     │      daemons                    │
│      quota auto-ping)           │     │    - Skips background OAuth     │
│    - OAuth proactive token      │     │      refresh loops              │
│      refresh timer              │     │    - Skips periodic checkpoint  │
│    - WAL checkpoint periodic    │     │  • Graceful drain on SIGTERM    │
│  • Graceful drain on SIGTERM    │     │                                 │
└─────────────────────────────────┘     └─────────────────────────────────┘
```

---

## 2. Environment Variables & Host-Sizing Formula

| Variable | Type / Default | Description |
|---|---|---|
| `KHATAM_WORKERS` | `string \| number`<br>Default: `auto` | Configures worker count.<br>• `auto` / unset: Automatically calculates worker count using host-sizing formula below.<br>• `1`: Single-process mode. Completely bypasses cluster supervisor; runs identical to legacy runtime.<br>• `2..64`: Explicit number of worker processes to spawn. |
| `WEB_CONCURRENCY` | `string \| number`<br>Default: unset | Standard 12-factor fallback alias for `KHATAM_WORKERS` (used only when `KHATAM_WORKERS` is unset). |
| `KHATAM_MIGRATIONS_DONE` | `string`<br>Default: unset | Set to `1` by the Primary before forking workers. Workers skip redundant `runMigrationOnce(adapter)` execution when set (see Section 5.3). |
| `KHATAM_WORKER_ROLE` | `string`<br>Default: unset | Set by the Primary per worker: `"leader"` (Worker 1) or `"worker"` (followers). Unset in single-process mode. Governs leader-only background daemons and WAL checkpoint gates. |
| `KHATAM_DRAIN_TIMEOUT_MS` | `number`<br>Default: `30000` (30s) | Maximum time worker processes allow in-flight streaming requests to finish after receiving `SIGTERM` before terminating. |
| `KHATAM_CRASH_RESET_MS` | `number`<br>Default: `30000` (30s) | Minimum uptime before a worker process is marked healthy and its consecutive crash counter resets to 0. |

### Host-Sizing Formula (Canonical, Scalar)
To avoid CPU starvation of critical background services (Linux kernel TCP stack, epoll, SQLite WAL writer & checkpoint fsync, local Redis server, and Bun JSC garbage collector), worker count MUST NOT allocate 100% of logical CPU cores. The canonical default across this spec package (spec.md, plan.md, tasks.md, research.md, quickstart.md, data-model.md) is a single scalar formula:

$$\text{defaultWorkers} = \max\left(1,\; nproc - 2\right)$$

- `nproc <= 2`: `Math.max(1, nproc - 2) === 1` (single-process mode on tiny hosts).
- `nproc === 8` (this host): **6 workers** (2 cores reserved for kernel/SQLite/Redis/GC).
- Overridable at run time via `KHATAM_WORKERS` (or `WEB_CONCURRENCY` fallback).

> Note: The earlier piecewise formula (with an `nproc > 8` branch flooring at 75% of cores) is removed from this contract; the single scalar `Math.max(1, nproc - 2)` is authoritative everywhere.

---

## 3. Worker Socket Binding & Kernel Port Sharing (Bun 1.4.3 Reality)

1. **Listen Interception**:
   - Next.js standalone server calls `server.listen(port, hostname)` via Node's `http.createServer()`.
   - Under Bun 1.4.3, `node:cluster` intercepts `server.listen()` in worker processes and each worker binds its **own `SO_REUSEPORT` socket** to the identical configured port (`PORT`, default `20128`).
   - **Bun does NOT use Node's master socket passing and does NOT implement `SCHED_RR` connection handoff.** `cluster.schedulingPolicy` is reported by Bun but **ignored** at runtime. There is no listening socket in the Primary; no accept-queue stealing between workers.
2. **Connection Distribution**:
   - Because each worker holds an independent `SO_REUSEPORT` listener, the **Linux kernel distributes new TCP connections by 4-tuple hashing** over `(src_ip, src_port, dst_ip, dst_port)`.
   - Distribution is **balanced over many connections, but NOT guaranteed round-robin**. A small number of long-lived keep-alive connections can land unevenly on a subset of workers (e.g. 4 clients all hashing to one worker). Benchmark and smoke oracles MUST therefore:
     - drive many short-lived connections (`Connection: close`), and
     - assert only `distinctWorkerPids >= 2` for a 4-worker smoke (not exact per-worker evenness).
   - Keep-alive HTTP/1.1 requests on an established TCP connection always remain with the worker serving that socket.
3. **Loopback IP Trust Invariant**:
   - Sockets are accepted directly by worker processes on the host.
   - Forwarding headers (`X-Forwarded-For`, `X-Real-IP`) MUST continue to be trusted **strictly from loopback addresses** (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
   - No external proxy CIDR trust (`TRUSTED_PROXY_CIDRS`) is introduced. Direct/public sockets remain keyed strictly by the peer socket address.
4. **Primary Does Not Serve**: The Primary supervisor never calls `listen`; it only forks, brokers IPC, and monitors.

---

## 4. Single-Leader Background Tasks

Certain background tasks MUST run in exactly ONE process to avoid duplicate upstream API calls, token invalidation, multiple tunnel daemon spawns, and lock contention:

1. **OAuth Token Proactive Refresh**:
   - `custom-server.js` calls `startBackgroundTokenRefreshFromCustomServer()` on server listen.
   - In multi-worker mode, this timer MUST execute only in the designated leader worker (`process.env.KHATAM_WORKER_ROLE === "leader"` or Worker 1).
   - Sibling workers (`KHATAM_WORKER_ROLE === "worker"`) MUST skip starting the periodic refresh interval.
2. **Background Daemons in `initializeApp.js`**:
   - `src/shared/services/initializeApp.js` is bootstrapped via `src/app/layout.js` -> `src/shared/services/bootstrap.js`.
   - Its deferred startup routine `runHeavyStartup()` registers:
     - `safeRestartTunnel("startup")` / `ensureCloudflared()`
     - `safeRestartTailscale("startup")`
     - `autoStartMitm(settings)`
     - `configureTunnelMonitoring(settings)`
     - `startQuotaAutoPing()`
     - `startBackgroundTokenRefresh()`
   - In multi-worker mode, all of these background services MUST execute ONLY when `process.env.KHATAM_WORKER_ROLE === "leader"` or when the role is unset (single-process mode). Follower workers (`KHATAM_WORKER_ROLE === "worker"`) MUST skip `runHeavyStartup()`.
3. **Periodic WAL Checkpoints**:
   - The 60-second `PRAGMA wal_checkpoint(TRUNCATE)` timer in `src/lib/db/adapters/bunSqliteAdapter.js:87-90` runs ONLY in the leader worker (`KHATAM_WORKER_ROLE === "leader"`) or in single-process mode when unset. Follower workers do not register this timer.

---

## 5. SQLite Multi-Writer Safety Contract

1. **Sole Driver**: Native `bun:sqlite` with WAL mode:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA busy_timeout = 5000;
   PRAGMA synchronous = NORMAL;
   PRAGMA temp_store = MEMORY;
   PRAGMA foreign_keys = ON;
   ```
2. **Write Lock Serialization**:
   - All write transactions executing read-then-write sequences (such as `saveRequestUsage` in `src/lib/db/repos/usageRepo.js:258`) MUST use `db.immediate(...)` (`BEGIN IMMEDIATE`).
   - Upfront write lock acquisition prevents `SQLITE_BUSY_SNAPSHOT` deadlocks between concurrent worker processes on the same host. Spike evidence: 90% `SQLITE_BUSY` failures under deferred transactions vs 99.5% success under `BEGIN IMMEDIATE` across 4 concurrent processes (200 ops, 500 ms busy_timeout); re-proven by `tests/unit/usage-concurrent-writers.test.js` using real child processes.
3. **One-Time Startup Migrations**:
   - SQLite migrations (`src/lib/db/migrate.js`) and the backup/integrity preflight MUST be executed by the Primary process BEFORE forking workers (before `cluster.fork()`). Verified problem: `src/lib/db/driver.js:86-90` unconditionally awaits `runMigrationOnce(adapter)` in every process.
   - The Primary exports `KHATAM_MIGRATIONS_DONE=1` into the worker environment. `src/lib/db/driver.js` checks this env and skips `runMigrationOnce(adapter)` when set (workers assume the schema is up to date and never execute DDL migrations concurrently).
   - Single-process mode (`KHATAM_WORKERS=1`, `KHATAM_MIGRATIONS_DONE` unset) keeps the existing behaviour unchanged: migrations run in-process as today.
   - No export symbols are added to or removed from `src/lib/db/adapters/bunSqliteAdapter.js` or `src/lib/redis/events.js` in this wave: the twins parity test `tests/unit/wave75-twins-alignment.test.js` checks exported-symbol parity for both modules, so any wave-8 edits must be internal-only (the test remains green).

---

## 6. In-Process Cache Invalidation & IPC Protocol

Workers maintain in-process TTL caches (5s hard cap) for model aliases, combos, and provider nodes. `comboByNameCache` is a bounded LRU (maximum 512 entries, oldest eviction). Caches invalidate on `khatam:events:config_reload` scopes `aliases`, `combos`, `nodes`, `settings`, and `all`.

1. **When Redis is Configured**:
   - Workers publish and subscribe to `khatam:events:config_reload` via Redis Pub/Sub.
   - Invalidation propagates across all worker processes in `< 1 ms`.
2. **When Redis is Absent (Standalone SQLite)** — Primary IPC broadcast:
   - `src/lib/redis/events.js` `publishKhatamEvent` falls back to an in-process EventEmitter when `REDIS_URL` is unset.
   - In cluster mode, workers additionally send the event to the Primary via `process.send({ type: "config_reload", scope })`.
   - The Primary acts as an IPC invalidation broker, re-broadcasting `config_reload` events to all active sibling workers (skipping the sender to avoid echo loops):
     ```javascript
     // Worker write path:
     process.send({ type: "config_reload", scope: "aliases" });

     // Primary broker:
     cluster.on("message", (worker, msg) => {
       if (msg?.type === "config_reload") {
         for (const id in cluster.workers) {
           if (cluster.workers[id] !== worker) cluster.workers[id].send(msg);
         }
       }
     });
     ```
   - Sibling workers apply the Primary message by emitting it on the local `EventEmitter` bus (`localBus`), which invokes registered cache-invalidation subscribers.
   - If IPC fails, the 5-second hard TTL bounds cross-process staleness.
3. **Settings Scope Invalidation**:
   - `settingsRepo.js:168` publishes `KHATAM_EVENTS.CONFIG_RELOAD` with `scope: "settings"` (and legacy write paths are covered by the `"all"` scope).
   - Any subscriber for `configs` MUST treat scopes `aliases`, `combos`, `nodes`, `settings`, and `all` as invalidation triggers for `aliasRepo`, `combosRepo`, `nodesRepo` and `settingsRepo` caches so routing-setting changes are never served stale.

---

## 7. Graceful Drain, Signal Handling & Crash Backoff

### 7.1 Graceful Drain Sequence
1. **Signal Catch**: Primary receives `SIGTERM` or `SIGINT`. Primary sets `isDraining = true` and forwards `SIGTERM` to all active workers.
2. **Stop Accepting**: Each worker immediately calls `server.close()`. The kernel removes the worker from the listener pool; incoming connections route to surviving workers.
3. **Stream Settlement**: Worker tracks active in-flight requests (`inFlightRequests`). If `inFlightRequests === 0`, worker exits immediately (code 0).
4. **Deadline Enforcement**:
   - Worker enforces `KHATAM_DRAIN_TIMEOUT_MS` (default 30s). If streams remain active after deadline, sockets are destroyed and worker exits (code 0).
   - Supervisor enforces `SUPERVISOR_DRAIN_TIMEOUT_MS = KHATAM_DRAIN_TIMEOUT_MS + 5000`. If worker is still alive after 35s, supervisor issues `SIGKILL`.

### 7.2 Crash Recovery with Exponential Backoff
1. **Healthy Run Reset**: If a worker runs continuously for $> 30\text{ seconds}$, its consecutive crash counter resets to 0.
2. **Rapid Crash Detection**: If a worker exits within $< 5000\text{ ms}$ of boot:
   - Increment `crashCount++`.
   - Calculate restart delay: `delayMs = Math.min(250 * Math.pow(2, crashCount), 10000)`.
   - Schedule respawn after `delayMs`.
3. **Alerting**: If 5 consecutive rapid crashes occur, log high-priority alert (`[Supervisor] Worker crashed 5 consecutive times in rapid succession. Throttling restarts to 10s.`). Sibling workers continue serving traffic.

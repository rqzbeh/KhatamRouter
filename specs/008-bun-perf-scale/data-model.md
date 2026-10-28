# Data Model: Wave 8 — Bun Hot-Path Slim and Vertical Scale

No persistent database schema changes. This document defines the measurement, runtime topology, and telemetry data models produced and consumed by the vertical scaling feature.

---

## 1. L1Profile (JSON, written by `scripts/perf-l1-harness.mjs`)

Granular in-process performance breakdown captured across request processing phases.

| Field | Type | Description |
|---|---|---|
| `schema` | `string` | Contract version identifier: `khatam.perf.l1/1`. |
| `label` | `string` | Run label: `baseline` or `after-slim`. |
| `git_sha` | `string` | Commit SHA of the measured codebase. |
| `bun_version` | `string` | Bun runtime version (from `Bun.version`, e.g. `1.4.3`). |
| `env` | `object` | Environment metadata: `{ cpu_model, cpus, node_env, redis: "on" \| "off", data_dir: "temp" }`. |
| `workload` | `object` | Execution workload specification: `{ requests, warmup, runs, mix: { direct, translated, combo } }`. |
| `phases_ms` | `object` | Per-phase percentiles `{ p50, p95, p99, mean }` for `auth_acl`, `model_info`, `translate`, `dispatch_glue`. |
| `total_ms` | `object` | Total in-process request latency percentiles `{ p50, p95, p99, mean }`. |
| `db_queries_per_req` | `number` | Average SQLite queries per request intercepted at adapter level (the slimming proof). |
| `run_means_ms` | `number[]` | Array of mean latency across runs. Reported summary is the median of means. |

**Validation Rules**:
- `runs >= 5`, `warmup >= 50`.
- Coefficient of variation ($CV = \frac{\text{stddev}}{\text{mean}}$) must be $< 15.0\%$. Runs with $CV \ge 15.0\%$ are marked `noisy` and cannot certify improvement.

---

## 2. VerticalWorkerTopology (In-Memory Runtime State)

Internal topology maintained by the primary supervisor process in `src/lib/cluster/supervisor.js`.

| Field | Type | Description |
|---|---|---|
| `primaryPid` | `number` | OS Process ID of the supervisor process. |
| `mode` | `string` | `"cluster"` (multi-process) or `"single"` (`KHATAM_WORKERS=1` or 1-core host). |
| `workerCount` | `number` | Number of active worker child processes (`1..64`); default `Math.max(1, nproc - 2)`, overridable via `KHATAM_WORKERS` (fallback `WEB_CONCURRENCY`). |
| `port` | `number` | TCP listen port shared across workers (`PORT`, default `20128`) via per-worker `SO_REUSEPORT` sockets. |
| `migrationsDone` | `boolean` | `true` when the Primary has completed `runMigrationOnce(adapter)` and exported `KHATAM_MIGRATIONS_DONE=1` to workers; workers skip re-running migrations when this is `true`. |
| `workers` | `Map<number, WorkerState>` | Map of active worker processes keyed by cluster worker ID. |
| `isDraining` | `boolean` | `true` when supervisor has received `SIGTERM` / `SIGINT` and is draining. |

### WorkerState Sub-Entity

| Field | Type | Description |
|---|---|---|
| `id` | `number` | Cluster worker identifier (1-indexed). |
| `pid` | `number` | Operating system child process ID. |
| `role` | `string` | `"leader"` (Worker 1 / `KHATAM_WORKER_ROLE === "leader"`: runs background OAuth refresh, `initializeApp.js` daemons, WAL checkpoint timer) or `"worker"` (`KHATAM_WORKER_ROLE === "worker"`: standard HTTP handler, no leader-only daemons). |
| `migrationsSkipped` | `boolean` | `true` when the worker observed `KHATAM_MIGRATIONS_DONE=1` and skipped `runMigrationOnce(adapter)`. |
| `walCheckpointActive` | `boolean` | `true` only for the leader worker: 60 s `PRAGMA wal_checkpoint(TRUNCATE)` timer is registered. |
| `state` | `string` | `"booting"` \| `"ready"` \| `"draining"` \| `"exited"`. |
| `bootTime` | `number` | Epoch timestamp of worker start. |
| `consecutiveCrashes` | `number` | Number of rapid crashes within `< 5000ms` window. |
| `inFlightRequests` | `number` | Number of currently active HTTP/SSE connections. |

---

## 3. VerticalLadderRow (Markdown Table Rows in `ladder-results.md`)

Master benchmark row schema for single-host vertical scaling evaluation.

| Field | Type | Format / Constraints | Description |
|---|---|---|---|
| `tier` | `string` | `L0 micro` \| `L1 harness` \| `L2 loopback` \| `Vertical <N>-worker` | Performance tier. |
| `workers` | `number` | Integer `1..64` | Configured worker process count. |
| `p50_ms` | `number \| string` | Decimal number or `UNMEASURED` | 50th percentile latency in milliseconds. |
| `p95_ms` | `number \| string` | Decimal number or `UNMEASURED` | 95th percentile latency in milliseconds. |
| `p99_ms` | `number \| string` | Decimal number or `UNMEASURED` | 99th percentile latency in milliseconds. |
| `req_per_s` | `number \| string` | Decimal number or `UNMEASURED` | Requests served per second. |
| `rss_mb` | `number \| string` | Decimal number or `UNMEASURED` | Aggregate / per-worker resident set memory footprint in MB. |
| `mode` | `string` | `normal` \| `degraded` | Operational state (`degraded` when Redis is halted). |
| `cv_pct` | `string` | Percentage string (e.g. `5.39%`) | Coefficient of variation across runs. |
| `errors` | `number` | Integer (must be 0 for passing runs) | Non-2xx response or dropped connection count. |
| `env` | `string` | String | Host machine, CPU cores, RAM, OS, Bun version. |
| `command` | `string` | Command line string | Exact reproducible command. |
| `cause` | `string` | String (required if any cell is `UNMEASURED`) | Technical explanation for unmeasured cell or operational notes. |

---

## 4. WorkerLifecycleEvent (IPC & Logging Telemetry)

Structured lifecycle messages exchanged between Primary supervisor and Worker processes.

```text
WorkerLifecycleEvent (plain JS object shapes, no TypeScript)
  { type: "ready"; workerId: number; pid: number; role: "leader" | "worker" }
  { type: "config_reload"; scope: "aliases" | "combos" | "nodes" | "settings" | "all"; timestamp: number; source?: string }
  { type: "in_flight"; count: number }
  { type: "drain"; deadlineMs: number }
  { type: "exit"; workerId: number; code: number; signal: string; uptimeMs: number }
```

**IPC rules**:
- Workers send `config_reload` to the Primary with `process.send(...)`. The Primary re-broadcasts to every sibling worker (skipping the sender, avoiding echo loops).
- Receiving workers apply the payload by emitting it on the local `EventEmitter` bus (`src/lib/redis/events.js` `localBus`), which invokes registered cache invalidators.
- When Redis is configured, the channel `khatam:events:config_reload` carries the same payload via Pub/Sub; Primary IPC is not used for fan-out.

### Worker identity (Bun 1.4.3)

Workers are 1-indexed (`cluster.workers` keys `"1".."N"`). Worker 1 receives `KHATAM_WORKER_ROLE="leader"`; all others receive `"worker"`. In single-process mode `KHATAM_WORKER_ROLE` is unset and every leader-only gate is satisfied (legacy behaviour preserved). There is no `Worker 0`.

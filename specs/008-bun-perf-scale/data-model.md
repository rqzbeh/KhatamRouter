# Data Model: 008-bun-perf-scale

No database schema changes. These are the measurement and config entities the feature produces or consumes.

## L1Profile (JSON, written by `scripts/perf-l1-harness.mjs`)

| Field | Type | Notes |
|---|---|---|
| `schema` | string | `khatam.perf.l1/1` |
| `label` | string | `baseline` or `after-<change>` |
| `git_sha` | string | commit measured |
| `bun_version` | string | from `Bun.version` |
| `env` | object | `{cpu_model, cpus, node_env, redis: "on"\|"off", data_dir: "temp"}` |
| `workload` | object | `{requests, warmup, runs, mix: {direct, translated, tools, combo}}` |
| `phases_ms` | object | per-phase `{p50, p95, p99, mean}` for `auth_acl`, `model_info`, `translate`, `dispatch_glue` |
| `total_ms` | object | `{p50, p95, p99, mean}` |
| `db_queries_per_req` | number | counted via adapter wrapper; the slimming proof |
| `run_means_ms` | number[] | per-run means; the reported figure is the median of means |

**Validation**: `runs >= 5`, `warmup >= 50`. A run whose coefficient of variation exceeds 15% is flagged `noisy`, and the figure cannot certify a win (spec edge case).

## LadderRow (markdown table rows in `ladder-results.md`)

| Field | Notes |
|---|---|
| `tier` | L0/L1/L2/L3 |
| `replicas` | 1, 2, 4 (L3) |
| `p50/p95/p99_ms`, `req_per_s` | numbers or the literal `UNMEASURED` |
| `command`, `env` | exact reproduction |
| `cause` | required when any metric is `UNMEASURED` |
| `mode` | `normal` or `degraded` (Redis down mid-run) |

## ReplicaTopology (compose, not stored)

`{lb: nginx@20128, app: N replicas, redis: redis:8.2-alpine, volume: 9router-data (single host)}`

## SharedStateItem (audit inventory, from research-scale.md §2–3)

| Item | Tier | Redis key |
|---|---|---|
| Concurrency semaphores | Redis ZSET + Lua | `khatam:semaphore:*` |
| Circuit-breaker trips | Pub/Sub + mirror | `khatam:events:circuit_trip` |
| Combo/proxy rotation | Redis `INCR` | `khatam:counter:*` |
| OAuth refresh lock | Redis `SET NX EX` | `khatam:lock:refresh:*` |
| Login limiter | Redis JSON + TTL | `khatam:ratelimit:login:*` |
| API-key auth | SQLite authoritative, Redis advisory | `khatam:cache:auth:key:*` |
| Settings, aliases, combos, usage | SQLite | n/a |

# Research Index: 008-bun-perf-scale (node-1.1 integration — Vertical Scaling)

Scope: Branch integration for Wave 8 research. Integrates L1 hot-path profiling (`research-profile.md`), vertical multi-process runtime research (`research-vertical-runtime.md`), and performance ladder methodology (`research-ladder.md`). Notes `research-scale.md` as superseded following PR #77 reversion.

## Note Inventory

| Leaf | File | Size | Delivers |
|---|---|---|---|
| 1.1.1 | `specs/008-bun-perf-scale/research-profile.md` | ~15.6 KB, 7 `##` sections | L1 attribution 40/35/25 (model-info+DB / translation / middleware), slim plan (~2.2ms cache + ~1.5ms short-circuit), re-measure protocol, golden regression guard |
| 1.1.2 | `specs/008-bun-perf-scale/research-vertical-runtime.md` | ~22.8 KB, 8 `##` sections | Evaluates Bun concurrency options (Bun.serve reusePort vs node:cluster vs worker threads). Proves `node:cluster` natively shares listen sockets across workers without EADDRINUSE on Bun 1.4.3 via per-worker `SO_REUSEPORT` binds (kernel 4-tuple hashing, `cluster.schedulingPolicy` ignored). Establishes the canonical host-sizing formula `Math.max(1, nproc - 2)`, Primary one-time migrations (`KHATAM_MIGRATIONS_DONE=1`), leader-only background tasks (Worker 1 / `KHATAM_WORKER_ROLE === "leader"` with `KHATAM_WORKER_ROLE === "worker"` followers skip daemons and WAL checkpoints), IPC broadcast cache invalidation, graceful drain (30s), and rapid-crash backoff (`Math.min(250 * 2^restarts, 10000)ms` in a `<$\text{5000 ms}$ crash window`). |
| 1.1.3 | `specs/008-bun-perf-scale/research-ladder.md` | ~25.0 KB, 11 `##` sections | L0–L3 ladder with **L3 = vertical multi-worker tier on one host** (1/2/4/6 workers via `KHATAM_WORKERS`) plus a Redis-down degraded row; baseline inventory with measured L0 cells, UNMEASURED-with-cause L1–L3 cells, ceiling-moved verdict criteria (p50 $\ge$ −35%, p95 $\ge$ −25%, `db_queries_per_req` $\le 11.0$), next-bottleneck hypotheses. The reverted compose/nginx L3 tier appears only in the clearly-labelled "Superseded (reverted PR #76/#77)" note and is inactive for measurement. |
| [SUPERSEDED] | `specs/008-bun-perf-scale/research-scale.md` | ~25.5 KB, 10 `##` sections | [SUPERSEDED] Historical horizontal multi-replica compose research. Merged in PR #76, formally reverted in PR #77. Preserved for lineage. |

Each active note attests `check_index_coverage` over relied files and ends in a `## Handoff` mapping findings to functional requirements.

## Shared-Contract Agreement

| Contract | Profile | Vertical Runtime | Ladder | Verdict |
|---|---|---|---|---|
| Dashboard/gateway port 20128, `PORT`/`DASHBOARD_PORT` | assumed | verified `node:cluster` shared port 20128 | assumed | AGREE |
| `DATA_DIR` controls `data.sqlite`; temp `DATA_DIR` for bench runs; prod `~/.9router` untouched | temp DATA_DIR + mock executor | temp DATA_DIR + isolated SQLite | `mktemp -d`, `PORT=29128` isolation | AGREE |
| Fail-open quota/limit/lease/breaker paths, fail-closed auth (SQLite authority) | assumed via guard | verified per-subsystem with file:line cites | assumed via drill | AGREE |
| Bun-only (`bun:sqlite` sole driver), no Node fallback | stated | verified under Bun 1.4.3 | measured 50ms gate | AGREE |
| Webpack retained, no Turbopack re-litigation | — | — (no note proposes Turbopack) | — | AGREE |
| Loopback-only XFF trust strictly preserved (no external proxy trust) | — | confirmed workers share loopback/public sockets; loopback-only trust is safe and sufficient | — | AGREE |
| Docker runs via subagents only; never `prune` (FR-019; single-container multi-worker test only) | — | stated | stated | AGREE |
| Scalar worker sizing `Math.max(1, nproc - 2)` (one formula everywhere, WHAM/lab no piecewise) | — | codified | ladder assumes 6 workers on 8 cores | AGREE |
| Primary-only migrations with `KHATAM_MIGRATIONS_DONE=1` worker skip gate | — | codified | ladder workers never re-run migrations | AGREE |
| Leader-only daemons (tunnel, tailscale, MITM, quota auto-ping, token refresh) + WAL checkpoint gate on `KHATAM_WORKER_ROLE` | — | codified (`initializeApp.js`, `custom-server.js:151-153`, `bunSqliteAdapter.js:87-90`) | ladder asserts no follower daemons | AGREE |
| IPC broadcast cache invalidation (`process.send` -> `cluster.on('message')` -> sibling workers skipping sender -> local `EventEmitter` emit) when Redis is absent; Redis Pub/Sub when present; 5s hard TTL backstop; NO `PRAGMA data_version` polling | — | codified | ladder drills Redis-down row using local/IPC state | AGREE |
| Duo parity: `bunSqliteAdapter` and `redis/events` exported symbol parity must be preserved via internal-only edits | — | codified (twins test `tests/unit/wave75-twins-alignment.test.js`) | — | AGREE |

## Cross-Note Consistency & Architectural Decisions

- **Hot-Path Slimming (US1)**:
  - Hotspot lists agree: uncached `getComboByName`/`getModelAliases`/`getProviderNodes`, repeated linear `findModel` array scans, and regex recompilation in `matchPattern`.
  - Solutions: In-memory TTL caches (5s hard cap) with bounded-LRU `comboByNameCache` (max 512 entries, oldest eviction) in `aliasRepo.js`, `combosRepo.js`, and `nodesRepo.js`; module-load `Map<modelId, entry>` in `providerModels.js`; regex LRU cache in `pricing.js`; request-scoped `keyRecord` reuse in `chat.js` and `keyAccess.js`; `settings`-scope invalidation wiring; `db.immediate()` in `usageRepo`.
  - Invariant: Auth/API-key lookups are NEVER cached across requests.
- **Vertical Multi-Process Scale (US2)**:
  - Process model: Primary supervisor + N workers using Bun 1.4.3 built-in `node:cluster` with per-worker `SO_REUSEPORT` sockets; Primary never listens.
  - Migrations: Primary runs `runMigrationOnce(adapter)` and backup preflight once before `cluster.fork()`; exports `KHATAM_MIGRATIONS_DONE=1`; workers short-circuit migrations. Single-process mode behavior unchanged.
  - Leader-only daemons and timers: `initializeApp.js` `runHeavyStartup()` (`safeRestartTunnel`, `safeRestartTailscale`, `ensureCloudflared`, `autoStartMitm`, `configureTunnelMonitoring`, `startQuotaAutoping`, `startBackgroundTokenRefresh`) plus `custom-server.js:151-153` `startBackgroundTokenRefreshFromCustomServer` and the 60s WAL checkpoint timer all run only when `KHATAM_WORKER_ROLE === "leader"` or unset; followers skip.
  - Graceful drain: On `SIGTERM`, worker calls `server.close()`, drains in-flight chat streams up to `KHATAM_DRAIN_TIMEOUT_MS` (30s), and exits.
  - Crash recovery: Rapid-crash backoff `Math.min(250 * 2^restarts, 10000)ms` when crash window $< 5000\text{ ms}$.
  - Multi-writer SQLite safety: `db.immediate(...)` write serialization prevents `SQLITE_BUSY_SNAPSHOT` lock upgrade aborts, proven by real child-process test.
  - Security: Loopback-only XFF trust in `custom-server.js` is preserved untouched (`custom-server.ts` NOT touched in Wave 8). No external proxy CIDR trust.
- **Vertical Ladder Benchmark (US3)**:
  - Evaluation across 1, 2, 4, and 6 vertical workers on THIS host using loopback load driver `scripts/perf-ladder.sh` driving many `Connection: close` requests, distributing via kernel 4-tuple hashing to assert only `>= 2` distinct worker PIDs on the 4-worker smoke.
  - Honest reporting: Evaluates against D7 thresholds, reports host CPU saturation if cores saturate, documents per-worker RSS (reference: ~101 MB idle, ~150-220 MB peak), and includes Redis-down degraded row.

## Handoff Readiness

All requirements FR-001..FR-019 have an owning research finding; every unmeasured cell carries cause; no note contradicts another on shared contracts. Ready for implementation planning.

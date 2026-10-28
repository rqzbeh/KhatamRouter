# Specification Quality Checklist: Wave 8 — Bun Hot-Path Slim and Vertical Scale

**Purpose**: Validate specification completeness, quality, and vertical scaling boundaries before proceeding to implementation  
**Created**: 2026-10-27  
**Feature**: `specs/008-bun-perf-scale/spec.md`

---

## 1. Vertical Scaling Architectural Boundaries

- [x] Scope is strictly vertical scaling on ONE Bun host (multi-core, multi-process architecture).
- [x] Zero active instructions for horizontal compose replicas, Nginx load balancers, or `docker-compose.scale.yml`.
- [x] Zero active instructions for `TRUSTED_PROXY_CIDRS`; loopback-only reverse proxy trust in `custom-server.js` is preserved strictly.
- [x] Supervising primary process and worker processes communicate via `node:cluster` kernel port sharing on Bun 1.4.3.
- [x] Host sizing formula is the single scalar `Math.max(1, nproc - 2)` (KHATAM_WORKERS / WEB_CONCURRENCY overridable), reserving cores for Linux kernel TCP/epoll, SQLite WAL writer & checkpoint fsync, Redis server, and Bun JSC GC; no piecewise variant remains anywhere in this spec package.
- [x] Primary runs SQLite migrations (`src/lib/db/driver.js:86-90`) and backup preflight ONCE before `cluster.fork()`; workers receive `KHATAM_MIGRATIONS_DONE=1` and skip `runMigrationOnce`; single-process mode keeps legacy migration behaviour.
- [x] Leader-only background daemons: `initializeApp.js` tunnel/tailscale/`ensureCloudflared`/MITM/quota-auto-ping/token-refresh daemons and `custom-server.js:151-153` `startBackgroundTokenRefreshFromCustomServer` run only in Worker 1 (`KHATAM_WORKER_ROLE === "leader"`) or unset (single process); WAL checkpoint timer (`bunSqliteAdapter.js:87-90`) is leader-only.
- [x] Compatibility: `KHATAM_WORKERS=1` (or 1-core machine) runs single-process mode identically to legacy runtime.

## 2. Hot-Path Slimming & Re-Land Contract

- [x] Independent hot-path optimizations from commit `6768fb82` identified for re-landing (L1 harness, TTL caches with bounded LRU max 512 for `comboByNameCache`, Map index, regex memoization, request-scoped reuse, `db.immediate`).
- [x] Auth/API-key lookups are NEVER cached across requests (revoked/expired keys fail immediately; SQLite is authoritative).
- [x] Performance targets stated as REFERENCE TARGETS ONLY, re-measured on the current tree: p95 tail latency target ($\ge 25\%$) with reference historical ~48%; p50 median latency target ($\ge 35\%$) with reference historical ~24–29%; gated acceptance thresholds are p50 $\ge -35\%$, p95 $\ge -25\%$, `db_queries_per_req` $\le 11.0$ (SC-001), all evaluated honestly with misses reported as missed.
- [x] Database query reduction verified via adapter query interception (reference historical: queries drop from 15.2 to ~10.8 per request; current tree re-measures its own baseline).
- [x] Zero behavior regressions on translator golden suites and unit baselines.

## 3. Concurrency, Resilience & Edge Cases

- [x] Worker crash mid-stream: Supervisor detects exit and respawns replacement with exponential backoff; sibling workers continue serving without dropped turns.
- [x] Graceful drain on `SIGTERM`: Workers close listening sockets immediately, drain in-flight streams up to `KHATAM_DRAIN_TIMEOUT_MS` (30s), and exit cleanly.
- [x] Single-leader background tasks: proactive OAuth token refresh, `initializeApp.js` startup daemons, and periodic WAL checkpoints execute in leader worker (Worker 1 / `KHATAM_WORKER_ROLE === "leader"`) only.
- [x] SQLite multi-writer safety: `db.immediate()` (`BEGIN IMMEDIATE`) write serialization in `usageRepo.saveRequestUsage` prevents `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks; proven by real child-process test (`tests/unit/usage-concurrent-writers.test.js`).
- [x] Cross-process cache invalidation: Redis Pub/Sub (`khatam:events:config_reload`) when Redis is active; Primary IPC broadcast (`process.send` -> `cluster.on('message')` -> sibling `worker.send`, sender skipped) when standalone SQLite; 5 s hard TTL is the backstop (NOT PRAGMA `data_version` polling).
- [x] Cache invalidation covers scopes `aliases`, `combos`, `nodes`, `settings`, `all` so routing-setting changes (`settingsRepo.js:168` publishes scope `settings`) are never served stale.
- [x] Redis outage degradation: All subsystems degrade gracefully to in-process/IPC coordination without request-path exceptions.

## 4. Feature Readiness & Measurable Oracles

- [x] All functional requirements (FR-001..FR-019) have concrete, measurable oracles and owning tasks.
- [x] All success criteria (SC-001..SC-006) define verifiable outcomes.
- [x] No [NEEDS CLARIFICATION] markers remain.
- [x] Task file ownership sets are verified completely disjoint (parsed mechanically from the 'Owns' lines; zero duplicate paths).
- [x] Live Docker verification delegated to container subagents only (never main agent, no prune commands, single container multi-worker test only).
- [x] Twins parity constraint recorded: `tests/unit/wave75-twins-alignment.test.js` asserts exported-symbol parity for `bunSqliteAdapter` and `redis/events`; Wave 8 edits to those files are internal-only (no export add/remove/rename).

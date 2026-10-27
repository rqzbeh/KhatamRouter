# Implementation Plan: Wave 8 — Bun Hot-Path Slim and Vertical Scale (multi-core / multi-process on one host)

**Branch**: `spec/008-vertical-scale` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `specs/008-bun-perf-scale/spec.md`  

---

## 1. Executive Summary

Wave 8 delivers **vertical scaling on a single Bun host**: unlocking all available host CPU cores without introducing external multi-replica container overlays, Nginx load balancers, or `TRUSTED_PROXY_CIDRS`.

Execution progresses strictly sequentially:
1. **US1 (P1, MVP)**: Re-land the independent hot-path performance work from reverted commit `6768fb82` (L1 harness, TTL caches for aliases/combos/nodes with a bounded 512-entry LRU for `comboByNameCache` and `settings`-scope invalidation, module-load `Map` index in `providerModels.js`, regex memoization in `pricing.js`, request-scoped reuse in `chat.js`, and `db.immediate()` SQLite write serialization). Measure before/after with `scripts/perf-l1-harness.mjs` and evaluate against Research D7 targets honestly. The historical `6768fb82` figures (p95 ~-48%, p50 ~-24..29%, ~15.2 -> ~10.8 queries/req, ~101 MB RSS, ~180–200 req/s) are **reference targets only** and must be re-measured on the current tree; the gating thresholds are p50 $\ge -35\%$, p95 $\ge -25\%$, `db_queries_per_req` $\le 11.0$ (SC-001). Misses are reported as misses.
2. **US2 (P2)**: Vertical multi-process concurrency on Bun 1.4.3 via built-in `node:cluster`. The Primary supervisor runs SQLite migrations and the backup/integrity preflight once, exports `KHATAM_MIGRATIONS_DONE=1`, computes host sizing (`Math.max(1, nproc - 2)`), forks N worker processes sharing port 20128 via per-worker `SO_REUSEPORT` sockets, brokers IPC cache invalidations, restarts crashed workers with exponential backoff, and coordinates graceful stream drain on `SIGTERM` (30s timeout). Leader-only work (Worker 1, `KHATAM_WORKER_ROLE === "leader"`): `initializeApp.js` startup daemons, OAuth token refresh, and the WAL checkpoint timer. Followers (`KHATAM_WORKER_ROLE === "worker"`) skip all of it. Loopback-only reverse proxy trust in `custom-server.js` is preserved untouched (no `TRUSTED_PROXY_CIDRS`). Single-worker compatibility (`KHATAM_WORKERS=1`) is strictly preserved. `custom-server.ts` does not exist in this wave's touch list.
3. **US3 (P3)**: Vertical performance ladder: benchmark 1 vs 2 vs 4 vs 6 workers on THIS host using loopback load driver `scripts/perf-ladder.sh`. Document throughput scaling, latency percentiles, per-worker RSS (reference: ~101 MB idle, ~150–220 MB peak), host CPU saturation, Redis-down degraded row, and honest ceiling verdict. Delegated container subagent verifies single-container multi-worker boot.

---

## 2. Technical Context

- **Language / Runtime**: JavaScript (ESM), Bun 1.4.3 (Strictly Bun-only; NO Node fallback drivers, NO TypeScript in engine).
- **Concurrency Mechanism**: `node:cluster` built into Bun 1.4.3. Native kernel-level listen socket sharing on port 20128.
- **Primary Dependencies**: Next.js 16 (Webpack retained), `ioredis`, `bun:sqlite`, vitest (Bun host).
- **Storage Tier**: Native `bun:sqlite` in WAL mode (`busy_timeout = 5000`, `temp_store = MEMORY`) with `db.immediate()` write serialization + Redis `khatam:` prefix (fail-open except auth).
- **Testing**: `bun x vitest run` from `tests/`; baselines `tests/__baseline__/verify-*.mjs`; translator goldens.
- **Target Platform**: Single Linux host (AMD Ryzen 7 4800H WSL2, 8 physical cores / 16 threads, 7.8 GB RAM).
- **Security Boundary**: Loopback-only XFF trust in `custom-server.js` strictly preserved. Auth is fail-closed and NEVER cached across requests.

---

## 3. Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| **I Upstream Integrity** | PASS | Additive in-process TTL caches, O(1) Map index, and cluster supervisor. Zero upstream routing logic removed. |
| **II Single Runtime, Port Contract** | PASS | Bun 1.4.3 only. All workers bind the single port 20128 with their own `SO_REUSEPORT` sockets via `node:cluster`. Zero port offset proxies or external forwarders. |
| **III SQLite WAL + Redis Hybrid** | PASS | SQLite remains authoritative. `db.immediate()` write serialization eliminates lock upgrade deadlocks. Redis Pub/Sub provides sub-millisecond cache invalidation with IPC broadcast fallback. |
| **IV Graph-First Discovery** | PASS | Graph index verified with `check_index_coverage` on all relied files. |
| **V Spec-Kit + Unlazy** | PASS | Spec package in `specs/008-bun-perf-scale/`, Unlazy gates in `.unlazy/008-bun-perf-scale/`. |
| **VI Resilience, Stealth** | PASS | Loopback-only XFF trust preserved byte-for-byte (no `TRUSTED_PROXY_CIDRS`, zero attack surface expansion). Auth is fail-closed. Redis outage degrades gracefully to in-process/IPC handling. |

---

## 4. Project Structure

### Documentation (`specs/008-bun-perf-scale/`)
```text
specs/008-bun-perf-scale/
├── spec.md                         # Feature specification (vertical multi-process scale)
├── plan.md                         # Implementation plan (this document)
├── tasks.md                        # Dependency-ordered tasks T001..T030
├── research.md                     # Architectural decisions D1..D11
├── research-index.md               # Research inventory and contract agreement
├── research-vertical-runtime.md    # Bun 1.4.3 multi-process runtime research & measurements
├── research-profile.md             # L1 hot-path attribution research
├── research-ladder.md              # Performance ladder methodology
├── research-scale.md               # [SUPERSEDED] Historical horizontal research
├── data-model.md                   # L1Profile, VerticalWorkerTopology, VerticalLadderRow
├── quickstart.md                   # Operational verification guide
├── checklists/requirements.md      # Specification quality checklist
└── contracts/
    ├── vertical-workers.md         # Worker lifecycle, IPC protocol, sizing, drain contract
    └── perf-harness.md             # L1 harness & vertical ladder CLI contract
```

### Source Touch List

```text
# US1: Hot-Path Slimming (Re-landed from 6768fb82)
scripts/perf-l1-harness.mjs         # In-process L1 gateway harness
scripts/perf-l0-micro.mjs           # Sub-microsecond micro-benchmark runner
scripts/perf-mock-upstream.mjs      # Fast mock upstream streaming server
src/lib/db/repos/aliasRepo.js       # In-memory TTL cache for modelAliases
src/lib/db/repos/combosRepo.js      # In-memory TTL cache for getComboByName
src/lib/db/repos/nodesRepo.js       # In-memory TTL cache for getProviderNodes
src/lib/db/index.js                 # Cache invalidation hooks on write / importDb
src/lib/db/repos/usageRepo.js       # db.immediate() write lock serialization
open-sse/config/providerModels.js   # Module-load Map index for findModel
open-sse/providers/pricing.js       # Memoized RegExp cache in matchPattern
open-sse/handlers/chatCore.js       # Transport memoization tweak
src/sse/handlers/chat.js            # Request-scoped keyRecord and combo reuse
src/sse/services/keyAccess.js       # keyAccessContextFromRecord reuse helper
src/sse/services/model.js           # Pre-resolved combo parameter in getModelInfo

# US2: Vertical Multi-Process Supervisor Runtime
src/lib/cluster/supervisor.js       # Primary supervisor: CPU sizing, one-time migrations, env export, fork, crash backoff, IPC broker
src/lib/cluster/worker.js           # Worker lifecycle: role detection, graceful drain, IPC client (config_reload relay)
src/lib/db/driver.js                # KHATAM_MIGRATIONS_DONE=1 skip gate for runMigrationOnce (internal edit, no export change)
src/lib/db/adapters/bunSqliteAdapter.js  # Leader-only WAL checkpoint timer (internal edit, no export change - twins parity test)
src/lib/redis/events.js             # IPC fallback: worker->Primary process.send, Primary broadcast, sibling local emit (no export change - twins parity test)
src/shared/services/initializeApp.js  # Gate heavy startup daemons behind leader/unset role
tests/unit/wave75-twins-alignment.test.js constraint  # bunSqliteAdapter/events twin files MUST keep exported-symbol parity (internal edits only)
custom-server.js                    # Cluster primary branch, leader-gated token refresh registration (custom-server.ts NOT touched in Wave 8)
scripts/copy-standalone-assets.mjs  # Include cluster modules in standalone package
scripts/vertical-smoke.sh           # Host multi-worker smoke validation drill

# US3: Vertical Ladder Benchmark
scripts/perf-ladder.sh              # Loopback load driver supporting vertical worker counts
scripts/perf-ladder-lib.mjs         # Ladder benchmark runner library
scripts/perf-ladder-seed.mjs        # Database fixture seeding for ladder runs
specs/008-bun-perf-scale/results/ladder-host.md  # Host ladder measurements (1, 2, 4, 6 workers)
specs/008-bun-perf-scale/ladder-results.md       # Integrated master ladder table & honest verdict

# Tests
tests/unit/perf-harness.test.js
tests/unit/model-info-cache.test.js
tests/unit/model-index-map.test.js
tests/unit/pattern-match-cache.test.js
tests/unit/request-scoped-reuse.test.js
tests/unit/usage-concurrent-writers.test.js
tests/unit/import-db-cache-invalidation.test.js
tests/unit/model-reserved-prefix.test.js
tests/unit/vertical-cluster-supervisor.test.js
tests/unit/vertical-custom-server-integration.test.js
tests/unit/cluster-database-roles.test.js
tests/unit/perf-ladder-contract.test.js
```

---

## 5. Implementation Phases & Gate Progression

Execution proceeds through six strictly ordered phases:

```
[Phase 1: Setup] ──► [Phase 2: Guard Baseline]
                            │
                            ▼
           [Phase 3: US1 Hot-Path Slimming] (T004..T013)
           • L1 harness, TTL caches (512-entry LRU + settings scope), Map index, regex cache, request reuse, db.immediate
           • Exit Gate: guard-after diff zero, db_queries_per_req <= 11.0, p95 reduced >=25%, p50 honest
                            │
                            ▼
           [Phase 4: US2 Vertical Runtime] (T014..T024)
           • node:cluster supervisor, one-time migrations, worker lifecycle, IPC invalidation,
             leader-only daemons + WAL checkpoint, graceful drain, loopback XFF
           • Exit Gate: cluster tests pass, smoke drill shows >=2 worker PIDs, container subagent boots 2 workers
                            │
                            ▼
           [Phase 5: US3 Vertical Ladder] (T025..T027)
           • perf-ladder.sh driver, 1 vs 2 vs 4 vs 6 workers on host, ladder-results.md
           • Exit Gate: honest D7 evaluation, per-worker RSS, host saturation documented
                            │
                            ▼
           [Phase 6: Polish & Closeout] (T028..T030)
           • README, ROADMAP, CHANGELOG, PERFORMANCE.md, full vitest suite green, PR audit
```

### Phase Details

#### Phase 1: Setup & Preflight (T001–T002)
- Confirm Bun 1.4.3 environment.
- Document baseline test results against `tests/__baseline__/known-fails.txt` in `results/preflight.md`.

#### Phase 2: Foundational Regression Guard (T003)
- Capture pre-change regression baseline (`results/guard-before.txt`) covering alias/provider snapshot verifiers and golden translator suites.

#### Phase 3: User Story 1 — Hot-Path Slimming & Re-Land (T004–T013)
- Re-land independent hot-path work from commit `6768fb82`.
- Run baseline L1 profile (`results/l1-baseline.json`).
- Implement and test TTL caches, Map index, pattern match cache, request-scoped reuse, and `db.immediate()`.
- Re-run regression guard (`results/guard-after.txt`); assert zero regressions.
- Measure after slimming (`results/l1-after.json`, `results/l1-compare.md`, `results/l1-hotspots.md`).
- Reference targets: the historical `6768fb82` numbers (p95 ~-48%, p50 ~-24..29%, ~15.2 -> ~10.8 queries/req) are reference targets only and MUST be re-measured on this tree; acknowledge historical figures honestly but do not assert them as achieved results.
- **Phase Exit Gate**: `db_queries_per_req` strictly lower ($\le 11.0$, SC-001), p95 latency reduced by $\ge 25\%$, p50 reported honestly against the D7 p50 threshold ($\ge 35\%$, reported as missed if unmet), translator goldens 100% green.

#### Phase 4: User Story 2 — Vertical Multi-Process Scale (T014–T024)
- Implement vertical cluster supervisor in `src/lib/cluster/supervisor.js` and worker lifecycle in `src/lib/cluster/worker.js` (T014, T015).
- Implement standalone IPC cache invalidation fallback in `src/lib/redis/events.js` (internal edit, no export change) (T016, T017).
- Wire Primary-side one-time migrations and `KHATAM_MIGRATIONS_DONE=1` export (T018, T019), leader-only background daemons (T020, T021), and leader-only WAL checkpoint gating (T019).
- Integrate into `custom-server.js` only (`custom-server.ts` is NOT touched in Wave 8) and update standalone asset copying (T022).
- Ensure loopback-only reverse proxy trust is preserved strictly.
- Author and execute host smoke drill (`scripts/vertical-smoke.sh`) (T023).
- Container subagent validates single-container multi-worker boot (`results/vertical-container-smoke.md`) (T024).
- **Phase Exit Gate**: Cluster unit tests pass, host smoke drill passes with >= 2 distinct worker PIDs under connected load, container subagent confirms 2-worker boot in one container.

#### Phase 5: User Story 3 — Vertical Ladder Benchmark & Master Results (T025–T027)
- Implement `scripts/perf-ladder.sh` load driver (T025).
- Run host ladder across 1, 2, 4, 6 workers with mock upstream and temporary `DATA_DIR`, driving many `Connection: close` connections so the kernel `SO_REUSEPORT` hash spreads load across workers (T026).
- Record per-worker RSS, latency percentiles, throughput, and Redis-down degraded row in `results/ladder-host.md`.
- Synthesize master ladder table and write honest verdict in `specs/008-bun-perf-scale/ladder-results.md` (T027).
- **Phase Exit Gate**: All cells are measured numbers or `UNMEASURED` with cause; D7 targets evaluated honestly; next bottlenecks named.

#### Phase 6: Documentation, Polish & Closeout (T028–T030)
- Update `README.md`, `ROADMAP.md`, `CHANGELOG.md`, and `docs/PERFORMANCE.md`.
- Run `bun x eslint` across touched files.
- Run full vitest suite (`cd tests && bun x vitest run`). Assert red set equals `known-fails.txt` exactly.
- Orchestrator final audit against FRs and SCs; prepare PR.

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **EADDRINUSE port conflicts across workers** | Bun's `node:cluster` intercepts `server.listen()` and each worker binds its own `SO_REUSEPORT` socket. Empirically verified on Bun 1.4.3 with the Next.js standalone build. |
| **Uneven connection distribution** | Bun ignores `cluster.schedulingPolicy` (no `SCHED_RR` handoff); distribution is kernel 4-tuple hashing. Ladders and smoke use many `Connection: close` requests and assert `>= 2` distinct worker PIDs rather than exact evenness. |
| **Worker crash terminates active AI completion streams** | Multi-process fault isolation: a worker crash drops only that worker's connections. Sibling workers continue serving traffic. Supervisor respawns worker within backoff limits. |
| **Rapid crash cycling on bad config or corrupt DB** | Exponential backoff algorithm (`Math.min(250 * 2^restarts, 10000)ms`, crash window < 5000 ms). Throttles restarts; logs high-priority alert after 5 rapid crashes. |
| **Concurrent migration/DDL races at boot** | Primary runs `runMigrationOnce(adapter)` + backup preflight once before `cluster.fork()` and exports `KHATAM_MIGRATIONS_DONE=1`; workers short-circuit the migration path (single-process mode unchanged). |
| **Duplicate upstream OAuth token refreshes / duplicate tunnel + quota daemons** | Leader-only gates: `initializeApp.js` `runHeavyStartup()` daemons, `startBackgroundTokenRefreshFromCustomServer`, and the 60 s WAL checkpoint timer run only when `KHATAM_WORKER_ROLE === "leader"` or the role is unset. |
| **SQLite write lock upgrade deadlocks (`SQLITE_BUSY_SNAPSHOT`)** | `db.immediate(...)` (`BEGIN IMMEDIATE`) acquires write locks upfront for usage persistence, eliminating lock upgrade conflicts across workers. |
| **Cross-process cache staleness without Redis** | Primary brokers IPC `config_reload` broadcasts to sibling workers (sender skipped, no echo loops); 5-second hard TTL ceiling bounds staleness if IPC drops. Scopes `aliases/combos/nodes/settings/all` are all honored. |
| **Host CPU core saturation during benchmark** | Canonical scalar sizing `Math.max(1, nproc - 2)` reserves 2 dedicated cores for kernel/SQLite/Redis/GC. Ladder reports host saturation honestly rather than misattributing bottleneck to code. |

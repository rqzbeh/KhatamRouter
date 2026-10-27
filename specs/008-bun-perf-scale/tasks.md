---
description: "Task list for Wave 8 — Bun Hot-Path Slim and Vertical Scale"
---

# Tasks: Wave 8 — Bun Hot-Path Slim and Vertical Scale (multi-core / multi-process on one host)

**Input**: `specs/008-bun-perf-scale/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)  
**Context**: Re-lands independent hot-path performance work from reverted commit `6768fb82` and delivers vertical multi-process scaling on Bun 1.4.3 via `node:cluster`.

## Execution Rules
- The main agent orchestrates and reviews. Every task is executed by a **sonnet** subagent via the Workflow tool.
- `[SUBAGENT-DOCKER]` tasks run Docker. They are delegated strictly to a dedicated container subagent, never the main agent. No `docker system prune`, no `volume prune`. Validates single container multi-worker boot only.
- Every task starts graph-first (`search_graph` → `trace_path` → `get_code_snippet`, then `check_index_coverage` on each relied file). Read `open-sse/AGENTS.md` before touching `open-sse/`.
- Any script or test that opens SQLite sets a temporary `DATA_DIR` first. Nothing touches `~/.9router/`.
- **Strict Sequential Order**: US1 complete (baseline, slim, guard, after-measure) → US2 complete (vertical runtime, supervisor, worker lifecycle, IPC, leader daemons, smoke) → US3 complete (vertical ladder, master results). No US2 work may overlap US1; no US3 work may overlap US2.
- **Unique File Ownership**: Every task owns a strictly unique, non-overlapping file path set. Parallel tasks never share an owned path.
- **Threshold & Measurement Discipline**: Evaluations adhere strictly to Research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, `db_queries_per_req` ≤ 11.0). Historical figures from `6768fb82` (15.2 queries/req, p95 -48%, p50 -24..29%, RSS 101 MB, 180-200 req/s) are **reference targets only** to be re-measured on this tree; the spec never asserts them as achieved facts. Missed thresholds are reported honestly as a miss. Any unmeasured, invalid, or noisy run ($CV \ge 15\%$) cannot certify improvement.
- **Twin Parity Constraint**: `tests/unit/wave75-twins-alignment.test.js` enforces exported-symbol parity between JS and TS twin files for `bunSqliteAdapter` and `redis/events`. Any wave-8 changes to `src/lib/db/adapters/bunSqliteAdapter.js` or `src/lib/redis/events.js` must be internal-only (no exported functions, variables, or types added, removed, or renamed).

## Format: `[ID] [P?] [Story] Description`
- **[P]**: parallel-safe (disjoint files, within the same phase gate, no dependency on an incomplete task)
- **[CHERRY-PICK 6768fb82]**: code or tests re-landed from reverted commit `6768fb82`
- **Owns**: lists the only paths a task may write.

---

## Phase 1: Setup & Preflight

- [ ] T001 Create `specs/008-bun-perf-scale/results/` with `.gitkeep`.  
  *Test/Oracle*: `test -f specs/008-bun-perf-scale/results/.gitkeep`  
  *Unlazy Gate*: G1  
  *Owns*: `specs/008-bun-perf-scale/results/.gitkeep`

- [ ] T002 Preflight check: confirm `bun -v` is 1.4.3, run `bun install` at the root and `cd tests && bun install`, run vitest suite once, and record the red set versus `tests/__baseline__/known-fails.txt` in `specs/008-bun-perf-scale/results/preflight.md`. Depends on T001.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/results/preflight.md && grep -q "1.4.3" specs/008-bun-perf-scale/results/preflight.md && grep -q "known-fails" specs/008-bun-perf-scale/results/preflight.md`  
  *Unlazy Gate*: G1  
  *Owns*: `specs/008-bun-perf-scale/results/preflight.md`

---

## Phase 2: Foundational Regression Guard (Blocks All Stories)

- [ ] T003 Capture pre-change regression baseline into `specs/008-bun-perf-scale/results/guard-before.txt`. Formats output with header line `# GUARD_CAPTURE_BEFORE timestamp=<ISO8601> bun=1.4.3` followed by execution verdicts for `verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, the four golden translator test suites (`golden-request.test.js`, `golden-translator-concerns.test.js`, `golden-url-header.test.js`, `golden-response-stream.test.js`), and core unit tests (`capabilities`, `key-access`, `translator-request-normalization`, `translator-helpers-edge`). Depends on T002.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/results/guard-before.txt && grep -q "GUARD_CAPTURE_BEFORE" specs/008-bun-perf-scale/results/guard-before.txt && grep -q "verify-alias" specs/008-bun-perf-scale/results/guard-before.txt && grep -q "verify-providers" specs/008-bun-perf-scale/results/guard-before.txt && grep -q "golden-" specs/008-bun-perf-scale/results/guard-before.txt`  
  *Unlazy Gate*: G8  
  *Owns*: `specs/008-bun-perf-scale/results/guard-before.txt`

**Checkpoint**: Preflight recorded and regression guard captured. Prerequisite for Phase 3.

---

## Phase 3: User Story 1 — Hot-Path Slimming & Re-Land (Priority: P1, MVP) 🎯

**Goal**: Deliver in-process L1 breakdown, re-land hot-path performance optimizations from `6768fb82`, reduce database queries to $\le 11.0$ queries/req (reference historical: ~15.2 down to ~10.8), cut p95 tail latency by $\ge 25\%$ (reference historical target: ~48%), and evaluate against D7 targets honestly with zero behavior regressions (FR-001..FR-006, SC-001, SC-002).

### Phase 3A: Harness & Baseline

- [ ] T004 [US1] [CHERRY-PICK 6768fb82] Write `tests/unit/perf-harness.test.js` test-first. Asserts that the harness creates an ephemeral `DATA_DIR` via `mkdtemp`, refuses execution with error output containing "refusing production DATA_DIR" if `DATA_DIR` resolves under `~/.9router/`, prints `PERF_L1_OK <label>`, and outputs valid JSON matching `data-model.md` (`runs >= 5`, `warmup >= 50`, CV>15% flagged `noisy`). The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T003.  
  *Test/Oracle*: `test -s tests/unit/perf-harness.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/perf-harness.test.js) -ge 4 ] && [ $(grep -c 'expect(' tests/unit/perf-harness.test.js) -ge 4 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/perf-harness.test.js && grep -qE "perf-l1-harness|perf-mock-upstream" tests/unit/perf-harness.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `tests/unit/perf-harness.test.js`

- [ ] T005 [US1] [CHERRY-PICK 6768fb82] Implement `scripts/perf-l1-harness.mjs`, `scripts/perf-l0-micro.mjs`, and `scripts/perf-mock-upstream.mjs` per `contracts/perf-harness.md`: in-process mock executor, seeded test key/combo/nodes, per-phase timers (`auth_acl`, `model_info`, `translate`, `dispatch_glue`), database query counter wrapper, refusing production `DATA_DIR` with explicit message ("refusing production DATA_DIR"), and 40/40/20 mix. Make T004 pass. Depends on T004.  
  *Test/Oracle*: `test -s scripts/perf-l1-harness.mjs && test -s scripts/perf-mock-upstream.mjs && bun scripts/perf-l0-micro.mjs | grep -q "L0 Micro-Benchmarks" && cd tests && bun x vitest run unit/perf-harness.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `scripts/perf-l1-harness.mjs`, `scripts/perf-l0-micro.mjs`, `scripts/perf-mock-upstream.mjs`

- [ ] T006 [US1] Run baseline measurement: `bun scripts/perf-l1-harness.mjs --label baseline --out specs/008-bun-perf-scale/results/l1-baseline.json`. Verify that baseline telemetry records valid phase breakdown and baseline query count (reference target: ~15.2 queries/req). Oracle validates the same full L1Profile schema fields as T013 with label==="baseline". Depends on T005.  
  *Test/Oracle*: `node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("specs/008-bun-perf-scale/results/l1-baseline.json","utf8")); if(j.schema!=="khatam.perf.l1/1") throw new Error("schema"); if(j.label!=="baseline") throw new Error("label"); if(!j.workload||!(j.workload.runs>=5)) throw new Error("workload.runs"); if(!Array.isArray(j.run_means_ms)||j.run_means_ms.length<5) throw new Error("run_means_ms"); if(typeof j.total_ms?.p50!=="number"||typeof j.total_ms?.p95!=="number") throw new Error("total_ms p50/p95 missing"); if(!j.phases_ms||typeof j.phases_ms.auth_acl?.p95!=="number") throw new Error("phases_ms"); if(Object.keys(j.phases_ms).length<4) throw new Error("phases count"); if(!(typeof j.db_queries_per_req==="number"&&j.db_queries_per_req>=10.0)) throw new Error("db_queries_per_req < 10.0"); console.log("T006_PASS");'`  
  *Unlazy Gate*: G5  
  *Owns*: `specs/008-bun-perf-scale/results/l1-baseline.json`

### Phase 3B: Hot-Path Slimming (Starts strictly after T006 baseline gate passes)

- [ ] T007 [US1] [CHERRY-PICK 6768fb82] Write `tests/unit/model-info-cache.test.js` test-first. Asserts alias/combo/node reads are cached in memory; invalidation occurs on write and on `khatam:events:config_reload` across scopes `aliases`, `combos`, `nodes`, `settings`, and `all`; `comboByNameCache` is bounded to 512 entries with oldest eviction; 5-second hard TTL bounds staleness; and API key validity is NEVER cached across requests (revoked/expired keys fail next request; SQLite authoritative). The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T006.  
  *Test/Oracle*: `test -s tests/unit/model-info-cache.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/model-info-cache.test.js) -ge 10 ] && [ $(grep -c 'expect(' tests/unit/model-info-cache.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/model-info-cache.test.js && grep -qE "aliasRepo|combosRepo|nodesRepo" tests/unit/model-info-cache.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `tests/unit/model-info-cache.test.js`

- [ ] T008 [US1] [CHERRY-PICK 6768fb82] Add in-process TTL caches to `src/lib/db/repos/aliasRepo.js` (`getModelAliases`), `combosRepo.js` (`getComboByName`), and `nodesRepo.js` (`getProviderNodes`). Ensure `comboByNameCache` in `combosRepo.js` is implemented as a bounded LRU cache (maximum 512 entries, oldest eviction on insert) to prevent unbounded memory growth from arbitrary client model strings. Wire cache invalidation on write methods, inside `src/lib/db/index.js` (`importDb`), and on `config_reload` events across scopes `aliases`, `combos`, `nodes`, `settings` (per `settingsRepo.js:168`), and `all`. Add `tests/unit/import-db-cache-invalidation.test.js`. Make T007 pass. Depends on T007.  
  *Test/Oracle*: `test -s src/lib/db/repos/aliasRepo.js && test -s src/lib/db/repos/combosRepo.js && test -s src/lib/db/repos/nodesRepo.js && test -s tests/unit/import-db-cache-invalidation.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/import-db-cache-invalidation.test.js) -ge 1 ] && [ $(grep -c 'expect(' tests/unit/import-db-cache-invalidation.test.js) -ge 1 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/import-db-cache-invalidation.test.js && grep -qE "importDb|aliasRepo|combosRepo|nodesRepo" tests/unit/import-db-cache-invalidation.test.js && cd tests && bun x vitest run unit/model-info-cache.test.js unit/import-db-cache-invalidation.test.js && cd .. && node .unlazy/008-bun-perf-scale/scripts/negative-control-cache.mjs`  
  *Unlazy Gate*: G5  
  *Owns*: `src/lib/db/repos/aliasRepo.js`, `src/lib/db/repos/combosRepo.js`, `src/lib/db/repos/nodesRepo.js`, `src/lib/db/index.js`, `tests/unit/import-db-cache-invalidation.test.js`

- [ ] T009 [P] [US1] [CHERRY-PICK 6768fb82] Build module-load `Map<modelId, entry>` in `open-sse/config/providerModels.js` for O(1) `findModel` lookups. Memoize transport resolution in `open-sse/handlers/chatCore.js`. Add `tests/unit/model-index-map.test.js` and `tests/unit/model-reserved-prefix.test.js` with master snapshot `tests/fixtures/model-reserved-prefix.master-snapshot.json`. Depends on T006.  
  *Test/Oracle*: `test -s tests/unit/model-index-map.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/model-index-map.test.js) -ge 5 ] && [ $(grep -c 'expect(' tests/unit/model-index-map.test.js) -ge 5 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/model-index-map.test.js && grep -qE "providerModels" tests/unit/model-index-map.test.js && test -s tests/unit/model-reserved-prefix.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/model-reserved-prefix.test.js) -ge 2 ] && [ $(grep -c 'expect(' tests/unit/model-reserved-prefix.test.js) -ge 2 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/model-reserved-prefix.test.js && grep -qE "model\.js|localDb|providerModels" tests/unit/model-reserved-prefix.test.js && cd tests && bun x vitest run unit/model-index-map.test.js unit/model-reserved-prefix.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js`, `tests/unit/model-index-map.test.js`, `tests/unit/model-reserved-prefix.test.js`, `tests/fixtures/model-reserved-prefix.master-snapshot.json`

- [ ] T010 [P] [US1] [CHERRY-PICK 6768fb82] Memoize compiled regular expressions in `matchPattern` (`open-sse/providers/pricing.js`) using a bounded LRU cache. Write `tests/unit/pattern-match-cache.test.js` test-first. Must preserve case-insensitivity, wildcard globbing, and special character escaping. Depends on T006.  
  *Test/Oracle*: `test -s tests/unit/pattern-match-cache.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/pattern-match-cache.test.js) -ge 5 ] && [ $(grep -c 'expect(' tests/unit/pattern-match-cache.test.js) -ge 5 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/pattern-match-cache.test.js && grep -qE "pricing|matchPattern" tests/unit/pattern-match-cache.test.js && cd tests && bun x vitest run unit/pattern-match-cache.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `open-sse/providers/pricing.js`, `tests/unit/pattern-match-cache.test.js`

- [ ] T011 [US1] [CHERRY-PICK 6768fb82] Request-scoped reuse and SQLite write-lock serialization. Resolve `keyRecord` once in `handleChat` (`src/sse/handlers/chat.js`) and thread through `handleSingleModelChat` and `getKeyAccessContext` (`src/sse/services/keyAccess.js`). Pass resolved combo to `getModelInfo` and `getComboModels` (`src/sse/services/model.js`). In `src/lib/db/repos/usageRepo.js:258`, change transaction from `db.transaction()` (deferred) to `db.immediate(...)` (`BEGIN IMMEDIATE`, already exposed at `bunSqliteAdapter.js:137`), acquiring the write lock upfront to eliminate `SQLITE_BUSY_SNAPSHOT` lock upgrade deadlocks (spike measured 90% busies deferred vs 99.5% success immediate across 4 processes, 200 ops, 500 ms busy_timeout). Write `tests/unit/request-scoped-reuse.test.js` and `tests/unit/usage-concurrent-writers.test.js` (re-proving multi-process write serialization using real child processes). Depends on T008.  
  *Test/Oracle*: `test -s tests/unit/request-scoped-reuse.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/request-scoped-reuse.test.js) -ge 6 ] && [ $(grep -c 'expect(' tests/unit/request-scoped-reuse.test.js) -ge 6 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/request-scoped-reuse.test.js && grep -qE "chat|keyAccess|model|usageRepo" tests/unit/request-scoped-reuse.test.js && test -s tests/unit/usage-concurrent-writers.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/usage-concurrent-writers.test.js) -ge 1 ] && [ $(grep -c 'expect(' tests/unit/usage-concurrent-writers.test.js) -ge 1 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/usage-concurrent-writers.test.js && grep -qE "usageRepo|saveRequestUsage" tests/unit/usage-concurrent-writers.test.js && cd tests && bun x vitest run unit/request-scoped-reuse.test.js unit/usage-concurrent-writers.test.js`  
  *Unlazy Gate*: G5  
  *Owns*: `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, `src/sse/services/model.js`, `src/lib/db/repos/usageRepo.js`, `tests/unit/request-scoped-reuse.test.js`, `tests/unit/usage-concurrent-writers.test.js`

### Phase 3C: US1 Exit & Measurement

- [ ] T012 [US1] Re-run the regression guard into `specs/008-bun-perf-scale/results/guard-after.txt`. Formats output with header line `# GUARD_CAPTURE_AFTER timestamp=<ISO8601> bun=1.4.3` followed by execution verdicts for `verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, and the four golden translator test suites (`tests/translator/golden-request.test.js`, `golden-translator-concerns.test.js`, `golden-url-header.test.js`, `golden-response-stream.test.js`). Diff against `guard-before.txt` across verdict lines must show zero functional regressions, and files must not be a plain copy. Depends on T009, T010, T011.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/results/guard-after.txt && grep -q "GUARD_CAPTURE_AFTER" specs/008-bun-perf-scale/results/guard-after.txt && ! cmp -s specs/008-bun-perf-scale/results/guard-before.txt specs/008-bun-perf-scale/results/guard-after.txt && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-oauth-urls.mjs && (cd tests && bun x vitest run translator/golden-request.test.js translator/golden-translator-concerns.test.js translator/golden-url-header.test.js translator/golden-response-stream.test.js) && diff -u <(grep -v "^#" specs/008-bun-perf-scale/results/guard-before.txt | grep -E "PASS|FAIL") <(grep -v "^#" specs/008-bun-perf-scale/results/guard-after.txt | grep -E "PASS|FAIL")`  
  *Unlazy Gate*: G5, G8  
  *Owns*: `specs/008-bun-perf-scale/results/guard-after.txt`

- [ ] T013 [US1] Measure after slimming (`--label after-slim`). Write `specs/008-bun-perf-scale/results/l1-after.json`, `specs/008-bun-perf-scale/results/l1-compare.md`, and `specs/008-bun-perf-scale/results/l1-hotspots.md`. The JSON must carry the `L1Profile` fields from `data-model.md` (`schema`, `label`, `workload`, `phases_ms`, `total_ms`, `db_queries_per_req`, `run_means_ms`), and `l1-compare.md` must show the baseline-vs-after p50/p95 comparison honestly with >= 5 data rows. Oracle validates the full schema, confirms `query-count-drop.mjs` passes, fails if `db_queries_per_req > 11.0` (SC-001), if `label !== "after-slim"`, or if `total_ms.p50`/`total_ms.p95` are missing/non-numeric. Report p50 against the D7 target ($\ge 35\%$) honestly (misses reported as misses). Completes US1. Depends on T012.  
  *Test/Oracle*: `node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("specs/008-bun-perf-scale/results/l1-after.json","utf8")); if(j.schema!=="khatam.perf.l1/1") throw new Error("schema"); if(j.label!=="after-slim") throw new Error("label"); if(!j.workload||!(j.workload.runs>=5)) throw new Error("workload.runs"); if(!Array.isArray(j.run_means_ms)||j.run_means_ms.length<5) throw new Error("run_means_ms"); if(typeof j.total_ms?.p50!=="number"||typeof j.total_ms?.p95!=="number") throw new Error("total_ms p50/p95 missing"); if(!j.phases_ms||typeof j.phases_ms.auth_acl?.p95!=="number") throw new Error("phases_ms"); if(Object.keys(j.phases_ms).length<4) throw new Error("phases count"); if(!(j.db_queries_per_req<=11.0)) throw new Error("db_queries_per_req > 11.0"); console.log("T013_PASS");' && node .unlazy/008-bun-perf-scale/scripts/query-count-drop.mjs && test -s specs/008-bun-perf-scale/results/l1-compare.md && grep -q "p50" specs/008-bun-perf-scale/results/l1-compare.md && grep -q "p95" specs/008-bun-perf-scale/results/l1-compare.md && [ $(grep -cE "^\|[^-]" specs/008-bun-perf-scale/results/l1-compare.md) -ge 5 ] && test -s specs/008-bun-perf-scale/results/l1-hotspots.md`  
  *Unlazy Gate*: G5  
  *Owns*: `specs/008-bun-perf-scale/results/l1-after.json`, `specs/008-bun-perf-scale/results/l1-compare.md`, `specs/008-bun-perf-scale/results/l1-hotspots.md`

**Checkpoint**: Strict US1 complete. All US1 tasks T004–T013 must be complete and verified before any US2 task begins.

---

## Phase 4: User Story 2 — Vertical Multi-Process Scale on One Host (Priority: P2)

**Goal**: Multi-process vertical scaling via Bun 1.4.3 `node:cluster` sharing port 20128, canonical scalar sizing `Math.max(1, nproc - 2)`, worker lifecycle with crash backoff (< 5000 ms, base 250 ms), graceful drain on `SIGTERM`, one-time primary migrations, leader-only daemons and WAL checkpoint, cross-worker IPC invalidation, and strict loopback-only reverse proxy trust (FR-007..FR-016, SC-003..SC-005).

**Strict Order Rule**: US2 work strictly begins ONLY after US1 is 100% complete and verified.

- [ ] T014 [US2] Write `tests/unit/vertical-cluster-supervisor.test.js` test-first. Asserts:
  - Canonical scalar host-sizing formula `Math.max(1, nproc - 2)`.
  - Single-worker mode (`KHATAM_WORKERS=1` or 1 core) bypasses cluster supervisor completely.
  - IPC message protocol between Primary and workers (`ready`, `drain`, `config_reload`, `in_flight`).
  - Crash detection and exponential backoff (`Math.min(250 * 2^restarts, 10000)ms` if crash < 5000 ms).
  - Graceful drain on `SIGTERM` with `KHATAM_DRAIN_TIMEOUT_MS` deadline.
  - 1-indexed Worker 1 designated leader (`KHATAM_WORKER_ROLE === "leader"`).
  - Loopback-only XFF trust contract preserved.
  The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T013.  
  *Test/Oracle*: `test -s tests/unit/vertical-cluster-supervisor.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/vertical-cluster-supervisor.test.js) -ge 5 ] && [ $(grep -c 'expect(' tests/unit/vertical-cluster-supervisor.test.js) -ge 5 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/vertical-cluster-supervisor.test.js && grep -qE "src/lib/cluster|supervisor|worker" tests/unit/vertical-cluster-supervisor.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `tests/unit/vertical-cluster-supervisor.test.js`

- [ ] T015 [US2] Implement vertical cluster supervisor in `src/lib/cluster/supervisor.js` and worker lifecycle in `src/lib/cluster/worker.js`.
  - Primary process evaluates CPU sizing, executes SQLite schema migrations once, sets `KHATAM_MIGRATIONS_DONE=1` for workers, sets `KHATAM_WORKER_ROLE="leader"` for Worker 1 and `"worker"` for followers, forks workers, brokers IPC cache invalidations (skipping the sending worker), and monitors worker lifecycles with exponential backoff.
  - Worker process manages active in-flight request counter, handles graceful drain on `SIGTERM` (`server.close()`), and sends IPC invalidation notifications. Make T014 pass. Depends on T014.  
  *Test/Oracle*: `test -s src/lib/cluster/supervisor.js && test -s src/lib/cluster/worker.js && cd tests && bun x vitest run unit/vertical-cluster-supervisor.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `src/lib/cluster/supervisor.js`, `src/lib/cluster/worker.js`

- [ ] T016 [P] [US2] Write `tests/unit/cluster-events-ipc.test.js` test-first. Asserts:
  - When `REDIS_URL` is unset, `publishKhatamEvent` in `src/lib/redis/events.js` delivers locally on `localBus` AND sends `{ type: "config_reload", scope }` to the Primary via `process.send` when running inside a cluster worker.
  - Workers listen for IPC messages from the Primary and emit them locally on `localBus` to trigger in-process cache invalidation.
  - Primary skips the sending worker to prevent echo loops.
  - Scopes `aliases`, `combos`, `nodes`, `settings`, and `all` are handled.
  The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T015.  
  *Test/Oracle*: `test -s tests/unit/cluster-events-ipc.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/cluster-events-ipc.test.js) -ge 3 ] && [ $(grep -c 'expect(' tests/unit/cluster-events-ipc.test.js) -ge 3 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/cluster-events-ipc.test.js && grep -qE "events|publishKhatamEvent" tests/unit/cluster-events-ipc.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `tests/unit/cluster-events-ipc.test.js`

- [ ] T017 [P] [US2] Implement cross-worker IPC fallback in `src/lib/redis/events.js`. When `REDIS_URL` is unset, in cluster worker mode send `process.send({ type: "config_reload", scope })` to Primary; wire listener for IPC messages from Primary to emit on `localBus`. Internal edit only: DO NOT add, remove, or rename any exports so that `tests/unit/wave75-twins-alignment.test.js` remains 100% green. Make T016 pass. Depends on T016.  
  *Test/Oracle*: `grep -q "process.send" src/lib/redis/events.js && cd tests && bun x vitest run unit/cluster-events-ipc.test.js unit/wave75-twins-alignment.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `src/lib/redis/events.js`

- [ ] T018 [P] [US2] Write `tests/unit/cluster-db-safety.test.js` test-first. Asserts:
  - `src/lib/db/driver.js`: `getAdapter()` skips `runMigrationOnce(adapter)` when `process.env.KHATAM_MIGRATIONS_DONE === "1"`, but executes it when unset (single-process mode).
  - `src/lib/db/adapters/bunSqliteAdapter.js`: The 60-second WAL checkpoint timer (`setInterval PRAGMA wal_checkpoint(TRUNCATE)`) runs only when `KHATAM_WORKER_ROLE === "leader"` or when `KHATAM_WORKER_ROLE` is unset; follower workers (`KHATAM_WORKER_ROLE === "worker"`) skip registering the checkpoint interval.
  - Twin parity constraint: asserts exported-symbol parity is preserved for `bunSqliteAdapter`.
  The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T015.  
  *Test/Oracle*: `test -s tests/unit/cluster-db-safety.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/cluster-db-safety.test.js) -ge 2 ] && [ $(grep -c 'expect(' tests/unit/cluster-db-safety.test.js) -ge 2 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/cluster-db-safety.test.js && grep -qE "driver|bunSqliteAdapter" tests/unit/cluster-db-safety.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `tests/unit/cluster-db-safety.test.js`

- [ ] T019 [P] [US2] Implement one-time startup migrations guard in `src/lib/db/driver.js` (skip `runMigrationOnce` when `KHATAM_MIGRATIONS_DONE === "1"`) and leader-only WAL checkpoint timer in `src/lib/db/adapters/bunSqliteAdapter.js:87-90` (gate `setInterval` on `KHATAM_WORKER_ROLE === "leader"` or unset). Internal edits only: DO NOT add, remove, or rename any exports so that `tests/unit/wave75-twins-alignment.test.js` remains 100% green. Make T018 pass. Depends on T018.  
  *Test/Oracle*: `grep -q "KHATAM_MIGRATIONS_DONE" src/lib/db/driver.js && grep -q "KHATAM_WORKER_ROLE" src/lib/db/adapters/bunSqliteAdapter.js && cd tests && bun x vitest run unit/cluster-db-safety.test.js unit/wave75-twins-alignment.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `src/lib/db/driver.js`, `src/lib/db/adapters/bunSqliteAdapter.js`

- [ ] T020 [P] [US2] Write `tests/unit/cluster-leader-daemons.test.js` test-first. Asserts that in `src/shared/services/initializeApp.js`, `runHeavyStartup()` (starting `safeRestartTunnel`, `safeRestartTailscale`, `ensureCloudflared`, `autoStartMitm`, `configureTunnelMonitoring`, `startQuotaAutoPing`, `startBackgroundTokenRefresh`) executes all startup daemons when `process.env.KHATAM_WORKER_ROLE === "leader"` or unset, and skips execution when `process.env.KHATAM_WORKER_ROLE === "worker"`. The implementer must record the RED run (expected failure reason) in the task transcript. Depends on T015.  
  *Test/Oracle*: `test -s tests/unit/cluster-leader-daemons.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/cluster-leader-daemons.test.js) -ge 2 ] && [ $(grep -c 'expect(' tests/unit/cluster-leader-daemons.test.js) -ge 2 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/cluster-leader-daemons.test.js && grep -qE "initializeApp" tests/unit/cluster-leader-daemons.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `tests/unit/cluster-leader-daemons.test.js`

- [ ] T021 [P] [US2] Implement leader-only background daemon gating in `src/shared/services/initializeApp.js`: gate `runHeavyStartup()` on `process.env.KHATAM_WORKER_ROLE === "leader"` or role unset (single-process mode); follower workers skip heavy startup daemons. Make T020 pass. Depends on T020.  
  *Test/Oracle*: `grep -q "KHATAM_WORKER_ROLE" src/shared/services/initializeApp.js && cd tests && bun x vitest run unit/cluster-leader-daemons.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `src/shared/services/initializeApp.js`

- [ ] T022 [US2] Integrate vertical cluster supervisor into `custom-server.js` (plain JavaScript only; `custom-server.ts` is NOT touched).
  - If `cluster.isPrimary` and workers > 1: run supervisor from `src/lib/cluster/supervisor.js`.
  - If worker: wrap Next.js HTTP server as usual, start background OAuth token refresh (`startBackgroundTokenRefreshFromCustomServer`) only if `isLeader` (`KHATAM_WORKER_ROLE === "leader"` or unset), attach graceful drain handler to `SIGTERM`.
  - **Preserve loopback-only reverse proxy trust strictly** (`isLoopbackProxy`). NO `TRUSTED_PROXY_CIDRS`.
  - Update `scripts/copy-standalone-assets.mjs` to include cluster modules in standalone package.
  - Write `tests/unit/vertical-custom-server-integration.test.js`. Depends on T017, T019, T021.  
  *Test/Oracle*: `grep -q "cluster.isPrimary" custom-server.js && grep -q "src/lib/cluster" scripts/copy-standalone-assets.mjs && test -s tests/unit/vertical-custom-server-integration.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/vertical-custom-server-integration.test.js) -ge 2 ] && [ $(grep -c 'expect(' tests/unit/vertical-custom-server-integration.test.js) -ge 2 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/vertical-custom-server-integration.test.js && grep -qE "custom-server|supervisor" tests/unit/vertical-custom-server-integration.test.js && cd tests && bun x vitest run unit/vertical-custom-server-integration.test.js`  
  *Unlazy Gate*: G6  
  *Owns*: `custom-server.js`, `scripts/copy-standalone-assets.mjs`, `tests/unit/vertical-custom-server-integration.test.js`

- [ ] T023 [US2] Author multi-worker host smoke script `scripts/vertical-smoke.sh` (host loopback drill; contains NO Docker commands).
  - Starts KhatamRouter with `KHATAM_WORKERS=4` on temporary port.
  - Verifies port sharing across 4 workers (sends 200 requests with `Connection: close`, asserts responses hit $\ge 2$ distinct worker PIDs due to Bun kernel 4-tuple socket hashing; never assumes exact round-robin).
  - Verifies graceful drain: sends 10s stream, dispatches `SIGTERM`, verifies stream completes before worker exits.
  - Verifies crash recovery: kills one worker with `SIGKILL`, verifies supervisor respawns replacement worker within backoff limits and sibling workers serve uninterrupted.
  - Verifies leader background refresh and startup daemons execute in Worker 1 only. Depends on T022.  
  *Test/Oracle*: `test -s scripts/vertical-smoke.sh && bash -n scripts/vertical-smoke.sh && grep -q "KHATAM_WORKERS" scripts/vertical-smoke.sh && grep -q "SIGTERM" scripts/vertical-smoke.sh && grep -q "SIGKILL" scripts/vertical-smoke.sh && grep -qiE "distinct.*pid|pid.*distinct" scripts/vertical-smoke.sh && ! grep -qi "docker" scripts/vertical-smoke.sh && node .unlazy/008-bun-perf-scale/scripts/check-smoke-script.mjs`  
  *Unlazy Gate*: G6  
  *Owns*: `scripts/vertical-smoke.sh`

- [ ] T024 [US2] [SUBAGENT-DOCKER] Container subagent: delegated single-container multi-worker verification (never main agent, no `prune`, per FR-019).
  - Boots `Dockerfile.bun` image with `KHATAM_WORKERS=2` inside one container.
  - Verifies `/api/health` returns 200 OK.
  - Verifies requests route across workers without port conflict.
  - Records transcript in `specs/008-bun-perf-scale/results/vertical-container-smoke.md`.
  - Transcript MUST contain exact evidence markers:
    1. Completion sentinel: `VERTICAL_CONTAINER_SMOKE_OK`
    2. Subagent marker: `SUBAGENT_DELEGATION=container-subagent`
    3. Container ID line: `CONTAINER_ID=<hex-id>` (matches `CONTAINER_ID=[a-f0-9]+`)
    4. Supervisor boot line: `KHATAM_WORKERS=2`
    5. Multi-worker PIDs: `DISTINCT_WORKER_PIDS=<pid1>,<pid2>` (matches `DISTINCT_WORKER_PIDS=[0-9]+,[0-9]+`)
    6. Health check response: `HTTP/1.1 200 OK` (or `200 OK`)
  - Completes US2. Depends on T022, T023.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -q "VERTICAL_CONTAINER_SMOKE_OK" specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -q "SUBAGENT_DELEGATION=container-subagent" specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -qE "CONTAINER_ID=[a-f0-9]+" specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -qE "KHATAM_WORKERS=2" specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -qE "DISTINCT_WORKER_PIDS=[0-9]+,[0-9]+" specs/008-bun-perf-scale/results/vertical-container-smoke.md && grep -qE "HTTP/1.1 200 OK|200 OK" specs/008-bun-perf-scale/results/vertical-container-smoke.md && ! grep -q "docker system prune" specs/008-bun-perf-scale/results/vertical-container-smoke.md`  
  *Unlazy Gate*: G6  
  *Owns*: `specs/008-bun-perf-scale/results/vertical-container-smoke.md`

**Checkpoint**: Strict US2 complete. Multi-process vertical runtime verified on host and single container.

---

## Phase 5: User Story 3 — Vertical Ladder Benchmark & Master Results (Priority: P3)

**Goal**: Benchmark 1 vs 2 vs 4 vs 6 workers on THIS host with loopback load driver, record per-worker RSS, evaluate against D7 targets honestly, and synthesize master results table in `ladder-results.md` (FR-017..FR-019, SC-006).

**Strict Order Rule**: US3 work strictly begins ONLY after US2 is 100% complete.

- [ ] T025 [US3] [CHERRY-PICK 6768fb82] Implement `scripts/perf-ladder.sh` and supporting libraries `scripts/perf-ladder-lib.mjs`, `scripts/perf-ladder-seed.mjs`.
  - Loopback load driver supporting vertical worker benchmarking: `scripts/perf-ladder.sh <workers> --url <url> --concurrency <c>`.
  - Uses many `Connection: close` requests to spread load across kernel `SO_REUSEPORT` sockets.
  - Emits `VerticalLadderRow` markdown row. Contains NO Docker commands.
  - Write `tests/unit/perf-ladder-contract.test.js` test-first. Depends on T024.  
  *Test/Oracle*: `test -s scripts/perf-ladder-lib.mjs && test -s scripts/perf-ladder-seed.mjs && test -s tests/unit/perf-ladder-contract.test.js && [ $(grep -cE "\bit\(|\btest\(" tests/unit/perf-ladder-contract.test.js) -ge 2 ] && [ $(grep -c 'expect(' tests/unit/perf-ladder-contract.test.js) -ge 2 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/perf-ladder-contract.test.js && grep -qE "perf-ladder-lib" tests/unit/perf-ladder-contract.test.js && cd tests && bun x vitest run unit/perf-ladder-contract.test.js && cd .. && test -s scripts/perf-ladder.sh && bash -n scripts/perf-ladder.sh && ! grep -qi "docker" scripts/perf-ladder.sh && node .unlazy/008-bun-perf-scale/scripts/check-ladder-script.mjs`  
  *Unlazy Gate*: G7  
  *Owns*: `scripts/perf-ladder.sh`, `scripts/perf-ladder-lib.mjs`, `scripts/perf-ladder-seed.mjs`, `tests/unit/perf-ladder-contract.test.js`

- [ ] T026 [US3] Run vertical ladder benchmarks on THIS host across 1 vs 2 vs 4 vs 6 workers against mock upstream with temporary `DATA_DIR`.
  - Record per-worker RSS (reference: ~101 MB idle, ~150–220 MB peak), latency percentiles ($p50, p95, p99$), throughput ($req/s$), CV%, errors, and Redis-down degraded row in `specs/008-bun-perf-scale/results/ladder-host.md`. Numeric table must contain >= 4 data rows. Depends on T025.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/results/ladder-host.md && grep -q "Vertical 1-worker" specs/008-bun-perf-scale/results/ladder-host.md && grep -q "Vertical 2-worker" specs/008-bun-perf-scale/results/ladder-host.md && grep -q "Vertical 4-worker" specs/008-bun-perf-scale/results/ladder-host.md && grep -q "Vertical 6-worker" specs/008-bun-perf-scale/results/ladder-host.md && grep -qiE "rss|memory" specs/008-bun-perf-scale/results/ladder-host.md && node -e 'const fs=require("fs"); const rows=fs.readFileSync("specs/008-bun-perf-scale/results/ladder-host.md","utf8").split("\n").filter(l=>/^\s*\|/.test(l)&&!/^\s*\|[\s:|-]+\|\s*$/.test(l)&&!/\|\s*Tier/i.test(l)&&/\d/.test(l)); if(rows.length<4) process.exit(1);'`  
  *Unlazy Gate*: G7  
  *Owns*: `specs/008-bun-perf-scale/results/ladder-host.md`

- [ ] T027 [US3] Orchestrator integration and honest verdict: synthesize host micro-benchmarks (L0), L1 harness results, vertical worker ladder rows (1, 2, 4, 6 workers), and degraded mode into `specs/008-bun-perf-scale/ladder-results.md`.
  - Evaluate against D7 thresholds honestly (p95 threshold $\ge 25\%$; p50 threshold $\ge 35\%$; queries threshold $\le 11.0$; reporting misses honestly).
  - Document per-worker RSS memory scaling.
  - Report host CPU core saturation honestly (WSL2 8 cores).
  - Name next bottlenecks (dispatch glue, stream setup, SQLite single-writer serialization). Completes US3. Depends on T026.  
  *Test/Oracle*: `test -s specs/008-bun-perf-scale/ladder-results.md && grep -q "Vertical Scale" specs/008-bun-perf-scale/ladder-results.md && node .unlazy/008-bun-perf-scale/scripts/check-ladder-results.mjs`  
  *Unlazy Gate*: G7  
  *Owns*: `specs/008-bun-perf-scale/ladder-results.md`

**Checkpoint**: Strict US3 complete. Master performance ladder documented in `ladder-results.md`.

---

## Phase 6: Documentation, Polish & Closeout

- [ ] T028 [P] Update documentation per repo convention: `README.md`, `ROADMAP.md` (mark Wave 8 vertical scale planned/shipped), `CHANGELOG.md`, and `docs/PERFORMANCE.md` with vertical scaling guide and canonical host sizing rules `Math.max(1, nproc - 2)`. Oracle checks that each file contains `/vertical/i` and that `PERFORMANCE.md` and `README.md` match `/KHATAM_WORKERS/`. Depends on T027.  
  *Test/Oracle*: `node -e 'const fs=require("fs"); const files=["README.md","ROADMAP.md","CHANGELOG.md","docs/PERFORMANCE.md"]; for(const f of files){const c=fs.readFileSync(f,"utf8"); if(!/vertical/i.test(c)) throw new Error(f+" missing vertical");} if(!/KHATAM_WORKERS/.test(fs.readFileSync("README.md","utf8"))||!/KHATAM_WORKERS/.test(fs.readFileSync("docs/PERFORMANCE.md","utf8"))) throw new Error("missing KHATAM_WORKERS");'`  
  *Unlazy Gate*: G8  
  *Owns*: `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/PERFORMANCE.md`

- [ ] T029 Run lint on touched files, doc content verification, and full vitest suite against known-fails baseline. Execute `bun x eslint` on files touched by Wave 8. Verify documentation content in `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/PERFORMANCE.md`. Run full vitest suite with JSON reporter and assert zero regressions against `tests/__baseline__/known-fails.txt` via `tests/__baseline__/verify-no-regression.mjs`. Depends on T028.  
  *Test/Oracle*: `node -e 'const fs=require("fs"); const files=["README.md","ROADMAP.md","CHANGELOG.md","docs/PERFORMANCE.md"]; for(const f of files){const c=fs.readFileSync(f,"utf8"); if(!/vertical/i.test(c)) throw new Error(f+" missing vertical");} if(!/KHATAM_WORKERS/.test(fs.readFileSync("README.md","utf8"))||!/KHATAM_WORKERS/.test(fs.readFileSync("docs/PERFORMANCE.md","utf8"))) throw new Error("missing KHATAM_WORKERS");' && bun x eslint custom-server.js src/lib/cluster src/lib/db/repos/aliasRepo.js src/lib/db/repos/combosRepo.js src/lib/db/repos/nodesRepo.js src/lib/db/repos/usageRepo.js src/lib/db/index.js src/lib/db/driver.js src/lib/db/adapters/bunSqliteAdapter.js src/lib/redis/events.js src/sse/handlers/chat.js src/sse/services/keyAccess.js src/sse/services/model.js src/shared/services/initializeApp.js open-sse/config/providerModels.js open-sse/handlers/chatCore.js open-sse/providers/pricing.js scripts/copy-standalone-assets.mjs scripts/perf-l1-harness.mjs scripts/perf-l0-micro.mjs scripts/perf-mock-upstream.mjs scripts/perf-ladder-lib.mjs scripts/perf-ladder-seed.mjs && rm -f /tmp/vitest-results.json && (cd tests && (bun x vitest run --reporter=json --outputFile=/tmp/vitest-results.json || test -s /tmp/vitest-results.json)) && node tests/__baseline__/verify-no-regression.mjs /tmp/vitest-results.json`  
  *Unlazy Gate*: G8  
  *Owns*: none (read-only verification)

- [ ] T030 Orchestrator final audit: verify all Unlazy gates and evidence, audit all claims against FR-001..FR-019 and SC-001..SC-006, confirm zero horizontal leftovers, and prepare PR. Depends on T029.  
  *Test/Oracle*: `test -s .unlazy/008-bun-perf-scale/GATES.md && ! grep -q -- "- \[ \] G" .unlazy/008-bun-perf-scale/GATES.md && node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/008-bun-perf-scale/GATES.md`  
  *Unlazy Gate*: G8  
  *Owns*: none (read-only audit)

---

## Dependencies & Phase Order

```text
Phase 1 & 2: Setup & Guard
T001 → T002 → T003

→ Phase 3: [US1 Complete] (T004..T013)
T004 → T005 → T006 (baseline gate)
               ├─ T007 → T008 ──→ T011 ─┬─→ T012 → T013 (US1 complete gate)
               ├─ T009 ─────────────────┤
               └─ T010 ─────────────────┘

→ Phase 4: [US2 Complete] (T014..T024, strictly begins after T013 completes)
T014 → T015 ─┬─→ T016 → T017 ─┬─→ T022 ─┬─→ T023 ──┐
             ├─→ T018 → T019 ─┤         └──────────┼─→ T024 (delegated container subagent, completes US2)
             └─→ T020 → T021 ─┘

→ Phase 5: [US3 Complete] (T025..T027, strictly begins after T024 completes)
T025 → T026 → T027 (alone owns ladder-results.md, completes US3)

→ Phase 6: Polish & Closeout
T028 → T029 → T030
```

---

## Disjoint Ownership Map

| Task ID | Owned File Paths |
|---|---|
| **T001** | `specs/008-bun-perf-scale/results/.gitkeep` |
| **T002** | `specs/008-bun-perf-scale/results/preflight.md` |
| **T003** | `specs/008-bun-perf-scale/results/guard-before.txt` |
| **T004** | `tests/unit/perf-harness.test.js` |
| **T005** | `scripts/perf-l1-harness.mjs`, `scripts/perf-l0-micro.mjs`, `scripts/perf-mock-upstream.mjs` |
| **T006** | `specs/008-bun-perf-scale/results/l1-baseline.json` |
| **T007** | `tests/unit/model-info-cache.test.js` |
| **T008** | `src/lib/db/repos/aliasRepo.js`, `src/lib/db/repos/combosRepo.js`, `src/lib/db/repos/nodesRepo.js`, `src/lib/db/index.js`, `tests/unit/import-db-cache-invalidation.test.js` |
| **T009** | `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js`, `tests/unit/model-index-map.test.js`, `tests/unit/model-reserved-prefix.test.js`, `tests/fixtures/model-reserved-prefix.master-snapshot.json` |
| **T010** | `open-sse/providers/pricing.js`, `tests/unit/pattern-match-cache.test.js` |
| **T011** | `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, `src/sse/services/model.js`, `src/lib/db/repos/usageRepo.js`, `tests/unit/request-scoped-reuse.test.js`, `tests/unit/usage-concurrent-writers.test.js` |
| **T012** | `specs/008-bun-perf-scale/results/guard-after.txt` |
| **T013** | `specs/008-bun-perf-scale/results/l1-after.json`, `specs/008-bun-perf-scale/results/l1-compare.md`, `specs/008-bun-perf-scale/results/l1-hotspots.md` |
| **T014** | `tests/unit/vertical-cluster-supervisor.test.js` |
| **T015** | `src/lib/cluster/supervisor.js`, `src/lib/cluster/worker.js` |
| **T016** | `tests/unit/cluster-events-ipc.test.js` |
| **T017** | `src/lib/redis/events.js` |
| **T018** | `tests/unit/cluster-db-safety.test.js` |
| **T019** | `src/lib/db/driver.js`, `src/lib/db/adapters/bunSqliteAdapter.js` |
| **T020** | `tests/unit/cluster-leader-daemons.test.js` |
| **T021** | `src/shared/services/initializeApp.js` |
| **T022** | `custom-server.js`, `scripts/copy-standalone-assets.mjs`, `tests/unit/vertical-custom-server-integration.test.js` |
| **T023** | `scripts/vertical-smoke.sh` |
| **T024** | `specs/008-bun-perf-scale/results/vertical-container-smoke.md` |
| **T025** | `scripts/perf-ladder.sh`, `scripts/perf-ladder-lib.mjs`, `scripts/perf-ladder-seed.mjs`, `tests/unit/perf-ladder-contract.test.js` |
| **T026** | `specs/008-bun-perf-scale/results/ladder-host.md` |
| **T027** | `specs/008-bun-perf-scale/ladder-results.md` |
| **T028** | `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/PERFORMANCE.md` |
| **T029** | none (read-only verification) |
| **T030** | none (read-only audit) |

*Disjointness Invariant*: Every owned file path appears in exactly one task row. No file is co-owned or modified by more than one task.

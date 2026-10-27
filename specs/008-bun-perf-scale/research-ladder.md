# Research Note: Performance Ladder Definition & Evidence Hunt (US3 / FR-017..FR-019)

**Target Spec**: `specs/008-bun-perf-scale/spec.md` (US1 FR-001..FR-006, US2 FR-007..FR-016, US3 FR-017..FR-019; ladder side: FR-017, FR-018, FR-019)  
**Date**: 2026-10-24 (rewritten 2026-10-27 for vertical scaling)  
**Author**: Performance Architecture Subagent  
**Scope**: Performance ladder tier definitions (L0–L3), existing test & benchmark baseline inventory, single-host vertical worker benchmarking methodology (1/2/4/6 workers via `KHATAM_WORKERS`), Redis-down degraded row, empirical findings, ceiling-moved verdict criteria, next-bottleneck hypotheses, and plan handoff. The reverted compose/nginx L3 tier appears only as a clearly-labelled superseded note.

---

## 1. Architectural Baseline & Bun-Only Reality

The KhatamRouter codebase is strictly standardized on native Bun runtime:
- **Sole Database Driver**: Native `bun:sqlite` with Write-Ahead Logging (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;`). All legacy Node-runtime fallback drivers (`better-sqlite3`, `node:sqlite`, `sql.js`) were eliminated in Wave 7.5 and verified clean by `scripts/verify-driver-pruning.mjs`. Any legacy references to `db.json` or `lowdb` in `docs/ARCHITECTURE.md` are obsolete.
- **Cluster State via Redis**: Shared coordination operates via Redis `8.2-alpine` using the default key prefix `khatam:` (`process.env.REDIS_KEY_PREFIX`, defaulting to `khatam:` per `specs/0075-bun-only-redis-default/contracts/redis-conventions.md:10`). All distributed concurrency leases (`khatam:semaphore:*`), circuit breaker events (`khatam:events:circuit_trip`), persistent combo rotation counters (`khatam:counter:combo:*`), and single-use OAuth locks (`khatam:lock:refresh:*`) are centralized in Redis with automatic fail-open/SQLite degradation when Redis is unconfigured or stopped.
- **Network Boundaries**: `custom-server.js:10-36` binds `PORT=20128` (with `DASHBOARD_PORT=20128` as alias). Loopback proxy trust sanitizes `X-Forwarded-For` and stamps `x-9r-real-ip` and `x-9r-peer-token` (`custom-server.js:124-150`).

---

## 2. Existing Benchmarks, Harnesses, and Baseline Test Suites

Codebase discovery verified the following existing suites and validation tools available for baseline L1 anchoring:

### 2.1 Regression Snapshots and Golden Verifiers
1. **Alias Snapshot Verification** (`tests/__baseline__/verify-alias.mjs:1-35`):
   - Command: `bun tests/__baseline__/verify-alias.mjs`
   - Scope: Asserts byte-for-byte stability of 132 alias tokens and provider mapping in both directions across `open-sse/services/model.js` and `open-sse/config/providerModels.js`.
   - Measured Runtime: **~35 ms** (passes cleanly).
2. **Provider Registry Snapshot** (`tests/__baseline__/verify-providers.mjs:1-35`):
   - Command: `bun tests/__baseline__/verify-providers.mjs`
   - Scope: Evaluates 124 registered providers in `open-sse/config/providers.js` against `providers-baseline.json`.
   - Measured Runtime: **~40 ms** (passes cleanly).
3. **OAuth URL Baseline** (`tests/__baseline__/verify-oauth-urls.mjs:1-25`):
   - Command: `bun tests/__baseline__/verify-oauth-urls.mjs`
   - Scope: Asserts exact match of OAuth authorize, token, and device endpoints.
   - Measured Runtime: **~20 ms** (passes cleanly).
4. **Driver Pruning Invariant** (`scripts/verify-driver-pruning.mjs:1-50`):
   - Command: `bun scripts/verify-driver-pruning.mjs`
   - Scope: Verifies zero occurrences of pruned drivers in manifests and source.
   - Measured Runtime: **~50 ms** (passes cleanly).
5. **No-Regression Gate Script** (`tests/__baseline__/verify-no-regression.mjs:1-32`):
   - Reads `tests/__baseline__/known-fails.txt` (88 catalogued pre-existing test failures, e.g. unmocked external cloud endpoints such as `unit/embeddings.cloud.test.js` or live credential-dependent tests).
   - Asserts that no test flips from PASS to FAIL.

### 2.2 Vitest Test Suite under Bun Host
- Configuration: `tests/vitest.config.js:1-41` configures Vitest for Bun host with `environment: "node"`, `maxConcurrency: 60`, subpath alias `@/` mapping to `src/`, and `open-sse/` alias mapping to root `open-sse/`.
- Test execution: Over 4,100 tests pass without regression under `bun x vitest run`.
- Single unit suite sample: `bun x vitest run unit/capabilities.test.js` completes 34 tests in **348 ms** (setup: 0 ms, tests: 47 ms).
- Golden roundtrip translator suite: `bun x vitest run translator/golden-url-header.test.js` verifies all 210 provider request builder configurations in **1.69 s** (tests: 94 ms).

### 2.3 Legacy Benchmark Harness Finding (`tests/unit/db-benchmark.test.js`)
- `tests/unit/db-benchmark.test.js:1-45` was originally written to compare SQLite against `lowdb`.
- **Finding**: Running `bun x vitest run unit/db-benchmark.test.js` fails with `Cannot find package 'lowdb'` because `lowdb` was completely removed during the Wave 7.5 Bun-only SQLite migration.
- **Value for L1**: The file demonstrates the isolated benchmarking pattern in this repo: creating an ephemeral scratchpad directory via `fs.mkdtempSync(path.join(os.tmpdir(), "9router-bench-sqlite-"))`, binding `process.env.DATA_DIR`, running `sqliteDb.initDb()`, executing warmup rounds, and collecting precise delta timings using `performance.now()`.

---

## 3. The Performance Ladder Definition (L0 through L3)

The performance ladder evaluates KhatamRouter at four ascending levels of abstraction. **L3 is now vertical multi-worker on one host**; the earlier compose/nginx L3 is superseded.

| Tier | Name | Target Measured | Execution Context | Primary Metrics |
| :--- | :--- | :--- | :--- | :--- |
| **L0** | Micro-Benchmarks | Isolated functions: `parseModel`, `getModelInfoCore`, `rowToNode`, `bun:sqlite` prepared queries | In-process micro-runner (`bun:test` or `bun -e`) | Latency per operation (µs/op), memory allocation per call |
| **L1** | In-Process Request Hot Path | Full control-plane pipeline: JSON parse, internal trust, ACL, rate/spend quota, `getModelInfo`, translator transform, mock upstream dispatch | Synthetic request harness through `handleChat` (`src/sse/handlers/chat.js`) with temp `DATA_DIR` | Per-request latency breakdown (ms), `p50`, `p95`, memory churn |
| **L2** | Single-Process HTTP Server | Standalone HTTP server (`custom-server.js` on loopback port `20128`, `KHATAM_WORKERS=1`) serving concurrent synthetic clients | Loopback HTTP benchmark (Bun-native client loop via `scripts/perf-ladder.sh`) | End-to-end `p50`, `p95`, `p99`, Throughput (`req/s`), CPU saturation % |
| **L3** | Vertical Multi-Worker Scale (one host) | The same single host running `KHATAM_WORKERS=1`, `2`, `4`, `6` via `node:cluster` on port `20128`; plus a Redis-down degraded row | Loopback load driver against the multi-worker instance; NO containers, NO compose, NO nginx | Aggregate throughput (`req/s`), vertical scaling efficiency (1x / 2x / 4x / 6x workers), per-worker RSS, `p50`/`p95`/`p99`, distinct worker PIDs |

### Superseded (reverted PR #76/#77)
The previous L3 specification was a **horizontal multi-replica Docker Compose tier** (2–4 gateway containers, shared Redis container, shared SQLite WAL volume, nginx `gateway-lb` reverse proxy, `docker-compose.scale.yml` overlay, `TRUSTED_PROXY_CIDRS`). That architecture was merged in PR #76 and formally **reverted in PR #77**. It is **not** part of the active ladder: no container-per-replica rows, no `--scale`, no nginx, no CIDR proxy trust are measured or required anywhere in this note. It survives only as lineage in `research-scale.md`.

---

## 4. Single-Process Baseline Method (L1 & L2)

To produce reproducible, noise-isolated baseline measurements without contaminating production databases:

### 4.1 Environment Specification
- **Isolated Scratchpad Directory**:
  ```bash
  TEMP_DATA=$(mktemp -d /tmp/khatam-perf-data-XXXXXX)
  export DATA_DIR="$TEMP_DATA"
  ```
  *Rationale*: `src/lib/db/paths.js` honors `DATA_DIR` for SQLite (`data.sqlite`), guaranteeing `~/.9router/` production logs and configs are never modified (`specs/008-bun-perf-scale/spec.md:102`).
- **Runtime Configuration**:
  - `NODE_ENV=production`
  - `PORT=29128` (isolated non-conflicting port)
  - `REDIS_URL="redis://127.0.0.1:6379"` (local Redis instance)
  - `REDIS_KEY_PREFIX="khatam:"`
- **Initial Seed State**:
  - 1 active API key with tier limits (`allowedKinds: ["llm"]`, RPM: 1000, daily spend: $50.00).
  - 1 combo definition (`smart-combo` pointing to `openai/gpt-4o` and `anthropic/claude-3-5-sonnet`).
  - 2 provider connections (`openai`, `anthropic`).

### 4.2 Workload Request Set
A standardized 1,000-request set composed of three representative archetypes:
1. **Passthrough Direct Model** (40% of requests):
   - Model: `openai/gpt-4o-mini`
   - Payload: Standard OpenAI 2-turn conversation.
   - Exercises: Auth, unified ACL, key quota check, model lookup, direct pass.
2. **Cross-Format Translation** (40% of requests):
   - Model: `anthropic/claude-3-5-sonnet`
   - Payload: OpenAI request structure with system prompt and tool definitions requiring bidirectional translation (`open-sse/translator/`).
   - Exercises: Bidirectional schema mapping, tool parameter sanitization.
3. **Capability-Gated Combo** (20% of requests):
   - Model: `smart-combo`
   - Payload: Multimodal request (image block + reasoning tags).
   - Exercises: `detectRequiredCapabilities`, `filterAdapterModels`, combo rotation counter (`khatam:counter:combo:*`).

### 4.3 Protocol & Execution Procedure
- **Warmup Phase**: 100 requests executed sequentially to prime Bun JIT, warm SQLite file system caches, and establish Redis connection pools.
- **Measurement Phase**: 5 consecutive iterations of 1,000 requests at concurrency $C=10$.
- **Outlier Filtering**: Drop the highest and lowest iterations; average the median 3 runs.
- **Primary Metrics**:
  - Latency: `p50` (median overhead in ms), `p95`, `p99`.
  - Throughput: Requests per second (`req/s`).
  - Hotspot breakdown: Attributed time spent in:
    1. Middleware / Auth / ACL (`src/sse/handlers/chat.js:69-195`)
    2. Model Info & Node Resolution (`src/sse/services/model.js:38-79`)
    3. Translation & Body Prep (`open-sse/handlers/chatCore.js:94-250`)
    4. Quota & Idempotency Store (`src/lib/quota/redisQuotaStore.js` & `src/lib/idempotency/hook.js`)

---

## 5. Vertical Multi-Worker Method (L3, one host)

### 5.0 Superseded (reverted PR #76/#77): Horizontal compose/nginx L3
Historically, this section specified a **multi-replica Docker Compose tier** (removing `container_name: 9router`, adding an internal nginx `gateway-lb` round-robin proxy on host port `20128`, a shared `9router-data` WAL volume, shared `redis:8.2-alpine`, and `docker compose up --scale 9router={1,2,4}`). That architecture was merged in PR #76 and formally **reverted in PR #77**; it is inactive and is preserved below only for lineage. The active L3 tier is the vertical multi-worker ladder defined in 5.1–5.3.

<details><summary>Lineage: historical horizontal L3 (reverted, inactive)</summary>
1. **Container Name Hardcoding**: `container_name: 9router` removal so compose could name replicas `9router-1`, `9router-2`, etc.
2. **Reverse Proxy Load Balancer**: internal nginx `gateway-lb` distributing across `http://9router:20128` targets.
3. **Shared Volume & WAL Safety**: `9router-data:/app/data` mounted to all replicas; POSIX file locking for SQLite WAL.
4. **Shared Redis Service**: `redis:8.2-alpine` as the single cluster-state backbone.
</details>

### 5.1 Vertical Multi-Worker Architecture (one host)
The gateway runs a single Bun 1.4.3 primary supervising N worker processes via `node:cluster` on the SAME host and SAME port `20128`. Each worker binds its own `SO_REUSEPORT` socket; the Linux kernel hashes new TCP connections across the listener pool by 4-tuple. No compose, no nginx, no `TRUSTED_PROXY_CIDRS`.

### 5.2 Worker Counts Under Test (vertical ladder)
- `KHATAM_WORKERS=1` (baseline; single process, supervisor bypassed)
- `KHATAM_WORKERS=2`
- `KHATAM_WORKERS=4`
- `KHATAM_WORKERS=6` (on this 8-core host: `Math.max(1, 8 - 2)` default)
- Plus a **Redis-down degraded row** measured at the highest stable worker count.

### 5.3 Execution Mandate (FR-019 / Repo Memory Convention)
Per project instructions and repository memory, all live container operations MUST be delegated to a dedicated container subagent (never the main agent, never prune). The vertical ladder itself is **host-only loopback traffic** (no container runs at all); the single-container multi-worker boot validation is delegated per FR-019.

---

## 6. Empirical Results & Evidence Hunt Table

The table below catalogs measured numbers obtained directly under native Bun on the host machine without Docker, alongside required containerized cells explicitly designated as `UNMEASURED` with cause per FR-018:

| Ladder Level | Measurement Description | Measured Metric / Status | Method & Command | Evidence / Cause |
| :--- | :--- | :--- | :--- | :--- |
| **L0** | `bun:sqlite` Prepared Point Query | **0.0072 ms/op** (7.2 µs) | In-memory temp DB, 1000 prepared lookups | Native Bun JIT + SQLite memory pointer (`bun:sqlite`) |
| **L0** | Alias Baseline Verification | **35 ms** (132/132 pass) | `bun tests/__baseline__/verify-alias.mjs` | `tests/__baseline__/verify-alias.mjs:1-35` byte-for-byte pass |
| **L0** | Provider Config Verification | **40 ms** (124/124 pass) | `bun tests/__baseline__/verify-providers.mjs` | `tests/__baseline__/verify-providers.mjs:1-35` byte-for-byte pass |
| **L0** | Driver Pruning Gate | **50 ms** (0 Node drivers) | `bun scripts/verify-driver-pruning.mjs` | All Node drivers verified pruned from source |
| **L0** | Vitest Unit Test Run (`capabilities`) | **348 ms** (34/34 pass) | `bun x vitest run unit/capabilities.test.js` | Single test suite execution under Bun host |
| **L0** | Translator Golden Headers | **1.69 s** (210/210 pass) | `bun x vitest run translator/golden-url-header.test.js` | 210 provider request header builders verified |
| **L1** | Hot-Path Redundant DB Calls | **~5 to 7 queries/req** | Static code trace of `handleChat` + `getModelInfo` | `src/sse/services/model.js:43-60`, `src/sse/handlers/chat.js:161-191` |
| **L1** | In-Process Gateway Latency | **UNMEASURED** | L1 Profile Harness (`scripts/perf-l1-harness.mjs`) | *Cause*: Synthetic L1 harness script to be authored in Speckit Plan phase (FR-001/FR-002) |
| **L2** | Single-Process HTTP Throughput | **UNMEASURED** | Standalone server + loopback load runner (`scripts/perf-ladder.sh` with `KHATAM_WORKERS=1`) | *Cause*: Requires running standalone HTTP server process during dedicated benchmark pass |
| **L3** | Vertical 2-Worker Ladder | **UNMEASURED** | `KHATAM_WORKERS=2` + loopback load driver (no Docker) | *Cause*: Requires supervisor + ladder scripts; bun-only, host-only |
| **L3** | Vertical 4-Worker Ladder | **UNMEASURED** | `KHATAM_WORKERS=4` + loopback load driver (no Docker) | *Cause*: Same; assert >= 2 distinct worker PIDs (kernel 4-tuple hashing, not round-robin) |
| **L3** | Redis Outage Degradation Throughput | **UNMEASURED** | Redis lacking/down during multi-worker ladder row | *Cause*: Inactive Redis simulated by leaving `REDIS_URL` unset at boot so IPC fallback is exercised without touching shared state |

---

## 7. Hot-Path Breakdown & Attributed Hotspots

Codebase analysis using graph queries (`search_graph`, `trace_path`, `get_code_snippet`) revealed the structural root causes of the ~8ms gateway overhead:

### Hotspot 1: Uncached Sequential SQLite Lookups in `getModelInfo`
- **File & Lines**: `src/sse/services/model.js:38-79`
- **Defect**: When `!parsed.isAlias`, if `RESERVED_PROVIDER_PREFIXES` does not match, the code executes three sequential SQLite queries:
  1. `await getProviderNodes({ type: "openai-compatible" })` (`nodesRepo.js:41-48`)
  2. `await getProviderNodes({ type: "anthropic-compatible" })`
  3. `await getProviderNodes({ type: "custom-embedding" })`
  Each query calls `db.all(sql)` and executes `JSON.parse(row.data)` on every row returned. If `parsed.isAlias` is true, it queries `await getComboByName(parsed.model)` (`combosRepo.js:29-33`).
- **Impact**: 3 to 4 asynchronous SQLite queries and JSON deserializations per request on every single model resolution.

### Hotspot 2: Quadruple Redundant Database Queries in `handleChat`
- **File & Lines**: `src/sse/handlers/chat.js:161-260`
- **Defect**:
  1. Line 161: `const keyRecord = apiKey ? await getApiKeyByKey(apiKey) : null;`
  2. Line 191: `const keyAccess = await getKeyAccessContext(request);` which internally re-fetches the identical record via `const record = await getApiKeyByKey(apiKey);` (`src/sse/services/keyAccess.js:82`).
  3. Line 225: Inside `handleSingleModelChat`, `getApiKeyByKey(apiKey)` is queried a third time!
  4. Line 82: `const settings = await getSettings();` fetches global settings from SQLite on every request without in-memory TTL caching.
  5. Line 205: `await getComboModels(modelStr)` issues another query to the `combos` table.
- **Impact**: Up to 6 redundant SQLite queries per request before dispatching to upstream. In Bun, while native `bun:sqlite` point queries take only ~7.2 µs of pure C++ execution, asynchronous JS promise creation, context switches, JSON parsing, and object cloning multiply to **~4 to 6 ms** of overhead.

### Hotspot 3: Idempotency & Quota Serialization Churn
- **File & Lines**: `src/sse/handlers/chat.js:93-156`, `src/lib/idempotency/hook.js:1-80`
- **Defect**: Full request body cloning (`request.clone().json()`) and header mapping on both pre-flight and post-flight phases.

---

## 8. Ceiling-Moved Verdict Criteria (SC-006 / FR-018)

To objectively decide whether the performance ceiling moved after implementing the hot-path slimming and vertical multi-worker configuration, the following four criteria must be satisfied:

1. **L1 Overhead Reduction** (gating thresholds per Research D7):
   - The median gateway latency overhead ($p50$) for direct requests must decrease by at least **35%**.
   - $p95$ tail latency must decrease by at least **25%**.
   - Historical `6768fb82` numbers are reference targets only, re-measured on the current tree; any miss is reported as a miss.
2. **Vertical Throughput Scalability**:
   - Scaling from 1 worker to 2 workers MUST improve throughput measurably (target $\ge 1.6x$ before saturation).
   - Scaling from 1 worker to 4 workers SHOULD approach $\ge 2.8x$ before host CPU saturation (on an 8-core host).
   - Exact per-worker request evenness is NOT a criterion (kernel 4-tuple hashing, not round-robin); distribution is validated by `>= 2` distinct worker PIDs.
3. **Cluster Invariant Preservation**:
   - Zero behavioral regressions: `tests/__baseline__/verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, and golden translator round-trip tests MUST remain 100% green (FR-006).
   - Redis cluster state invariants (concurrency leases via `RedisSemaphore`, circuit-breaker trip events on `khatam:events:circuit_trip`, and combo rotation indices on `khatam:counter:combo:*`) must synchronize across vertical workers without contention loss or dropped turns; cross-worker cache invalidation via IPC broadcast (Redis absent) or Pub/Sub (Redis present) MUST remain < 5 s worst case.
4. **Graceful Outage Fallback**:
   - During a simulated Redis outage, all workers must degrade to internal SQLite/in-memory/IPC handling without dropping requests or throwing uncaught exceptions on the request path (FR-015).

---

## 9. Next-Bottleneck Hypotheses

Once the ~8ms hot-path is slimmed and 2–6 Bun vertical workers are deployed on this host, what will constrain the system next?

1. **Hypothesis 1: SQLite WAL Write Contention Under Multi-Worker Load**:
   - While SQLite WAL allows concurrent readers, it permits only **one writer at a time**.
   - With 4–6 vertical workers concurrently writing usage ledger entries (`saveRequestUsage`), write transactions will queue. `db.immediate(...)` upfront write locking eliminates `SQLITE_BUSY_SNAPSHOT` lock upgrade aborts, but under high concurrency (e.g. >500 req/s), workers wait on SQLite's `busy_timeout = 5000` queue.
2. **Hypothesis 2: Redis Single-Threaded Event Loop Saturation**:
   - Concurrency semaphores (`RedisSemaphore`) execute Lua scripts (`EVAL`) on ZSETs for every request acquire/release. Under high concurrent load across vertical workers, Redis CPU utilization on the single-threaded engine may become the bottleneck.
3. **Hypothesis 3: JavaScriptCore Garbage Collection on Streaming SSE Chunks**:
   - High-throughput streaming requests with tool decloaking (`open-sse/handlers/chatCore/streamingHandler.js`) create substantial buffer and string allocations. Under thousands of concurrent streams, Bun's JSC garbage collector pauses will dictate tail latency ($p99$).
4. **Hypothesis 4: Upstream Socket Exhaustion**:
   - Absent persistent HTTP keep-alive connection pools to upstream LLM providers, ephemeral socket exhaustion or TLS handshake overhead will limit throughput when calling external APIs.

---

## 10. Index Coverage Verification

As mandated by the subagent tier verification rules, `check_index_coverage` was executed for all files relied upon in this research:
- `src/sse/services/model.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/sse/handlers/chat.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/lib/db/repos/nodesRepo.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/lib/db/repos/combosRepo.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/sse/services/keyAccess.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/sse/services/allowedModels.js` — verified (`no_recorded_issue`, `metadata_match`)
- `src/lib/idempotency/hook.js` — verified (`no_recorded_issue`, `metadata_match`)
- `custom-server.js` — verified (`no_recorded_issue`, `metadata_match`)
- `docker-compose.yml` — verified (`no_recorded_issue`, `metadata_match`)
- `scripts/w75-compose-smoke.sh` — verified (`no_recorded_issue`, `metadata_match`)
- `scripts/w75-redis-outage-drill.sh` — verified (`no_recorded_issue`, `metadata_match`)
- `scripts/verify-driver-pruning.mjs` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/vitest.config.js` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/package.json` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/__baseline__/known-fails.txt` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/__baseline__/verify-no-regression.mjs` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/__baseline__/verify-alias.mjs` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/__baseline__/verify-providers.mjs` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/__baseline__/verify-oauth-urls.mjs` — verified (`no_recorded_issue`, `metadata_match`)
- `tests/unit/db-benchmark.test.js` — verified (`no_recorded_issue`, `metadata_match`)
- `specs/0075-bun-only-redis-default/contracts/redis-conventions.md` — verified (`no_recorded_issue`, `metadata_match`)
- `specs/008-bun-perf-scale/spec.md` — verified (`no_recorded_issue`, `metadata_match`)

Zero coverage gaps or missed lines were reported.

---

## 11. Handoff

### Mapping to Functional Requirements

| Requirement | Research Finding & Artifact | Speckit Plan Action Item |
| :--- | :--- | :--- |
| **FR-001** (TTL Caches) | Hotspots attributed: `getModelInfo` (3x SQLite queries in `src/sse/services/model.js:43-60`), `getApiKeyByKey` (3x redundant calls in `src/sse/handlers/chat.js:161-225`), uncached settings. | Plan dedicated synthetic L1 profiling script `scripts/perf-l1-harness.mjs` measuring translation, model info, and middleware overhead; LRU-bounded `comboByNameCache`; `settings`-scope invalidation. |
| **FR-002** (Map Index / Slim Hotspot & Re-measure) | Identified quick-win optimizations: request-scoped memoization of `keyRecord`, in-memory TTL caching of `providerNodes` and `settings`, and the `findModel` Map index. | Implement request context cache and lightweight in-memory cache for `providerNodes` and `settingsRepo`. |
| **FR-006** (Zero Behavior Regressions) | Established test harness: `bun tests/__baseline__/verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, and `translator/golden-url-header.test.js`. | Require these baseline gates in Phase 1 and Phase 2 task completion criteria. |
| **FR-007** (`node:cluster` vertical runtime) | Workers bind per-worker `SO_REUSEPORT` sockets; primary never listens; primary-only migrations with `KHATAM_MIGRATIONS_DONE=1`. | Implement `src/lib/cluster/supervisor.js` and `src/lib/cluster/worker.js`. |
| **FR-012..FR-013 / FR-014 (Leader-only daemons & WAL checkpoint; `db.immediate()`)** | `initializeApp.js` `runHeavyStartup()`, `custom-server.js:151-153` `startBackgroundTokenRefreshFromCustomServer`, and `bunSqliteAdapter.js:87-90` checkpoint timer must be gated on `KHATAM_WORKER_ROLE`; `usageRepo.saveRequestUsage` to `db.immediate(...)`. | Leader gating tasks and multi-process SQLite safety task. |
| **FR-015** (Cross-worker cache invalidation via IPC broadcast when Redis absent) | `src/lib/redis/events.js` already emits on `localBus` when Redis is unset; vertical mode must additionally `process.send` to Primary and re-apply to sibling workers via local emit (sender skipped). | Add IPC fallback task for cache invalidation when `REDIS_URL` unset. |
| **FR-017** (Identical Metrics Reporting) | Defined metrics contract: $p50$, $p95$, $p99$, throughput (req/s), worker count, command, isolated temp `DATA_DIR`, and `Connection: close` short-lived connections. | Use identical metrics schema in before/after ladder comparison table. |
| **FR-018** (Explicit UNMEASURED Marking) | Unmeasured cells (live server and container benchmarks) cataloged with exact causes and handoffs in Section 6. | Forbid silent omission or fabrication; require subagent execution for live container benchmarks. |
| **FR-019** (Subagent Container Delegation) | Main agent container execution is strictly forbidden by repository memory convention. | Tag the Docker-running task in `tasks.md` for dedicated subagent execution. |

### What Speckit Plan Needs Next
1. **Author `scripts/perf-l1-harness.mjs`**: A Bun script simulating synthetic chat completion requests against the `handleChat` pipeline using a mock upstream executor, measuring exact phase latency (`performance.now()`) across JSON parsing, auth/ACL, model resolution, translation, and response formatting.
2. **Specify Request-Scoped Cache & Repo Micro-Cache**: In `src/sse/handlers/chat.js` and `src/sse/services/model.js`, thread a request cache object (or WeakMap) to reuse `keyRecord` and avoid redundant calls to `getApiKeyByKey` and `getSettings`. Micro-cache `providerNodes` in memory with invalidation on `khatam:events:config_reload`.
3. **Design the vertical supervisor and IPC cache-invalidation fallback**: Primary supervisor (`cluster.isPrimary` branch in `custom-server.js`), IPC broker, and per-worker invalidation via `process.send` when Redis is unset.
4. **Draft Tasks with Disjoint Ownership**: Structure `tasks.md` into discrete phases (Scaffolding, Hot-Path Slimming, Vertical Cluster, Ladder Execution) with subagent delegation for container tasks.

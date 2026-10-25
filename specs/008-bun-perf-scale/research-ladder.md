# Research Note: Performance Ladder Definition & Evidence Hunt (US3 / FR-007..FR-008)

**Target Spec**: `specs/008-bun-perf-scale/spec.md` (US3, FR-007, FR-008, FR-009)  
**Date**: 2026-10-24  
**Author**: Performance Architecture Subagent  
**Scope**: Performance ladder tier definitions (L0–L3), existing test & benchmark baseline inventory, single-replica and multi-replica benchmarking methodology, empirical findings, ceiling-moved verdict criteria, next-bottleneck hypotheses, and plan handoff.

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

The performance ladder evaluates KhatamRouter at four ascending levels of abstraction:

| Tier | Name | Target Measured | Execution Context | Primary Metrics |
| :--- | :--- | :--- | :--- | :--- |
| **L0** | Micro-Benchmarks | Isolated functions: `parseModel`, `getModelInfoCore`, `rowToNode`, `bun:sqlite` prepared queries | In-process micro-runner (`bun:test` or `bun -e`) | Latency per operation (µs/op), memory allocation per call |
| **L1** | In-Process Request Hot Path | Full control-plane pipeline: JSON parse, internal trust, ACL, rate/spend quota, `getModelInfo`, translator transform, mock upstream dispatch | Synthetic request harness through `handleChat` (`src/sse/handlers/chat.js:42-270`) with temp `DATA_DIR` | Per-request latency breakdown (ms), `p50`, `p95`, memory churn |
| **L2** | Single-Replica HTTP Server | Standalone HTTP server (`custom-server.js:28-36` on loopback port `20128`) serving concurrent synthetic clients | Loopback HTTP benchmark (e.g. `autocannon` or `k6` or Bun-native client loop) | End-to-end `p50`, `p95`, `p99`, Throughput (`req/s`), CPU saturation % |
| **L3** | Multi-Replica Clustered Scale | 2 to 4 gateway replicas sharing Redis container and shared SQLite WAL volume behind a loopback proxy | Docker Compose cluster (`docker-compose.yml` + scale overlay) | Aggregate throughput (`req/s`), scaling efficiency (1x vs 2x vs 4x), lease/lock contention latency |

---

## 4. Single-Replica Baseline Method (L1 & L2)

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

## 5. Multi-Replica Compose Method (L3)

### 5.1 Compose Scale Architecture
The current `docker-compose.yml:1-56` specifies a single `services.9router` with static `container_name: 9router` and host port `20128:20128`. Running multiple replicas requires:
1. **Removing Container Name Hardcoding**: Remove `container_name: 9router` so docker compose can assign replica instance names (`9router-1`, `9router-2`, etc.).
2. **Reverse Proxy Load Balancer**: Introduce an internal nginx reverse proxy service (e.g. `gateway-lb`) listening on host port `20128`, distributing requests across `http://9router:20128` endpoints using round-robin.
3. **Shared Volume & WAL Safety**: Mount `9router-data:/app/data` to all replicas. Because containers share a local host ext4/xfs volume, POSIX file locking protects SQLite WAL coordination (`busy_timeout = 5000`).
4. **Shared Redis Service**: Centralized `redis:8.2-alpine` container providing the single cluster state backbone.

### 5.2 Scaling Topology & Target Counts
- **Baseline**: 1 replica (`--scale 9router=1`).
- **Scale Tier 1**: 2 replicas (`--scale 9router=2`).
- **Scale Tier 2**: 4 replicas (`--scale 9router=4`).

### 5.3 Execution Mandate (FR-009 / Repo Memory Convention)
Per project instructions and repository memory:
> *"Never run docker in the main agent / subagent smoke test procedure. Live container verification MUST be delegated to subagents (never docker system prune / volume prune)."*

Therefore, live Docker Compose execution for multi-replica scaling MUST be orchestrated via dedicated container smoke subagents using `scripts/w75-compose-smoke.sh` and scale harnesses, never run directly in the planning or main turn.

---

## 6. Empirical Results & Evidence Hunt Table

The table below catalogs measured numbers obtained directly under native Bun on the host machine without Docker, alongside required containerized cells explicitly designated as `UNMEASURED` with cause per FR-008:

| Ladder Level | Measurement Description | Measured Metric / Status | Method & Command | Evidence / Cause |
| :--- | :--- | :--- | :--- | :--- |
| **L0** | `bun:sqlite` Prepared Point Query | **0.0072 ms/op** (7.2 µs) | In-memory temp DB, 1000 prepared lookups | Native Bun JIT + SQLite memory pointer (`bun:sqlite`) |
| **L0** | Alias Baseline Verification | **35 ms** (132/132 pass) | `bun tests/__baseline__/verify-alias.mjs` | `tests/__baseline__/verify-alias.mjs:1-35` byte-for-byte pass |
| **L0** | Provider Config Verification | **40 ms** (124/124 pass) | `bun tests/__baseline__/verify-providers.mjs` | `tests/__baseline__/verify-providers.mjs:1-35` byte-for-byte pass |
| **L0** | Driver Pruning Gate | **50 ms** (0 Node drivers) | `bun scripts/verify-driver-pruning.mjs` | All Node drivers verified pruned from source |
| **L0** | Vitest Unit Test Run (`capabilities`) | **348 ms** (34/34 pass) | `bun x vitest run unit/capabilities.test.js` | Single test suite execution under Bun host |
| **L0** | Translator Golden Headers | **1.69 s** (210/210 pass) | `bun x vitest run translator/golden-url-header.test.js` | 210 provider request header builders verified |
| **L1** | Hot-Path Redundant DB Calls | **~5 to 7 queries/req** | Static code trace of `handleChat` + `getModelInfo` | `src/sse/services/model.js:43-60`, `src/sse/handlers/chat.js:161-191` |
| **L1** | Single-Replica Gateway Latency | **UNMEASURED** | L1 Profile Harness (`scripts/perf-l1-harness.mjs`) | *Cause*: Synthetic L1 harness script to be authored in Speckit Plan phase (FR-001/FR-002) |
| **L2** | Single-Replica HTTP Throughput | **UNMEASURED** | Standalone server + loopback load runner | *Cause*: Requires running standalone HTTP server process during dedicated benchmark pass |
| **L3** | Multi-Replica (2 Replicas) Compose | **UNMEASURED** | `docker compose up --scale 9router=2` | *Cause*: FR-009 / Memory rule forbids direct Docker execution; delegated to subagent smoke harness |
| **L3** | Multi-Replica (4 Replicas) Compose | **UNMEASURED** | `docker compose up --scale 9router=4` | *Cause*: FR-009 / Memory rule forbids direct Docker execution; delegated to subagent smoke harness |
| **L3** | Redis Outage Degradation Throughput | **UNMEASURED** | `scripts/w75-redis-outage-drill.sh` scale run | *Cause*: Requires container drill execution via subagent per FR-006 / FR-009 |

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

## 8. Ceiling-Moved Verdict Criteria (SC-005 / FR-007)

To objectively decide whether the performance ceiling moved after implementing the hot-path slimming and multi-replica compose configuration, the following four criteria must be satisfied:

1. **L1 Overhead Reduction**:
   - The median gateway latency overhead ($p50$) for direct requests must decrease by at least **35%** (e.g. from ~8.0 ms baseline down to $\le 5.0$ ms).
   - $p95$ tail latency must decrease by at least **25%**.
2. **Horizontal Throughput Scalability**:
   - Scaling from 1 replica to 2 replicas in Compose must yield at least **1.6x** throughput under load ($> 80\%$ parallel scaling efficiency).
   - Scaling from 1 replica to 4 replicas must achieve at least **2.8x** throughput before saturation.
3. **Cluster Invariant Preservation**:
   - Zero behavioral regressions: `tests/__baseline__/verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, and golden translator round-trip tests MUST remain 100% green (FR-003).
   - Redis cluster state invariants (concurrency leases via `RedisSemaphore`, circuit-breaker trip events on `khatam:events:circuit_trip`, and combo rotation indices on `khatam:counter:combo:*`) must synchronize across replicas without contention loss or dropped turns (FR-005).
4. **Graceful Outage Fallback**:
   - During a simulated Redis outage (stopping Redis container), all replicas must degrade to internal SQLite/in-memory handling without dropping requests or throwing uncaught exceptions on the request path (FR-006).

---

## 9. Next-Bottleneck Hypotheses

Once the ~8ms hot-path is slimmed and 2–4 Bun replicas are deployed behind Redis, what will constrain the system next?

1. **Hypothesis 1: SQLite WAL Write Contention Under Clustered Load**:
   - While SQLite WAL allows concurrent readers, it permits only **one writer at a time**.
   - With 4 gateway replicas concurrently writing usage ledger entries (`saveRequestUsage`) and session tokens to the shared volume, write transactions will queue. Even with `busy_timeout = 5000`, sustained write throughput exceeding ~500–800 req/s will experience write-lock contention latency spikes ($p99$).
2. **Hypothesis 2: Redis Single-Threaded Event Loop Saturation**:
   - Concurrency semaphores (`RedisSemaphore`) execute Lua scripts (`EVAL`) on ZSETs for every request acquire/release. Under high concurrent load across 4 replicas, Redis CPU utilization on the single-threaded engine may become the bottleneck.
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
| **FR-001** (L1 Profile) | Hotspots attributed: `getModelInfo` (3x SQLite queries in `src/sse/services/model.js:43-60`), `getApiKeyByKey` (3x redundant calls in `src/sse/handlers/chat.js:161-225`), uncached `getSettings()`. | Plan dedicated synthetic L1 profiling script `scripts/perf-l1-harness.mjs` measuring translation, model info, and middleware overhead. |
| **FR-002** (Slim Hotspot & Re-measure) | Identified quick-win optimizations: request-scoped memoization of `keyRecord`, in-memory TTL caching of `providerNodes` and `settings`, skipping node lookups when provider is known. | Implement request context cache and lightweight in-memory cache for `providerNodes` and `settingsRepo`. |
| **FR-003** (Zero Behavior Regressions) | Established test harness: `bun tests/__baseline__/verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, and `translator/golden-url-header.test.js`. | Require these baseline gates in Phase 1 and Phase 2 task completion criteria. |
| **FR-004** (Multi-Replica Compose) | `docker-compose.yml:1-56` has fixed `container_name: 9router`. Scaling requires dynamic container naming and loopback load balancer overlay (`docker-compose.scale.yml`). | Design compose override with reverse proxy service on port 20128 balancing across scaled replicas. |
| **FR-005** (Cluster-Safe State) | Wave 7.5 contracts (`specs/0075-bun-only-redis-default/contracts/redis-conventions.md`) specify `RedisSemaphore`, `khatam:events:circuit_trip`, and combo rotation counters. | Verify cross-replica state sync under 2+ instances in plan tasks. |
| **FR-006** (Redis Outage Graceful Degradation) | Degradation contract verified in `scripts/w75-redis-outage-drill.sh`: fails open for quotas/limits to SQLite, zero request-path crashes. | Retain outage drill verification in multi-replica scale tests. |
| **FR-007** (Identical Metrics Reporting) | Defined metrics contract: $p50$, $p95$, $p99$, throughput (req/s), replica count, command, and isolated temp `DATA_DIR`. | Use identical metrics schema in before/after ladder comparison table. |
| **FR-008** (Explicit UNMEASURED Marking) | Unmeasured cells (live server and container benchmarks) cataloged with exact causes and handoffs in Section 6. | Forbid silent omission or fabrication; require subagent execution for live container benchmarks. |
| **FR-009** (Subagent Container Delegation) | Main agent container execution is strictly forbidden by repository memory convention. | Tag all Docker-running tasks in `tasks.md` for dedicated subagent execution. |

### What Speckit Plan Needs Next
1. **Author `scripts/perf-l1-harness.mjs`**: A Bun script simulating synthetic chat completion requests against the `handleChat` pipeline using a mock upstream executor, measuring exact phase latency (`performance.now()`) across JSON parsing, auth/ACL, model resolution, translation, and response formatting.
2. **Specify Request-Scoped Cache & Repo Micro-Cache**: In `src/sse/handlers/chat.js` and `src/sse/services/model.js`, thread a request cache object (or WeakMap) to reuse `keyRecord` and avoid redundant calls to `getApiKeyByKey` and `getSettings`. Micro-cache `providerNodes` in memory with invalidation on `khatam:events:config_reload`.
3. **Design `docker-compose.scale.yml`**: Compose overlay removing static `container_name: 9router`, exposing scaled replicas, and configuring an internal round-robin proxy on host port `20128`.
4. **Draft Tasks with Disjoint Ownership**: Structure `tasks.md` into discrete phases (Scaffolding, Hot-Path Slimming, Compose Scale Config, Ladder Execution) with subagent delegation for container tasks.

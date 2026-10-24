---
description: "Dependency-ordered task list for Wave 7.5 Bun-Only Runtime and Redis by Default"
---

# Tasks: Wave 7.5 — Bun-Only Runtime and Redis by Default

**Feature Branch**: `spec/0075-bun-only-redis-default`  
**Input**: Design documents from `/specs/0075-bun-only-redis-default/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/redis-conventions.md`, `contracts/idempotency.md`, `quickstart.md`)  
**Prerequisites**: `spec.md` (required), `plan.md` (required), `research.md`, `data-model.md`, `contracts/`  
**Tests**: Bun-hosted Vitest unit test suites (`tests/unit/wave75-*.test.js`, `tests/unit/us7-*.test.js`), baseline checks (`node tests/__baseline__/verify-*.mjs`)  
**Organization**: Tasks are grouped by phase and user story to enable independent implementation and testing of each story with strict disjoint file ownership.

---

## Constitution & Architectural Alignment

- **Principle I (Upstream 9router Base Integrity)**: Retains all 9router routing capabilities, capacity adapters, and provider executors.
- **Principle II (Dual-Runtime Stack & Strict Port Separation)**:  
  *Explicit Architectural Note*: Principle II describes the future Phase 2 Go gateway on port `20129` (`ENDPOINT_PORT`). Phase 2 is not yet built. This wave operates strictly on the Bun control-plane half (port `20128`, `DASHBOARD_PORT`), standardizing on `bun:sqlite` and Redis `8.2-alpine`, maintaining full forward-compatibility with Principle II.
- **Principle III (Shared SQLite3 WAL + Redis Hybrid State)**: `bun:sqlite` is the sole SQLite driver with WAL mode. Redis is enabled by default under `khatam:*` with automatic degradation to SQLite storage (`SqliteQuotaStore`) when Redis is unavailable.
- **Principle IV (Graph-First Discovery & Coverage Invariant)**: All five audit claims were structurally investigated via `codebase-memory-mcp` and verified by direct file inspection in `research.md`.
- **Principle V (Spec-Kit SDD + Unlazy Gate-Driven Completion)**: Tasks follow strict dependency ordering, disjoint file ownership, and explicit test oracles.
- **Principle VI (Resilience, Granular Limits, Stealth & Capabilities)**: Solves circuit-breaker evaluation order, wires `connectionLimiter`, enables spend tracking via `request_cost_ledger`, repairs streaming tool decloaking, and ensures non-chat endpoints enforce unified ACL and quota limits.

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (strictly disjoint file sets, no shared files, no inter-task dependencies).
- **[Story]**: Which user story this task belongs to (`US1`, `US2`, `US3`, `US4`, `US5`, `US6`, `US7`, `Setup`, `Foundational`, `Polish`).
- Every task description specifies the exact files owned.
- Every testable task specifies its exact check command.

---

## Phase 1: Setup & Prerequisite Scaffolding

**Purpose**: Test mocks and verification scripts needed across stories.

- [ ] T001 [P] [Setup] Create Redis test mock supporting Sorted Sets and subscriber isolation in `/tmp/khatam-w75/tests/unit/helpers/redisMock.js`. Provide an enhanced in-memory `FakeRedis` implementing `ZADD`, `ZREM`, `ZCARD`, `ZREMRANGEBYSCORE`, string locks (`SET NX EX`), and command vs subscriber separation.  
  *Files owned*: `tests/unit/helpers/redisMock.js`  
  *Check command*: `bun -e 'import "./tests/unit/helpers/redisMock.js"; console.log("OK");'`

- [ ] T002 [P] [Setup] Create static driver pruning verification script in `/tmp/khatam-w75/scripts/verify-driver-pruning.mjs`. Assert that `better-sqlite3`, `sql.js`, and `node:sqlite` do not appear in source files, manifests, or external package lists (excluding CHANGELOG and spec docs).  
  *Files owned*: `scripts/verify-driver-pruning.mjs`  
  *Check command*: `node scripts/verify-driver-pruning.mjs --dry-run`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before user stories can execute.

- [ ] T003 [Foundational] Separate Redis command client and subscriber client in `/tmp/khatam-w75/src/lib/redis/client.js` and `/tmp/khatam-w75/src/lib/redis/client.ts`. Ensure `getRedisClient()` is used for all general commands and PubSub publishing while `getRedisSubscriber()` is reserved exclusively for subscription listeners (`SUBSCRIBE` / `UNSUBSCRIBE`).  
  *Files owned*: `src/lib/redis/client.js`, `src/lib/redis/client.ts`  
  *Check command*: `bun -e 'import { getRedisClient, getRedisSubscriber } from "./src/lib/redis/client.js"; console.log("OK");'`

- [ ] T004 [Foundational] Implement automatic degradation from Redis to SQLite quota store in `/tmp/khatam-w75/src/lib/quota/redisQuotaStore.js` and `/tmp/khatam-w75/src/lib/quota/redisQuotaStore.ts`. When Redis is unconfigured, disconnected, or throws a runtime error, forward calls to an internal `SqliteQuotaStore` fallback instance so `consume()` and `peek()` strictly enforce limits with `{ allowed, remaining, resetAtMs, resetMs, current, limit, degraded: true }` instead of granting unlimited bypass (resolves Claim 1 / FR-014).  
  *Files owned*: `src/lib/quota/redisQuotaStore.js`, `src/lib/quota/redisQuotaStore.ts`  
  *Check command*: `bun x vitest run unit/wave2-quota-store.test.js`

---

## Phase 3: User Story 1 - One SQLite Driver, Bun Only (Priority: P1) 🎯 MVP

**Goal**: KhatamRouter boots strictly with `bun:sqlite` as its sole driver with WAL mode. All legacy Node fallback drivers (`better-sqlite3`, `node:sqlite`, `sql.js`) are removed.

**Independent Test**: Boot the server on a fresh and existing database; assert reported driver is `bun:sqlite`, `PRAGMA journal_mode` is `wal`, `PRAGMA quick_check` is `ok`, and non-Bun runtime fails closed immediately.

- [ ] T005 [P] [US1] Author unit test suite in `/tmp/khatam-w75/tests/unit/wave75-bun-sqlite.test.js`. Verify `bun:sqlite` single driver initialization, WAL mode enforcement, integrity check on startup, immediate fail-closed error if `process.versions.bun` is missing, and correct behavior of direct consumers (FR-001, FR-002, FR-006).  
  *Files owned*: `tests/unit/wave75-bun-sqlite.test.js`  
  *Check command*: `bun x vitest run unit/wave75-bun-sqlite.test.js`

- [ ] T006 [US1] Refactor `/tmp/khatam-w75/src/lib/db/driver.js` to eliminate all fallback driver probing (`better-sqlite3`, `node:sqlite`, `sql.js`). Enforce an immediate fail-closed error if `process.versions.bun` is missing with a clear error message. Preserve `MIGRATED_MARKER` in the unreachable legacy JSON branch of `/tmp/khatam-w75/src/lib/db/migrate.js` (invoked by `driver.js`) per US7 Acceptance Scenario 14 (FR-001, FR-002).  
  *Files owned*: `src/lib/db/driver.js`  
  *Check command*: `bun -e 'import { getAdapter } from "./src/lib/db/driver.js"; console.log("OK");'`

- [ ] T007 [US1] Delete obsolete adapter files: `/tmp/khatam-w75/src/lib/db/adapters/betterSqliteAdapter.js`, `/tmp/khatam-w75/src/lib/db/adapters/nodeSqliteAdapter.js`, and `/tmp/khatam-w75/src/lib/db/adapters/sqljsAdapter.js` (FR-001).  
  *Files owned*: `src/lib/db/adapters/betterSqliteAdapter.js`, `src/lib/db/adapters/nodeSqliteAdapter.js`, `src/lib/db/adapters/sqljsAdapter.js`  
  *Check command*: `test ! -f src/lib/db/adapters/betterSqliteAdapter.js && test ! -f src/lib/db/adapters/nodeSqliteAdapter.js && test ! -f src/lib/db/adapters/sqljsAdapter.js`

- [ ] T008 [US1] Consolidate `/tmp/khatam-w75/src/lib/db/adapters/bunSqliteAdapter.js` and `/tmp/khatam-w75/src/lib/db/adapters/bunSqliteAdapter.ts`. Ensure consistent method contracts (`run`, `get`, `all`, `exec`, `pragma`, `transaction`, `checkpoint`, `close`) and ensure `get()` returns `null` consistently across both twins on a row miss (FR-001, FR-005).  
  *Files owned*: `src/lib/db/adapters/bunSqliteAdapter.js`, `src/lib/db/adapters/bunSqliteAdapter.ts`  
  *Check command*: `bun -e 'import { createBunSqliteAdapter } from "./src/lib/db/adapters/bunSqliteAdapter.js"; console.log("OK");'`

- [ ] T009 [US1] Update migration runner in `/tmp/khatam-w75/src/lib/db/migrationRunner.js` and `/tmp/khatam-w75/src/lib/db/migrationRunner.ts` to operate strictly over `bunSqliteAdapter` (FR-001).  
  *Files owned*: `src/lib/db/migrationRunner.js`, `src/lib/db/migrationRunner.ts`  
  *Check command*: `bun -e 'import { runMigrations } from "./src/lib/db/migrationRunner.js"; console.log("OK");'`

- [ ] T010 [P] [US1] Update direct SQLite consumers to use `bun:sqlite` with `{ readonly: true }` where read-only (FR-004):  
  - `/tmp/khatam-w75/src/lib/oauth/utils/zedCredentials.js`  
  - `/tmp/khatam-w75/src/app/api/oauth/cursor/auto-import/route.js`  
  - `/tmp/khatam-w75/src/app/api/cli-tools/omp-settings/route.js`  
  - `/tmp/khatam-w75/open-sse/shared/mimoAccount.js`  
  *Files owned*: `src/lib/oauth/utils/zedCredentials.js`, `src/app/api/oauth/cursor/auto-import/route.js`, `src/app/api/cli-tools/omp-settings/route.js`, `open-sse/shared/mimoAccount.js`  
  *Check command*: `node scripts/verify-driver-pruning.mjs`

- [ ] T011 [US1] Prune removed dependencies (`better-sqlite3`, `sql.js`) from root `/tmp/khatam-w75/package.json`, `/tmp/khatam-w75/bun.lock`, and `/tmp/khatam-w75/next.config.mjs` (`serverExternalPackages`) (FR-003).  
  *Files owned*: `package.json`, `bun.lock`, `next.config.mjs`  
  *Check command*: `node scripts/verify-driver-pruning.mjs`

- [ ] T012 [P] [US1] Update CLI launcher in `/tmp/khatam-w75/cli/cli.js`, `/tmp/khatam-w75/cli/package.json`, and `/tmp/khatam-w75/cli/hooks/trayRuntime.js`. Require `bun`, display a clear install guide if absent, launch the server via `bun`, and delete obsolete `/tmp/khatam-w75/cli/hooks/sqliteRuntime.js` (FR-007).  
  *Files owned*: `cli/cli.js`, `cli/package.json`, `cli/hooks/trayRuntime.js`, `cli/hooks/sqliteRuntime.js`  
  *Check command*: `node cli/cli.js --help`

---

## Phase 4: User Story 2 - Docker Compose Runs Bun with Redis On (Priority: P1)

**Goal**: `docker compose up` brings up the single Bun image of KhatamRouter and healthy Redis 8.2 Alpine with zero manual setup.

**Independent Test**: Static inspection and container compose validation verifying Redis service healthcheck, volume persistence, loopback host binding, and app `REDIS_URL` auto-wiring.

- [ ] T013 [P] [US2] Author test `/tmp/khatam-w75/tests/unit/wave75-docker-compose.test.js` validating compose YAML structure, Redis service configuration (`redis:8.2-alpine`, AOF, volume, healthcheck, loopback port), and app container dependency (FR-009, FR-026).  
  *Files owned*: `tests/unit/wave75-docker-compose.test.js`  
  *Check command*: `bun x vitest run unit/wave75-docker-compose.test.js`

- [ ] T014 [US2] Consolidate container definitions: update `/tmp/khatam-w75/Dockerfile.bun` as the single production Bun image, align `/tmp/khatam-w75/Dockerfile` to build from `Dockerfile.bun`, update `/tmp/khatam-w75/start.sh` to run with Bun, and update `/tmp/khatam-w75/captain-definition` (FR-008).  
  *Files owned*: `Dockerfile.bun`, `Dockerfile`, `start.sh`, `captain-definition`  
  *Check command*: `grep -q "oven/bun" Dockerfile && grep -q "bun" start.sh`

- [ ] T015 [US2] Update `/tmp/khatam-w75/docker-compose.yml` to define `redis` service using `redis:8.2-alpine` with `--appendonly yes`, named volume `redis-data`, `redis-cli ping` healthcheck, `127.0.0.1:6379:6379` host port; wire app service to build from `Dockerfile.bun`, depend on `redis` (`condition: service_healthy`), and default `REDIS_URL: redis://redis:6379` (FR-009, FR-010).  
  *Files owned*: `docker-compose.yml`  
  *Check command*: `bun x vitest run unit/wave75-docker-compose.test.js`

---

## Phase 5: User Story 3 - Cluster-Safe Shared State in Redis (Priority: P1)

**Goal**: Coordinate distributed state across multiple router instances behind a load balancer: sorted-set concurrency semaphores, single-use OAuth refresh locks, multi-instance circuit trips, session stickiness, and login limiters.

**Independent Test**: Run two module instances with shared fake Redis; assert concurrency limits hold across replicas, single-use token is refreshed once, trips sync without echo, and outages degrade fail-open.


- [ ] T015a [US2] Author `scripts/w75-compose-smoke.sh`: pin the merge SHA, build the Bun image with `--platform linux/amd64`, `NEXT_BUILD_CPUS=2`, `NODE_OPTIONS=--max-old-space-size=3072`; bring up the stack; wait for Redis `service_healthy`; probe dashboard `/` and `/dashboard` (302/307 to login is PASS) and `/v1/models`; assert `PRAGMA journal_mode=wal` and `quick_check=ok` inside the container; assert a `-wal` file appears in the mounted volume; assert `find / -name better_sqlite3.node` is empty; always clean up containers/images/worktree and never touch the `hindsight` container or run `docker system prune`.
  *Files owned*: `scripts/w75-compose-smoke.sh`
  *Check command*: `bash scripts/w75-compose-smoke.sh`

- [ ] T015b [US2] Author `scripts/w75-redis-outage-drill.sh`: with the stack up, stop the Redis container, assert the app still answers `/v1/models` and that a quota-limited key is still rejected (limits still enforced), assert one degraded warning, then start Redis again and assert reconnection without restart.
  *Files owned*: `scripts/w75-redis-outage-drill.sh`
  *Check command*: `bash scripts/w75-redis-outage-drill.sh`

- [ ] T016 [P] [US3] Author test `/tmp/khatam-w75/tests/unit/wave75-redis-shared-state.test.js` validating distributed semaphore leases, holder-death release, OAuth refresh single-use mutex, multi-instance circuit trip sync, dashboard login limiter, and session pinning across replicas (FR-012, FR-013, FR-015, FR-016, FR-017).  
  *Files owned*: `tests/unit/wave75-redis-shared-state.test.js`  
  *Check command*: `bun x vitest run unit/wave75-redis-shared-state.test.js`

- [ ] T017 [US3] Implement `/tmp/khatam-w75/src/lib/resilience/redisSemaphore.js` providing lease-based concurrency limits using Redis Sorted Sets (`ZSET`) and Lua scripts (`SEMAPHORE_TRY_ACQUIRE`, `SEMAPHORE_RELEASE`), automatic holder-death pruning via score expiration, and seamless fallback to `InProcessSemaphore` (FR-017, FR-022).  
  *Files owned*: `src/lib/resilience/redisSemaphore.js`  
  *Check command*: `bun -e 'import { RedisSemaphore } from "./src/lib/resilience/redisSemaphore.js"; console.log("OK");'`

- [ ] T018 [US3] Update `/tmp/khatam-w75/open-sse/services/tokenRefresh/dedup.js` to add distributed Redis locking (`khatam:lock:refresh:<provider>:<tokenHash>`, `SET NX EX 30`) with result caching to prevent single-use refresh token burn across multiple instances (resolves Claim 2 / FR-013, FR-022).  
  *Files owned*: `open-sse/services/tokenRefresh/dedup.js`  
  *Check command*: `bun -e 'import { dedupRefresh } from "./open-sse/services/tokenRefresh/dedup.js"; console.log("OK");'`

- [ ] T019 [US3] Update `/tmp/khatam-w75/src/lib/resilience/circuitBreakerStore.js` to publish breaker transitions to `OPEN` and `DEGRADED` over `khatam:events:circuit_trip`, subscribe to cluster trips, and synchronize the in-memory breaker registry across replicas without echoing self-published events (FR-012, FR-022).  
  *Files owned*: `src/lib/resilience/circuitBreakerStore.js`  
  *Check command*: `bun -e 'import { getCircuitBreakerForDomain } from "./src/lib/resilience/circuitBreakerStore.js"; console.log("OK");'`

- [ ] T020 [US3] Update `/tmp/khatam-w75/src/lib/auth/loginLimiter.js` to coordinate failed dashboard login counts and lockouts in Redis under `khatam:ratelimit:login:<ipHash>` across cluster instances, falling back to local Map (FR-015, FR-022).  
  *Files owned*: `src/lib/auth/loginLimiter.js`  
  *Check command*: `bun -e 'import { recordFail } from "./src/lib/auth/loginLimiter.js"; console.log("OK");'`

- [ ] T021 [US3] Update `/tmp/khatam-w75/src/lib/stealth/stickiness.js` to store session pin mappings in Redis under `khatam:session:stealth:<promptHash>` with 15-minute TTL, falling back to in-process memory (FR-016, FR-022).  
  *Files owned*: `src/lib/stealth/stickiness.js`  
  *Check command*: `bun -e 'import { getStickyConnection } from "./src/lib/stealth/stickiness.js"; console.log("OK");'`

- [ ] T022 [US3] Wire cache invalidation for pricing and request details observability config caches upon receiving `khatam:events:config_reload` events in `/tmp/khatam-w75/src/lib/db/repos/pricingRepo.js` and `/tmp/khatam-w75/src/lib/db/repos/requestDetailsRepo.js` (FR-019).  
  *Files owned*: `src/lib/db/repos/pricingRepo.js`, `src/lib/db/repos/requestDetailsRepo.js`  
  *Check command*: `bun -e 'import { getPricing } from "./src/lib/db/repos/pricingRepo.js"; console.log("OK");'`

---

## Phase 6: User Story 4 - Redis Accelerators (Priority: P2)

**Goal**: Accelerate request handling with advisory API key auth caching, pub/sub dashboard usage/log streaming, and atomic round-robin rotation counters.

**Independent Test**: Unit tests asserting cache hit metadata speedup, negative control rejecting revoked keys, log/usage fanout without echo, and atomic counter rotation.

- [ ] T023 [P] [US4] Author test `/tmp/khatam-w75/tests/unit/wave75-redis-accelerators.test.js` validating advisory API key auth caching with negative control (revoked/banned key rejected), live usage and log pub/sub fanout, and atomic counter rotation (FR-018, FR-020, FR-021).  
  *Files owned*: `tests/unit/wave75-redis-accelerators.test.js`  
  *Check command*: `bun x vitest run unit/wave75-redis-accelerators.test.js`

- [ ] T024 [US4] Implement `/tmp/khatam-w75/src/lib/auth/apiKeyCache.js` for advisory Redis caching of API key metadata (`khatam:cache:auth:key:<apiKeyHash>`, 60s TTL), ensuring cache hits never bypass SQLite status checks for revoked/banned keys; wire eviction on revoke/ban/delete into `/tmp/khatam-w75/src/lib/db/repos/apiKeysRepo.js` (FR-020, FR-022).  
  *Files owned*: `src/lib/auth/apiKeyCache.js`, `src/lib/db/repos/apiKeysRepo.js`  
  *Check command*: `bun -e 'import { getCachedApiKey } from "./src/lib/auth/apiKeyCache.js"; console.log("OK");'`

- [ ] T025 [P] [US4] Implement distributed usage fanout in `/tmp/khatam-w75/src/lib/usage/usageFanout.js` publishing usage records over `khatam:events:usage` so all dashboard instances receive live metrics without double-echo (FR-021).  
  *Files owned*: `src/lib/usage/usageFanout.js`  
  *Check command*: `bun -e 'import { fanoutUsageEvent } from "./src/lib/usage/usageFanout.js"; console.log("OK");'`

- [ ] T026 [P] [US4] Update `/tmp/khatam-w75/src/lib/consoleLogBuffer.js` to fan out console log lines over `khatam:events:console_log` to all cluster dashboard log subscribers (FR-021, FR-022).  
  *Files owned*: `src/lib/consoleLogBuffer.js`  
  *Check command*: `bun -e 'import { initConsoleLogCapture } from "./src/lib/consoleLogBuffer.js"; console.log("OK");'`

- [ ] T027 [US4] Implement atomic round-robin rotation in `/tmp/khatam-w75/src/sse/handlers/chat/comboRotation.js` and `/tmp/khatam-w75/open-sse/services/combo.js` using Redis `INCR` (`khatam:counter:combo:<comboName>:index`) and in `/tmp/khatam-w75/open-sse/services/proxyPoolFitness.js` (`khatam:counter:proxy:pool:index`) eliminating per-request SQLite disk writes (FR-018).  
  *Files owned*: `src/sse/handlers/chat/comboRotation.js`, `open-sse/services/combo.js`, `open-sse/services/proxyPoolFitness.js`  
  *Check command*: `bun x vitest run unit/wave75-redis-accelerators.test.js`

---

## Phase 7: User Story 5 - Opt-In Idempotency Keys (Priority: P2)

**Goal**: Prevent duplicate upstream execution and duplicate billing on retried requests by caching responses keyed by `(apiKeyHash, idempotencyKey)` for non-streaming requests.

**Independent Test**: Send identical requests with same key (assert 0 additional upstream calls); send key with conflicting body (assert 422); send streaming request (assert bypass).

- [ ] T028 [P] [US5] Author test `/tmp/khatam-w75/tests/unit/wave75-idempotency.test.js` verifying response replay on identical request, payload mismatch conflict (HTTP 422), in-flight concurrent handling (HTTP 409), streaming request exclusion, and per-API-key tenant isolation (FR-023).  
  *Files owned*: `tests/unit/wave75-idempotency.test.js`  
  *Check command*: `bun x vitest run unit/wave75-idempotency.test.js`

- [ ] T029 [US5] Implement `/tmp/khatam-w75/src/lib/idempotency/idempotencyStore.js` managing idempotency records under `khatam:idempotency:<apiKeyHash>:<idempotencyKey>` with SHA-256 payload hashing, 300s TTL, 60s in-flight locking, and fail-open behavior (FR-022, FR-023).  
  *Files owned*: `src/lib/idempotency/idempotencyStore.js`  
  *Check command*: `bun -e 'import { getIdempotencyStore } from "./src/lib/idempotency/idempotencyStore.js"; console.log("OK");'`

- [ ] T030 [US5] Wire `Idempotency-Key` header handling into `/tmp/khatam-w75/src/sse/handlers/chat.js` for non-streaming chat requests, adding `Idempotency-Replayed: true` header on replays, returning 422 on payload mismatch, and returning 409 when in-flight. (Serialized before T032 double-gate fix) (FR-023).  
  *Files owned*: `src/sse/handlers/chat.js`  
  *Check command*: `bun x vitest run unit/wave75-idempotency.test.js`

---

## Phase 8: User Story 7 - Wave 1-7 Defect Fixes (Priority: P2)

**Goal**: Resolve 11 verified Wave 1–7 defects with a strict failing-test-first protocol, plus twin alignment and legacy marker verification. Every Scenario 1-11 fix task below satisfies **FR-025** (each confirmed defect fixed with a regression test; twins resolved; `MIGRATED_MARKER` untouched).

### Scenario 1: Double-Gate ACL Rejection Fix
- [ ] T031 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario01-double-gate.test.js` reproducing defect where keys using Wave 3 tri-state ACL are rejected by the legacy `enforceKeyAccess` gate after passing the unified gate in `src/sse/handlers/chat.js`.  
  *Files owned*: `tests/unit/us7-scenario01-double-gate.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario01-double-gate.test.js`
- [ ] T032 [US7] Fix `/tmp/khatam-w75/src/sse/handlers/chat.js` to remove redundant legacy `enforceKeyAccess` invocation when unified ACL evaluation has already completed. (Serialized after T030) (FR-025).  
  *Files owned*: `src/sse/handlers/chat.js`  
  *Check command*: `bun x vitest run unit/us7-scenario01-double-gate.test.js`

### Scenario 2: Connection Limiter Wiring
- [ ] T033 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario02-connection-limiter.test.js` verifying that connection rate, spacing, or concurrency limits trigger `connectionLimiter.js` during dispatch.  
  *Files owned*: `tests/unit/us7-scenario02-connection-limiter.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario02-connection-limiter.test.js`
- [ ] T034 [US7] Update `/tmp/khatam-w75/open-sse/handlers/chatCore.js` to wire and invoke `/tmp/khatam-w75/open-sse/services/rateLimitManager/connectionLimiter.js` on incoming connection dispatch, and pass the in-process semaphores (`open-sse/services/rateLimitManager/semaphore.js`) through the Redis lease path from leaf 1.4 when available.  
  *Files owned*: `open-sse/handlers/chatCore.js`  
  *Check command*: `bun x vitest run unit/us7-scenario02-connection-limiter.test.js`

### Scenario 3: Spend Ledger Wiring
- [ ] T035 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario03-spend-ledger.test.js` verifying that completed requests populate `request_cost_ledger` and trigger USD spend caps.  
  *Files owned*: `tests/unit/us7-scenario03-spend-ledger.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario03-spend-ledger.test.js`
- [ ] T036 [US7] Update `/tmp/khatam-w75/open-sse/handlers/chatCore.js` to wire post-flight invocation of `recordKeyQuotaUsage` (`src/domain/keyQuota.js`) so `request_cost_ledger` is populated and USD caps in `src/lib/usage/apiKeyUsageLimits.js` actually trigger. (Serialized with T034).  
  *Files owned*: `open-sse/handlers/chatCore.js`  
  *Check command*: `bun x vitest run unit/us7-scenario03-spend-ledger.test.js`

### Scenario 4: GateTarget Priority Inversion Fix
- [ ] T037 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario04-gatetarget-priority.test.js` verifying that `gateTarget` without `options.getBreaker` returns `circuit_open` rather than `cooldown` when a breaker is `OPEN` (resolves Claim 3).  
  *Files owned*: `tests/unit/us7-scenario04-gatetarget-priority.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario04-gatetarget-priority.test.js`
- [ ] T038 [US7] Fix `/tmp/khatam-w75/src/domain/fallbackResilience.js` to await `resolveBreaker(domain)` before invoking `evaluateTargetGates` so Gate 1 (`circuitGate`) executes first and cannot be skipped by cooldowns.  
  *Files owned*: `src/domain/fallbackResilience.js`  
  *Check command*: `bun x vitest run unit/us7-scenario04-gatetarget-priority.test.js`

### Scenario 5: HALF_OPEN Probe Budget Consumption
- [ ] T039 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario05-half-open-probe.test.js` verifying that `HALF_OPEN` circuit state consumes the probe budget via `canExecute()` so concurrent probes are strictly bounded.  
  *Files owned*: `tests/unit/us7-scenario05-half-open-probe.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario05-half-open-probe.test.js`
- [ ] T040 [US7] Update `/tmp/khatam-w75/src/domain/executeTargetGates.js` to invoke `canExecute()` on the circuit breaker to properly consume the probe budget during `HALF_OPEN` admission.  
  *Files owned*: `src/domain/executeTargetGates.js`  
  *Check command*: `bun x vitest run unit/us7-scenario05-half-open-probe.test.js`

### Scenario 6: PubSub Subscriber Publish Bug Fix
- [ ] T041 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario06-pubsub-subscriber-publish.test.js` verifying that `publishKhatamEvent` rejects publishing over a subscriber connection and successfully publishes over the command client (resolves Claim 4).  
  *Files owned*: `tests/unit/us7-scenario06-pubsub-subscriber-publish.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario06-pubsub-subscriber-publish.test.js`
- [ ] T042 [US7] Update `/tmp/khatam-w75/src/lib/redis/events.js` and `/tmp/khatam-w75/src/lib/redis/events.ts` to use `getRedisClient()` instead of `getRedisSubscriber()` for `publishKhatamEvent`, and add `USAGE` (`"khatam:events:usage"`) and `CONSOLE_LOG` (`"khatam:events:console_log"`) to `KHATAM_EVENTS`.  
  *Files owned*: `src/lib/redis/events.js`, `src/lib/redis/events.ts`  
  *Check command*: `bun x vitest run unit/us7-scenario06-pubsub-subscriber-publish.test.js`

### Scenario 7: Passthrough Streaming Tool Decloak & Dead Code Removal
- [ ] T043 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario07-passthrough-tool-decloak.test.js` verifying that same-format streams decloak tool names for clients when tool cloaking is active (resolves Claim 5).  
  *Files owned*: `tests/unit/us7-scenario07-passthrough-tool-decloak.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario07-passthrough-tool-decloak.test.js`
- [ ] T044 [US7] Update `/tmp/khatam-w75/open-sse/handlers/chatCore/streamingHandler.js` to pass `toolNameMap` into `createPassthroughStreamWithLogger` / decloak stream chunks, and document `restoreToolNames` / remove uncalled `decloakToolsInResponse` in `/tmp/khatam-w75/src/lib/stealth/toolCloak.js`.  
  *Files owned*: `open-sse/handlers/chatCore/streamingHandler.js`, `src/lib/stealth/toolCloak.js`  
  *Check command*: `bun x vitest run unit/us7-scenario07-passthrough-tool-decloak.test.js`

### Scenario 8: Model Discovery Reconciler Wiring
- [ ] T045 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario08-model-discovery-reconciler.test.js` verifying that `normalizeDiscoveredModels` feeds the context reconciler and capability cascade at request time.  
  *Files owned*: `tests/unit/us7-scenario08-model-discovery-reconciler.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario08-model-discovery-reconciler.test.js`
- [ ] T046 [US7] Wire discovery end-to-end: in `/tmp/khatam-w75/src/app/api/providers/[id]/models/route.js` call `normalizeDiscoveredModels`, persist the result, then invoke `resolveModelCapabilities` via `/tmp/khatam-w75/src/lib/models/contextReconciler.js`; fix `normalizeDiscoveredModels` dropping its `providerIdOrOptions` argument (`src/lib/models/discovery.js`) so the reconciler can consume its output. If wiring is judged unsafe, the alternative is deleting the dead modules and documenting discovery as manual-only — record which was chosen.
  *Files owned*: `src/app/api/providers/[id]/models/route.js`, `src/lib/models/discovery.js`, `src/lib/models/capabilities.js`, `src/lib/models/contextReconciler.js`
  *Check command*: `bun x vitest run unit/us7-scenario08-model-discovery-reconciler.test.js`

### Scenario 9: Non-Chat Endpoints Unified ACL and Spend Enforcement
- [ ] T047 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario09-non-chat-acl-spend.test.js` verifying that embeddings and non-chat endpoints reject revoked/banned keys and enforce spend caps.  
  *Files owned*: `tests/unit/us7-scenario09-non-chat-acl-spend.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario09-non-chat-acl-spend.test.js`
- [ ] T048 [US7] Update non-chat endpoints (`/tmp/khatam-w75/src/sse/handlers/embeddings.js`, `/tmp/khatam-w75/src/app/api/v1/embeddings/route.js`, `/tmp/khatam-w75/src/app/api/v1/images/generations/route.js`, `/tmp/khatam-w75/src/app/api/v1/audio/transcriptions/route.js`) to enforce the unified ACL gate and spend check.  
  *Files owned*: `src/sse/handlers/embeddings.js`, `src/app/api/v1/embeddings/route.js`, `src/app/api/v1/images/generations/route.js`, `src/app/api/v1/audio/transcriptions/route.js`  
  *Check command*: `bun x vitest run unit/us7-scenario09-non-chat-acl-spend.test.js`

### Scenario 10: CI Test Suite List Completeness
- [ ] T049 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario10-ci-suites.test.js` asserting that `.github/workflows/verify.yml` lists all unit test suites from Waves 1 through 7.  
  *Files owned*: `tests/unit/us7-scenario10-ci-suites.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario10-ci-suites.test.js`
- [ ] T050 [US7] Update `/tmp/khatam-w75/.github/workflows/verify.yml` to include `wave4-resilience.test.js`, `wave5-stealth.test.js`, `wave6-models.test.js`, and `wave7-parity.test.js` in the `unit-wave` job.  
  *Files owned*: `.github/workflows/verify.yml`  
  *Check command*: `bun x vitest run unit/us7-scenario10-ci-suites.test.js`

### Scenario 11: Production Secret Enforcement & Windsurf Registry Consistency
- [ ] T051 [P] [US7] Author failing test `/tmp/khatam-w75/tests/unit/us7-scenario11-secrets-windsurf.test.js` verifying that `custom-server.js` fails closed in production when `JWT_SECRET` or `API_KEY_SECRET` is unset, and verifying Windsurf provider registry inclusion vs test expectation.  
  *Files owned*: `tests/unit/us7-scenario11-secrets-windsurf.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario11-secrets-windsurf.test.js`
- [ ] T052 [US7] Update `/tmp/khatam-w75/custom-server.js` to execute `runtime-secrets.cjs` validation at boot time, and align `/tmp/khatam-w75/scripts/migrate-registry.mjs` and `/tmp/khatam-w75/tests/unit/windsurf-executor.test.js` for Windsurf consistency.  
  *Files owned*: `custom-server.js`, `scripts/migrate-registry.mjs`, `tests/unit/windsurf-executor.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario11-secrets-windsurf.test.js`

### Scenario 12: Twin Audit & Alignment
- [ ] T053 [P] [US7] Author audit test `/tmp/khatam-w75/tests/unit/wave75-twins-alignment.test.js` checking that `.js` and `.ts` twins (`bunSqliteAdapter`, `redisQuotaStore`, `events`, `client`) do not diverge in behavior, return shapes, or exported symbols.  
  *Files owned*: `tests/unit/wave75-twins-alignment.test.js`  
  *Check command*: `bun x vitest run unit/wave75-twins-alignment.test.js`

### Scenario 13: Documentation Statements Match Code
(Satisfied by documentation synchronization in Phase 10 tasks T057–T062 and verified via `scripts/verify-docs-claims.mjs` in T064 per US7 Acceptance Scenario 13).

### Scenario 14: MIGRATED_MARKER Legacy Branch Preserved
- [ ] T054 [P] [US7] Author test `/tmp/khatam-w75/tests/unit/us7-scenario14-migrated-marker.test.js` confirming that the `MIGRATED_MARKER` reference in the legacy JSON migration branch of `src/lib/db/migrate.js` (reached via `src/lib/db/driver.js`) remains untouched as required by US7 Acceptance Scenario 14.  
  *Files owned*: `tests/unit/us7-scenario14-migrated-marker.test.js`  
  *Check command*: `bun x vitest run unit/us7-scenario14-migrated-marker.test.js`

---

## Phase 9: User Story 6 - Build Pipeline: Turbopack Evaluation (Priority: P3)

**Goal**: Execute an isolated comparison between Next.js Webpack and Turbopack under Bun across 5 concrete criteria; adopt Turbopack conditionally only if zero regressions occur.

- [ ] T055 [US6] Create evaluation script `/tmp/khatam-w75/scripts/eval-turbopack.mjs` to execute Webpack vs Turbopack comparison under Bun in an isolated worktree (`/tmp/khatam-turbopack-eval`), recording build time, peak RSS memory, standalone directory size, route manifest diff, and container runtime checks (FR-024).  
  *Files owned*: `scripts/eval-turbopack.mjs`, `specs/0075-bun-only-redis-default/turbopack-eval.md`  
  *Check command*: `node scripts/eval-turbopack.mjs --dry-run`

- [ ] T056 [US6] Execute Turbopack evaluation and record findings in `/tmp/khatam-w75/specs/0075-bun-only-redis-default/turbopack-eval.md`. Conditionally adopt Turbopack in `package.json` build scripts ONLY if all 5 comparison criteria pass with zero regressions; otherwise retain `--webpack` and document rationale in `CLAUDE.md`. (Depends on T055) (FR-024).  
  *Files owned*: `specs/0075-bun-only-redis-default/turbopack-eval.md`, `CLAUDE.md`, `package.json`  
  *Check command*: `test -f specs/0075-bun-only-redis-default/turbopack-eval.md`

---

## Phase 10: Documentation, CI & Polish (Cross-Cutting Concerns)

**Purpose**: Explicit documentation updates, regression baseline regeneration, and quickstart validation.

- [ ] T057 [P] [Polish] Update `/tmp/khatam-w75/.env.example` with `REDIS_URL=redis://redis:6379`, `REDIS_KEY_PREFIX=khatam:`, Redis disable instructions, and dual-port documentation (`DASHBOARD_PORT=20128`) (FR-010, FR-011, FR-022).  
  *Files owned*: `.env.example`  
  *Check command*: `grep -q "redis://redis:6379" .env.example`

- [ ] T058 [P] [Polish] Update `/tmp/khatam-w75/DOCKER.md` documenting Bun-only single image architecture, Redis 8.2 Alpine service configuration, volume persistence, and outage drills (FR-011).  
  *Files owned*: `DOCKER.md`  
  *Check command*: `grep -q "redis:8.2-alpine" DOCKER.md`

- [ ] T059 [P] [Polish] Update `/tmp/khatam-w75/docs/ARCHITECTURE.md` documenting `bun:sqlite` as sole SQLite engine, Redis default architecture, sorted-set semaphores, OAuth refresh locks, auth caching, and idempotency key handling (FR-011).  
  *Files owned*: `docs/ARCHITECTURE.md`  
  *Check command*: `grep -q "bun:sqlite" docs/ARCHITECTURE.md`

- [ ] T060 [Polish] Update `/tmp/khatam-w75/CLAUDE.md` documenting Bun runtime requirements, removal of fallback drivers, compose defaults, and Turbopack evaluation outcome (FR-011). (Serialized after T056.)  
  *Files owned*: `CLAUDE.md`  
  *Check command*: `grep -q "bun:sqlite" CLAUDE.md`

- [ ] T061 [P] [Polish] Update `/tmp/khatam-w75/README.md` and all shipped variants (`README.zh-CN.md`, `/tmp/khatam-w75/public/i18n/`, `/tmp/khatam-w75/i18n/`, `gitbook/`) reflecting Bun runtime requirement, Redis by default in compose, and removed Node driver dependencies (FR-011).  
  *Files owned*: `README.md`, `README.zh-CN.md`, `public/i18n/`, `i18n/`, `gitbook/`  
  *Check command*: `grep -q "bun:sqlite" README.md`

- [ ] T062 [P] [Polish] Update `/tmp/khatam-w75/ROADMAP.md` marking Wave 7.5 as shipped/in-progress between Wave 7 and Wave 8 (FR-027).  
  *Files owned*: `ROADMAP.md`  
  *Check command*: `grep -q "Wave 7.5" ROADMAP.md`

- [ ] T063 [Polish] Regenerate baseline test snapshots and update `known-fails.txt` to account for removed driver test suites and verified defect fixes (FR-006, SC-008).  
  *Files owned*: `tests/package.json`, `tests/vitest.config.js`, `tests/__baseline__/baseline-results.json`, `tests/__baseline__/known-fails.txt`  
  *Check command*: `node tests/__baseline__/verify-no-regression.mjs`

- [ ] T064 [Polish] Run full Quickstart verification protocol (`specs/0075-bun-only-redis-default/quickstart.md` Scenarios 1–5) and confirm container smoke test passes.  
  *Files owned*: `specs/0075-bun-only-redis-default/quickstart.md`  
  *Check command*: `node scripts/verify-docs-claims.mjs`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Can run immediately. No dependencies.
- **Foundational (Phase 2)**: Depends on Phase 1. Blocks all subsequent user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2. Core database driver unification.
- **User Story 2 (Phase 4)**: Depends on Phase 3 (Docker builds from Bun image).
- **User Story 3 (Phase 5)**: Depends on Phase 2 (Redis client separation & quota degradation).
- **User Story 4 (Phase 6)**: Depends on Phase 5 (Redis shared state & pubsub).
- **User Story 5 (Phase 7)**: Depends on Phase 5 (Redis client).
- **User Story 7 (Phase 8)**: Depends on Phase 2. Each scenario executes failing test first, then fix. Tasks touching `src/sse/handlers/chat.js` and `open-sse/handlers/chatCore.js` are serialized.
- **User Story 6 (Phase 9)**: Independent evaluation; runs after Phase 3.
- **Polish (Phase 10)**: Depends on all user stories completing.

### File Serialization Chains (No Races):
- `src/sse/handlers/chat.js`: T030 (idempotency header) → T032 (double-gate fix).
- `open-sse/handlers/chatCore.js`: T034 (connection limiter) → T036 (spend ledger).
- `src/lib/redis/events.js` & `.ts`: T042 (subscriber publish fix) depends on T003 (client separation).
- `package.json`: T011 (prune drivers) → T056 (Turbopack conditional adoption).
- `CLAUDE.md`: T056 (Turbopack eval rationale) → T060 (CLAUDE.md doc update).

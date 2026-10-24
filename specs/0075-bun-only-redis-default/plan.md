# Implementation Plan: Wave 7.5 — Bun-Only Runtime and Redis by Default

**Branch**: `spec/0075-bun-only-redis-default` | **Date**: 2026-10-23 | **Spec**: [specs/0075-bun-only-redis-default/spec.md](/tmp/khatam-w75/specs/0075-bun-only-redis-default/spec.md)

**Input**: Feature specification from `/tmp/khatam-w75/specs/0075-bun-only-redis-default/spec.md`

---

## Summary

Wave 7.5 establishes **Bun** as the sole supported runtime for the KhatamRouter control plane and dashboard, eliminating `better-sqlite3`, `node:sqlite`, and `sql.js` entirely in favor of native `bun:sqlite` with WAL mode. It configures **Redis 8.2** (`redis:8.2-alpine`) as the default in `docker-compose.yml`, elevating Redis to its full potential across cluster instances:
- Cluster-safe shared state (sorted-set concurrency semaphores, single-use OAuth refresh locks, multi-instance circuit trips, session stickiness, and login limiters).
- Redis accelerators (API key auth metadata cache, pub/sub usage and log streaming, atomic round-robin rotation).
- Opt-in `Idempotency-Key` response replay for non-streaming inference requests.
- Fail-open resilience with graceful degradation from `RedisQuotaStore` to `SqliteQuotaStore`.
- Resolution of 12 verified Wave 1–7 defects (including double-gate ACL rejection, uncalled `connectionLimiter`, unrecorded `request_cost_ledger`, `gateTarget` priority inversion, subscriber publish rejection, and passthrough streaming decloak).
- Isolated evaluation protocol for Next.js Turbopack vs Webpack.

---

## Technical Context

**Language/Version**: JavaScript (ESM) and TypeScript (`tsconfig.json` `noEmit: true`), executed on **Bun `v1.4.3`**.  
**Primary Dependencies**: Next.js 16 (`standalone` output), `ioredis` (^6.0.0), `bun:sqlite` (built-in). `better-sqlite3` and `sql.js` completely removed.  
**Storage**:
- **Durable**: SQLite 3 WAL at `$DATA_DIR/db/data.sqlite` via `bun:sqlite` (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`).
- **Ephemeral/Cluster**: Redis 8.2 Alpine (`redis:8.2-alpine`) with AOF persistence, keyed under `khatam:*`.  
**Testing**: Bun-hosted **Vitest** (`tests/package.json`, `tests/vitest.config.js` via `bun x vitest run`).  
**Target Platform**: Linux containers (`Dockerfile.bun`, AMD64 & ARM64), local Bun CLI.  
**Project Type**: Local AI routing gateway + Next.js web dashboard (`src/`), engine (`open-sse/`), launcher CLI (`cli/`).  
**Performance Goals**: < 1ms local SQLite queries, < 2ms Redis lease acquisitions, zero disk I/O on combo/proxy rotation, 0 duplicate upstream requests on network retries.  
**Constraints**: Fail-open for infrastructure outages without throwing on the request path; strict tenant isolation per hashed API key; zero plaintext secrets in Redis keys.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I (Upstream 9router Base Integrity)**: **PASS**. Preserves all 9router base capabilities (`keyAccess`, `capacityAdapter`, `responsesHandler`, `pxpipe`, and all 40+ provider executors).
- **Principle II (Dual-Runtime Stack & Strict Port Separation)**: **PASS**.
  - Control plane and dashboard run on **Bun `v1.4.3`** on port **`20128`** (`DASHBOARD_PORT`).
  - *Explicit architectural note*: Principle II describes the future Phase 2 Go gateway on port `20129`. Phase 2 is not yet built; Wave 7.5 operates strictly on the Bun control-plane half and maintains full forward compatibility with Principle II.
- **Principle III (Shared SQLite3 WAL + Redis Hybrid State)**: **PASS**. `bun:sqlite` is the sole SQLite driver with WAL mode. Redis is enabled by default under `khatam:*` with automatic degradation to SQLite storage (`SqliteQuotaStore`) when Redis is unavailable.
- **Principle IV (Graph-First Discovery & Coverage Invariant)**: **PASS**. All five audit claims were structurally investigated via `codebase-memory-mcp` (`search_graph`, `trace_path`, `check_index_coverage`), verified by direct file inspection, and documented in `research.md`.
- **Principle V (Spec-Kit SDD + Unlazy Gate-Driven Completion)**: **PASS**. Plan follows speckit-plan workflow; Unlazy gates will track implementation.
- **Principle VI (Resilience, Granular Limits, Stealth & Capabilities)**: **PASS**. Fixes circuit-breaker evaluation order, wires `connectionLimiter`, enables spend tracking via `request_cost_ledger`, repairs streaming tool decloaking, and ensures non-chat endpoints enforce unified ACL and quota limits.

---

## Project Structure & Work Breakdown (Leaf Split by File Ownership)

To prevent merge races and ensure modular delivery, implementation is split into disjoint, file-ownership-isolated task leaves:

```
specs/0075-bun-only-redis-default/
├── plan.md              # Implementation Plan (this document)
├── research.md          # Phase 0 Research & Verified Claims
├── data-model.md        # Phase 1 Data Model & Entity Schemas
├── quickstart.md        # Phase 1 Runnable Validation Scenarios
├── contracts/
│   ├── redis-conventions.md  # Redis key naming, lease Lua scripts, pub/sub schemas
│   └── idempotency.md        # HTTP Idempotency-Key request/response contract
└── tasks.md             # Phase 2 Work Breakdown (generated next)
```

### Disjoint Leaf Split:

1. **`db-runtime`** (Leaf Owner: Core DB)
   - Files: `src/lib/db/driver.js`, `src/lib/db/adapters/bunSqliteAdapter.js`, `src/lib/db/adapters/bunSqliteAdapter.ts`, `src/lib/db/migrationRunner.js`, `src/lib/db/migrationRunner.ts`.
   - Remove: `src/lib/db/adapters/betterSqliteAdapter.js`, `nodeSqliteAdapter.js`, `sqljsAdapter.js`.
   - Update Direct Consumers to `bun:sqlite`: `src/lib/oauth/utils/zedCredentials.js`, `src/app/api/oauth/cursor/auto-import/route.js`, `src/app/api/cli-tools/omp-settings/route.js`, `open-sse/shared/mimoAccount.js`.
   - Prune dependencies in `package.json`, `bun.lock`, `next.config.mjs` (`serverExternalPackages`).

2. **`packaging-docker`** (Leaf Owner: Infra/Docker)
   - Files: `Dockerfile.bun`, `Dockerfile`, `docker-compose.yml`, `start.sh`, `captain-definition`.
   - Consolidate to `Dockerfile.bun` as the single image definition; configure `docker-compose.yml` with `redis:8.2-alpine` healthcheck, named volume, loopback host binding, and `REDIS_URL` auto-wiring.

3. **`cli-bun`** (Leaf Owner: CLI)
   - Files: `cli/cli.js`, `cli/package.json`, `cli/hooks/trayRuntime.js`.
   - Remove: `cli/hooks/sqliteRuntime.js`.
   - Require `bun` runtime, provide clear install instructions if missing, launch server via `bun`.

4. **`redis-shared-state`** (Leaf Owner: Distributed State)
   - Files: `src/lib/redis/client.js`, `src/lib/redis/client.ts`, `src/lib/redis/events.js`, `src/lib/redis/events.ts`, `src/lib/resilience/redisSemaphore.js`, `open-sse/services/tokenRefresh/dedup.js`, `src/lib/auth/loginLimiter.js`, `src/lib/stealth/stickiness.js`, `src/lib/resilience/circuitBreakerStore.js`, `src/lib/db/repos/pricingRepo.js`, `src/lib/db/repos/requestDetailsRepo.js`.
   - Implement sorted-set lease-based semaphore, distributed OAuth refresh lock (`SET NX EX`), multi-instance circuit trip sync (`CIRCUIT_TRIP`), dashboard login limiter in Redis, stealth session pinning, and cache invalidation for pricing and request details on config reload.

5. **`redis-accelerators`** (Leaf Owner: Performance/PubSub)
   - Files: `src/lib/auth/apiKeyCache.js`, `src/lib/usage/usageFanout.js`, `src/lib/consoleLogBuffer.js`, `src/sse/handlers/chat/comboRotation.js`, `open-sse/services/combo.js`, `open-sse/services/proxyPoolFitness.js`, `src/lib/db/repos/apiKeysRepo.js`.
   - Implement advisory Redis API key auth cache, pub/sub fanout for dashboard usage and log events, atomic round-robin rotation counters, and config-reload cache invalidation.

6. **`idempotency`** (Leaf Owner: API Protocols)
   - Files: `src/lib/idempotency/idempotencyStore.js`, `src/sse/handlers/chat.js`, `open-sse/handlers/chatCore.js`.
   - Implement opt-in `Idempotency-Key` header handling, request hashing, response caching, conflict detection (422), and in-flight handling (409).

7. **`us7-defect-fixes`** (Leaf Owner: Defect Resolution)
   - Files:
     - `src/sse/handlers/chat.js`: Fix double-gate ACL rejection.
     - `open-sse/handlers/chatCore.js`: Wire `open-sse/services/rateLimitManager/connectionLimiter.js` and post-flight `recordKeyQuotaUsage`.
     - `src/domain/fallbackResilience.js`: Fix `gateTarget` pre-resolution order (Circuit > Cooldown > Credential).
     - `src/domain/executeTargetGates.js`: Consume probe budget in `canExecute()` for HALF_OPEN circuit state.
     - `src/lib/redis/events.js` & `.ts`: Fix publish-over-subscriber bug by publishing through command client and add `USAGE` / `CONSOLE_LOG` channels.
     - `open-sse/handlers/chatCore/streamingHandler.js`: Fix passthrough streaming tool decloak.
     - `src/lib/stealth/toolCloak.js`: Remove dead `decloakToolsInResponse` and document `restoreToolNames`.
     - `src/app/api/providers/[id]/models/route.js`: Wire `normalizeDiscoveredModels` and context reconciler.
     - `src/sse/handlers/embeddings.js`, `src/app/api/v1/embeddings/route.js`, `src/app/api/v1/images/generations/route.js`, `src/app/api/v1/audio/transcriptions/route.js`: Enforce unified ACL, key validation, and spend limits on non-chat endpoints.
     - `custom-server.js`: Fail closed in production when secrets are empty or unset.
     - `scripts/migrate-registry.mjs`, `tests/unit/windsurf-executor.test.js`: Resolve registry test inconsistency for hidden Windsurf provider.

8. **`tests-baseline`** (Leaf Owner: QA/CI)
   - Files: `tests/package.json`, `tests/vitest.config.js`, `.github/workflows/verify.yml`, `tests/__baseline__/`.
   - Configure Bun-hosted Vitest, wire Wave 4–7 test suites into `verify.yml`, regenerate baseline snapshots for removed drivers.

9. **`turbopack-eval`** (Leaf Owner: Build Pipeline)
   - Files: `scripts/eval-turbopack.mjs`, `CLAUDE.md`.
   - Execute isolated comparison of Webpack vs Turbopack under Bun; record results.

10. **`docs`** (Leaf Owner: Documentation)
    - Files: `README.md`, `README.zh-CN.md`, `ROADMAP.md`, `CLAUDE.md`, `DOCKER.md`, `docs/ARCHITECTURE.md`, `public/i18n/`, `i18n/`, `gitbook/`.
    - Document Bun-only runtime, Redis by default, compose setup, Breaking Changes for CLI, and updated architecture.

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| :--- | :--- | :--- |
| *None* | No constitutional violations. Fully aligns with Principles I–VI. | N/A |

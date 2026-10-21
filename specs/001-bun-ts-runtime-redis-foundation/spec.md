# Feature Specification: Wave 1 - Bun TS Runtime & Redis Foundation

**Feature Branch**: `001-bun-ts-runtime-redis-foundation`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Wave 1: Bun v1.4.3 + TypeScript configuration, DASHBOARD_PORT=20128 and ENDPOINT_PORT=20129 separation in .env.example & custom-server, bun:sqlite WAL adapter with busy_timeout=5000 & integrity check, and Redis client/PubSub with 'khatam:' prefix"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bun v1.4.3 Runtime & TypeScript Compilation Foundation (Priority: P1)

As a developer and system operator, I need KhatamRouter to run natively on Bun v1.4.3 with full TypeScript compilation support and a multi-stage Docker build, so that the control plane operates with minimal memory footprint and fast startup times while maintaining strict type safety.

**Why this priority**: Foundational prerequisite for all subsequent control plane and dashboard features in the migration to TypeScript.

**Independent Test**: Can be fully tested by running `bun -v` (confirming Bun v1.4.3+), running `tsc --noEmit` against `tsconfig.json` without compiler errors, and verifying `Dockerfile.bun` builds an `oven/bun:1.4.3-slim` image.

**Acceptance Scenarios**:

1. **Given** a development or production environment with Bun v1.4.3 installed, **When** executing `bun run dev` or `bun run build`, **Then** the project compiles and starts using native Bun runtime semantics.
2. **Given** a codebase with mixed JavaScript and TypeScript files, **When** running TypeScript verification (`tsconfig.json`), **Then** `@/*` paths resolve correctly to `./src/*`, and compiler flags (`ES2022`, `bundler` resolution, `skipLibCheck: true`) pass without errors.
3. **Given** `Dockerfile.bun`, **When** building a container image, **Then** it uses `oven/bun:1.4.3-slim` base, executes `bun install --include=optional`, verifies `bun:sqlite` with an inline query, and prepares a production runner on port 20128.

---

### User Story 2 - Dual-Port Separation: Dashboard vs Endpoint Gateway (Priority: P1)

As a cluster operator, I need KhatamRouter to strictly separate the control-plane dashboard (port 20128) from the data-plane endpoint gateway (port 20129) without requiring manual mode toggles, so that dashboard management traffic cannot saturate or compromise the high-throughput LLM proxy path.

**Why this priority**: Adheres to KhatamRouter Constitution Principle II (Dual-Runtime Stack & Strict Port Separation).

**Independent Test**: Can be fully tested by starting the server with `.env.example` configurations and verifying port bindings: management/dashboard routes bind to `DASHBOARD_PORT=20128` (or fallback `PORT=20128`), while documentation and gateway configurations expose `ENDPOINT_PORT=20129`.

**Acceptance Scenarios**:

1. **Given** an environment configuration with `DASHBOARD_PORT=20128` and `ENDPOINT_PORT=20129`, **When** `custom-server.js` initializes, **Then** it binds the Next.js control plane to port 20128 and exports configuration recognizing port 20129 for the data-plane gateway.
2. **Given** legacy deployments setting only `PORT=20128`, **When** the server reads environment variables, **Then** it maps `PORT` to `DASHBOARD_PORT` gracefully while keeping `ENDPOINT_PORT` default at 20129.
3. **Given** `.env.example`, **When** inspected by an operator, **Then** it clearly documents `DASHBOARD_PORT=20128` for the Bun control plane and `ENDPOINT_PORT=20129` for the Go data-plane gateway.

---

### User Story 3 - Robust bun:sqlite WAL Database Adapter with Busy Timeout & Integrity Check (Priority: P1)

As an application service, I need a database adapter utilizing native `bun:sqlite` with write-ahead logging (WAL), a 5000ms busy timeout, and a startup integrity check, so that concurrent readers and writers across Bun and the Go gateway can safely access the database without SQLITE_BUSY lock exhaustion or silent corruption.

**Why this priority**: Required by Constitution Principle III to safely support multi-process concurrent access on `$DATA_DIR/db/data.sqlite`.

**Independent Test**: Can be fully tested by instantiating the `bun:sqlite` adapter in a unit test, running `PRAGMA integrity_check`, verifying WAL journal mode, and asserting `busy_timeout` is 5000.

**Acceptance Scenarios**:

1. **Given** the database file `$DATA_DIR/db/data.sqlite`, **When** the adapter initializes under Bun runtime, **Then** it executes `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;`.
2. **Given** a newly opened or recovered database connection, **When** startup checks execute, **Then** `PRAGMA integrity_check` runs; if the result is not `ok`, initialization throws a descriptive corruption error.
3. **Given** background operations or graceful shutdown, **When** `adapter.checkpoint()` or shutdown handlers trigger, **Then** `PRAGMA wal_checkpoint(TRUNCATE)` safely truncates the WAL log.

---

### User Story 4 - Redis Client & Real-Time PubSub with 'khatam:' Prefix & Offline Fallback (Priority: P1)

As a distributed routing instance, I need a Redis client and Pub/Sub manager that namespaces all keys under `khatam:` and falls back gracefully to in-memory/SQLite operation when `REDIS_URL` is unset, so that multi-replica synchronization works reliably in production while local zero-dependency development remains possible.

**Why this priority**: Constitution Principle III requires Redis state sharing (`khatam:` prefix) for rate limiting, quotas, circuit breakers, and event bus invalidation.

**Independent Test**: Can be fully tested by creating the Redis manager with and without `REDIS_URL`, verifying that all keys and channels are prefixed with `khatam:`, and confirming graceful no-op/fallback behavior when offline.

**Acceptance Scenarios**:

1. **Given** `REDIS_URL` is set, **When** the Redis client connects, **Then** all set/get commands prefix keys with `khatam:`, and subscriptions listen to `khatam:events:*`.
2. **Given** `REDIS_URL` is empty or undefined, **When** the application attempts to publish or read Redis cache, **Then** it does not crash, logs an informational fallback warning once, and uses an in-memory/SQLite fallback.
3. **Given** a cluster invalidation event (`khatam:events:config_reload` or `khatam:events:circuit_trip`), **When** broadcast via Redis Pub/Sub, **Then** subscribed listeners receive and dispatch the payload to clear local caches.

---

### Edge Cases

- **Missing Bun Runtime**: If executed in standard Node.js environments (e.g. legacy tests or scripts), the driver falls back cleanly to `better-sqlite3`, `node:sqlite`, or `sql.js` without failing on missing `bun:sqlite`.
- **Database File Corruption**: If `PRAGMA integrity_check` returns anything other than `ok`, the adapter stops initialization and surfaces the exact corruption report rather than writing further corrupted rows.
- **SQLite Concurrency & High Write Load**: With `PRAGMA busy_timeout = 5000`, transient write locks back off up to 5 seconds before raising `SQLITE_BUSY`.
- **Redis Connection Drops & Reconnection**: `ioredis` reconnection strategy retries with exponential backoff up to a maximum delay (e.g. 2000ms), maintaining an offline command buffer or shedding non-critical cache reads.
- **Port Collisions**: If `DASHBOARD_PORT` equals `ENDPOINT_PORT`, startup logs a configuration error indicating the dual-runtime architecture requires distinct ports.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a root `tsconfig.json` configuring TypeScript 5.x with `target: "ES2022"`, `moduleResolution: "bundler"`, `paths: { "@/*": ["./src/*"] }`, and support for Bun and Next.js.
- **FR-002**: System MUST provide `Dockerfile.bun` using `oven/bun:1.4.3-slim` as the base image, supporting multi-stage build, dependency caching, and native runtime execution.
- **FR-003**: System MUST update `package.json` to expose Bun development, build, and test scripts (`dev:bun`, `build:bun`, `start:bun`, `test:bun`).
- **FR-004**: System MUST specify `DASHBOARD_PORT=20128` (Control Plane / Dashboard) and `ENDPOINT_PORT=20129` (Data Plane Gateway) in `.env.example`.
- **FR-005**: `custom-server.js` (and any TypeScript entry point) MUST read `DASHBOARD_PORT` with fallback to `PORT` and default `20128`.
- **FR-006**: `runtime-secrets.cjs` MUST maintain consistent peer token validation and IP spoofing defenses across both dashboard and gateway forwarding paths.
- **FR-007**: `src/lib/db/adapters/bunSqliteAdapter.js` MUST use native `bun:sqlite`, apply WAL mode, set `PRAGMA busy_timeout = 5000`, and execute `PRAGMA integrity_check` on connection creation.
- **FR-008**: Database initialization MUST fail with a clear diagnostic message if `PRAGMA integrity_check` fails.
- **FR-009**: Database adapter MUST implement clean checkpointing (`PRAGMA wal_checkpoint(TRUNCATE)`) periodically and upon `SIGINT`/`SIGTERM` process termination.
- **FR-010**: System MUST provide a Redis module under `src/lib/redis/` enforcing the `khatam:` key prefix across all keys and Pub/Sub channel names.
- **FR-011**: The Redis module MUST operate in graceful fallback mode when `REDIS_URL` is omitted, returning null or in-memory responses without throwing unhandled exceptions.
- **FR-012**: System MUST supply a Vitest unit test suite `tests/unit/wave1-bun-ts-redis-sqlite.test.js` validating Bun runtime detection, SQLite WAL PRAGMAs, integrity check, port separation logic, and Redis key prefixing.

### Key Entities

- **DatabaseAdapter**: The unified interface (`run`, `get`, `all`, `exec`, `transaction`, `checkpoint`, `close`) backed by `bun:sqlite` under Bun and fallbacks under Node.
- **RedisManager**: Singleton client wrapping `ioredis` with automatic prefixing (`khatam:`), connection pooling, Pub/Sub event dispatcher, and offline mode guards.
- **ServerConfig**: Centralized runtime configuration parsing `DASHBOARD_PORT`, `ENDPOINT_PORT`, database path, and Redis connectivity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `tsconfig.json` parses successfully and validates the repository source tree without syntax or configuration errors.
- **SC-002**: `.env.example` explicitly defines `DASHBOARD_PORT=20128` and `ENDPOINT_PORT=20129`.
- **SC-003**: The `bun:sqlite` adapter executes `PRAGMA integrity_check` and sets `busy_timeout` to 5000ms.
- **SC-004**: Redis client produces keys formatted as `khatam:<namespace>:<identifier>` across all operations.
- **SC-005**: Test suite `tests/unit/wave1-bun-ts-redis-sqlite.test.js` passes with 100% assertions green.
- **SC-006**: Existing provider baseline integrity check (`node tests/__baseline__/verify-providers.mjs`) passes without regressions.

## Assumptions

- Bun v1.4.3+ is installed on the target development and deployment environments (with binaries available in `$HOME/.bun/bin` or standard PATH).
- Upstream 9router control-plane endpoints and Next.js routes remain backward compatible while TypeScript types and adapter enhancements are phased in.
- Data-plane gateway (Go 1.27.2) will run as an independent process on port 20129 and connect to the same SQLite WAL file and Redis instance.

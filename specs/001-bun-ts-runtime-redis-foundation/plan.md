# Implementation Plan: Wave 1 - Bun TS Runtime & Redis Foundation

**Branch**: `001-bun-ts-runtime-redis-foundation` | **Date**: 2026-10-21 | **Spec**: [Feature Spec](./spec.md)

**Input**: Feature specification from `/specs/001-bun-ts-runtime-redis-foundation/spec.md`

## Summary

This plan establishes the foundation for Wave 1 of the KhatamRouter migration:
1. **Bun v1.4.3 + TypeScript Runtime Foundation**: Configures TypeScript compiler settings (`tsconfig.json`) matching OmniRoute's battle-tested Next.js/Bun setup and a multi-stage `Dockerfile.bun` utilizing `oven/bun:1.4.3-slim`.
2. **Dual-Port Separation**: Adheres to KhatamRouter Constitution Principle II by defining `DASHBOARD_PORT=20128` (control plane) and `ENDPOINT_PORT=20129` (data plane) in `.env.example`, `custom-server.js`, and runtime helpers, modeling the socket/peer IP protection patterns from VansRouter.
3. **Robust `bun:sqlite` WAL Adapter**: Enhances the existing database adapter to enforce `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, `PRAGMA synchronous = NORMAL`, and runs `PRAGMA integrity_check` on connection startup to guarantee multi-process integrity across Bun and Go runtimes.
4. **Redis Subsystem with `khatam:` Prefix**: Implements an `ioredis`-based Redis client and Pub/Sub manager under `src/lib/redis/` that strictly namespaces keys and channels under `khatam:`, with automatic fail-safe fallback when `REDIS_URL` is omitted.
5. **Validation & Unit Testing**: Deploys a targeted Vitest test suite (`tests/unit/wave1-bun-ts-redis-sqlite.test.js`) and verifies provider catalog baseline integrity without regressions.

## Technical Context

**Language/Version**: TypeScript 5.x / JavaScript ES2022 / Bun v1.4.3 (Node.js 22+ fallback for legacy tooling)

**Primary Dependencies**: Next.js 16.1.6, React 19.2.4, `ioredis` ^5.4.0, native `bun:sqlite`

**Storage**: SQLite 3.45+ (via `bun:sqlite` in WAL mode, shared at `$DATA_DIR/db/data.sqlite`), Redis 7+ (via `ioredis`, optional)

**Testing**: Vitest (`npx vitest run`), Node test baseline verification (`tests/__baseline__/verify-providers.mjs`)

**Target Platform**: Linux x86_64 / arm64, Docker (`oven/bun:1.4.3-slim`), WSL2

**Project Type**: Full-stack Next.js control plane with dual-port split for Go 1.27.2 data-plane gateway

**Performance Goals**:
- Bun cold start < 500ms
- SQLite query p99 latency < 5ms under concurrent access
- Zero `SQLITE_BUSY` crashes under 5000ms lock contention
- Redis Pub/Sub invalidation delivery < 5ms

**Constraints**:
- Strict port separation: 20128 for dashboard / control plane, 20129 for endpoint gateway
- Shared SQLite file must be safely shared with Go process without schema divergence
- Zero regressions against 9Router upstream baseline provider catalog (94 providers)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I: Upstream Base Integrity**: PASSED. No upstream providers, executors, or key access modules modified or removed.
- **Principle II: Dual-Runtime Stack & Strict Port Separation**: PASSED. Control plane dashboard bound to `DASHBOARD_PORT=20128`; gateway configured for `ENDPOINT_PORT=20129`.
- **Principle III: Shared SQLite3 WAL + Redis Hybrid State**: PASSED. SQLite connection uses identical PRAGMAs (`WAL`, `NORMAL`, `busy_timeout = 5000`, `MEMORY`, `foreign_keys = ON`), startup integrity check, and Redis client strictly namespaces `khatam:`.
- **Principle IV: Graph-First Discovery & Coverage Invariant**: PASSED. OmniRoute and VansRouter patterns inspected directly.
- **Principle V: Spec-Kit SDD + Unlazy Gate-Driven Completion**: PASSED. Specs generated under `specs/001-bun-ts-runtime-redis-foundation/`, Unlazy ledger under `.unlazy/wave-001/GATES.md` with passing `gate-lint.mjs`.

## Architectural References & Patterns

### 1. OmniRoute Patterns
- **`Dockerfile.bun`**: Multi-stage build (`oven/bun:1.4.3-slim AS base`), build dependencies (`build-essential`, `python3`, `make`, `g++`, `libsecret-1-0`), dependency caching layer, native `bun install --include=optional`, and native `bun:sqlite` smoke check during image creation.
- **TypeScript Configuration (`tsconfig.json`)**: Configured with `target: "ES2022"`, `module: "esnext"`, `moduleResolution: "bundler"`, `allowJs: true`, `jsx: "react-jsx"`, path mappings (`@/*` pointing to `./src/*`), and isolatedModules for compatibility with both Bun and Next.js.
- **Redis Connection Management**: Connection lifecycle, exponential backoff reconnect, and error handling patterns for clustered and single-node Redis deployments.

### 2. VansRouter Patterns
- **Port Management & Clean Configuration**: Clear distinction between `PORT` (legacy/general) and dedicated service ports, with `custom-server.js` managing socket binding and reverse proxy forwarding headers.
- **Peer Token & Spoofing Defense**: Deriving TCP socket peer IP (`x-9r-real-ip` / `x-khatam-real-ip`) from the actual socket connection, stripping untrusted client-supplied headers, and stamping `NINEROUTER_PEER_TOKEN` / `KHATAM_PEER_TOKEN`.
- **`runtime-secrets.cjs` Integration**: Self-contained runtime secrets generation ensuring zero plain-text fallback tokens are committed to source control.

## Project Structure

### Documentation (this feature)

```text
specs/001-bun-ts-runtime-redis-foundation/
├── spec.md              # Feature specification
├── plan.md              # Technical implementation plan (this file)
└── tasks.md             # Dependency-ordered task list (T001..T008)
```

### Source Code Changes & Files Touched

```text
/home/redsnow/KhatamRouter/
├── .gitignore                                      # Added .unlazy/ and .unlazy-hook-state.json
├── .env.example                                    # DASHBOARD_PORT=20128 and ENDPOINT_PORT=20129
├── package.json                                    # Bun scripts (dev:bun, build:bun, test:bun) & types
├── tsconfig.json                                   # TypeScript compiler configuration for Bun/Next.js
├── Dockerfile.bun                                  # Multi-stage Bun 1.4.3 production container
├── custom-server.js                                # Port binding (DASHBOARD_PORT) & socket peer IP
├── runtime-secrets.cjs                             # Peer token derivation
├── src/
│   └── lib/
│       ├── db/
│       │   ├── schema.js                           # PRAGMA_SQL with busy_timeout=5000 & WAL
│       │   ├── driver.js                           # Driver loader & startup integrity check invocation
│       │   └── adapters/
│       │       └── bunSqliteAdapter.js             # Native bun:sqlite adapter with integrity check
│       └── redis/
│           ├── client.ts                           # ioredis client with 'khatam:' key prefixing
│           ├── pubsub.ts                           # PubSub event bus for cluster invalidation
│           └── index.ts                            # Public module exports & graceful fallback guards
├── tests/
│   └── unit/
│       └── wave1-bun-ts-redis-sqlite.test.js      # Vitest unit test suite for Wave 1
└── .unlazy/
    └── wave-001/
        └── GATES.md                                # Unlazy verification ledger (G1, G2, G3)
```

## Detailed Technical Design

### 1. TypeScript & Bun Configuration (`tsconfig.json`, `package.json`, `Dockerfile.bun`)
- Create `tsconfig.json` with compiler options tailored for Bun v1.4.3 + Next.js App Router:
  - `target: "ES2022"`, `lib: ["dom", "dom.iterable", "esnext"]`
  - `allowJs: true`, `checkJs: false`, `skipLibCheck: true`
  - `module: "esnext"`, `moduleResolution: "bundler"`, `resolveJsonModule: true`
  - `jsx: "react-jsx"`, `incremental: true`
  - `paths: { "@/*": ["./src/*"] }`
- Update `package.json` scripts:
  - `"dev:bun": "bun --bun next dev --webpack --port 20128"`
  - `"build:bun": "bun --bun next build --webpack"`
  - `"start:bun": "bun custom-server.js --port 20128"`
  - `"test:bun": "bun test"`
- Create `Dockerfile.bun` referencing OmniRoute's `Dockerfile.bun`:
  - Base: `oven/bun:1.4.3-slim`
  - Package installation: `bun install --include=optional`
  - Pre-build smoke check: `bun -e "import { Database } from 'bun:sqlite'; ..."`
  - Production runner with default `PORT=20128` and non-root execution.

### 2. Dual-Port Separation (`.env.example`, `custom-server.js`)
- Update `.env.example`:
  ```ini
  # Control Plane & Dashboard port (Bun v1.4.3 runtime)
  DASHBOARD_PORT=20128
  PORT=20128

  # Data Plane Endpoint Gateway port (Go 1.27.2 runtime)
  ENDPOINT_PORT=20129
  ```
- Update `custom-server.js`:
  - Parse `process.env.DASHBOARD_PORT || process.env.PORT || 20128`.
  - Maintain peer token header sanitization (`x-9r-real-ip` / `x-khatam-real-ip`).

### 3. `bun:sqlite` WAL Adapter with Integrity Check (`bunSqliteAdapter.js`)
- PRAGMAs ensured:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 30000000;
  PRAGMA cache_size = -64000;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```
- Startup integrity check:
  ```js
  const integrity = db.query("PRAGMA integrity_check").get();
  const status = integrity ? Object.values(integrity)[0] : null;
  if (status !== "ok") {
    throw new Error(`[DB] SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }
  ```
- WAL checkpointing:
  - Periodic checkpoint: `PRAGMA wal_checkpoint(TRUNCATE)` every 60 seconds with unref'd timer.
  - Safe shutdown checkpoint on `SIGINT`, `SIGTERM`, `beforeExit`.

### 4. Redis Client & Pub/Sub (`src/lib/redis/`)
- Module structure:
  - `src/lib/redis/client.ts`: Singleton managing Redis connection via `ioredis`. If `REDIS_URL` or `REDIS_HOST` is unset, client transitions to disconnected/stub mode.
  - Prefixing: Custom key prefix utility or `keyPrefix: "khatam:"` option in `ioredis` configuration so all keys (`khatam:ratelimit:*`, `khatam:quota:*`, `khatam:circuit:*`) are isolated.
  - `src/lib/redis/pubsub.ts`: Pub/Sub event dispatcher for cluster invalidation (`khatam:events:config_reload`, `khatam:events:circuit_trip`).
  - Fallback: Transparent in-memory Map / event emitter when Redis is inactive so single-node installations run out-of-the-box.

### 5. Vitest Unit Test Suite (`tests/unit/wave1-bun-ts-redis-sqlite.test.js`)
- Tests:
  1. Port separation contract: verifies `DASHBOARD_PORT` defaults to 20128, `ENDPOINT_PORT` to 20129, and precedence order.
  2. `bun:sqlite` adapter contract: verifies WAL mode, `busy_timeout` set to 5000ms, and integrity check passes.
  3. Redis namespace contract: verifies key formatting includes `khatam:` prefix and fallback operates cleanly without unhandled rejections when Redis is offline.
  4. TypeScript configuration contract: verifies `tsconfig.json` can be loaded and compiler options are valid.

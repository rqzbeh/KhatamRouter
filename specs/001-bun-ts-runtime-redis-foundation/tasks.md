---
description: "Dependency-ordered checklist of tasks for Wave 1 Bun TS Runtime & Redis Foundation"
---

# Tasks: Wave 1 - Bun TS Runtime & Redis Foundation

**Input**: Design documents from `/specs/001-bun-ts-runtime-redis-foundation/` (`spec.md`, `plan.md`)

**Prerequisites**: `spec.md` (required), `plan.md` (required)

**Tests**: Unit test suite `tests/unit/wave1-bun-ts-redis-sqlite.test.js` and baseline test `tests/__baseline__/verify-providers.mjs`.

**Organization**: Tasks are dependency-ordered across 4 phases to establish the Bun v1.4.3 runtime, TypeScript configuration, dual-port split, SQLite WAL adapter, and Redis client.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Environment & Configuration Setup

**Purpose**: Establish base configuration files, container definition, and environment variables.

- [x] T001 [P] [US1] Create root `tsconfig.json` with compiler options for Bun v1.4.3 and Next.js (ES2022 target, bundler module resolution, `@/*` path mapping to `./src/*`, isolatedModules, skipLibCheck).
- [x] T002 [P] [US1] Create `Dockerfile.bun` referencing OmniRoute's `oven/bun:1.4.3-slim` multi-stage pattern and update `package.json` with Bun execution scripts (`dev:bun`, `build:bun`, `start:bun`).
- [x] T003 [P] [US2] Update `/home/redsnow/KhatamRouter/.env.example` to define `DASHBOARD_PORT=20128` (control plane) and `ENDPOINT_PORT=20129` (data plane) with documentation on dual-runtime port separation.

---

## Phase 2: Foundational Server & Database Core

**Purpose**: Wire port separation into the server entry point and strengthen SQLite WAL database adapter.

- [x] T004 [US2] Update `/home/redsnow/KhatamRouter/custom-server.js` and `/home/redsnow/KhatamRouter/runtime-secrets.cjs` to bind Next.js to `DASHBOARD_PORT` (default 20128, fallback `PORT`), enforce socket peer IP derivation, and sanitize forwarding headers per VansRouter pattern.
- [x] T005 [US3] Enhance `/home/redsnow/KhatamRouter/src/lib/db/adapters/bunSqliteAdapter.js` and `/home/redsnow/KhatamRouter/src/lib/db/driver.js` to enforce `PRAGMA busy_timeout = 5000`, `PRAGMA journal_mode = WAL`, execute startup `PRAGMA integrity_check`, and manage periodic WAL checkpointing.

---

## Phase 3: Redis Client & Pub/Sub Subsystem

**Purpose**: Build the distributed caching and event invalidation layer.

- [x] T006 [US4] Implement `/home/redsnow/KhatamRouter/src/lib/redis/client.ts` using `ioredis` with mandatory `khatam:` key prefix, exponential reconnect backoff, and graceful in-memory/no-op fallback when `REDIS_URL` is omitted.
- [x] T007 [US4] Implement `/home/redsnow/KhatamRouter/src/lib/redis/events.ts` (with the `.js` twin loaded at runtime) to manage cluster-wide event broadcasting (`khatam:events:config_reload`, `khatam:events:circuit_trip`) with offline safety guards.

---

## Phase 4: Verification & Automated Gate Testing

**Purpose**: Validate all Wave 1 deliverables against acceptance criteria and Unlazy gates.

- [x] T008 [US1..US4] Author and execute unit test suite `/home/redsnow/KhatamRouter/tests/unit/wave1-bun-ts-redis-sqlite.test.js` validating Bun runtime detection, SQLite WAL PRAGMAs & integrity checks, port separation resolution, and Redis `khatam:` key isolation under Vitest; verify provider catalog baseline integrity via `node tests/__baseline__/verify-providers.mjs`.

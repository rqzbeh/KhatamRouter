# KhatamRouter Constitution

## Core Principles

### I. Upstream `decolua/9router` Base Integrity
KhatamRouter is a direct fork of `decolua/9router` (`master` @ `v0.5.104`). Every feature ported from `Vanszs/VansRouter` and `diegosouzapw/OmniRoute` MUST be implemented cleanly on top of the `9router` codebase without regressing or deleting `9router`'s upstream capabilities (`keyAccess`, `capacityAdapter`, `responsesHandler`, `pxpipe`, and the 8 newer upstream executors).

### II. Single-Runtime Stack & Port Contract (Bun `v1.4.4`)
- **Unified Gateway & Dashboard**: Executed entirely on **Bun `v1.4.4`** (`bun:sqlite` sole driver, Next.js App Router, `custom-server.js`). Both dashboard control-plane and `/v1/*` endpoint routing run in a single process listening on default port **`20128`** (`PORT`, with `DASHBOARD_PORT` kept as a backward-compatible alias).

### III. SQLite3 WAL + Redis Hybrid State
- **SQLite3**: Driven exclusively by **`bun:sqlite`** (the sole SQLite driver) on `$DATA_DIR/db/data.sqlite` using WAL mode connection PRAGMAs (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `temp_store = MEMORY`, `foreign_keys = ON`). Bun's versioned migration runner (`_khatam_migrations`) is the single schema migration authority at startup.
- **Redis**: Redis (`ioredis`) uses the `khatam:` key prefix for atomic Lua rate limiting (`RATE_LIMIT_SCRIPT`), sliding-window token/spend quotas (`INCRBYFLOAT`), 4-state circuit breakers, session stickiness, and real-time Pub/Sub invalidation (`khatam:events:config_reload`, `khatam:events:circuit_trip`), with graceful SQLite fallback when `REDIS_URL` is unset.

### IV. Graph-First Discovery & Coverage Invariant (`codebase-memory-mcp`)
Before modifying any subsystem, agents MUST query `codebase-memory-mcp` (`search_graph`, `trace_path`, `get_code_snippet`) across `home-redsnow-KhatamRouter`, `home-redsnow-VansRouter`, and `home-redsnow-OmniRoute`, followed by `check_index_coverage` on every relied-upon file. Any `parse_partial`, `metadata_changed`, or excluded range MUST be verified via direct source `Read`/`Grep`.

### V. Spec-Kit SDD + Unlazy Gate-Driven Completion (NON-NEGOTIABLE)
Every implementation wave MUST be specified under `specs/<NNN-feature>/` (`spec.md`, `plan.md`, `tasks.md`) and tracked by an Unlazy ledger (`.unlazy/<scope>/PLAN.md` and per-leaf `GATES.md`). Every leaf ledger MUST pass `gate-lint.mjs` with zero errors before execution and `gate-check.mjs` (process exit 0 + `EXPECT:` token match) before completion is reported.

### VI. Resilience, Granular Limits, Stealth & Dynamic Model Capabilities
- **Stateless Executors**: Executors are stateless singletons; `buildHeaders(credentials, stream = true, model = null, body = null)` MUST NOT mutate instance state.
- **Granular Rate/Token/Spend Limits**: Provider connections enforce `rate_limit_overrides_json` (`rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, `modelConcurrency`); API keys enforce sliding windows (`RPH`, `RPM`, `RPD`), token limits (`TPD`, `TPM`), and USD caps (`request_cost_ledger`).
- **4-State Circuit Breaker**: Enforces `CLOSED -> DEGRADED -> OPEN -> HALF_OPEN` with failure-kind cooldowns and exempts client 4xx (400, 406, 408, 409, 410, 422) and content-filter `POLICY` refusals.
- **Stealth & Anti-Ban**: Enforces CLI header/field ordering, proxy header scrubbing, provider identity profiles (Antigravity, Cursor Jyh checksum, Copilot, Claude Code xxHash64 `cch=`), tool cloaking, `U+200D` ZWJ obfuscation, TLS fingerprinting, and 15m session stickiness.
- **Dynamic & Custom Model Capabilities**: Supports live provider model/capability discovery (`vision`, `video`, `audio`, `tools`, `reasoning`, `contextWindow`, `maxOutputTokens`), `models.dev` catalog sync, and custom models with full capability metadata and fail-closed combo capability gating.

## Development Workflow & Model Delegation Tiers

- **Orchestrator & Verifier (Main Session)**: Authors Spec-Kit specs/plans/tasks, Unlazy `PLAN.md` and `GATES.md` ledgers, queries `codebase-memory-mcp`, dispatches subagent waves, and runs parent `--reverify` and regression checks.
- **`judgment` Tier Leaves (`model: "sonnet"`)**: Bun/TS/Redis foundation, DB migrations, ACL & rate limiters, 4-state circuit breaker, stealth suite, and model capability discovery.
- **`mechanical` Tier Leaves (`model: "haiku"`)**: Provider registry ports, TTS voice lists, repository CRUD helpers, and UI/CLI wiring with fixed `CHECK:`/`EXPECT:` oracles.

**Version**: 2.1.0 | **Ratified**: 2026-10-21 | **Last Amended**: 2026-10-24

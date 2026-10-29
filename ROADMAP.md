# KhatamRouter Architectural Roadmap

## Introduction

This document outlines the architectural **intent and forward-looking development plan** for KhatamRouter. For the operational capabilities active in the codebase today, refer to the [README.md](./README.md).

**Nothing in this document should be construed as currently operational unless explicitly designated with the 🟢 Shipped status.** All other capabilities represent planned or in-progress architectural targets.

---

## Status Legend

| Status | Meaning |
| :---: | :--- |
| 🟢 **Shipped** | Implemented, verified by automated tests, and operational in the current codebase. |
| 🟡 **In progress** | Actively specified and under active development; partial implementation underway. |
| 🔵 **Planned** | Fully specified architectural target scheduled for an upcoming wave. |
| ⚪ **Exploring** | Early design investigation, prototyping, and feasibility analysis. |

---

## Shipped Today

The table below mirrors the shipped rows of the authoritative status table in [README.md](./README.md):

| Feature Capability | Status | Target Wave / Delivery |
| :--- | :---: | :--- |
| **Bun v1.4.3 Runtime** | 🟢 Shipped | Wave 1: Native Bun execution, `@/*` mapping, `Dockerfile.bun` |
| **SQLite WAL Engine + Integrity Preflight** | 🟢 Shipped | Wave 1: `bun:sqlite` WAL, `busy_timeout=5000`, startup integrity check |
| **Redis Accelerator & Real-Time Pub/Sub** | 🟢 Shipped | Wave 1: `khatam:` namespace, cluster invalidation, transparent SQLite fallback |
| **Versioned DB Migrations & Hybrid Quota** | 🟢 Shipped | Wave 2: Idempotent `_khatam_migrations` runner with backup-before-migrate, additive schema v3, hybrid Redis/SQLite sliding-window quota store with fail-open, 5s settings cache |
| **Unified Tri-State ACL & Internal Trust** | 🟢 Shipped | Wave 3: Pure tri-state access control (kinds, providers, combos, models), 404 enumeration defense, constant-time internal trust token |
| **Granular Per-Connection / Key Limits** | 🟢 Shipped | Wave 3: Connection concurrency/rate overrides (`rate_limit_overrides_json`), multi-window key limits (RPM/RPH/RPD), and USD spend caps with fail-open degradation |
| **Hardened Request Ingestion & Smuggling Defense** | 🟢 Shipped | HTTP/1.1 & h2c smuggling defenses, 128 MiB JSON body cap, 64 MiB chunked cap |
| **Token Savers (RTK, Caveman, Ponytail)** | 🟢 Shipped | Pre-translation tool compression with 10 MiB cap, prompt injection modes |
| **4-State Resilient Circuit Breakers** | 🟢 Shipped | Wave 4: 4-state machine in `src/shared/utils/circuitBreaker.js`, 429 classification, escalating cooldowns, `domain_circuit_breakers` persistence, and pre-dispatch gates |
| **Stealth & Anti-Ban Fingerprinting** | 🟢 Shipped | Wave 5: CLI client header/field ordering in `src/lib/stealth/cliFingerprints.js`, reverse-proxy header scrub, tool-name cloaking with RESTORE map, zero-width obfuscation, session stickiness |
| **Dynamic Capability Discovery & Fail-Closed Routing** | 🟢 Shipped | Wave 6: Live `/v1/models` discovery in `src/lib/models/discovery.js`, 7-tier precedence cascade, self-healing context reconciler, fail-closed vision gating |
| **VansRouter Provider Parity & Stateless Executors** | 🟢 Shipped | Wave 7: 30 new providers in `open-sse/providers/registry/`, specialized executors in `open-sse/executors/`, free-tier catalog in `open-sse/providers/freeTiers.js`, Ponytail prompts in `open-sse/rtk/ponytailPrompt.js`, and stateless `open-sse/utils/loopGuard.js` |
| **Bun-Only Runtime & Redis-by-Default** | 🟢 Shipped | Wave 7.5: Sole `bun:sqlite` engine, complete Node.js removal, docker-compose with `redis:8.2-alpine`, lease semaphores, Webpack retained, 4102 passing tests (0 regressions) |
| **Upstream Ports & Security Hardening** | 🟢 Shipped | Wave 9: 44 candidates ported (VansRouter 0.91.81 / 9router 0.5.109); PR #67: 5 decolua/9router PRs (#4988, #5222, #5150, #5179, #5193) with security hardening; see [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md) |
| **Dashboard and Tooling** | 🟢 Shipped | PR #71 (specs), PR #72 (implementation): pure JavaScript controls: limits modal (`src/shared/components/ConnectionLimitsModal.js`, stored and displayed; connection budget cap NOT enforced at request time), key quota tabs with spend trends (`src/app/(dashboard)/dashboard/quota/`), capability badges (provider rows, model selector, combo builder via `src/shared/components/CapacityBadges.js`) |
| **Bun Performance and Scale** | 🟢 Shipped | Wave 8, PR #79 (squash `5208a6b0`, merged 2026-10-28): vertical scaling on one Bun host via `node:cluster` (`KHATAM_WORKERS`, default `Math.max(1, nproc - 2)`) plus hot-path slimming. DB queries/req 15.20 -> 10.78 (met); p95 4.93 -> 2.56 ms (-48%, met); p50 1.35 -> 1.00 ms (-25.7%, 35% target missed). Measured ladder 238 -> 361 -> 454 -> 495 req/s at 1/2/4/6 workers (8-logical-CPU WSL2, zero-latency mock): sub-linear, causes unprofiled. Without `REDIS_URL`, login lockout, rate limits, combo rotation and circuit-breaker trips are per worker; the npm `9router` CLI bundle runs single-process. Horizontal replica work was reverted (PR #77) and is not part of Wave 8. See [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) |
| **Psiphon Rotating Proxy Pool** | 🟢 Shipped | Spec 014, PR #117 (squash `ba52a602`, merged 2026-10-29): `psiphon` proxy-pool type for OpenCode Free and any pool-bound provider in `src/lib/network/psiphon/`; supervises operator-supplied `ConsoleClient` sidecars, holds the lowest-latency tunnel, and rotates to a new IP and country on 429 / 403 `FreeTierError` / transport failure / per-IP thresholds. Fail-closed (`strictProxy` forced, no direct replay, no MITM-bypass direct). CI uses a fake `ConsoleClient`; not verified against the live Psiphon network. See [`docs/PSIPHON.md`](./docs/PSIPHON.md) |
| **KhatamRouter Branding & Release Update Feed** | 🟢 Shipped | PR #69: UI/CLI display branding, update check targeting KhatamRouter GitHub Releases with strict semver parsing and 512 KiB buffer cap in `src/app/api/version/route.js`; in-place updater disabled (`/api/version/update` returns 403) |

### Operational Baseline (Shipped)

Only the following capabilities are shipped and operational today:

- **Dashboard and tooling (PR #71/#72)**: Pure JavaScript controls: per-connection limits modal (`src/shared/components/ConnectionLimitsModal.js`), key quota tabs with spend trends (`src/app/(dashboard)/dashboard/quota/components/KeyQuotaView.js`, `SpendTrendsChart.js`), and 9-modality capability badges (`src/shared/components/CapacityBadges.js`). Connection-level budget caps (`maxBudgetUsd`) are stored and displayed, but are NOT enforced at request time (follow-up).
- **KhatamRouter branding and release update feed (PR #69)**: Full UI/CLI display branding to KhatamRouter (guarded by `tests/unit/display-branding-guard.test.js`). Update checks in `/api/version` (`src/app/api/version/route.js`) and CLI query GitHub Releases of `rqzbeh/KhatamRouter` with 512 KiB buffer cap, strict semver validation/reconstruction, and 4s timeout. In-place auto-updater is permanently neutralized (`/api/version/update` returns 403).
- **Upstream ports & security hardening (Wave 9 & PR #67)**: 44 audit-confirmed upstream candidates ported across 19 commits from VansRouter `v0.91.61`→`v0.91.81` and 9router `v0.5.104`→`v0.5.109`, plus five `decolua/9router` PRs (#4988, #5222, #5150, #5179, #5193) ported via PR #67 with security hardening. Core hardening includes `undici` 7.30.1 with loopback-only headroom binding (`127.0.0.1:8787:8787`), pinned Monaco 0.57.0 CDN loader (`src/shared/constants/monaco.js`), Gemini prototype pollution (`Object.defineProperty`) and method shadowing (`Object.create(null)`) defenses, 8-second models discovery timeout guards, SSRF-safe Gemini reference image inputs, distributed Redis-backed Smart Router session stickiness (`khatam:smartrouter:session:*`), neutral CLI fingerprinting preventing host layout disclosure, strict OpenCode domain gating and bounded buffering on 403 free-tier replays, DeepSeek `json_schema` downgrade guard, context cap pinning, and probe-free free-lane dashboard tests. Full audit ledger in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md).
- **Vertical scaling & hot-path slimming (Wave 8, PR #79)**: Multi-process runtime on one Bun host via `node:cluster` (`src/lib/cluster/supervisor.js`, `src/lib/cluster/worker.js`, `custom-server.js`) with `KHATAM_WORKERS` (`auto` = `Math.max(1, nproc - 2)`), supervisor-run migrations, leader-only daemons (`KHATAM_WORKER_ROLE=leader`), IPC config broadcast without Redis, graceful drain (`KHATAM_DRAIN_TIMEOUT_MS`), and crash backoff. Hot-path TTL caches and `BEGIN IMMEDIATE` usage writes. Limits are per worker without `REDIS_URL`; see *Known Limitations Today*. Measured numbers in [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md).
- **Bun-only runtime & `bun:sqlite` engine**: Complete elimination of Node.js. Server strictly requires Bun v1.4.4+. Sole SQLite engine is native `bun:sqlite` with WAL mode (`busy_timeout = 5000`, `temp_store = MEMORY`), preflight integrity validation (`PRAGMA quick_check`), and zero legacy Node drivers. Published CLI launcher requires `bun` on PATH.
- **Docker Compose with Redis by default (`redis:8.2-alpine`)**: Default stack running `redis:8.2-alpine` with Append-Only File on `redis-data`, `redis-cli ping` healthcheck, loopback-only binding (`127.0.0.1:6379`), and app `depends_on: { redis: { condition: service_healthy } }`. Disabling Redis is fully documented and degrades gracefully to SQLite.
- **Distributed Redis primitives & lease semaphores**: All keys TTL-bounded and namespaced under `khatam:`, with secrets cryptographically hashed. Includes shared circuit-breaker trips (`khatam:cb:*`), dashboard login limiter, OAuth single-use refresh locks, advisory API-key auth caching, real-time Pub/Sub invalidation bus, prompt-cache stealth session pins, pricing/request-details invalidation, round-robin counters, lease-based distributed concurrency semaphores (`khatam:sem:*`), and opt-in chat idempotency keys.
- **Hybrid quota resilience contract**: When `REDIS_URL` is omitted, non-consuming fail-open semantics operate locally. When Redis is configured but encounters an outage, quotas degrade safely to SQLite transaction-backed counters (`SqliteQuotaStore`) so configured spending and rate limits remain strictly enforced.
- **Retained Webpack bundler**: Webpack retained (`--webpack`) following empirical Turbopack evaluation showing a 52% standalone size inflation regression and configuration disparity.
- **Bun v1.4.3 runtime**: Native Bun execution via `bun run dev:bun` and `bun run start:bun`, `@/*` path mapping to `./src/*`, and multi-stage container builds via `Dockerfile.bun`.
- **SQLite WAL engine + integrity preflight**: Native `bun:sqlite` adapter running Write-Ahead Logging (`PRAGMA journal_mode = WAL`), a 5000ms lock timeout (`PRAGMA busy_timeout = 5000`), in-memory temporary storage (`PRAGMA temp_store = MEMORY`), and mandatory startup integrity validation (`PRAGMA integrity_check`) refusing silent fallback over existing data.
- **Redis client, pub/sub, hybrid quota store, and circuit breaker cache**: Connection management and Pub/Sub event bus under `src/lib/redis/` enforcing the `khatam:` namespace prefix for cluster-wide cache invalidation (`khatam:events:config_reload`), atomic sliding-window quota tracking via `RedisQuotaStore` (`khatam:quota:*`), and optional circuit breaker mirror caching (`khatam:cb:*` via `src/lib/resilience/circuitBreakerStore.js`), with automatic fail-safe fallback to in-memory/SQLite when `REDIS_URL` is omitted.
- **Versioned DB migrations & hybrid quota store**: Idempotent `_khatam_migrations` runner executing ordered JS/TS migrations with backup-before-migrate safety, additive schema v4 (`rate_limit_overrides_json`, `api_key_quota_limits`, `request_cost_ledger`, `domain_circuit_breakers`, `model_capabilities`), hybrid Redis/SQLite sliding-window quota store (`RedisQuotaStore` and `SqliteQuotaStore` via `createQuotaStore`) with fail-open semantics, and a 5-second in-memory TTL settings cache (`invalidateSettingsCache` / `bumpSettingsRevision`).
- **Unified Tri-State ACL & Timing-Safe Internal Trust**: Granular authorization filters on API keys supporting `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels` with explicit allow, deny, and wildcard rules, model enumeration prevention (returns 404 `model_not_found` for forbidden models), catalog filtering on `/v1/models`, and constant-time `internalTrust` token validation (`crypto.timingSafeEqual`) on `x-9r-cli-token`.
- **Granular Per-Connection / Key Rate Limits & USD Spend Caps**: Multi-tier rate limiting with `rate_limit_overrides_json` enforcing connection-level RPM/RPD/TPM/TPD, inter-call `minTime` spacing, in-process concurrency semaphores (`maxConcurrent`, `modelConcurrency`), per-key multi-window sliding limits (RPM/RPH/RPD via `QuotaStore`), and daily/weekly USD expenditure caps via `request_cost_ledger` with fail-open degradation when Redis/DB encounters transient infrastructure faults.
- **Hardened request ingestion (128 MiB JSON, 64 MiB h2c, CL+TE smuggling rejection)**: Defense-in-depth HTTP request parsing enforcing a 128 MiB ceiling on JSON request bodies via Next.js `experimental.proxyClientMaxBodySize` (default `128mb`, overridable with `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE`), a 64 MiB ceiling on chunked h2c streams (`MAX_H2C_BODY_BYTES` in `custom-server.js`), strict CRLF framing validation, and immediate rejection of HTTP smuggling attempts combining `Content-Length` and `Transfer-Encoding`.
- **Token savers (RTK/Caveman/Ponytail)**: Pre-translation tool compression via RTK (token-reducing compression of `tool_result` content with a 10 MiB ceiling per `RAW_CAP` in `open-sse/rtk/constants.js` that intentionally applies lossy per-filter truncation: e.g., git diff hunks capped at 100 lines via `GIT_DIFF_HUNK_MAX_LINES`, repetitive logs deduplicated and capped at 2,000 lines via `DEDUP_LINE_MAX`, and build outputs sliced to top deprecations and 5 warnings), Caveman terseness prompts, and Ponytail prompt modes (saving an upstream 9Router-claimed 20-40% input tokens and up to 65% output tokens, rather than a measured KhatamRouter benchmark).
- **Stealth and anti-ban suite (`src/lib/stealth/`)**: Canonical CLI header and body field ordering per native CLI tool profile (`codex`, `claude`, `claude-code-compatible`, `github`, `antigravity`, `cursor`), reverse-proxy header scrubbing (`x-forwarded-for`, `x-real-ip`, `via`) and browser fingerprint removal with `Accept-Encoding` normalisation, JSON schema sanitisation and PascalCase tool cloaking with response decloaking via bidirectional RESTORE map, sensitive agent word `U+200D` obfuscation strictly preserving Persian half-spaces (`U+200C`) and emoji ZWJ sequences, and first-message SHA-256 prompt-cache session pinning with 15-minute TTL and fail-open resilience. All capabilities default-off behind `CLI_COMPAT_<PROVIDER>=1` / `STEALTH_*=1`.
- **Live model discovery and capability resolution (`src/lib/models/`, `src/domain/requestCapabilities.js`)**: Defensive normalisation of `/v1/models` discovery responses across 4 real payload shapes (`src/lib/models/discovery.js`), 7-tier pure capability precedence cascade (`src/lib/models/capabilities.js`), self-correcting context reconciler with manual pin protection (`src/lib/models/contextReconciler.js`), and fail-closed combo capability gating (`open-sse/services/combo.js`) ensuring image requests never dispatch to non-vision targets. Default-off behind `KHATAM_MODEL_CAPABILITY_GUARD=1`.
- **VansRouter provider parity and specialized executors (`open-sse/providers/registry/`, `open-sse/executors/`)**: Full provider parity bringing 30 new upstream providers to the gateway (164 total providers), specialized protocol executors with strictly stateless `buildHeaders` contracts (`agentrouter.js`, `qwen.js`, `zcode.js`, `freebuff.js`, `muse-spark-web.js`), deterministic free-tier catalog derivation (`open-sse/providers/freeTiers.js` via `listFreeTiers()`), multi-intensity Ponytail prompts (`open-sse/rtk/ponytailPrompt.js`), and stateless anti-loop detection (`open-sse/utils/loopGuard.js`). Default-off behind `loopGuardEnabled: false` in `src/lib/db/repos/settingsRepo.js`.
- **Inherited 9router feature set (providers, translators, executors, quotas UI, combos)**: Upstream provider registry supporting 40+ providers, protocol translation pivoting across OpenAI, Claude, Gemini, and Kiro formats, specialized executors, Next.js control-plane dashboard, model combos with multi-tier fallback, and automated OAuth token refresh flows.

---

## Wave 2 — Storage and Quota Foundation

**Status**: 🟢 Shipped (PR #38 merged, commit `5d4d5590`)

Wave 2 established the persistence and quota foundation required for distributed rate and spend enforcement:

- **Concrete Artifacts**:
  - Migration runner: `src/lib/db/migrationRunner.js` with idempotent execution tracking in `_khatam_migrations` and automated pre-migration DB backups.
  - Migration 002: `src/lib/db/migrations/002-wave2-storage-quota.js` adding tables and columns for limits, quotas, cost ledger, circuit breakers, and capabilities.
  - Central schema version: `SCHEMA_VERSION = 3` in `src/lib/db/schema.js`.
  - Quota store files: `src/lib/quota/storeFactory.js`, `src/lib/quota/redisQuotaStore.js`, `src/lib/quota/sqliteQuotaStore.js`, and `src/lib/quota/index.js`.
  - Settings cache: 5-second in-memory TTL cache with `bumpSettingsRevision` and `invalidateSettingsCache` in `src/lib/db/repos/settingsRepo.js`.
- **Versioned `_khatam_migrations` runner**: A dedicated startup migration engine executing ordered, versioned migration scripts to ensure schema consistency in the Bun runtime.
- **Schema additions (SCHEMA_VERSION = 3)**:
  - `rate_limit_overrides_json`: Connection-level limits storing overrides for `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, and `modelConcurrency`.
  - `api_key_quota_limits`: Granular per-key rate, token, and concurrency limits.
  - `request_cost_ledger`: Ledger recording per-request token usage, provider unit cost, and total USD expenditure.
  - `domain_circuit_breakers`: State persistence tracking failure counters, error classifications, and cooldown expirations per provider/domain.
  - `model_capabilities`: Registry table storing discovered context boundaries, modalities, and feature flags.
- **`RedisQuotaStore` with SQLite fallback**: Atomic sliding-window quota counters implemented via Redis Lua scripts (`RedisQuotaStore`) with transparent fallback to SQLite transaction-backed counters (`SqliteQuotaStore`) via `createQuotaStore()` when `REDIS_URL` is unset, with fail-open semantics on Redis errors.
- **5-second settings TTL cache**: An in-memory read-through cache on `settingsRepo` reducing SQLite read lock contention on high-throughput proxy paths.

---

## Wave 3 — Unified ACL and Granular Limits

**Status**: 🟢 Shipped (PR #41 merged, commit `cfab219f`)

Wave 3 established fine-grained authorization policies and multi-tier rate limiting:

- **Concrete Artifacts**:
  - Unified ACL Service: `src/sse/services/allowedModels.js` implementing pure tri-state logic (`isKindAllowed`, `isComboAllowed`, `isProviderAllowed`, `isModelAllowed`, `enforceUnifiedAcl`) with 403 `forbidden` (kinds, providers, combos) and 404 `model_not_found` model enumeration prevention.
  - Internal Trust Guard: `src/sse/services/internalTrust.js` implementing timing-safe constant-time (`crypto.timingSafeEqual`) verification on `x-9r-cli-token` and loopback bypass, integrated with `src/dashboardGuard.js`.
  - Catalogue Filtering: `filterModelsListForKey()` in `src/sse/services/keyAccess.js` ensuring restricted keys cannot enumerate unauthorized models via `/v1/models`.
  - Connection Rate Limiter: `open-sse/services/rateLimitManager/connectionLimiter.js`, `overrides.js`, and `semaphore.js` providing in-process concurrency semaphores (`maxConcurrent`, `modelConcurrency`), `minTime` call spacing, and connection-level RPM/RPD/TPM/TPD enforcement from `providerConnections.rate_limit_overrides_json`.
  - Per-Key Quota & Spend Caps: `src/lib/usage/apiKeyUsageLimits.js`, `src/domain/keyQuota.js`, and `src/lib/db/keyQuota.js` implementing sliding-window rate limits (RPM/RPH/RPD via `QuotaStore`) and daily/weekly USD expenditure caps via `request_cost_ledger`.
  - Fail-Open Degradation: All rate limiters and quota stores gracefully degrade to `{ allowed: true, degraded: true }` when Redis or SQLite encounter transient faults, preserving proxy throughput.
  - Test Suites: Comprehensive unit verification in `tests/unit/wave3-acl.test.js` (tri-state evaluation, wildcard rules, enumeration defense, timing-safe tokens) and `tests/unit/wave3-limits.test.js` (in-process semaphores, connection overrides, quota sliding windows, spend caps, fail-open degradation).
- **Tri-state access control lists**: Granular authorization filters on API keys supporting `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels` with explicit allow, deny, and wildcard rules.
- **`internalTrust` timing-safe token**: Timing-attack resistant token validation for securing inter-process communication and trusted reverse-proxy routing.
- **Per-connection rate and concurrency limits**: Strict enforcement of requests per minute (RPM), requests per day (RPD), tokens per minute (TPM), tokens per day (TPD), minimum inter-call spacing (`minTime`), and concurrency caps (`maxConcurrent` / `modelConcurrency`).
- **Per-key sliding windows**: Sub-second sliding-window algorithms tracking requests per hour (RPH), requests per minute (RPM), and requests per day (RPD).
- **USD expenditure caps**: Configurable daily, weekly, and monthly budget limits backed by `request_cost_ledger`, with fail-open resilience on infrastructure errors and 429 Retry-After on limit exhaustion.

---

## Wave 4 — Resilience

**Status**: 🟢 Shipped (PR #55 merged, commit `c98cc443`)

Wave 4 implements fault-tolerant routing and provider health protection:

- **4-state circuit breaker (`src/shared/utils/circuitBreaker.js`)**: Finite-state machine transitioning across `CLOSED` (healthy) → `DEGRADED` (consecutive transient errors) → `OPEN` (traffic diverted) → `HALF_OPEN` (controlled canary probes) with adaptive backoff escalation (`openCycleCount`), bounded transition history, and cold-registry eviction.
- **`classify429` error taxonomy (`src/lib/resilience/failureClassification.js`)**: Response body and header analysis distinguishing temporary concurrency throttling from exhausted billing quotas (`looksLikeQuotaExhausted`, `looksLikeConcurrencyLimit`, declared sub-hour `RetryInfo` delays).
- **Failure-kind cooldowns (`src/lib/resilience/cooldownManager.js`)**: Variable backoff durations tailored to specific failure modes (`rate_limit`, `quota_exhausted`, `transient`) with exponential doubling past escalation count.
- **Client 4xx and POLICY exemptions**: Explicit exemption of client-induced 4xx errors (400, 406, 408, 409, 410, 422), content moderation `POLICY` refusals, and local stream-lifecycle/execution errors from provider health penalties.
- **Pre-dispatch target gates (`src/domain/executeTargetGates.js`)**: Pre-flight validation verifying circuit health, active cooldowns, and credential availability before dispatching requests to upstream connections.
- **Durable persistence with Redis mirror (`src/lib/resilience/circuitBreakerStore.js`)**: Additive schema migration `003` for `domain_circuit_breakers` with optional `khatam:cb:` Redis caching and automatic fail-open degradation.
- **Default-off fallback wiring (`src/domain/fallbackResilience.js`)**: Pre-dispatch gating and outcome recording integrated into `src/sse/handlers/chat.js` behind `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1`.

---

## Wave 5 — Stealth and Anti-Ban

**Status**: 🟢 Shipped ([PR #57](https://github.com/rqzbeh/KhatamRouter/pull/57))

Wave 5 protects credentials and upstream accounts through client signature emulation. Every capability is **default-off** and activated per provider (`CLI_COMPAT_<PROVIDER>=1`, `CLI_COMPAT_ALL=1`) or per capability (`STEALTH_FINGERPRINTS=1`, `STEALTH_HEADER_SCRUB=1`, `STEALTH_TOOL_CLOAK=1`, `STEALTH_ZERO_WIDTH=1`, `STEALTH_STICKINESS=1`, `STEALTH_ALL=1`):

- **Canonical CLI header and field ordering** (`src/lib/stealth/cliFingerprints.js`): Strict matching of HTTP header order and JSON field serialization for the `codex`, `claude`, `claude-code-compatible`, `github`, `antigravity`, and `cursor` profiles, with internal router markers (`_khatam*`, `_omniroute*`) stripped before dispatch.
- **Reverse-proxy header scrubbing** (`src/lib/stealth/headerScrub.js`): Stripping internal proxy indicators (`x-forwarded-for`, `x-forwarded-*`, `x-real-ip`, `forwarded`, `via`), Chromium/browser fingerprints (`sec-ch-*`, `sec-fetch-*`, `priority`), and normalizing `Accept-Encoding` to the Node.js CLI value (`gzip, deflate, br`). Stainless SDK headers are preserved for Claude and stripped elsewhere.
- **Tool-name cloaking** (`src/lib/stealth/toolCloak.js`): Mapping non-standard snake_case and lowercase tool call signatures (`read_file`, `run_command`) to canonical PascalCase vendor names (`Read`, `Bash`) with a bidirectional RESTORE map that decloaks JSON responses, OpenAI chat/Responses shapes, and Anthropic SSE deltas. Parameter schemas are sanitized (stripped `$schema`/`$id`/`$comment`, empty `required` dropped, root `type: "object"` enforced); `$ref` is deliberately preserved. MCP (`mcp__*`) and Anthropic server tool names are never rewritten.
- **`U+200D` zero-width joiner obfuscation** (`src/lib/stealth/zeroWidth.js`): Insertion of a joiner after the first character of sensitive agent words, paired with selective stripping that is bounded to ASCII word characters so Persian half-spaces (`U+200C` / نیم‌فاصله) and emoji ZWJ sequences are preserved verbatim.
- **15-minute session stickiness** (`src/lib/stealth/stickiness.js`): SHA-256 hash of the first user message (namespaced by provider) pins a conversation to the same upstream connection, with a 15-minute TTL, 500-entry LRU bound, and fail-open semantics. Wired into the account-selection loop: a failed pinned account releases the pin.

**Deferred (not shipped)**: `Jyh` Cursor checksum emulation, Copilot token-exchange signature synthesis, Claude Code `cch=` xxHash64 hashing beyond the existing `open-sse/utils/claudeCloaking.js` path, and TLS cipher-suite fingerprint alignment. These require protocol-level capture or custom TLS stacks and are tracked as known limitations below.

---

## Wave 6 — Model Intelligence

**Status**: 🟢 Shipped ([PR #59](https://github.com/rqzbeh/KhatamRouter/pull/59))

Wave 6 provides dynamic model awareness, defensive catalog ingestion, and capability validation:

- **Defensive model discovery normalisation** (`src/lib/models/discovery.js`): Normalized extraction of model limits, modalities, and reasoning tiers across 4 real upstream schemas (Standard OpenAI, OpenRouter architecture modality, Lemonade Server labels, Ollama native capabilities) with strict non-throwing guarantees under corrupt or unexpected payloads.
- **Pure capability precedence cascade** (`src/lib/models/capabilities.js`): Deterministic 7-tier resolution (`manual` operator pin > `auto:discovery` override > `PROVIDER_CAPABILITIES` > synced catalog > `MODEL_CAPABILITIES` > `PATTERN_CAPABILITIES` > `DEFAULT_CAPABILITIES`), featuring a `persistedOverrides: false` flag for self-healing reconciler baseline comparisons.
- **Self-correcting context reconciler** (`src/lib/models/contextReconciler.js`): Automated synchronization of discovered context windows against catalog baselines into `model_context_overrides` with `source: 'auto:discovery'`. Prunes redundant auto pins on catalog parity, and strictly protects `manual` operator pins from being overwritten.
- **Fail-closed combo capability gating** (`src/domain/requestCapabilities.js`, `open-sse/services/combo.js`): Pre-dispatch validation verifying that target models support all requested modalities. For requests carrying image inputs, incompatible text-only targets are pruned; if no targets confirm vision, the combo refuses with HTTP 400 (`vision_unsupported`), preventing corrupted outputs or wasted provider quotas. Opt in with `KHATAM_MODEL_CAPABILITY_GUARD=1`.
- **Additive context overrides schema** (`src/lib/db/migrations/004-wave6-model-capabilities.js`): Additive migration adding `provider`, `model_id`, and `source` columns with indexes to `model_context_overrides` and `source` to `model_capabilities`.

---

## Wave 7 — VansRouter Parity

**Status**: 🟢 Shipped ([PR #61](https://github.com/rqzbeh/KhatamRouter/pull/61))

Wave 7 achieves full provider parity with the VansRouter ecosystem:

- **30 ported provider registries** (`open-sse/providers/registry/`): Every provider present in VansRouter and absent from KhatamRouter was ported — 25 standard API-key/OpenAI-compatible providers (`a6api`, `ai21`, `alibaba`, `baseten`, `bytez`, `codestral`, `databricks`, `deepinfra`, `friendliai`, `galadriel`, `gigachat`, `heroku`, `hive`, `llamagate`, `meta`, `nanogpt`, `nscale`, `ovhcloud`, `predibase`, `publicai`, `snowflake`, `upstage`, `volcengine`, `wandb`, `zenmux`) plus 5 executor-backed providers (`agentrouter`, `freebuff`, `muse-spark-web`, `qwen`, `zcode`). None were skipped. The registry now holds 164 providers.
- **Specialized executors with a stateless contract** (`open-sse/executors/`): `agentrouter.js` (Claude CLI header spoofing plus canonical body field ordering), `qwen.js` (DashScope/Stainless fingerprints and `resource_url`-bound host resolution), `zcode.js` (ZCode Electron headers with Aliyun captcha retry and JWT/business-token refresh), `freebuff.js` (Codebuff agent-run registration, session claiming, and system-marker gating), `muse-spark-web.js` (Meta AI GraphQL request/response protocol). Each executor's `buildHeaders` is provably stateless: sequential calls with different credentials leak no key, token, or tenant identifier.
- **Script-generated registry index** (`scripts/migrate-registry.mjs`): `generateRegistryIndex()` (also reachable via `--index-only`) rebuilds the static import list from the directory listing; providers deliberately hidden by KhatamRouter (`trae`, `windsurf`, `devin-cli`) stay excluded. The index is never hand-edited.
- **Free-tier catalogue** (`open-sse/providers/freeTiers.js`): `listFreeTiers()` derives a provider-level row plus per-model rows from registry annotations (`hasFree`, `freeRefresh`, `category: "free"|"freeTier"`), rejects an out-of-allowlist cadence loudly, and sorts deterministically by cadence (`daily` → `weekly` → `monthly` → `rolling` → `one-time`), then provider, then model.
- **Multi-intensity Ponytail** (`open-sse/rtk/ponytailPrompt.js`): Lite/Full/Ultra prompts layered onto the existing `injectPonytail` → `injectSystemPrompt` pipeline, adding a 2026 skepticism clause and hard safety boundaries (validation, error handling, security and accessibility are never simplified away). Default setting unchanged.
- **Stateless LoopGuard** (`open-sse/utils/loopGuard.js`): `detectLoop()` inspects only the request body — single tool-call repeat ≥ 3, N-gram tool sequence repeat ≥ 2, repeated assistant message ≥ 3, and repeated sentence across messages ≥ 3 — and `applyLoopGuard()` appends an idempotent `[ROUTER NOTE: …]` hint. No cross-request state. Opt in with `loopGuardEnabled` (default `false`).

**Deferred (not shipped)**: VansRouter's translator-level fixes for thinking blocks, tool-call ID preservation, and streaming-protocol edge cases were not part of this parity wave; they remain separate follow-up work. LoopGuard's default-off posture means operators must enable it in settings.

---

## Wave 7.5 — Bun-Only Runtime & Redis by Default

**Status**: 🟢 Shipped — PR #63 merged to master as `51615273` (2026-10-24)

Wave 7.5 establishes an uncompromised native Bun architecture and default Redis coordination stack:

- **Strict Bun-Only Runtime**: The server strictly requires Bun v1.4.4+. Node.js is no longer supported (breaking change). Startup fails closed with an actionable message if Bun is missing.
- **Sole `bun:sqlite` Engine**: Complete pruning of all legacy Node-runtime SQLite fallback drivers (`better-sqlite3`, `node:sqlite`, and `sql.js`) from source, `package.json`, `bun.lock`, and Next.js configuration. All database operations standardize on native `bun:sqlite` with WAL journal mode (`busy_timeout = 5000`, `temp_store = MEMORY`) and mandatory startup integrity validation (`PRAGMA quick_check`).
- **CLI Bun Enforcement**: The published `9router` CLI launcher requires `bun` on system PATH and provides actionable install instructions when absent. The legacy fallback hook `cli/hooks/sqliteRuntime.js` is removed (runtime helpers relocated to `trayRuntime.js`).
- **Docker Compose with Redis by Default**: `docker-compose.yml` builds directly from `Dockerfile.bun` and runs `redis:8.2-alpine` by default: Append-Only File (AOF) on volume `redis-data`, `redis-cli ping` healthcheck, loopback-only host binding (`127.0.0.1:6379`), and application dependency with `condition: service_healthy`. Disabling Redis is fully documented and degrades gracefully to SQLite.
- **Distributed Redis Primitives Matrix**: All keys are TTL-bounded and namespaced under `REDIS_KEY_PREFIX` (`khatam:`), with secrets cryptographically hashed:
  - Shared circuit-breaker trip records (`khatam:cb:*`)
  - Dashboard brute-force login limiter (`khatam:auth:login:*`)
  - OAuth single-use refresh lock (`khatam:oauth:refresh:*`) preventing concurrent refresh collisions
  - Advisory API-key authentication cache (`khatam:auth:key:*`), with SQLite remaining authoritative
  - Real-time Pub/Sub invalidation bus and console/usage log fan-out (`khatam:events:*`)
  - Prompt-cache stealth session pins (`khatam:stealth:session:*`, opt-in)
  - Pricing and request-details cache invalidation
  - Combo and outbound proxy round-robin distribution counters
  - Lease-based distributed concurrency semaphores (`khatam:sem:*`) with auto-releasing leases
  - Opt-in Idempotency-Key cache on non-streaming chat completions (`khatam:idempotency:*`)
- **Hybrid Quota Resilience Contract**: Unset `REDIS_URL` operates as non-consuming fail-open locally (Wave 2 contract). When Redis is configured but encounters transient connection failures or outages, quota tracking degrades safely to transaction-backed SQLite storage (`SqliteQuotaStore`) so configured spending and rate limits remain strictly enforced.
- **Turbopack Evaluation (Retain Webpack)**: Webpack retained (`--webpack`) after empirical benchmarks in Spec 0075: the Turbopack standalone artifact is 52% larger, caused by dynamic filesystem tracing triggered through `open-sse/executors/devin-cli.js`, plus configuration disparities with the custom webpack resolve fallbacks and 27 compilation tracing warnings. Exact byte counts and methodology are in `specs/0075-bun-only-redis-default/turbopack-eval.md`.
- **Waves 1–7 Defect Remediation**: Wave 3 ACL double-gate, connectionLimiter wiring, spend ledger, non-chat endpoint ACL; Wave 4 gate order + HALF_OPEN probe budget; Wave 5 passthrough decloak; Wave 6 discovery wiring; Wave 1 pub/sub publish client.
- **Verified Test Posture & Evidence**: 4102 passing tests on this branch vs 3979 on master (+123 tests), 0 regressions, and `known-fails.txt` precisely calibrated against measured master failures. All 10 acceptance leaves (leaf-1.1 through leaf-1.10) verified with honest pass/fail reports.

---

## Wave 9 — Upstream Parity & Security Hardening

**Status**: 🟢 Shipped (Branch `spec/009-upstream-port`, 44 candidates landed across 19 commits)

Wave 9 completes the audit and synchronization of upstream improvements across VansRouter (`v0.91.61`→`v0.91.81`, 94 commits reviewed, 11 landed, 83 skipped) and 9router (`v0.5.104`→`v0.5.109`, 39 commits reviewed, 33 landed, 6 skipped). All 44 audit-confirmed candidates have landed and were verified via targeted test gates.

- **Security & Crash Blockers (User Story 1)**:
  - **`undici` 7.30.1 & loopback headroom** (`eaf244f1`, upstream `08ef047f`): Closes CVEs in undici (DoS on content encodings, TLS bypass). Binds headroom microservice strictly to `127.0.0.1:8787:8787` in `docker-compose.yml`.
  - **Monaco 0.57.0 loader pinned** (`c6711901`, upstream `5883110b`): Pins dashboard Monaco editor loader in `src/shared/constants/monaco.js` to 0.57.0 (DOMPurify 3.4.15), eliminating unpinned CDN loads of vulnerable versions.
  - **Gemini prototype defenses** (`15c7648a`, `61db0251`, `720cbcdb`, upstream `a06ec5d8`, `13441197`, `1ea22bfa`): Closes `__proto__` prototype pollution using `Object.defineProperty`/`Object.hasOwn`, prevents prototype-method shadowing (`toString`, `valueOf`, `constructor`) using `Object.create(null)`, strips invalid `items` from non-array schemas, and adds 8-second `timedFetch` timeout guards on discovery routes.
  - **CodeBuddy auth & 401 refresh** (`0936b5ac`, upstream `2063f090`): Validates JWT expiration in `testUtils.js` and wires 401 refresh recovery in `DefaultExecutor`.
  - **Pi-settings crash fix** (`5cb3e649`, upstream `342ecb0d`): Declares `existingProvider` before use in POST route, resolving fatal 500 errors.

- **Correctness & Resilience Bug Fixes (User Story 2)**:
  - **Combo resilience** (`b6048073`, upstream `b82f5c4a`, `5cdcddf5`, `ca7b5401`): Advances to next model on credit exhaustion, advances past request-scoped 4xx errors without cooling accounts, and falls through on empty-content streaming responses via `emptyFailover.js`.
  - **OpenCode real timestamps** (`e5549485`, upstream `01f1a1fe`): Encodes real monotonic 48-bit millisecond timestamps into `ses_` and `msg_` IDs, preventing session collisions and eviction churn.
  - **Antigravity discovery & Argon tiers** (`95451d6b`, upstream `39730d88`, `f172c3c4`, `82aeb907`): Repairs discovery by querying production endpoint, updates User-Agent to `hub/2.24.0`, monitors Gemini 4 Argon tiers, and resolves model tiers from client reasoning effort.
  - **Grok 4.7 500k context window** (`ff292a12`, upstream `b0655314`): Explicitly registers 500,000 token context window, preventing premature 80% (204k) context truncation.
  - **Stream tool-call restoration** (`5cb3e649`, upstream `95c9d03e`): Synthesizes missing tool-call IDs on fragments and restores renamed tool names on passthrough.
  - **Correctness singletons** (`5cb3e649`): Node-scoped model disabling and row purge on delete (`34c66988`), regex `lastIndex` state reset (`5853a88a`), `max_tokens` → `max_completion_tokens` parameter renaming (`7c42d8f8`), Kiro Anthropic model alias normalization (`3ce2b828`), Headroom tool compression for native Gemini/Responses/CommandCode (`a440ef43`), and Ollama `prompt_eval_count` number guard (`d56f8f18`).
  - **Provider stability fixes** (`273dff23`): Qoder `10605` queue capacity retry handling (`2720cd2a`), Ollama `/api/balance` cloud quota tracking (`31b8439b`), CommandCode quota display formatting (`4a76b8de`), and Codex image skip for ChatGPT Free accounts (`b08f12d5`).

- **Enhancements, Features & Providers (User Story 3)**:
  - **Smart Router with Redis session stickiness** (`84dffab9`, `902dc3aa`, upstream `f3f86fdd`): Dynamically evaluates request complexity via System One decision models, adapting upstream in-memory Map into distributed **Redis-backed session stickiness** (`khatam:smartrouter:session:*`) with 15-minute TTL, multi-instance concurrency safety, and fail-open degradation.
  - **RTK custom system prompt** (`d28d628f`, `bd03b835`, upstream `8a842043`): User-authored custom system prompt injection with Token Saver dashboard UI controls, length-only trace logging, and fail-open guarantees.
  - **Codex OAuth transcription provider (`cx/transcribe`)** (`ccb8dc84`, upstream `421f2262`): Audio transcription reusing Codex OAuth credentials with ffmpeg audio conversion and strict SSRF defenses on fetched audio URLs.
  - **SenseNova provider** (`273dff23`, upstream `351b04cb`): Registration of `sensenova-6.8-flash-lite` and U1.5 image models with parameter extensions.
  - **Gemini reference image inputs & MITM directory** (`3c0ba50b`, upstream `161e3493`): In-memory base64 reference image input support with strict SSRF defenses (forbids remote URL fetching), size limits, and safe MITM directory initialization.
  - **Ollama System One models** (`273dff23`, upstream `bc4a3cc7`): Registers `clef` and `clef-flash` decision models for Ollama Cloud and Local.
  - **Copilot & Cline catalogs** (`273dff23`, `95451d6b`, upstream `dbdbb648`, `cc0c2311`): Refreshes GitHub Copilot model catalog and enables auto-discovery of public Cline models.
  - **Combos search UI** (`b6048073`, upstream `9b4ea9eb`): Interactive search box filtering models and combos by name.

- **Post-Wave 9 Upstream Port Batch (PR #67)**:
  On top of Wave 9, five open `decolua/9router` PRs were audited and ported via PR #67 with security hardening prior to Wave 8:
  - **#5150**: DeepSeek `json_schema` downgrade to `json_object` in `open-sse/translator/concerns/paramSupport.js` with defensive optional chaining and non-object guards preventing TypeErrors.
  - **#5179**: OpenCode `deepseek-v4.1-flash-free` context window cap explicitly pinned at 200,000 / 32,000 in `open-sse/providers/capabilities.js`, safely honoring the <= 330,000 upstream limit without inflating client prompt expectations.
  - **#5193**: Avoids network probe on OpenCode free-tier dashboard connection test in `src/app/api/providers/[id]/test/testUtils.js` (returns `{ valid: true }` directly, preventing unnecessary gateway egress and spurious 403s on unauthenticated public tier), while preserving live chat probe for `opencode-go`.
  - **#5222**: Real monotonic 48-bit session timestamps and CLI fingerprinting in `open-sse/executors/opencode.js` and `open-sse/utils/opencodeFingerprint.js`. Replaces upstream host reconnaissance leak (`process.cwd()` and `os.tmpdir()`) with fixed neutral constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`), preventing server filesystem disclosure.
  - **#4988**: Outbound proxy HTTP 403 `FreeTierError` single direct replay for OpenCode origins in `open-sse/utils/proxyFetch.js`. Hardened with strict host allowlisting (`isOpenCodeHost`), strict proxy contract preservation (`strictProxy`), 64 KiB body buffering cap (DoS defense), consumed body safety, and log credential redaction.
  Every deviation and hardening rule is documented in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md).

- **Boundary Invariants & Non-Goals**:
  - **GitHub repository identity migration**: Explicitly **OUT OF SCOPE** and has **NOT** occurred. The repository retains its current identity (`rqzbeh/KhatamRouter`), remotes, and branch protections.
  - **Skipped upstream commits**: 83 VansRouter commits (release chores, pnpm/containerd tooling, pre-ported Wave 7 features, desktop code) and 6 9router commits (release tags, lockfile churn) were reviewed and intentionally excluded. Documented in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md).
  - **CI posture & test suite verification**: Master's Verify jobs (`Verify / Unit (waves)`, `Verify / Unit (core)`, `Verify / Baselines`, `Verify / Typecheck`, `Verify (tests + baselines)`) are green after PR #66 resolved an intermittent Vitest worker teardown flake (cause: unawaited circuit-breaker persistence opening the real DB/Redis after the test ended). All ported changes passed targeted unit test gates during implementation. Full regression test suite execution against `tests/__baseline__/known-fails.txt` is an independent release closeout task (`T049`) and is not claimed green by this documentation task.

---

## Dashboard and Tooling

**Status**: 🟢 Shipped (PR #71 specs, PR #72 implementation)

Dashboard and tooling delivers user interface controls and administrative tooling in pure JavaScript:

- **Per-connection limits modal** (`src/shared/components/ConnectionLimitsModal.js`): Opened from each provider connection row, backed by `GET/PUT/DELETE /api/providers/[id]/limits` endpoints with session authentication and sanitization. Validates additive `maxBudgetUsd` in `open-sse/services/rateLimitManager/overrides.js` alongside rate, pacing, concurrency, and model-level override fields.
  - *Honest scope note*: A connection-level budget cap (`maxBudgetUsd`) is stored and displayed, but is **NOT enforced at request time**. `request_cost_ledger` attributes spend per API key, not per connection; enforcement is a follow-up that requires a schema change.
- **API key quota utilization tabs and spend trends** (`src/app/(dashboard)/dashboard/quota/`): Dedicated "API Key Quotas" tab on `/dashboard/quota` (with SegmentedControl, defaulting to Provider Limits), backed by authenticated `GET/PUT /api/keys/[id]/quota/route.js` with fail-open behavior and masked key responses. Includes `KeyQuotaView.js` with utilization progress bars, reset countdowns, and quota limits modal, plus `SpendTrendsChart.js` plotting cost and token breakdown from `request_cost_ledger`.
- **Capability modality badges and combo aggregation** (`src/shared/components/CapacityBadges.js`): Capability metadata dictionary (`src/shared/constants/capacityMeta.js`) for all 9 model modalities (vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search, tools, reasoning) with Material Symbols icons, labels, descriptions, and Tailwind color tokens. Accessible badges wired into provider `ModelRow.js`, `ModelSelectModal.js`, and combo builders (`combos/page.js`, `ComboFormModal.js`). Combos aggregate capabilities via modality union, tools intersection, and primary model reasoning (`aggregateComboCapabilities`).
- **Verification**: 43 unit/integration tests across 4 test suites (`tests/unit/connection-limits-modal.test.js`, `key-quota-tabs.test.js`, `capability-badges.test.js`, `wave8-integration.test.js`), 150 Next.js routes compiled cleanly with Webpack (`next build --webpack`), and clean CI runs with 0 teardown errors.

---

## Wave 8 — Bun Performance and Scale

**Status**: 🟢 Shipped in PR #79 (squash `5208a6b0`, merged 2026-10-28; Verify run 40627502720 green on that commit). Spec at [`specs/008-bun-perf-scale`](./specs/008-bun-perf-scale).

Wave 8 is **vertical scaling** of one Bun host: using every core and every process the machine offers. The earlier horizontal multi-replica work (#76) was reverted (PR #77) and is not part of Wave 8. Delivered in PR #79:

- **Hot-path slimming (US1)**: 5 s TTL caches for aliases, combos and provider nodes; bounded combo LRU (512 entries); module-load `Map` model index; regex memoization in `pricing.js`; request-scoped key reuse; `BEGIN IMMEDIATE` usage writes. Auth is never cached across requests. In-process measurement: DB queries/req 15.20 -> 10.78 (met, <= 11.0); p95 4.93 -> 2.56 ms (-47.96%, met); p50 1.35 -> 1.00 ms (-25.67%, **misses** the 35% p50 target). Detail in [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md).
- **`node:cluster` multi-process runtime (US2)**: `KHATAM_WORKERS` (`auto` = `Math.max(1, nproc - 2)`, `WEB_CONCURRENCY` fallback, `1` = legacy single process); one-time migrations in the supervisor; leader-only daemons (token refresh, tunnels, quota ping, WAL checkpoint); IPC invalidation broker without Redis and Redis Pub/Sub with it; graceful drain (`KHATAM_DRAIN_TIMEOUT_MS`, default 30 s); crash backoff (`KHATAM_CRASH_RESET_MS`, default 30 s); loopback-only `X-Forwarded-For` trust unchanged.
- **Vertical ladder (US3)**: 8-logical-CPU WSL2 host, zero-latency mock upstream: 238 -> 361 -> 454 -> 495 req/s at 1/2/4/6 workers (scaling efficiency 100/76/48/35%). Scaling is **not linear**; the causes of the flattening are unprofiled.
- **Measure first**: deterministic in-process harness (`scripts/perf-l1-harness.mjs`), micro-benchmarks (`scripts/perf-l0-micro.mjs`), and load ladder (`scripts/perf-ladder.sh`).

Remaining work and limits are listed under *Known Limitations Today* and in [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) section 7.

---

## Known Limitations Today

To ensure clear operational expectations, the following limitations exist in the current implementation:

- **No GitHub Release exists yet**: The update check queries GitHub Releases of `rqzbeh/KhatamRouter`. Because no formal GitHub Release has been tagged yet, the update check reports no update available until the first release is tagged.
- **Connection budget enforcement and composite ledger index are follow-ups**: Connection-level budget caps (`maxBudgetUsd`) are stored and displayed in `ConnectionLimitsModal.js`, but are not enforced at request time because `request_cost_ledger` currently attributes expenditure per API key rather than per connection; request-time connection budget enforcement requires a schema follow-up. Additionally, spend trend queries scan `request_cost_ledger` which currently has separate single-column indexes on `api_key_id` and `created_at`; a composite index is a planned performance follow-up as ledger volume grows.
- **VansRouter git-ancestry merge could not be pushed**: The VansRouter git-ancestry merge could not be pushed to the remote repository because GitHub secret-scanning push protection blocks historical OAuth credentials/literals committed deep within VansRouter's historical commit history. This shared git lineage is not completed and is not claimed anywhere as done.
- **Redis defaults in Compose, optional elsewhere**: `docker-compose.yml` runs `redis:8.2-alpine` by default for cluster Pub/Sub invalidation, sliding-window quotas, distributed lease semaphores, and advisory auth caches. However, KhatamRouter operates fully without Redis using `bun:sqlite` transactions and in-process concurrency semaphores when `REDIS_URL` is omitted. If Redis is configured but encounters an outage, quotas degrade safely to SQLite transactions so limits remain enforced, while caching/events fail open.
- **Circuit breaker is opt-in today**: The Wave 4 breaker, 429 classifier and pre-dispatch gates are implemented and tested, but the fallback-path integration is gated behind `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1`. Left unset (the default), the account-fallback loop executes its pre-Wave-4 statements unchanged — no breaker reads, no gate evaluation.
- **Stealth and anti-ban suite is opt-in today**: The Wave 5 fingerprinting, proxy scrubbing, tool cloaking, zero-width obfuscation, and session stickiness capabilities are implemented and tested, but are default-off. Operators opt in per provider (`CLI_COMPAT_<PROVIDER>=1`, e.g. `CLI_COMPAT_CLAUDE=1`), per capability (`STEALTH_FINGERPRINTS=1`, `STEALTH_HEADER_SCRUB=1`, `STEALTH_TOOL_CLOAK=1`, `STEALTH_ZERO_WIDTH=1`, `STEALTH_STICKINESS=1`), or globally (`STEALTH_ALL=1` or `CLI_COMPAT_ALL=1`). Left unset (the default), headers and request bodies are passed untouched. Protocol-level signatures (Cursor Jyh cipher, Copilot token exchange synthesis, and low-level TLS cipher fingerprinting) remain deferred roadmap items.
- **Model capability guard is opt-in today**: Fail-closed combo capability gating is implemented in `src/domain/requestCapabilities.js` and wired into `open-sse/services/combo.js`, but is default-off behind `KHATAM_MODEL_CAPABILITY_GUARD=1` or explicit caller options. Left unset (the default), existing fallback behavior is preserved.
- **LoopGuard is default-off**: Stateless agent loop detection in `open-sse/utils/loopGuard.js` is implemented and verified, but disabled by default via `loopGuardEnabled: false` in settings (`src/lib/db/repos/settingsRepo.js`). Operators opt in via settings or by passing `loopGuardEnabled: true`. Furthermore, `zcode` executor's automatic captcha-solving (`solveCaptcha`) requires optional `playwright-core` and browser binaries; without them it logs a warning and fails open to standard retries.
- **Smart Router Redis dependency for multi-replica stickiness**: Smart Router adaptive combo routing uses Redis (`khatam:smartrouter:session:*`) to maintain session stickiness across multiple gateway replicas. When `REDIS_URL` is omitted, it falls back gracefully to local in-process state with fail-open semantics.
- **Vertical scale: per-process state is not shared without Redis**: With `KHATAM_WORKERS > 1` and no `REDIS_URL`, login lockout (`src/lib/auth/loginLimiter.js`), rate limits, circuit-breaker trips, combo rotation state, concurrency semaphores (`keyAccess.js`) and stream/session stickiness live inside each worker. Limits are enforced per worker process, not per host, so effective limits multiply by worker count (e.g. a login lockout threshold applies to each worker separately). Set `REDIS_URL` for multi-worker deployments. Cross-worker config invalidation still works via the IPC broker, bounded by the 5 s TTL.
- **Vertical scale: `requestDetails` buffer lost on SIGKILL**: Observability records buffer for up to 5 s (`OBSERVABILITY_FLUSH_INTERVAL_MS`). A `SIGKILL`ed worker loses unflushed records. Usage rows are written synchronously and are not affected.
- **Vertical scale: in-flight requests lost on worker SIGKILL**: A `SIGKILL`ed worker drops its sockets immediately, with no drain. Observed up to 1 failed request per kill in the smoke loop (the spec tolerance is 2). Graceful in-flight SSE drain on `SIGTERM` is verified for one clean mock stream: in the host smoke drill (`scripts/vertical-smoke.sh`, `VERTICAL_SMOKE_ALL_PASS`), at least 3 of 8 chunks were still unsent at SIGTERM, the client received the remaining chunks plus `[DONE]`, the primary exited 0 after stream end (~5.9 s SIGTERM-to-stream-end), and new connections were refused. An earlier drill failure was fixed in `df1ef7ae`. Still unverified: drain under upstream stall or error, and streams near the 30 s `KHATAM_DRAIN_TIMEOUT_MS`.
- **Vertical scale: npm CLI bundle runs single-process**: `cli/scripts/build-cli.js` builds with `NEXT_TRACING_ROOT_MODE=workspace`, so `scripts/copy-standalone-assets.mjs` returns early and the published `9router` CLI omits the cluster supervisor closure. `KHATAM_WORKERS > 1` falls back to single-process mode there.
- **Vertical scale: leader-only daemons verified by role env only**: Token refresh, tunnels, quota ping and WAL checkpoint are gated on `KHATAM_WORKER_ROLE === "leader"`. The tests check the env contract, not an end-to-end leader failover of each daemon.
- **Vertical scale: `dispatch_glue` unprofiled**: It is the largest in-process phase (about 63% of mean request time). Its cause is not profiled yet; `bun --cpu-prof` is the next step before further hot-path changes.
- **Vertical scale: benchmark is synthetic**: Ladder numbers use a WSL2 8-vCPU host and a zero-latency mock upstream. They are not production throughput.
- **Psiphon pool: not verified against the live network; per-worker tunnels**: The `psiphon` pool type is tested with a fake `ConsoleClient` in CI and passed a container smoke without the binary; it has not been run against the real Psiphon network, and Psiphon server acceptance of a given sponsor ID is unverified. The GPL-3.0 `ConsoleClient` binary and credentials are operator-supplied (never bundled). With `KHATAM_WORKERS > 1` each worker owns its own tunnel; Redis-shared tunnels are deferred. See [`docs/PSIPHON.md`](./docs/PSIPHON.md).
- **Current CI posture and test suite status**: Master's Verify jobs (`Verify / Unit (waves)`, `Verify / Unit (core)`, `Verify / Baselines`, `Verify / Typecheck`, `Verify (tests + baselines)`) are green after PR #66 resolved an intermittent Vitest worker teardown flake (cause: unawaited fire-and-forget circuit-breaker persistence opening the real SQLite database or Redis client after tests finished, causing unhandled `EnvironmentTeardownError` when RPC logs were pending on worker shutdown). However, the full test suite is not claimed all-green: 75 baseline failures exist in `tests/__baseline__/known-fails.txt` (along with strict-proxy-enforcement tests requiring isolated proxy environments that fail under ambient proxies). Full regression test suite execution against `tests/__baseline__/known-fails.txt` remains an independent release closeout task (`T049`).

---

## Not Planned / Non-Goals

The following areas are explicitly out of scope for KhatamRouter:

- **GitHub repository identity migration**: Live repository migration, renaming, transfer, or remote changes are strictly out of scope and have not occurred. The repository retains its current identity and remotes.
- **Replacing the Next.js dashboard with a separate framework**: Next.js App Router provides an effective foundation for the control plane. We maintain dashboard components in plain JavaScript (ESM) rather than replacing the framework or migrating to TypeScript.
- **Operating as a multi-tenant public SaaS**: KhatamRouter is engineered for local development, self-hosted private servers, and single-tenant infrastructure. Multi-tenant public billing systems and hosted user authentication platforms are non-goals.
- **Reverse-engineering private enterprise protocols or bypassing provider ToS**: KhatamRouter implements standard API protocols, documented provider integrations, and client fingerprinting. We do not develop exploits or attempt to bypass vendor Terms of Service.

---

## Upstream Compatibility

KhatamRouter is maintained as a content fork of [`decolua/9router`](https://github.com/decolua/9router) (initialized from `v0.5.104`) and actively ports audited improvements from both `decolua/9router` and [`Vanszs/VansRouter`](https://github.com/Vanszs/VansRouter). Full details of all 44 candidates ported in Wave 9, the subsequent port of five `decolua/9router` PRs (#4988, #5222, #5150, #5179, #5193) via PR #67, security hardening, and rationales for skipped commits are documented in [`docs/UPSTREAM-PORTS.md`](./docs/UPSTREAM-PORTS.md).

We preserve ongoing compatibility with upstream updates through the following mechanisms:

- **Automated daily sync**: A scheduled GitHub Actions workflow (`.github/workflows/upstream-sync.yml`) runs daily at 03:17 UTC, fetching new commits from `decolua/9router` and merging them with `--allow-unrelated-histories`.
- **Deterministic override resolution**: Conflicting files listed in [`.github/upstream-sync-overrides.txt`](./.github/upstream-sync-overrides.txt) (governance specifications, sanitized OAuth credentials, branding, and CI pipelines) deterministically retain our version (`--ours`).
- **Reviewable sync PRs**: Conflicts on unlisted files adopt upstream changes (`--theirs`) and are submitted as reviewable Pull Requests labeled `upstream-sync`, ensuring no upstream enhancement lands without human review.

---

## Contributing

Contributions to KhatamRouter are welcome. All implementation work must follow the Spec-Kit specification-driven development workflow under `specs/<NNN-feature>/` and adhere to the architectural principles ratified in [`.specify/memory/constitution.md`](./.specify/memory/constitution.md). Before opening a Pull Request, verify that provider catalog baselines pass without regressions (`bun tests/__baseline__/verify-providers.mjs`), avoid introducing unverified dependencies, and ensure your branch is up to date with `master`.

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
| **Bun v1.4.3 + TypeScript Runtime** | 🟢 Shipped | Wave 1: Native Bun execution, `@/*` mapping, `Dockerfile.bun` |
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

### Operational Baseline (Shipped)

Only the following capabilities are shipped and operational today:

- **Bun-only runtime & `bun:sqlite` engine**: Complete elimination of Node.js. Server strictly requires Bun v1.4.3+. Sole SQLite engine is native `bun:sqlite` with WAL mode (`busy_timeout = 5000`, `temp_store = MEMORY`), preflight integrity validation (`PRAGMA quick_check`), and zero legacy Node drivers. Published CLI launcher requires `bun` on PATH.
- **Docker Compose with Redis by default (`redis:8.2-alpine`)**: Default stack running `redis:8.2-alpine` with Append-Only File on `redis-data`, `redis-cli ping` healthcheck, loopback-only binding (`127.0.0.1:6379`), and app `depends_on: { redis: { condition: service_healthy } }`. Disabling Redis is fully documented and degrades gracefully to SQLite.
- **Distributed Redis primitives & lease semaphores**: All keys TTL-bounded and namespaced under `khatam:`, with secrets cryptographically hashed. Includes shared circuit-breaker trips (`khatam:cb:*`), dashboard login limiter, OAuth single-use refresh locks, advisory API-key auth caching, real-time Pub/Sub invalidation bus, prompt-cache stealth session pins, pricing/request-details invalidation, round-robin counters, lease-based distributed concurrency semaphores (`khatam:sem:*`), and opt-in chat idempotency keys.
- **Hybrid quota resilience contract**: When `REDIS_URL` is omitted, non-consuming fail-open semantics operate locally. When Redis is configured but encounters an outage, quotas degrade safely to SQLite transaction-backed counters (`SqliteQuotaStore`) so configured spending and rate limits remain strictly enforced.
- **Retained Webpack bundler**: Webpack retained (`--webpack`) following empirical Turbopack evaluation showing a 52% standalone size inflation regression and configuration disparity.
- **Bun v1.4.3 + TypeScript runtime**: Native Bun execution via `bun run dev:bun` and `bun run start:bun`, `@/*` path mapping to `./src/*`, and multi-stage container builds via `Dockerfile.bun`.
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
  - Migration runner: `src/lib/db/migrationRunner.js` (and `migrationRunner.ts`) with idempotent execution tracking in `_khatam_migrations` and automated pre-migration DB backups.
  - Migration 002: `src/lib/db/migrations/002-wave2-storage-quota.js` adding tables and columns for limits, quotas, cost ledger, circuit breakers, and capabilities.
  - Central schema version: `SCHEMA_VERSION = 3` in `src/lib/db/schema.js`.
  - Quota store files: `src/lib/quota/storeFactory.js`, `src/lib/quota/redisQuotaStore.js`, `src/lib/quota/sqliteQuotaStore.js`, and `src/lib/quota/index.js` (with TypeScript source variants).
  - Settings cache: 5-second in-memory TTL cache with `bumpSettingsRevision` and `invalidateSettingsCache` in `src/lib/db/repos/settingsRepo.js`.
- **Versioned `_khatam_migrations` runner**: A dedicated startup migration engine executing ordered, versioned migration scripts to ensure schema consistency across both Bun and Go runtimes.
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

- **Strict Bun-Only Runtime**: The server strictly requires Bun v1.4.3+. Node.js is no longer supported (breaking change). Startup fails closed with an actionable message if Bun is missing.
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

## Wave 8 — Dashboard and Tooling

**Status**: 🔵 Planned

Wave 8 delivers user interface controls and administrative tooling:

- **TSX limits modals**: TypeScript/React dialogs for managing per-connection rate limits, concurrency ceilings, and budget caps.
- **Key quota tabs**: Dedicated dashboard views providing real-time visualization of per-key quota utilization, sliding-window consumption, and spend trends.
- **Capability badges**: Interface badges highlighting model modalities and capabilities across provider tables and combo builders.
- **CLI consolidation**: Unification of the standalone launcher CLI and runtime operational commands into a consolidated TypeScript CLI.

---

## Phase 2 — Go Gateway (Waves 9–11)

**Status**: 🔵 Planned

Phase 2 establishes a high-performance split-plane architecture:

- **Dedicated gateway binary**: High-throughput data-plane daemon (`cmd/khatam-gateway`) compiled with `CGO_ENABLED=0`, listening on dedicated port `ENDPOINT_PORT=20129`.
- **Shared SQLite state**: Concurrent access to `$DATA_DIR/db/data.sqlite` via `modernc.org/sqlite` using identical PRAGMAs (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`).
- **RCU configuration cache**: Read-Copy-Update in-memory routing tables invalidated in real time via Redis Pub/Sub (`khatam:events:config_reload`).
- **Zero-copy SSE framing**: Memory-efficient Server-Sent Events framing and stateful stream translation minimizing GC pressure.
- **Native protocol handling**: Native gzip decompression for Cursor protocols and CRC32 framing for Kiro EventStreams.
- **Asynchronous usage store**: Non-blocking channel-based usage collector flushing usage records to storage in background batches.
- **Strangler-fig cutover**: Incremental migration of proxy traffic from port 20128 to port 20129 validated by golden parity test suites and load benchmarks.

> **Operational Notice**: In the current runtime, all OpenAI-compatible `/v1/*` routes and dashboard views are served exclusively on port **20128** by Bun and Next.js. Port **20129** is reserved in `.env.example` and server configurations, but **no process is currently listening on port 20129**.

---

## Known Limitations Today

To ensure clear operational expectations, the following limitations exist in the current implementation:

- **No Go gateway yet**: All inference traffic is handled entirely by the Bun/Next.js control plane on port 20128. The Phase 2 Go gateway (`cmd/khatam-gateway`) is not yet implemented.
- **Redis defaults in Compose, optional elsewhere**: `docker-compose.yml` runs `redis:8.2-alpine` by default for cluster Pub/Sub invalidation, sliding-window quotas, distributed lease semaphores, and advisory auth caches. However, KhatamRouter operates fully without Redis using `bun:sqlite` transactions and in-process concurrency semaphores when `REDIS_URL` is omitted. If Redis is configured but encounters an outage, quotas degrade safely to SQLite transactions so limits remain enforced, while caching/events fail open.
- **Circuit breaker is opt-in today**: The Wave 4 breaker, 429 classifier and pre-dispatch gates are implemented and tested, but the fallback-path integration is gated behind `KHATAM_RESILIENCE_CIRCUIT_BREAKER=1`. Left unset (the default), the account-fallback loop executes its pre-Wave-4 statements unchanged — no breaker reads, no gate evaluation.
- **Stealth and anti-ban suite is opt-in today**: The Wave 5 fingerprinting, proxy scrubbing, tool cloaking, zero-width obfuscation, and session stickiness capabilities are implemented and tested, but are default-off. Operators opt in per provider (`CLI_COMPAT_<PROVIDER>=1`, e.g. `CLI_COMPAT_CLAUDE=1`), per capability (`STEALTH_FINGERPRINTS=1`, `STEALTH_HEADER_SCRUB=1`, `STEALTH_TOOL_CLOAK=1`, `STEALTH_ZERO_WIDTH=1`, `STEALTH_STICKINESS=1`), or globally (`STEALTH_ALL=1` or `CLI_COMPAT_ALL=1`). Left unset (the default), headers and request bodies are passed untouched. Protocol-level signatures (Cursor Jyh cipher, Copilot token exchange synthesis, and low-level TLS cipher fingerprinting) remain deferred roadmap items.
- **Model capability guard is opt-in today**: Fail-closed combo capability gating is implemented in `src/domain/requestCapabilities.js` and wired into `open-sse/services/combo.js`, but is default-off behind `KHATAM_MODEL_CAPABILITY_GUARD=1` or explicit caller options. Left unset (the default), existing fallback behavior is preserved.
- **LoopGuard is default-off**: Stateless agent loop detection in `open-sse/utils/loopGuard.js` is implemented and verified, but disabled by default via `loopGuardEnabled: false` in settings (`src/lib/db/repos/settingsRepo.js`). Operators opt in via settings or by passing `loopGuardEnabled: true`. Furthermore, `zcode` executor's automatic captcha-solving (`solveCaptcha`) requires optional `playwright-core` and browser binaries; without them it logs a warning and fails open to standard retries.
- **20129 refuses connections**: While `ENDPOINT_PORT=20129` is documented and recognized in runtime configuration, no service is listening on port 20129 today.
- **The test suite posture**: 4102 passing tests on this branch vs 3979 on master (+123 tests), with 0 regressions. `tests/__baseline__/known-fails.txt` now directly mirrors measured master baseline failures. The CI verify gate (`.github/workflows/verify.yml`) asserts no regressions against this calibrated baseline.

---

## Not Planned / Non-Goals

The following areas are explicitly out of scope for KhatamRouter:

- **Replacing the Next.js dashboard with a separate framework**: Next.js App Router provides an effective foundation for the control plane. We will migrate dashboard components to TypeScript (`TS`/`TSX`) rather than replacing the framework.
- **Operating as a multi-tenant public SaaS**: KhatamRouter is engineered for local development, self-hosted private servers, and single-tenant infrastructure. Multi-tenant public billing systems and hosted user authentication platforms are non-goals.
- **Reverse-engineering private enterprise protocols or bypassing provider ToS**: KhatamRouter implements standard API protocols, documented provider integrations, and client fingerprinting. We do not develop exploits or attempt to bypass vendor Terms of Service.

---

## Upstream Compatibility

KhatamRouter is maintained as a content fork of [`decolua/9router`](https://github.com/decolua/9router) (initialized from `v0.5.104`). We preserve ongoing compatibility with upstream updates through the following mechanisms:

- **Automated daily sync**: A scheduled GitHub Actions workflow (`.github/workflows/upstream-sync.yml`) runs daily at 03:17 UTC, fetching new commits from `decolua/9router` and merging them with `--allow-unrelated-histories`.
- **Deterministic override resolution**: Conflicting files listed in [`.github/upstream-sync-overrides.txt`](./.github/upstream-sync-overrides.txt) (governance specifications, sanitized OAuth credentials, branding, and CI pipelines) deterministically retain our version (`--ours`).
- **Reviewable sync PRs**: Conflicts on unlisted files adopt upstream changes (`--theirs`) and are submitted as reviewable Pull Requests labeled `upstream-sync`, ensuring no upstream enhancement lands without human review.

---

## Contributing

Contributions to KhatamRouter are welcome. All implementation work must follow the Spec-Kit specification-driven development workflow under `specs/<NNN-feature>/` and adhere to the architectural principles ratified in [`.specify/memory/constitution.md`](./.specify/memory/constitution.md). Before opening a Pull Request, verify that provider catalog baselines pass without regressions (`node tests/__baseline__/verify-providers.mjs`), avoid introducing unverified dependencies, and ensure your branch is up to date with `master`.

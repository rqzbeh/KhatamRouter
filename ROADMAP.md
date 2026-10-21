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
| **Granular Per-Connection / Key Limits & ACL** | 🟢 Shipped | Wave 3: Unified tri-state ACL, constant-time internal trust, sliding-window key limits, connection concurrency/rate overrides, USD spend caps with fail-open degradation |
| **Hardened Request Ingestion & Smuggling Defense** | 🟢 Shipped | HTTP/1.1 & h2c smuggling defenses, 128 MiB JSON body cap, 64 MiB chunked cap |
| **Token Savers (RTK, Caveman, Ponytail)** | 🟢 Shipped | Pre-translation tool compression with 10 MiB cap, prompt injection modes |

### Operational Baseline (Shipped)

Only the following capabilities are shipped and operational today:

- **Bun v1.4.3 + TypeScript runtime**: Native Bun execution via `bun run dev:bun` and `bun run start:bun`, `@/*` path mapping to `./src/*`, and multi-stage container builds via `Dockerfile.bun`.
- **SQLite WAL engine + integrity preflight**: Native `bun:sqlite` adapter running Write-Ahead Logging (`PRAGMA journal_mode = WAL`), a 5000ms lock timeout (`PRAGMA busy_timeout = 5000`), in-memory temporary storage (`PRAGMA temp_store = MEMORY`), and mandatory startup integrity validation (`PRAGMA integrity_check`) refusing silent fallback over existing data.
- **Redis client, pub/sub, and hybrid quota store (no distributed circuit state yet)**: Connection management and Pub/Sub event bus under `src/lib/redis/` enforcing the `khatam:` namespace prefix for cluster-wide cache invalidation (`khatam:events:config_reload`), plus atomic sliding-window quota tracking via `RedisQuotaStore` (`khatam:quota:*`), with automatic fail-safe fallback to in-memory/SQLite when `REDIS_URL` is omitted. Redis does not yet handle circuit breaker state storage (scheduled for Wave 4).
- **Versioned DB migrations & hybrid quota store**: Idempotent `_khatam_migrations` runner executing ordered JS/TS migrations with backup-before-migrate safety, additive schema v3 (`rate_limit_overrides_json`, `api_key_quota_limits`, `request_cost_ledger`, `domain_circuit_breakers`, `model_capabilities`), hybrid Redis/SQLite sliding-window quota store (`RedisQuotaStore` and `SqliteQuotaStore` via `createQuotaStore`) with fail-open semantics, and a 5-second in-memory TTL settings cache (`invalidateSettingsCache` / `bumpSettingsRevision`).
- **Unified Tri-State ACL & Timing-Safe Internal Trust**: Granular authorization filters on API keys supporting `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels` with explicit allow, deny, and wildcard rules, model enumeration prevention (returns 404 `model_not_found` for forbidden models), catalog filtering on `/v1/models`, and constant-time `internalTrust` token validation (`crypto.timingSafeEqual`) on `x-9r-cli-token`.
- **Granular Per-Connection / Key Rate Limits & USD Spend Caps**: Multi-tier rate limiting with `rate_limit_overrides_json` enforcing connection-level RPM/RPD/TPM/TPD, inter-call `minTime` spacing, in-process concurrency semaphores (`maxConcurrent`, `modelConcurrency`), per-key multi-window sliding limits (RPM/RPH/RPD via `QuotaStore`), and daily/weekly USD expenditure caps via `request_cost_ledger` with fail-open degradation when Redis/DB encounters transient infrastructure faults.
- **Hardened request ingestion (128 MiB JSON, 64 MiB h2c, CL+TE smuggling rejection)**: Defense-in-depth HTTP request parsing enforcing a 128 MiB ceiling on JSON request bodies via Next.js `experimental.proxyClientMaxBodySize` (default `128mb`, overridable with `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE`), a 64 MiB ceiling on chunked h2c streams (`MAX_H2C_BODY_BYTES` in `custom-server.js`), strict CRLF framing validation, and immediate rejection of HTTP smuggling attempts combining `Content-Length` and `Transfer-Encoding`.
- **Token savers (RTK/Caveman/Ponytail)**: Pre-translation tool compression via RTK (token-reducing compression of `tool_result` content with a 10 MiB ceiling per `RAW_CAP` in `open-sse/rtk/constants.js` that intentionally applies lossy per-filter truncation: e.g., git diff hunks capped at 100 lines via `GIT_DIFF_HUNK_MAX_LINES`, repetitive logs deduplicated and capped at 2,000 lines via `DEDUP_LINE_MAX`, and build outputs sliced to top deprecations and 5 warnings), Caveman terseness prompts, and Ponytail prompt modes (saving an upstream 9Router-claimed 20-40% input tokens and up to 65% output tokens, rather than a measured KhatamRouter benchmark).
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

**Status**: 🟢 Shipped

Wave 3 introduces fine-grained authorization policies and multi-tier rate limiting:

- **Concrete Artifacts**:
  - Unified ACL Service: `src/sse/services/allowedModels.js` implementing pure tri-state logic (`isKindAllowed`, `isComboAllowed`, `isProviderAllowed`, `isModelAllowed`, `enforceUnifiedAcl`) with 403 `forbidden` (kinds, providers, combos) and 404 `model_not_found` model enumeration prevention.
  - Internal Trust Guard: `src/sse/services/internalTrust.js` implementing timing-safe constant-time (`crypto.timingSafeEqual`) verification on `x-9r-cli-token` and loopback bypass, integrated with `src/dashboardGuard.js`.
  - Catalogue Filtering: `filterModelsListForKey()` in `src/sse/services/keyAccess.js` ensuring restricted keys cannot enumerate unauthorized models via `/v1/models`.
  - Connection Rate Limiter: `open-sse/services/rateLimitManager/connectionLimiter.js`, `overrides.js`, and `semaphore.js` providing in-process concurrency semaphores (`maxConcurrent`, `modelConcurrency`), `minTime` call spacing, and connection-level RPM/RPD/TPM/TPD enforcement from `providerConnections.rate_limit_overrides_json`.
  - Per-Key Quota & Spend Caps: `src/lib/usage/apiKeyUsageLimits.js`, `src/domain/keyQuota.js`, and `src/lib/db/keyQuota.js` implementing sliding-window rate limits (RPM/RPH/RPD via `QuotaStore`) and daily/weekly USD expenditure caps via `request_cost_ledger`.
  - Fail-Open Degradation: All rate limiters and quota stores gracefully degrade to `{ allowed: true, degraded: true }` when Redis or SQLite encounter transient faults, preserving proxy throughput.
- **Tri-state access control lists**: Granular authorization filters on API keys supporting `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels` with explicit allow, deny, and wildcard rules.
- **`internalTrust` timing-safe token**: Timing-attack resistant token validation for securing inter-process communication and trusted reverse-proxy routing.
- **Per-connection rate and concurrency limits**: Strict enforcement of requests per minute (RPM), requests per day (RPD), tokens per minute (TPM), tokens per day (TPD), minimum inter-call spacing (`minTime`), and concurrency caps (`maxConcurrent` / `modelConcurrency`).
- **Per-key sliding windows**: Sub-second sliding-window algorithms tracking requests per hour (RPH), requests per minute (RPM), and requests per day (RPD).
- **USD expenditure caps**: Configurable daily, weekly, and monthly budget limits backed by `request_cost_ledger`, with fail-open resilience on infrastructure errors and 429 Retry-After on limit exhaustion.

---

## Wave 4 — Resilience

**Status**: 🔵 Planned

Wave 4 implements fault-tolerant routing and provider health protection:

- **4-state circuit breaker**: Finite-state machine transitioning across `CLOSED` (healthy) → `DEGRADED` (consecutive transient errors) → `OPEN` (traffic diverted) → `HALF_OPEN` (controlled canary probes).
- **`classify429` error taxonomy**: Response body and header analysis distinguishing temporary concurrency throttling from exhausted billing quotas.
- **Failure-kind cooldowns**: Variable backoff durations tailored to specific failure modes (e.g. transient network timeouts vs upstream capacity limits vs authentication failures).
- **Client 4xx and POLICY exemptions**: Explicit exemption of client-induced 4xx errors (400, 406, 408, 409, 410, 422) and content moderation `POLICY` refusals from provider health penalties, preventing client errors from tripping backend circuit breakers.
- **Pre-dispatch target gates**: Pre-flight validation verifying circuit health and quota headroom before dispatching requests to upstream connections.

---

## Wave 5 — Stealth and Anti-Ban

**Status**: 🔵 Planned

Wave 5 protects credentials and upstream accounts through client signature emulation:

- **Canonical CLI header and field ordering**: Strict matching of HTTP header order and JSON field serialization identical to official client tooling (Claude Code, OpenAI Codex, GitHub Copilot).
- **Reverse-proxy header scrubbing**: Stripping internal proxy indicators (`x-forwarded-for`, `x-real-ip`, `via`) before dispatching requests to external providers.
- **Provider client profiles**: Accurate fingerprint synthesis including Antigravity identity headers, Cursor `Jyh` checksum emulation, Copilot token exchange signatures, and Claude Code xxHash64 `cch=` hashes.
- **Tool-name cloaking**: Mapping internal and non-standard tool call signatures to standard vendor formats to prevent vendor-side tool filtering.
- **`U+200D` zero-width joiner obfuscation**: Subtle prompt normalization mitigating simplistic pattern-matching detection heuristics.
- **TLS fingerprinting**: Alignment of TLS cipher suites and handshake parameters to prevent network-level proxy fingerprinting.
- **15-minute session stickiness**: Routing multi-turn conversation threads to the identical upstream account and connection to avoid detection triggered by rapid credential cycling.

---

## Wave 6 — Model Intelligence

**Status**: 🔵 Planned

Wave 6 provides dynamic model awareness and capability validation:

- **Live provider model discovery**: Automated querying of provider `/models` endpoints to register newly released upstream models without manual configuration.
- **`models.dev` catalog sync**: Scheduled catalog ingestion synchronizing current token pricing, context limits, and modality support flags.
- **Context-window reconciler**: Runtime inspection calculating prompt token size against true model context boundaries to select appropriate fallback targets.
- **Capability-rich custom models**: User-defined model aliases annotated with structured capability metadata (`vision`, `video`, `audio`, `tools`, `reasoning`, `contextWindow`, `maxOutputTokens`).
- **Fail-closed combo gating**: Pre-dispatch validation verifying that target models support all requested modalities (e.g. image inputs), preventing combos from routing multi-modal requests to text-only endpoints.

---

## Wave 7 — VansRouter Parity

**Status**: 🔵 Planned

Wave 7 integrates specialized capabilities ported from the VansRouter ecosystem:

- **31 provider registries**: Clean integration of 31 additional provider definitions on top of the 9Router registry architecture.
- **Net-new executors**: Specialized protocol executors supporting alternative inference backends.
- **Free tiers routing**: Automated discovery and fallback across zero-cost and promotional provider quotas.
- **Multi-level Ponytail**: Configurable prompt compression tiers (Lite, Full, Ultra) optimizing input token economy.
- **`LoopGuard`**: Execution monitoring detecting and breaking circular agent tool-calling loops.
- **Translator fixes**: Targeted improvements addressing thinking blocks, tool call ID preservation, and streaming protocol edge cases.

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
- **Redis handles connection, pubsub, and quota, but no distributed circuit state**: While Redis connection management, Pub/Sub cache invalidation, and sliding-window quota tracking (`RedisQuotaStore`) are operational, distributed circuit breaker state storage in Redis is not yet built (scheduled for Wave 4).
- **No circuit breaker yet**: Requests currently rely on basic try/catch fallback loops without stateful 4-state circuit trip transitions (`CLOSED → DEGRADED → OPEN → HALF_OPEN`) or failure-kind cooldowns.
- **20129 refuses connections**: While `ENDPOINT_PORT=20129` is documented and recognized in runtime configuration, no service is listening on port 20129 today.
- **The full test suite is not green on a bare checkout**: `tests/__baseline__/known-fails.txt` catalogs exactly 24 known-failing test cases, and `CLAUDE.md` documents roughly 64 failing tests on a plain checkout. The CI verify gate (`.github/workflows/verify.yml`) cites a more conservative ~91 expected failures, counting the 24 catalogued cases plus `unit/embeddings.cloud.test.js` (targets the `cloud/` worker directory, which is not in this repo), `unit/xai-oauth-service.test.js` (times out without reachable discovery), and 13 `tests/**/*.real.test.js` live-provider files requiring credentials. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run.

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

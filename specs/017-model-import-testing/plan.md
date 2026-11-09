# Implementation Plan: Model Import, Capability Discovery & Batch Testing

**Branch**: `017-model-import-testing` | **Date**: 2026-11-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-model-import-testing/spec.md`

## Summary

Wire the existing (but request-path-disconnected) Wave 6 model discovery/capability modules into production; add a defensive, idempotent model import API for built-in providers and user-created OpenAI/Anthropic-compatible gateways; make capability/context discovery best-effort with durable, provenance-tracked manual overrides; add an opt-in batch "test all" with classification-gated auto-disable; make automatic sync optional (global default + per-provider inherit/enabled/disabled); scope proxy-rotation failures; make retry intervals configurable but subordinate to upstream `Retry-After`; add per-combo failed-member cooldown with correct failover/isolation; add opt-in free-proxy source pools; and close a verified SSRF/TLS/background-authorization gap in custom-gateway discovery and automated sync. The Psiphon VPS item is gated on real evidence and is planned as blocked-until-evidence.

Plain JavaScript (ESM) only, Bun runtime, `bun:sqlite` WAL, Next.js App Router, vitest under `tests/` (independent package).

## Technical Context

**Language/Version**: JavaScript ESM (no TypeScript), Bun `1.4.4+` runtime.

**Primary Dependencies**: Next.js App Router (`src/app/api/**` route handlers), `undici` `ProxyAgent` + `socks-proxy-agent` (proxy egress), `ioredis` (optional, fail-open), `bun:sqlite` (only SQLite driver), React dashboard (existing components). No new runtime dependency is required.

**Storage**: `bun:sqlite` WAL under `$DATA_DIR/db/data.sqlite` via `src/lib/db/*` (repos in `src/lib/db/repos/`, migrations in `src/lib/db/migrations/`). `kv(scope,key,value)` is the existing flexible store (used by `disabledModelsRepo`). Settings live in `src/lib/db/repos/settingsRepo.js` (scope `settings`).

**Testing**: vitest from `tests/` (`bun x vitest run`), independent ESM package; aliases resolve `open-sse/` and `@/` from repo root. Unit tests in `tests/unit/**`, integration under `tests/integration/**` (e.g. `combo-cooldown-reliability.mjs`, `cowork-mcp-ssrf-guard.test.js`).

**Target Platform**: Local gateway/dashboard, single Bun process (default port 20128); Docker (Bun-only).

**Project Type**: Single repo — Next.js web app + provider-agnostic `open-sse/` engine + separate `cli/` launcher.

**Performance Goals**: Discovery/import and batch test must not block request routing; batch dispatch is sequential and rate-respecting; sync bounded by finite timeout/concurrency.

**Constraints**: Fail-open for availability, fail-closed for security (SSRF, TLS, strict-proxy). Never shorten upstream `Retry-After`. Manual overrides immutably survive refresh. No secret logging.

**Scale/Scope**: 40+ providers; catalogs up to a few thousand models; batch tests capped (e.g. `max 100` per run, mirroring OmniRoute).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Upstream Base Integrity** — Additive on top of `decolua/9router`; reuses Wave 6 modules and does not delete upstream capabilities. PASS.
- **II. Single-Runtime Stack (Bun)** — No new runtime; `bun:sqlite` retained; no Node fallback reintroduced. PASS.
- **III. SQLite WAL + Redis Hybrid** — New persisted state (sync policy, scoped rotation failures, free-proxy provenance, combo cooldown setting) will use existing SQLite repos; Redis use (if any) stays fail-open. PASS.
- **IV. Graph-First Discovery & Coverage Invariant** — This plan was produced after `search_graph`/grep + coverage checks; cited paths were verified by direct source reads (see research.md "Source Verification"). PASS.
- **V. Spec-Kit SDD + Unlazy Gate-Driven Completion (NON-NEGOTIABLE)** — Spec + plan + tasks under `specs/017-model-import-testing/`; implementation leaves must carry Unlazy `PLAN.md`/`GATES.md` and pass `gate-lint.mjs`/`gate-check.mjs`. PASS (implementation phase).
- **VI. Resilience, Granular Limits, Stealth & Dynamic Model Capabilities** — Directly advances dynamic/custom model capability discovery and granular limits; preserves 4-state breaker, strict-proxy fail-closed, and stealth. PASS.

**Post-Phase-1 re-check**: No violations; no Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/017-model-import-testing/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── import-discovery-api.md
│   ├── batch-test-api.md
│   ├── sync-policy-api.md
│   ├── scoped-rotation-and-retry.md
│   ├── combo-cooldown.md
│   └── free-proxy-sources.md
├── checklists/
│   └── requirements.md
├── spec.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
src/lib/models/
├── discovery.js                 # EXISTING: normalizeDiscoveredModels (unwired → wire in)
├── capabilities.js              # EXISTING: resolveModelCapabilities (unwired → wire in)
├── contextReconciler.js         # EXISTING: reconcileContextWindows (unwired → wire in)

src/lib/db/repos/
├── nodesRepo.js                 # EXISTING: provider nodes (baseUrl) — add local/isSelfHosted flag
├── settingsRepo.js              # EXISTING: global settings — add sync default + retry policy
├── combosRepo.js                # EXISTING: combos — add per-combo cooldown config
├── disabledModelsRepo.js        # EXISTING: soft-disable store — add reason/time audit
└── (new) syncPolicyRepo.js      # per-provider sync setting (inherit/enabled/disabled)

src/app/api/
├── providers/suggested-models/route.js   # GAP: raw unguarded fetch → guarded fetch
├── provider-nodes/route.js               # GAP: no SSRF on create
├── provider-nodes/[id]/route.js          # GAP: no SSRF on update; add local flag
├── provider-nodes/validate/route.js      # literal-only guard → DNS-aware
├── models/import/route.js                # NEW: discover + import (added/updated/skipped/failed)
├── models/test-batch/route.js            # NEW: batch "test all" with classification + opt-in auto-disable
├── models/overrides/route.js             # NEW: per-model capability/context overrides (manual)
├── models/sync-policy/route.js           # NEW: global default + per-provider override
└── settings/free-proxies/route.js        # NEW: free-proxy sources enable/list/sync (opt-in)

src/shared/utils/ssrfGuard.js             # EXISTING: assertPublicUrl / assertPublicUrlResolved / fetchPublic
src/dashboardGuard.js                     # EXISTING: isLocalRequest (request-scoped)
open-sse/utils/proxyFetch.js              # EXISTING: proxy/TLS path (insecure fallback guarded by STRICT_SSL)
open-sse/services/proxyPoolFitness.js     # EXISTING: in-process fitness; durable storage/production selection wiring must be verified and implemented
open-sse/services/combo.js                # EXISTING: scoped 429/5xx cooldown map (extend to config)

tests/unit/**, tests/integration/**
```

**Structure Decision**: Single-project layout (Next.js app + `open-sse` engine). Reuse existing directories; no new top-level packages. New files grouped by the concern they extend (models, db repos, api routes).

## Complexity Tracking

No constitution violations. No entries.

## Phased Delivery — Independently Mergeable Sequential PRs

Each PR is independently mergeable and references real code. Default dependent order: **S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10**. S0–S2 are security/correctness prerequisites; S3–S9 deliver spec stories; S10 is evidence-gated and may be reported blocked.

**Catalog amendment (2026-11-08, supersedes the earlier hand-edited catalog slice):** The user rejected refreshing default catalogs by reading per-model documentation and hand-editing registry files. Default catalog refresh MUST use the same discovery/import reconciliation engine as runtime import and automatic sync, so the refresh exercises and validates that engine. The hand-edited worktree is discarded. Pipeline: (1) provider listing adapter fetches the authoritative listing through the guarded fetch and reports completeness; (2) normalizer extracts listing-provided metadata (context, output limit, modalities, reasoning/levels where the listing exposes them); (3) enrichment from the existing models.dev catalog sync fills fields the listing omits, with per-field provenance; unknown stays unknown; (4) pure reconciliation engine computes add/update/remove against the prior snapshot, removing obsolete entries only on complete authoritative snapshots, never touching manual overrides; (5) the runtime importer persists the result, and a maintainer refresh script runs the identical engine to regenerate a generated default-catalog data file merged into the registry. Provider-specific rules (for example, a gateway forcing OpenAI reasoning wire format) are declarative adapter configuration, not per-model hand edits. Live refresh evidence must come from running this pipeline, not documentation scraping.

**Execution amendment (2026-11-08):** One narrower independent slice may land sooner, sequentially after its own review and CI: removing avoidable waits on explicitly quota-shaped wrapped 503 combo errors, without claiming the full configurable cooldown feature is delivered. These slices do not depend on gateway trust, override migrations or UI work. All merges are serialized; dependent work must be reverified on the merged base. The catalog amendment follows the user's subsequent request, and the quota amendment prioritizes the reproduced latency defect. S0 is subject to parent-authored real loopback regression tests and must not be marked complete based only on implementer self-checks.

> **Ordering corrections (re-review):** S5 (retry intervals) lands **before** S6 (batch) and S7 (sync) because both consume the effective-wait policy. S4 is the sole home of the overrides API (S1 does not create it). Every schema change bumps `SCHEMA_VERSION` (verified `= 5`) and is registered in `src/lib/db/migrations/index.js`.

| PR | Title | Spec coverage | Depends on |
|----|-------|---------------|------------|
| **S0** | SSRF/TLS hardening for custom gateways + safe background authorization | US10, FR-058..FR-063a, FR-065(TLS part); SC-019..SC-021 | **none** (setup only) |
| **S1** | Wire discovery + per-field capability override resolver into runtime (cache/invalidation) | US2, FR-006a..FR-012, FR-009a/FR-009b, FR-065; SC-003, SC-004, SC-025, SC-026 | capability migration + override cache (foundational) |
| **S2** | Combo failed-member cooldown + nested-error handling + handler threading + real-user reproduction | US7, FR-039..FR-046, FR-043a; SC-013..SC-015, SC-029 | combo migration (foundational) |
| **S3** | Model import API (defensive, idempotent) | US1, FR-001..FR-005; SC-001, SC-002 | S0, S1 |
| **S4** | Per-model overrides API (provider/model/source) + disable-audit compat | US2/US3 partial, FR-008/FR-008a/FR-012, FR-025/FR-025a; SC-012, SC-027 | S1 |
| **S5** | Configurable retry intervals (global + per-provider), subordinate to `Retry-After` | US6, FR-032..FR-035; SC-008 | Foundational retry repo (**before S6/S7**) |
| **S6** | Batch "test all" with classification + opt-in auto-disable + storm halt | US3, FR-019..FR-026; SC-005, SC-006, SC-010, SC-011 | S0, S3, S5 |
| **S7** | Optional automatic sync targeting real providers (global default + per-provider) | US4, FR-013..FR-018, FR-013a, FR-064; SC-009, SC-022, SC-028 | S0, S1, S3, S5 |
| **S8** | Scoped proxy-rotation failure attribution + proxy fitness integration | US5, FR-027..FR-031, FR-043b; SC-007, SC-030 | S5 |
| **S9** | Free-proxy providers as opt-in pools (1proxy/proxifly/iplocate; SOCKS unsupported; MIT notices) | US8, FR-047..FR-053; SC-016, SC-017 | S0 |
| **S10** | Psiphon VPS evidence-gated fix | US9, FR-054..FR-057; SC-018 | evidence |

**Dependency note (corrected)**: S0 has **no dependency on the foundational data work** (sync/retry policy repos, classification, combo migration) — it only needs Setup. The foundational phase blocks S1, S2, S4, S5, S6, S7, S8, S9, but **not S0**. S1/S2 require their own migration tasks (capability overrides, combo cooldown) which are foundational to those slices.

### S0 — SSRF/TLS hardening for custom gateways + safe background authorization
- Independent of foundational data work: S0 needs only Setup, so it can merge first.
- Replace raw `fetch(url)` in `src/app/api/providers/suggested-models/route.js` with `fetchPublic` (SSRF-guarded, redirect-re-validated); add `assertPublicUrlResolved` (DNS-aware) for the direct path.
- Add the guard to provider-node create (`src/app/api/provider-nodes/route.js`) and update (`src/app/api/provider-nodes/[id]/route.js`) so an unvalidated `baseUrl` cannot be persisted (FR-061).
- Upgrade `validate/route.js` from literal `assertPublicUrl` to DNS-aware `assertPublicUrlResolved`.
- Persist an explicit `isSelfHosted`/local flag on the node (`nodesRepo`), and make the local allowance **request-independent**: a persisted declared-local gateway is authorized for background sync even with no inbound request; a non-local/proxied request is still refused (FR-062, FR-062a).
- Do not forward credentials across an origin change on redirect; never log them (FR-063).
- TLS (FR-063a): default verification on; any self-signed relaxation must be explicit, scoped to the declared local gateway, and never applied to remote or strict-proxy/Psiphon egress. Note the existing `proxyFetch.js` insecure fallback keyed by `STRICT_SSL` — the local-gateway path must not rely on a global `insecure` toggle.

### S1 — Wire discovery + per-field override resolver into runtime
- Verified gaps: `src/lib/models/discovery.js` and `src/lib/models/contextReconciler.js` are imported only by tests; `resolveModelCapabilities` is called only by the reconciler; the request path uses `getCapabilitiesForModel` (`open-sse/providers/capabilities.js`, called from `src/domain/requestCapabilities.js`, `src/app/api/models/route.js`, `src/app/api/v1/models/route.js`).
- **Consumes (does not own) the Foundational schema work**: the `model_capability_overrides` scope columns + `SCHEMA_VERSION` bump are delivered in the Foundational phase. S1 does **not** create the overrides API (that is S4); it reads persisted overrides and seeds them directly in tests.
- **Per-field resolution (not record-level)**: change `resolveModelCapabilities` to merge field-by-field across the cascade instead of returning the first matching record wholesale (FR-009a, SC-026).
- **Null-safe override matching**: legacy rows have `provider` NULL and `model_pattern NOT NULL`; matching must fall back to `model_pattern`, and deterministic ids (`manual:<provider>:<model>`, `auto:<provider>:<model>`) prevent duplicates (see Foundational T020).
- **Synchronous path + cache**: `resolveCaps` is synchronous; add an `OverrideCache` loaded from SQLite and invalidated on write + `CONFIG_RELOAD` so overrides affect routing without an async DB read on the hot path (FR-009b).
- Route the runtime capability lookup and combo capability gating through the override-aware resolver, keeping `getCapabilitiesForModel` as the catalog floor.
- **Capability reconciliation (not just context)**: `reconcileContextWindows` only reconciles context; add capability reconciliation (vision/tools/reasoning/modalities) rather than assuming it exists (FR-006a).
- Provenance must be visible per field (FR-012).

### S2 — Combo failed-member cooldown + nested-error handling + handler threading + reproduction
- Extend the shipping scoped cooldown in `open-sse/services/combo.js` (commit `20a40ef8`): bounded map (`MAX_COOLDOWN_ENTRIES`), `parseRetryAfter`, scope isolation, abort cleanup — preserve all of these.
- **Migration (Foundational)**: nullable `cooldownMs` on `combos` + `SCHEMA_VERSION` bump are delivered in Foundational (FR-038a).
- **combosRepo SQL mapping (verified gap)**: `rowToCombo` currently returns only `{id,name,kind,models,createdAt,updatedAt}`; `createCombo`'s INSERT column list omits `cooldownMs`; `updateCombo`'s UPDATE omits it. All three MUST be extended or the value will silently not persist (FR-039).
- Add a per-combo cooldown config (presets 1m/5m/1h) persisted via `combosRepo`.
- **Handler threading (verified gap)**: `handleComboChat` accepts `cooldownScope` (`open-sse/services/combo.js:606`) but `src/sse/handlers/chat.js` never passes it, so scoped cooldown is off from the HTTP handler. Thread an appropriate scope through the three `handleComboChat` call sites (FR-043a, SC-029).
- Handle the real reproduction: outer 503 wrapping embedded upstream 429 with a daily-limit message and a ~11114s retry hint plus shorter conflicting hints. Classification must use the embedded signal, honor the longest trustworthy hint without truncation, parse untrusted hints conservatively (bounded regexes), and never cool down an unrelated member/scope. Distinguish account-level vs model-specific attribution.
- Reproduce with the real user example as a regression fixture (extend `fixtures/combo-cooldown/responses.json` and `tests/integration/combo-cooldown-reliability.mjs`).

### S3 — Model import API
- `POST /api/models/import` — discover via a guarded fetch (S0) + `normalizeDiscoveredModels`, upsert idempotently, return `{added, updated, skipped, failed}`.
- Covers built-in providers and `openai-compatible`/`anthropic-compatible` nodes; supports declared-local gateways (S0).

### S4 — Per-model overrides API (provider/model/source) + disable-audit compat
- **Single slice**: this is the only place the overrides API is created; S1 does not create it.
- `GET/POST/DELETE /api/models/overrides` writing `manual` rows into `model_context_overrides` and `model_capability_overrides` keyed by `provider`/`model_id`/`source`; deterministic ids and idempotent upsert (repeat POST updates); legacy NULL-provider rows handled safely; never overwritten by sync (S7).
- Extend `disabledModelsRepo` audit **without breaking `string[]` callers** (`src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, `src/app/api/models/disabled/route.js` verified): store audit in a parallel scope or return a `string[]` projection; keep the re-enable path (`DELETE /api/models/disabled`) (FR-025a, SC-027).

### S5 — Configurable retry intervals
- **Ordering**: S5 MUST land before S6 and S7, which consume the effective-wait policy.
- Persist a retry policy (global + per-provider) in `settingsRepo`; effective wait = `max(configured, upstream Retry-After)`; validated bounds; never bypasses access/regional restrictions.

### S6 — Batch "test all"
- `POST /api/models/test-batch` (bounded `modelIds` ≤ 100): sequential, rate-respecting; classify each result (success / hard-model-failure / quota-cost / access-restriction / rate-limited / transport-indeterminate); opt-in `autoHideFailed` disables only hard model failures via `disabledModelsRepo`; consecutive rate-limit/bot-block storm halt with `stopReason`; design-informed by OmniRoute `/api/models/test-all` (reference only).

### S7 — Optional automatic sync (must target real providers)
- Sync policy: global default (off) + per-provider inherit/enabled/disabled (`syncPolicyRepo`); applies to built-ins and compatible nodes.
- **Verified gap**: `src/lib/modelCatalog/sync.js` fetches only `https://models.dev/api.json` and diffs against the built-in registry; it does not call each provider's `/models`. S7 must add a per-provider/connection sync path (reusing the guarded fetch + discovery from S0/S3) so "enabled" providers actually sync, with models.dev remaining an optional enrichment source (FR-013a, SC-028).
- Use its own bounded `syncIntervalMs` (distinct from retry interval); preserve manual metadata; fail-open; never wipe catalog (atomic `.tmp`+rename already present).

### S8 — Scoped proxy-rotation failures + proxy fitness integration
- Record rotation failures with a scope (global/provider/account/combo/key); reject a non-global scope with no id; keep attribution as transport health (never quota/credential invalidation); preserve strict-proxy/Psiphon fail-closed.
- **Verified gap**: `pickProxyPoolId` (`src/lib/network/connectionProxy.js`) selects by round-robin/random without consulting fitness; `proxyPoolFitness.js` is imported by no production module (only `open-sse/executors/freebuff.js` calls `markPoolUnfit`). S8 must integrate fitness/rotation state (skip unfit pools, use `rotateProxyPoolIds`) into selection (FR-043b, SC-030).

### S9 — Free-proxy providers (opt-in)
- Sources: **1proxy** (`https://1proxy-api.aitradepulse.com/api/v1/proxies/advanced`), **proxifly** (`https://api.proxifly.dev/proxy`), **iplocate** (GitHub raw `iplocate/free-proxy-list`, opt-in via env in OmniRoute). Off by default; per-source enable; provenance-tagged free pool separate from operator pools; outbound-URL guard on imported proxies; explicit privacy/security disclosure; fail-closed preserved.
- **SOCKS unsupported**: KhatamRouter's proxy path uses undici `ProxyAgent` (`open-sse/utils/proxyFetch.js`, `src/lib/network/proxyTest.js`) which has no SOCKS support; `socks-proxy-agent` exists but is used only in `src/lib/mimoLoginSession.js`. HTTP/HTTPS-only in this slice; SOCKS entries are filtered/deferred.
- **MIT notices**: OmniRoute is MIT (`Copyright (c) 2026 diegosouzapw`); re-implementation only, with attribution. Do not copy code verbatim without a notice; prefer re-implementing against KhatamRouter contracts.

### S10 — Psiphon VPS evidence-gated fix (blocked until evidence)
- Collect diagnostics (tunnel lifecycle/exit logs, readiness/timing, exit-IP/region, error signatures). No root-cause claim without evidence; a fix requires a reproducible regression test; otherwise report blocked. Existing surfaces: `src/lib/network/psiphon/psiphonManager.js`, `src/lib/network/psiphon/probe.js`, `docs/PSIPHON.md`.

## Dependencies & Integration Notes

- **Spec 006** modules (`discovery.js`, `capabilities.js`, `contextReconciler.js`) are the reused core — currently unwired (S1).
- **Spec 004** failure taxonomy (`src/lib/resilience/failureClassification.js`, `open-sse/config/resilienceConfig.js`: `FAILURE_KIND`, `POLICY_FAILURE_PATTERN`) is the classification basis for S6/S8.
- **Specs 014/016** — strict-proxy/Psiphon contracts (`open-sse/utils/proxyFetch.js`, `src/lib/network/connectionProxy.js`) constrain S0/S8/S9.
- **OmniRoute** is behavioral reference only (MIT); no code/license compatibility presumed.
- Optional Redis features must remain fail-open (`src/lib/redis/client.js`).

## Performance amendment — preserve Spec 008 vertical scaling

The user explicitly requests an active Bun-native performance review of functions encountered during implementation and review, including whether replacing Node-oriented implementations with Bun APIs improves them. Do not limit this to incidental cleanup. Evaluate appropriate Bun networking, stream, file, serialization and SQLite APIs against the actual function's requirements; benchmark promising candidates and implement demonstrated improvements. Before each optimization, read Spec 008 and inspect the current runtime; measure baseline and candidate under equivalent Bun workloads and retain changes with repeatable benefit and green correctness/security checks. API availability alone is not evidence of speed or equivalent behavior; security-sensitive DNS/proxy/TLS contracts must remain intact.

- Preserve leader-only scheduled tasks, single-process fast path, cross-worker Redis/IPC invalidation, bounded caches and SQLite immediate write transactions.
- Never cache API-key authorization across requests or weaken SSRF, TLS, credential, proxy or quota boundaries for speed.
- Avoid duplicate provider polling per worker, repeated discovery normalization, redundant database lookups, unbounded fan-out and per-request agent allocation where measured improvements are feasible.
- Use targeted benchmarks for bounded leaf changes; run impacted Spec 008 hot-path or multi-worker checks for changes affecting those contracts. Do not claim noisy or unmeasured speedups.
- Deliver independently complete performance fixes in serialized PRs, reviewed by the main agent with regression tests.

## Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Mass auto-disable of healthy models | Opt-in only; disable strictly on hard model failures; classify quota/access/rate-limit/transport first (S6). |
| Override loss on refresh/sync | Manual rows are a distinct precedence layer; sync never writes `manual`; regression test for 5 cycles (S1/S4/S7). |
| SSRF via public-looking host or redirect | DNS-aware + redirect-re-validated guarded fetch on every gateway path (S0). |
| Credential leak on redirect/log | Host-scoped credentials, no cross-host forwarding, no secret logging (S0/S7). |
| Truncated/overlong `Retry-After` handling | Server-validated `parseRetryAfter`; never truncate; bounded parse of untrusted hints (S2/S5). |
| Catalog wipe on failed sync | Atomic write (existing `writeAtomic` in `src/lib/modelCatalog/sync.js`); fail-open (S7). |
| Psiphon guess-fix | Evidence gate; blocked if no evidence (S10). |

## Outcome

Phase 0/1 artifacts produced (research.md, data-model.md, contracts/, quickstart.md). Ready for `/speckit-tasks`.

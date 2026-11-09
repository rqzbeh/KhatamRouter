---
description: "Task list for Model Import, Capability Discovery & Batch Testing"
---

# Tasks: Model Import, Capability Discovery & Batch Testing

**Input**: Design documents from `specs/017-model-import-testing/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included — the spec defines independent tests and success criteria, and `quickstart.md` names the test files. Write tests first (they must fail before implementation).

**Organization**: Tasks are grouped by user story. Delivery slices (S0–S10) from `plan.md` are the independently mergeable PRs, **in this exact order**: S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Maps to spec.md user story (US1..US10)
- Exact file paths in every task

## Path Conventions

Single project: `src/`, `open-sse/`, `tests/` at repo root. Tests run from `tests/` via `bun x vitest run`.

## Dependency & Slice Correction (re-review)

`research.md` R13/R14 record the audits and their verification. Consequences:
- **S5 (retry intervals) must be delivered before S6 (batch) and S7 (sync)** because both consume the effective-wait policy. Phases are ordered accordingly.
- **S4 (overrides API) is a single slice**: the overrides route lives only in the S4 phase; S1 (runtime wiring) reads persisted overrides but does not create the API.
- **Every schema change bumps `SCHEMA_VERSION`** (`src/lib/db/schema.js`, verified `= 5` today) and is registered in `src/lib/db/migrations/index.js`.
- **Overrides use deterministic, scoped ids with legacy NULL provider safety** (verified: legacy rows have `model_pattern NOT NULL` and `provider` nullable; `contextReconciler` already uses `id = auto:${provider}:${modelId}` + `INSERT OR REPLACE`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm reused modules/guards; no new packages.

- [ ] T001 Verify reused modules exist and are importable per `research.md` R1/R2 (`grep -rn "models/discovery\|contextReconciler\|resolveModelCapabilities" src open-sse tests`) and record any drift
- [ ] T002 [P] Confirm `src/shared/utils/ssrfGuard.js` exports `assertPublicUrl`, `assertPublicUrlResolved`, `fetchPublic` (no code change if already exported)
- [ ] T003 [P] Create `tests/fixtures/gateways/` mock payloads (well-formed, mixed/malformed, private-resolving, redirect-to-internal)
- [ ] T004 [P] Create Unlazy ledger for slice S0 at `.unlazy/017-s0-gateway-safety/PLAN.md` and `.unlazy/017-s0-gateway-safety/GATES.md`

---

## Phase 2: User Story 10 — Safe custom-gateway discovery and automated sync (Priority: P1) — Slice S0

**Goal**: Every operator-supplied gateway URL passes literal + DNS + redirect-safe validation; local/self-hosted is an explicit persisted allowance valid for background work; TLS verifies by default.

**Independent of Foundational** — can be implemented and merged first.

**Independent Test**: `cd tests && bun x vitest run unit/gateway-ssrf-guard.test.js && bun x vitest run unit/gateway-local-auth-background.test.js`

### Tests for User Story 10

- [ ] T005 [P] [US10] SSRF guard test in `tests/unit/gateway-ssrf-guard.test.js`: public-looking host resolving private, literal private, redirect-to-internal, IPv4-mapped IPv6, trailing-dot localhost → all refused; 0 internal fetches (SC-019)
- [ ] T006 [P] [US10] Background local-auth test in `tests/unit/gateway-local-auth-background.test.js`: persisted `isSelfHosted` authorizes a no-request-context sync; proxied/non-local request to same URL refused (SC-020)
- [ ] T007 [P] [US10] Credential + TLS test in `tests/unit/gateway-credential-tls.test.js`: credential not forwarded across host change on redirect; verification on by default; insecure relaxation only for declared-local (SC-021, SC-024)

### Implementation for User Story 10

- [ ] T008 [US10] Replace raw `fetch(url)` in `src/app/api/providers/suggested-models/route.js` with `assertPublicUrlResolved` + `fetchPublic` (bounded `maxRedirects`)
- [ ] T009 [US10] Add URL validation to `src/app/api/provider-nodes/route.js` (POST) so an unvalidated `baseUrl` cannot be persisted (FR-061)
- [ ] T010 [US10] Add URL validation to `src/app/api/provider-nodes/[id]/route.js` (PUT) for `baseUrl` updates (FR-061)
- [ ] T011 [US10] Upgrade `src/app/api/provider-nodes/validate/route.js` from literal `assertPublicUrl` to DNS-aware `assertPublicUrlResolved`
- [ ] T012 [US10] Persist `isSelfHosted` (and optional `allowInsecureTls`) in `src/lib/db/repos/nodesRepo.js`; reject `allowInsecureTls` for non-self-hosted nodes (FR-062, FR-063a)
- [ ] T013 [US10] Implement `src/lib/network/gatewayTrust.js`: persisted `isSelfHosted` authorizes background work with no inbound request; never inheritable by proxied/non-local requests (FR-062a)
- [ ] T014 [US10] Host-scope gateway credentials (no forwarding across host change on redirect) and sanitize errors/logs in `src/app/api/provider-nodes/validate/route.js` and guarded-fetch callers (FR-063)

**Checkpoint**: Gateway URL handling SSRF/TLS/background-safe; independently testable.

---

## Phase 3: Foundational (Blocking Prerequisites for S1–S9)

**Purpose**: Shared persistence, migrations, classification, sync/retry repos, override cache.

**⚠️ CRITICAL**: Blocks S1–S9. Does NOT block S0 (Phase 2).

- [ ] T015 [P] Add `syncPolicyRepo` in `src/lib/db/repos/syncPolicyRepo.js` (kv pattern from `src/lib/db/repos/disabledModelsRepo.js`); shape `{ globalDefault, providers: { [id]: "inherit"|"enabled"|"disabled" } }`
- [ ] T016 [P] Add `retryPolicyRepo` in `src/lib/db/repos/retryPolicyRepo.js`; shape `{ globalMs, providers: { [id]: number } }` with bounded validation
- [ ] T017 Add batch classification module `open-sse/services/modelTestClassification.js` mapping to `success | hard_model_failure | quota_cost | access_restriction | rate_limited | transport_indeterminate`, reusing `src/lib/resilience/failureClassification.js` and `open-sse/config/resilienceConfig.js`
- [ ] T018 [P] Add migration `src/lib/db/migrations/005-model-capability-override-scope.js` adding `provider TEXT`, `model_id TEXT`, `source TEXT DEFAULT 'manual'` to `model_capability_overrides` (verified missing); register it in `src/lib/db/migrations/index.js` (FR-008a, FR-038a)
- [ ] T019 [P] Add migration `src/lib/db/migrations/006-combo-cooldown.js` adding nullable `cooldownMs INTEGER` to `combos`; register it in `src/lib/db/migrations/index.js`; mirror the column in `src/lib/db/schema.js` (FR-038a)
- [ ] T020 [P] Add a deterministic, unique scoped-override idempotency migration/constraint: capability overrides use `id = manual:${provider}:${modelId}` (and `auto:${provider}:${modelId}` for discovered), with a UNIQUE index over `COALESCE(provider,'')`+`COALESCE(model_id, model_pattern)`+`source` so legacy `provider IS NULL` rows are deduped safely (FR-008a)
- [ ] T021 [P] Bump `SCHEMA_VERSION` by +1 in `src/lib/db/schema.js` (verified `= 5` now; the file's own contract requires a bump for every TABLES change) and confirm `src/lib/db/migrate.js` takes the pre-change backup (FR-038a, SC-031)
- [ ] T022 [P] Extend `src/lib/db/repos/disabledModelsRepo.js` audit **without breaking `string[]` callers**: keep `getDisabledModels()` returning `string[]` (or projection); store `{ id, reason, disabledAt, batchId }` metadata in a parallel scope (FR-025a, SC-027)
- [ ] T023 Implement `src/lib/models/overrideCache.js`: synchronous in-process view of persisted overrides keyed by `(provider, modelId)`, loaded from SQLite, invalidated on write and `CONFIG_RELOAD` (FR-009b)
- [ ] T024 Wire `CONFIG_RELOAD` (payload `scope: "settings"`) invalidation consistent with `src/lib/db/repos/combosRepo.js` and `src/lib/redis/events.js`; ensure override/cache/config writes publish it
- [ ] T025 Add a migration registration/version guard test in `tests/unit/migration-registration.test.js`: every file in `src/lib/db/migrations/` is imported in `migrations/index.js`, versions unique/ascending, `SCHEMA_VERSION` bumped, fresh DB reaches expected schema (SC-031)

**Checkpoint**: Persistence, migrations (+version bump), classification, cache ready.

---

## Phase 4: User Story 2 — Best-effort capability discovery with durable manual overrides (Priority: P1) — Slice S1

**Goal**: Discovery best-effort populates context AND capabilities; the resolver is per-field and override-aware; runtime uses a synchronous cache. (The overrides **API** is S4; here overrides are read from persisted rows and seeded directly in tests.)

**Independent Test**: `cd tests && bun x vitest run unit/model-override-per-field.test.js && bun x vitest run unit/model-override-runtime-wiring.test.js`

### Tests for User Story 2

- [ ] T026 [P] [US2] Per-field resolution test in `tests/unit/model-override-per-field.test.js`: overriding only `contextWindow` leaves discovered `vision`/`tools` intact (SC-026)
- [ ] T027 [P] [US2] Runtime wiring test in `tests/unit/model-override-runtime-wiring.test.js`: a persisted `manual` override changes an actual capability/routing decision via `src/domain/requestCapabilities.js` (SC-025)
- [ ] T028 [P] [US2] Discovery/capability reconciliation test in `tests/unit/model-discovery-reconciler-wiring.test.js`: context AND capability reconciliation write `auto:discovery` without clobbering `manual`; legacy `provider IS NULL` rows are matched safely via `model_pattern` (SC-003, SC-004)
- [ ] T029 [P] [US2] Durability test in `tests/unit/model-override-durability.test.js`: manual values unchanged across 5 refresh cycles (SC-003)
- [ ] T030 [P] [US2] Cache invalidation test in `tests/unit/model-override-cache.test.js`: an override write and a `CONFIG_RELOAD` both refresh the synchronous cache (FR-009b)

### Implementation for User Story 2

- [ ] T031 [US2] Change `resolveModelCapabilities` in `src/lib/models/capabilities.js` to per-field merge across the cascade (manual → auto:discovery → provider → catalog → exact → pattern → default), recording per-field provenance (FR-009a)
- [ ] T032 [US2] Make override matching null-safe: treat legacy rows with `provider IS NULL` via `model_pattern`, and prefer scoped `(provider, model_id)` rows; deterministic ids (T020) prevent duplicates (`src/lib/models/capabilities.js` `findOverride`)
- [ ] T033 [US2] Wire `resolveCaps` in `src/domain/requestCapabilities.js` to the override-aware resolver using the synchronous `src/lib/models/overrideCache.js` view, falling back to `getCapabilitiesForModel`
- [ ] T034 [US2] Feed `getCapabilitiesForModel` (`open-sse/providers/capabilities.js`) results into the resolver as the catalog/static floor (preserve behavior with no overrides)
- [ ] T035 [US2] Implement `src/lib/models/overrideCache.js` load + invalidation (populate from `model_context_overrides`/`model_capability_overrides`, invalidate on write + `CONFIG_RELOAD`)
- [ ] T036 [US2] Create `src/lib/models/discoveryOrchestrator.js`: `normalizeDiscoveredModels` + context reconciliation + **capability reconciliation** (vision/tools/reasoning/modalities), writing `auto:discovery`, never `manual` (FR-006a)
- [ ] T037 [US2] Ensure combo capability gating in `open-sse/services/combo.js` uses the override-aware resolution via `src/domain/requestCapabilities.js`
- [ ] T038 [US2] Update client cache/UI (`src/shared/hooks/useModelCaps.js`) to reflect overrides and invalidate on override/config change (FR-009b)

**Checkpoint**: Per-field overrides + context/capability discovery affect real routing; independently testable.

---

## Phase 5: User Story 7 — Configurable combo failed-member cooldown (Priority: P1) — Slice S2

**Goal**: Configurable per-combo cooldown (1m/5m/1h), skip in round-robin, silent restore, scope isolation, nested-error handling, **combosRepo SQL mapping**, handler threading.

**Independent Test**: `cd tests && bun x vitest run unit/combo-cooldown-nested-error.test.js && bun x vitest run unit/combo-handler-cooldown-threading.test.js`

### Tests for User Story 7

- [ ] T039 [P] [US7] Nested-error regression in `tests/unit/combo-cooldown-nested-error.test.js`: outer 503 wrapping embedded 429 (daily-limit + ~11114s hint + shorter conflicting hints) — embedded-signal classification, no truncation, conservative parse (SC-014, SC-015)
- [ ] T040 [P] [US7] Cooldown semantics in `tests/unit/combo-cooldown-config.test.js`: presets 1m/5m/1h skip + silent restore + scope isolation (SC-013)
- [ ] T041 [P] [US7] Handler threading test in `tests/unit/combo-handler-cooldown-threading.test.js`: a request through `src/sse/handlers/chat.js` engages scoped cooldown (cooled member skipped) (SC-029)
- [ ] T042 [P] [US7] combosRepo mapping test in `tests/unit/combos-repo-cooldown.test.js`: `createCombo` persists `cooldownMs`, `rowToCombo` returns it, `updateCombo` updates it (FR-039)

### Implementation for User Story 7

- [ ] T043 [US7] Extend `fixtures/combo-cooldown/responses.json` with the real nested outer-503/embedded-429 shape
- [ ] T044 [US7] Map `cooldownMs` end-to-end in `src/lib/db/repos/combosRepo.js`: `rowToCombo` returns it, the `createCombo` INSERT column list/values include it, and the `updateCombo` UPDATE includes it (verified today all three omit it)
- [ ] T045 [US7] Add `cooldownMs` to combo create/edit API (`src/app/api/combos/route.js`, `src/app/api/combos/[id]/route.js`) with preset validation via `combosRepo`
- [ ] T046 [US7] Apply per-combo `cooldownMs` in `open-sse/services/combo.js` cooldown writes, preserving scope key, bounded map (`MAX_COOLDOWN_ENTRIES`), `parseRetryAfter`, and abort cleanup from commit `20a40ef8`
- [ ] T047 [US7] Implement nested outer-status/embedded-status classification in `open-sse/services/combo.js` (classify on embedded signal; honor longest trustworthy hint; conservative bounded parse)
- [ ] T048 [US7] Account-level vs model-specific attribution in `open-sse/services/combo.js`
- [ ] T049 [US7] Thread `cooldownScope` through all three `handleComboChat` call sites in `src/sse/handlers/chat.js` (lines ~263, ~295, ~375) — verified today it is never passed (FR-043a)

**Checkpoint**: Combo cooldown correct, isolated, persisted through combosRepo, engaged from the handler.

---

## Phase 6: User Story 1 — Discover and import models from any connection (Priority: P1) — Slice S3

**Goal**: One-action defensive, idempotent import for built-in providers and user OpenAI/Anthropic-compatible gateways.

**Independent Test**: `cd tests && bun x vitest run unit/model-import-api.test.js`

### Tests for User Story 1

- [ ] T050 [P] [US1] Import behavior test in `tests/unit/model-import-api.test.js`: well-formed import; malformed/mixed isolated; idempotent re-import; summary counts sum to input (SC-001, SC-002)
- [ ] T051 [P] [US1] Compatible-gateway import test in `tests/unit/model-import-compatible-node.test.js`: `openai-compatible-*` and `anthropic-compatible-*` nodes import via guarded fetch

### Implementation for User Story 1

- [ ] T052 [US1] Create `src/app/api/models/import/route.js` (POST): resolve connection/node, guarded fetch (T008/T013), `normalizeDiscoveredModels`, idempotent upsert on `(provider, connectionId, modelId)`, return `{added,updated,skipped,failed,failures,reconciled}`
- [ ] T053 [US1] Wire the import path to `src/lib/models/discoveryOrchestrator.js` (T036) so context + capability reconciliation runs, never overwriting `manual`
- [ ] T054 [US1] Enforce dashboard auth and no-secret-in-error on `src/app/api/models/import/route.js` (FR-037)

### Subsequent user amendment: authoritative pruning and real importer validation

- [ ] T094 [US1] Add `tests/unit/model-import-pruning.test.js` proving complete-snapshot removal, incomplete pagination/fallback/partial/failure no-prune, authoritative-empty safeguards, source isolation, shared-source retention, manual metadata preservation and missing combo warnings.
- [ ] T095 [US1] Implement source-scoped catalog reconciliation in `src/lib/models/discoveryOrchestrator.js` and import repository/API; expose `removed`, completeness and pruning-skipped reason. Confirmed obsolete imported models must not stay active; user-authored model entries and manual overrides remain intact.
- [ ] T096 [US1] Add opt-in live-listing smoke script under `tests/integration/` using actual discovery/import service and a disposable isolated DB; compare with verified public provider endpoints, rerun for idempotency, no production writes or paid inference. Run after importer exists and record exact source/date and limitations.

**Checkpoint**: Import works end-to-end, including obsolete-model reconciliation and actual-service validation; independently testable.

---

## Phase 7: User Story 2/3 — Per-model overrides API + disable audit (Priority: P1) — Slice S4

**Goal**: Operator-facing API to read/write/delete per-model overrides (provider/model/source, per-field provenance), and audit metadata for disables. Single slice — not part of S1.

**Independent Test**: `cd tests && bun x vitest run unit/model-overrides-api.test.js`

### Tests for User Story 2/3 (overrides API)

- [ ] T055 [P] [US2] Overrides API contract test in `tests/unit/model-overrides-api.test.js`: GET returns per-field provenance; POST writes a `manual` row keyed by provider/model/source and is idempotent (repeat POST = update, not duplicate); DELETE reverts to next layer; invalid field → 400; legacy NULL-provider row is handled safely (FR-008, FR-008a, FR-012, SC-026)

### Implementation for User Story 2/3 (overrides API)

- [ ] T056 [US2] Create `src/app/api/models/overrides/route.js` (GET/POST/DELETE) writing deterministic-id `manual` rows keyed by `provider`/`model_id`/`source`; validate fields; return per-field provenance; reject unknown fields (FR-008, FR-008a, FR-012)
- [ ] T057 [US3] Expose disable-audit read (reason/time/batchId) from the parallel scope while keeping `getDisabledModels()` a `string[]` for existing callers (FR-025, FR-025a, SC-027)

**Checkpoint**: Overrides API and disable audit complete; independently testable.

---

## Phase 8: User Story 6 — Configurable retry intervals (Priority: P2) — Slice S5

**Goal**: Global + per-provider retry interval; floor only, never shortens upstream `Retry-After`; never bypasses access/regional restrictions. **Delivered before S6/S7, which consume it.**

**Independent Test**: `cd tests && bun x vitest run unit/retry-interval-floor.test.js`

### Tests for User Story 6

- [ ] T058 [P] [US6] Retry floor test in `tests/unit/retry-interval-floor.test.js`: effective = max(configured, Retry-After); never shorter; per-provider override applies; invalid rejected; access restriction blocks retry (SC-008)

### Implementation for User Story 6

- [ ] T059 [US6] Implement effective-wait composition (`max(configuredMs, retryAfterMs)`) consuming `retryPolicyRepo` + existing `parseRetryAfter` in `open-sse/services/combo.js`/`open-sse/services/accountFallback.js`
- [ ] T060 [US6] Enforce access/regional terminal precedence (no retry) and validated bounds; expose the retry policy via `src/app/api/settings/route.js`

**Checkpoint**: Retry intervals configurable and safe; consumed by S6/S7.

---

## Phase 9: User Story 3 — Batch "test all" with safe, optional auto-disable (Priority: P1) — Slice S6

**Goal**: Per-model classification; opt-in auto-disable only on hard model failures; quota/cost flagged; conservative on transport.

**Independent Test**: `cd tests && bun x vitest run unit/model-test-batch-classification.test.js`

### Tests for User Story 3

- [ ] T061 [P] [US3] Batch classification test in `tests/unit/model-test-batch-classification.test.js`: fixture matrix; auto-disable only hard; others remain enabled (SC-005, SC-010)
- [ ] T062 [P] [US3] Storm-halt + re-enable + string[] compat test in `tests/unit/model-test-batch-storm.test.js`: consecutive threshold halts with `stopReason`; re-enable works; `getDisabledModels()` still returns `string[]` (SC-006, SC-012, SC-027)

### Implementation for User Story 3

- [ ] T063 [US3] Create `src/app/api/models/test-batch/route.js` (POST): bounded `modelIds` (≤ `batchTestMax`), sequential rate-respecting dispatch paced by the S5 retry policy, classification via `open-sse/services/modelTestClassification.js`
- [ ] T064 [US3] Implement opt-in `autoDisable` writing audit metadata through `disabledModelsRepo` only for `hard_model_failure`; never quota/access/rate-limit/transport/skipped
- [ ] T065 [US3] Implement consecutive rate-limit/bot-block storm halt with `stoppedEarly`/`stopReason`; untested models not counted as failures
- [ ] T066 [US3] Sanitize batch results/errors (no secrets); flag `quota_cost` distinctly from `rate_limited`/`transport_indeterminate` (FR-023, SC-011)
- [ ] T067 [US3] Ensure disable writes keep `src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, `src/app/api/models/disabled/route.js` reading `string[]` (FR-025a)

**Checkpoint**: Batch test safe; independently testable.

---

## Phase 10: User Story 4 — Optional automatic model sync (Priority: P2) — Slice S7

**Goal**: Off-by-default global setting + per-provider inherit/enabled/disabled; covers built-ins and compatible gateways; targets real providers; preserves manual metadata; bounded; fail-open.

**Independent Test**: `cd tests && bun x vitest run unit/model-sync-policy.test.js && bun x vitest run unit/model-sync-provider-targeting.test.js`

### Tests for User Story 4

- [ ] T068 [P] [US4] Sync policy resolution test in `tests/unit/model-sync-policy.test.js`: full SC-009 table for global × provider
- [ ] T069 [P] [US4] Provider-targeting test in `tests/unit/model-sync-provider-targeting.test.js`: an enabled provider/connection without a models.dev entry still syncs its advertised listing (SC-028)
- [ ] T070 [P] [US4] Sync-preserves-overrides test in `tests/unit/model-sync-preserves-overrides.test.js`: manual overrides/metadata preserved; failed/partial sync leaves catalog intact (SC-022)

### Implementation for User Story 4

- [ ] T071 [US4] Create `src/app/api/models/sync-policy/route.js` (GET/PUT) over `syncPolicyRepo` with strict enum validation and unknown-id rejection
- [ ] T072 [US4] Add a per-provider/connection sync path (reusing guarded fetch + `discoveryOrchestrator`) so "enabled" providers sync their **actual** advertised models; `models.dev` remains optional enrichment (FR-013a, SC-028) — verified today `src/lib/modelCatalog/sync.js` only fetches models.dev
- [ ] T073 [US4] Gate the scheduler in `src/lib/modelCatalog/sync.js` by the resolved policy; use its own bounded `syncIntervalMs` (distinct from retry interval); skip providers resolving to "no sync"; pace via S5 policy
- [ ] T074 [US4] Ensure sync in `src/lib/modelCatalog/sync.js` preserves `manual` rows and metadata; atomic `.tmp`+rename integrity retained; never wipes catalog (FR-016, FR-017)

**Checkpoint**: Optional sync works and targets real providers; independently testable.

---

## Phase 11: User Story 5 — Scoped proxy rotation failures + proxy fitness (Priority: P2) — Slice S8

**Goal**: Rotation failures attributed to exactly one scope; no cross-scope bleed; transport-health classification; proxy selection integrates fitness; fail-closed preserved.

**Independent Test**: `cd tests && bun x vitest run unit/proxy-rotation-scope.test.js && bun x vitest run unit/proxy-pool-fitness-selection.test.js`

### Tests for User Story 5

- [ ] T075 [P] [US5] Scoped rotation test in `tests/unit/proxy-rotation-scope.test.js`: failure in one scope changes 0 others; non-global without id rejected; classified transport not quota (SC-007)
- [ ] T076 [P] [US5] Proxy fitness selection test in `tests/unit/proxy-pool-fitness-selection.test.js`: an unfit pool is not chosen ahead of a fit one (SC-030)

### Implementation for User Story 5

- [ ] T077 [US5] Generalize `open-sse/services/proxyPoolFitness.js` scope to the 5 scopes (`global|provider|account|combo|key`) with `scopeId` required for non-global
- [ ] T078 [US5] Record rotation failures as transport health only (never quota/credential invalidation); no credential cycling; preserve strict-proxy/Psiphon fail-closed in `src/lib/network/connectionProxy.js`
- [ ] T079 [US5] Integrate fitness/rotation into `pickProxyPoolId` in `src/lib/network/connectionProxy.js` (skip unfit; use `rotateProxyPoolIds`), fixing the verified gap that no production module imports `proxyPoolFitness.js` (FR-043b)

**Checkpoint**: Scoped rotation and fitness-aware selection correct; independently testable.

---

## Phase 12: User Story 8 — Free proxy providers as opt-in free proxy pools (Priority: P3) — Slice S9

**Goal**: Opt-in 1proxy/proxifly/iplocate sources → provenance-tagged free pools; HTTP/HTTPS only; guarded; disclosed; fail-closed.

**Independent Test**: `cd tests && bun x vitest run unit/free-proxy-sources.test.js`

### Tests for User Story 8

- [ ] T080 [P] [US8] Free-proxy sources test in `tests/unit/free-proxy-sources.test.js`: all off by default (0 outbound/0 pools); enable imports with provenance; unsafe hosts rejected; SOCKS filtered; disclosure present (SC-016, SC-017)

### Implementation for User Story 8

- [ ] T081 [P] [US8] Implement source adapters in `src/lib/freeProxyProviders/` (1proxy, proxifly, iplocate) — HTTP/HTTPS only, filter `socks4/socks5`
- [ ] T082 [US8] Create `src/app/api/settings/free-proxies/route.js` (GET/PUT) and `src/app/api/settings/free-proxies/sync/route.js` (POST) with per-source enable and provenance-tagged free pool (`proxyPools.data.source = "free:<id>"`)
- [ ] T083 [US8] Validate imported hosts via `src/shared/utils/ssrfGuard.js`; reject private/loopback/link-local/metadata; keep existing entries on partial failure
- [ ] T084 [US8] Add the privacy/security disclosure to the dashboard and confirm strict-proxy/Psiphon fail-closed for free pools
- [ ] T085 [US8] Add MIT attribution/notice for re-implemented OmniRoute free-proxy behavior in `docs/` or the module header

**Checkpoint**: Opt-in free proxies safe and independently testable.

---

## Phase 13: User Story 9 — Evidence-based Psiphon VPS diagnosis and fix (Priority: P3) — Slice S10 (BLOCKED until evidence)

**Goal**: Collect VPS diagnostics; fix only if evidence supports a cause; otherwise report blocked.

- [ ] T086 [US9] Collect and record VPS diagnostics (tunnel lifecycle/exit logs, readiness/timing, exit-IP/region, error signatures) as an evidence artifact in `specs/017-model-import-testing/research.md` (append) or a linked file
- [ ] T087 [US9] If evidence identifies a reproducible cause: implement the fix in `src/lib/network/psiphon/psiphonManager.js` (or `probe.js`) and add a failing-then-passing regression test in `tests/unit/` (SC-018)
- [ ] T088 [US9] If evidence is insufficient: record blocked status with gathered evidence in `specs/017-model-import-testing/research.md`; do NOT ship a speculative fix

---

## Phase 14: Polish & Cross-Cutting Concerns

- [ ] T089 [P] Update `docs/ARCHITECTURE.md` and `CHANGELOG.md` for model import/override/sync/cooldown/free-proxy surfaces
- [ ] T090 [P] End-to-end run of `specs/017-model-import-testing/quickstart.md` scenarios 1–9
- [ ] T091 [P] Run baseline snapshots (`tests/__baseline__/verify-*.mjs`) after touching provider registry/alias logic (verify no drift)
- [ ] T092 [P] Confirm security posture in `tests/unit/`: SSRF fixtures (SC-019), TLS default-on (SC-024), credential non-leak (SC-021, SC-011)
- [ ] T093 Ensure each slice's Unlazy ledger (`.unlazy/017-*/GATES.md`) passes `gate-lint.mjs` before execution and `gate-check.mjs` (exit 0 + `EXPECT:` match) before completion is reported

---

## Dependencies & Execution Order

### Phase Dependencies (delivery order)

- **Setup (Phase 1)**: none
- **S0 / US10 (Phase 2)**: Setup only — independent of Foundational; may merge first
- **Foundational (Phase 3)**: after Setup; blocks S1–S9 (not S0)
- **S1 / US2 (Phase 4)**: Foundational (T018, T020, T021, T023/T024)
- **S2 / US7 (Phase 5)**: Foundational (T019, and T044 combosRepo mapping)
- **S3 / US1 (Phase 6)**: S0 + S1
- **S4 / overrides API (Phase 7)**: S1 (reads/writes the same rows)
- **S5 / US6 (Phase 8)**: Foundational (T016) — **must precede S6 and S7**
- **S6 / US3 (Phase 9)**: S0 + S3 + **S5**
- **S7 / US4 (Phase 10)**: S0 + S1 + S3 + **S5**
- **S8 / US5 (Phase 11)**: **S5**
- **S9 / US8 (Phase 12)**: S0
- **S10 / US9 (Phase 13)**: blocked until evidence
- **Polish (Phase 14)**: after desired stories

### Critical ordering corrections

- S5 is **before** S6 and S7 in both slice list and phases (they consume the effective-wait policy).
- The overrides API appears **only** in S4 (Phase 7); S1 (Phase 4) does not create it.
- combosRepo mapping (T044) is part of S2, not left implicit.
- Schema changes bump `SCHEMA_VERSION` (T021) and register migrations (T018/T019).

### Parallel Opportunities

- Setup: T002–T004 parallel.
- S0 tests T005–T007 parallel.
- Foundational: T015, T016, T018, T019, T020, T021, T022 parallel; T017/T023/T024/T025 independent.
- US2 tests T026–T030 parallel; overrides API test T055 independent.
- US7 tests T039–T042 parallel.
- Different stories on disjoint files can proceed in parallel once their prerequisites land.

---

## Parallel Example: Foundational

```bash
Task: "syncPolicyRepo in src/lib/db/repos/syncPolicyRepo.js"
Task: "retryPolicyRepo in src/lib/db/repos/retryPolicyRepo.js"
Task: "migration 005 model_capability_overrides scope columns + register"
Task: "migration 006 combos cooldownMs + register"
Task: "deterministic scoped-override id + UNIQUE index (legacy NULL-safe)"
Task: "bump SCHEMA_VERSION in src/lib/db/schema.js"
```

## Parallel Example: User Story 7 (S2)

```bash
Task: "Nested-error regression in tests/unit/combo-cooldown-nested-error.test.js"
Task: "Cooldown semantics in tests/unit/combo-cooldown-config.test.js"
Task: "Handler threading test in tests/unit/combo-handler-cooldown-threading.test.js"
Task: "combosRepo mapping test in tests/unit/combos-repo-cooldown.test.js"
```

---

## Implementation Strategy

### MVP First

1. Setup.
2. S0 (Phase 2) — security, independent, merge first.
3. Foundational (Phase 3).
4. S1 (US2) + S2 (US7) — P1 correctness.
5. S3 (US1) — import (first operator value).
6. **STOP and VALIDATE**: quickstart scenarios 1–4.

### Incremental Delivery (slice order)

S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 (blocked). Each slice is one mergeable PR with its own Unlazy ledger.

### Notes

- [P] = different files, no dependencies.
- Keep security tasks (SSRF/TLS/credentials) ahead of the feature that consumes them.
- No code in this plan phase; implementation begins only after approval.

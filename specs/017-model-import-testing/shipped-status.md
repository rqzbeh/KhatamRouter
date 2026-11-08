# Spec 017: Model Import & Catalog Reconcile — Shipped Status & Evidence Reconciliation

**Feature**: `017-model-import-testing`
**Slice**: Evidence Reconciliation & Scope Accounting
**Date**: 2026-11-09
**Verification Baseline**: Origin/master (`e1fb2594`, PR #150 merged, CI Verify passing), plus follow-up PR #151
**Status**: Partial Delivery / Foundation, Resolver, Batch Testing, Sync Scheduler, Runtime Overrides Cache, Listing Completeness, and Provider Detail UI Shipped (Feature In-Progress; Root Capabilities Partitioned Below)

---

## 1. Executive Summary

This document records the verified status of master merges spanning model import, schema translation, model picker UI, capability overrides, combo member cooldowns, proxy health policy, and dependencies.

- Merged PRs represent foundational milestones and correctness fixes; they do not complete Spec 017.
- Every claim cites source files and verified symbols on master.
- Shipped components vs pending capabilities are partitioned explicitly below.
- Psiphon proxy pool, OpenCode quota, and rotation policies remain user-frozen and untouched.

---

## 2. Merged PR Ledger & Symbol Evidence

| PR | Squash Commit | Scope & Headline | Verified Source Symbols | Key Test Suites |
|---|---|---|---|---|
| **#127** | `f3e6b53e` | `deps: bump @aws-sdk/credential-providers from 3.1159.0 to 3.1161.0` | `package.json`, `bun.lock` | `tests/unit/aws-credentials.test.js` (27 passed) |
| **#128** | `cdf51906` | `deps: bump ora from 9.4.1 to 10.0.0` | `package.json`, `bun.lock` | CLI packaging & runtime |
| **#129** | `8b20278e` | `deps: bump eslint from 9.39.5 to 10.14.0` | `package.json`, `bun.lock`, `eslint.config.mjs` | ESLint verification |
| **#137** | `d3809bb6` | `fix(proxy): require explicit egress attribution for 403 cooldowns` | `classifyProxyFailure`, `kindFor` in `src/lib/network/proxyHealthPolicy.js` | `tests/unit/proxy-403-attribution.test.js`, `tests/unit/proxy-health-policy.test.js` |
| **#138** | `50936d86` | `fix(translator): distinguish schema nodes from property dictionaries` | `cleanJSONSchemaForAntigravity`, `forEachChildSchema`, `SCHEMA_DICTIONARIES` in `open-sse/translator/formats/gemini.js` | `tests/unit/gemini-schema-property-map.test.js`, `tests/unit/gemini-parent-property-map.test.js` |
| **#139** | `bfe89ea4` | `fix(models): include live catalogs in passthrough model selection` | `groupModelsByProvider`, `useLiveProviderModels` in `src/shared/components/ModelSelectModal.js` | `tests/unit/model-select-zed-live-regression.test.js` |
| **#140** | `51dc5aa8` | `fix(models): prune imported models only from proven complete snapshots` | `importProviderModels` in `src/lib/models/importOrchestrator.js`, `reconcileCatalog` in `src/lib/models/catalogReconcile.js` | `tests/unit/import-route-completeness.test.js`, `tests/unit/catalog-parent-snapshot-safety.test.js`, `tests/unit/import-parent-malformed-page.test.js`, `tests/unit/import-parent-shared-source.test.js` |
| **#141** | `2e751abf` | `fix(models): merge capability overrides per field and specificity` | `resolveModelCapabilities` in `src/lib/models/capabilities.js` | `tests/unit/capability-per-field.test.js`, `tests/unit/capability-parent-per-field.test.js` |
| **#142** | `d77cbfe3` | `feat(combo): configure scoped member failure cooldown and recovery` | `MEMBER_COOLDOWN_PRESETS_MS`, `normalizeMemberCooldownMs` in `open-sse/config/comboCooldown.js` | `tests/unit/combo-configurable-cooldown.test.js`, `tests/unit/combo-parent-rollback-safety.test.js`, `tests/unit/combo-parent-scope-safety.test.js` |
| **#143** | `f5701871` | `deps(psiphon): pin regionhop v1.27.0 in one manifest with hash verification` | `regionhopRelease.json`, `downloader.js`, `regions.js` in `src/lib/network/psiphon/` | `tests/unit/regionhop-release-pin.test.js` |
| **#145** | `9c1cf4ed` | `feat(models): bounded test-all batch with opt-in safe auto-disable` | `runModelTestBatch`, `classifyModelTestResult`, `MODEL_TEST_CLASSIFICATION` in `src/lib/models/modelTestBatch.js`, `POST /api/models/test-batch` | `tests/unit/model-test-batch-route.test.js`, `tests/unit/model-test-batch-classification.test.js` |
| **#146** | `dbbc2705` | `feat(models): automatic model sync with global and per-provider policy` | `createProviderSyncScheduler`, `startModelSyncScheduler` in `src/lib/models/providerSync.js`, `src/lib/models/providerSyncRuntime.js`, `GET/PUT /api/models/sync-policy` | `tests/unit/provider-sync-scheduler.test.js`, `tests/unit/provider-sync-policy-api.test.js` |
| **#147** | `b0676cfb` | `feat(models): apply capability overrides at runtime with editing API` | `initializeOverrideCache`, `getOverrideSourcesSync`, `MAX_SNAPSHOT_ROWS` in `src/lib/models/overrideCache.js`, `GET/POST/PUT/DELETE /api/models/overrides` | `tests/unit/model-override-cache.test.js`, `tests/unit/model-overrides-api.test.js` |
| **#148** | `bb05dbb0` | `feat(proxy): opt-in OmniRoute free proxy sources with strict guards` | `FREE_PROXY_FEED_URLS`, `runFreeProxySync` in `src/lib/freeProxyProviders/index.js`, `FreeProxySourcesCard` in `src/shared/components/FreeProxySourcesCard.js` (standalone component, not wired) | `tests/unit/free-proxy-api.test.js`, `tests/unit/free-proxy-sources.test.js` |
| **#149** | `3cdbd654` | `feat(models): built-in provider listing completeness and proxy-aware discovery` | `evaluateOpenAIListing`, `mapCloudflareModelRow`, `validateProxySupport` in `src/lib/models/listingCompleteness.js`, `proxyAwareFetch` in `/api/providers/[id]/models/route.js` | `tests/unit/listing-completeness.test.js`, `tests/unit/provider-models-route.test.js` |
| **#150** | `e1fb2594` | `feat(dashboard): provider model import, test-all, auto-sync and override UI` | `ModelManagementPanel` in `src/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js`, `ModelOverrideModal` in `ModelOverrideModal.js` | `tests/unit/model-management-ui.test.js` |

Prior foundational PRs merged under Spec 017:
- **#130**: `fix(combo): skip transient delay for wrapped quota failures` (`isQuotaShapedTransientError` in `open-sse/services/combo.js`)
- **#133** (`83ac62eb`): `fix(gateway): SSRF, TLS and egress hardening for custom gateway discovery` (`src/app/api/providers/[id]/models/route.js`)
- **#134** (`142190b8`): `feat(db): model metadata persistence for the shared import engine` (`src/lib/db/repos/modelMetadataRepo.js`, migration `src/lib/db/migrations/005-model-metadata.js`)
- **#135** (`f5c55511`): `feat(models): model import that adds, updates and removes models` (`src/lib/models/catalogReconcile.js`)
- **#136** (`0094e076`): `feat(proxy): remove failing proxy pools from rotation for a configurable cooldown` (`src/lib/network/proxyHealthPolicy.js`)

---

## 3. Shipped Narrow Scope Detail

### 3.1 Cross-Provider Schema Mapwalk (PR #138, commit `50936d86`)
- **Mechanism**: Separates schema nodes from property dictionaries (`properties`, `$defs`, `definitions`, `patternProperties`, `dependentSchemas`) and schema arrays (`anyOf`, `oneOf`, `allOf`, `prefixItems`) via `forEachChildSchema`.
- **Keywords Preserved**: Transforms and keyword sanitization run solely on schema nodes. Dictionaries are traversed for values without filtering keys, preserving tool parameters named `items`, `type`, `properties`, `const`, or standard JSON schema keywords.
- **Provider Coverage**: Protects Gemini API, Gemini CLI, Antigravity translator/executor, and Vertex AI.

### 3.2 Picker Live Passthrough & Error States (PR #139, commit `bfe89ea4`)
- **Mechanism**: In `src/shared/components/ModelSelectModal.js`, `groupModelsByProvider` and `useLiveProviderModels` unify catalog selection between standard and passthrough branches (Zed, Cline, Cursor, custom gateways).
- **Resilient Account States**: Connected accounts remain visible in the picker during loading, error, and empty states using non-selectable status badges.
- **Fetch Hygiene**: Abort controllers cancel in-flight requests on modal close or unmount, preventing stale catalog overwrite on rapid reopen. Partial successes across multi-account setups remain usable.

### 3.3 Importer Complete-Validated Gateway Pruning & Shared Source Protection (PR #140, commit `51dc5aa8`)
- **Mechanism**: In `src/lib/models/importOrchestrator.js` (`importProviderModels`) and `src/lib/models/catalogReconcile.js` (`reconcileCatalog`), gateway listings require adapter-proven completeness before pruning obsolete models:
  - OpenAI-compatible gateways: completeness requires the absence of unread pagination indicators (`complete: true`).
  - Anthropic-compatible gateways: completeness requires validated, bounded cursor traversal chains.
- **Pruning Guards**:
  - Malformed or invalid records fail closed to add/update-only mode; pruning is refused.
  - Multi-connection safety: models still advertised by another active connection (`shared_across_connections`) are protected from deletion.
  - False capability updates: explicit `false` capabilities are persisted without inferring `false` from missing/unknown fields.
  - Paged override reads: prevents silent query truncation when reading manual overrides.

### 3.4 Per-Field Capability Override Resolution (PR #141, commit `2e751abf`)
- **Mechanism**: In `src/lib/models/capabilities.js`, `resolveModelCapabilities` merges capability overrides per field rather than all-or-nothing. A more-specific manual row overriding one field (e.g. tools) preserves lower-layer vision, context, and output limits from the discovery or registry layer.
- **Provenance & Precedence**: Tracks field-level provenance across the seven precedence layers, supports vendor-namespace lookup priority, and ensures explicit false values from authoritative layers cannot be overridden by heuristic name matches.
- **Scope Note**: PR #141 corrected the pure resolver; runtime cache/API wiring followed in PR #147 and the editor in PR #150.

### 3.5 Configurable Combo Member Cooldowns (PR #142, commit `d77cbfe3`)
- **Mechanism**: In `open-sse/config/comboCooldown.js` and `open-sse/services/combo.js`, supports configuring combo member failure cooldowns via `settings.comboStrategies[comboName].memberCooldownMs`.
- **Validation & Presets**: Preset choices: `"1m"` (60s), `"5m"` (300s), `"1h"` (3600s), or custom duration (10s to 24h) via `normalizeMemberCooldownMs`. Evaluates to `null` for unconfigured/default (`429`: 90s, `5xx`: 45s).
- **Caller Scoping & Upstream Retry-After**: Cooldowns are scoped per combo caller, honoring upstream `Retry-After` floors while excluding request-scoped policy failures. Failed settings saves trigger truthful compensating rollback reporting.
- **Schema Decision**: Formally supersedes T019 (no `006` schema migration needed); persisted in the existing settings key-value store.

### 3.6 Explicit Proxy Egress Attribution on 403 (PR #137, commit `d3809bb6`)
- **Mechanism**: In `src/lib/network/proxyHealthPolicy.js`, `classifyProxyFailure` (via `kindFor`) requires explicit source-IP or region denial tokens (e.g. `ip blocked`, `region not supported`) or proxy `CONNECT` failures before attributing an HTTP 403 to the outbound proxy pool.
- **Preserved Behavior**: 429 rate limits, 451 legal blocks, and 502/503/504 transport errors continue their standard proxy cooldown behavior; only HTTP 403 classification is narrowed to prevent false positives on permission, account, or billing errors.

### 3.7 Bounded Model Test-All Batch & Safe Auto-Disable (PR #145, commit `9c1cf4ed`)
- **Mechanism**: In `src/lib/models/modelTestBatch.js` and `src/app/api/models/test-batch/route.js`, executes sequential, bounded, and abortable model ping tests (`runModelTestBatch`) using provider aggregate probes rather than connection-pinned routes.
- **Strict Error Taxonomy**: `classifyModelTestResult` returns `success`, `hard_model_failure`, `quota_cost`, `rate_limited`, `access_restriction`, or `transport_indeterminate`.
- **Safe Auto-Disable**: Only explicit model-specific absence on HTTP 400/404/410 is eligible, excluding ambiguous access denials, schema validation and policy refusals. Disabling also requires `autoDisable: true`; quota, auth, access and transport failures never disable a model.
- **Reversibility & Audit**: Active disabled IDs and audit history use separate SQLite `kv` scopes (`disabledModels` and `disabledModelAudit`). `enableModels` restores availability and stamps the retained audit history.

### 3.8 Automatic Model Synchronization Policy & Runtime (PR #146, commit `dbbc2705`)
- **Mechanism**: In `src/lib/models/providerSync.js` and `src/lib/models/providerSyncRuntime.js`, provides a background sync scheduler (`createProviderSyncScheduler`, `startModelSyncScheduler`) running bounded, abortable import cycles across configured providers.
- **Leader-Only Execution**: Synchronization runs in the cluster leader (`KHATAM_WORKER_ROLE === "leader"`) or single-process mode when the role is unset; followers skip the timer.
- **Policy Storage & Bounds**: Global and per-provider enable/disable/inherit policy plus a shared interval (1 hour to 7 days, default 24 hours) are persisted in the SQLite `kv` table under scope `modelSyncPolicy` and key `policy`.
- **Worker Cache Coherence**: On completed runs, triggers post-commit `config_reload` events across cluster workers.

### 3.9 Runtime Capability & Context Overrides Cache & API (PR #147, commit `b0676cfb`)
- **Mechanism**: In `src/lib/models/overrideCache.js` and `src/app/api/models/overrides/route.js`, provides fast synchronous in-memory override resolution (`getOverrideSourcesSync`) feeding per-field capability resolution directly into request routing (`src/sse/handlers/chat.js`) and model listings (`/api/models`).
- **Cache Bounds & Safety**: Enforces a 50,000-row snapshot ceiling (`MAX_SNAPSHOT_ROWS = 50000`) with a 5-second TTL (`MAX_CACHE_TTL_MS = 5000`). Breaches fail closed, retaining previous valid snapshots. Row metadata always wins over untrusted body JSON keys.
- **API Surface**: Full REST endpoints (`GET`, `POST`, `PUT`, `DELETE` at `/api/models/overrides`) with strict provider/model canonicalization and immediate synchronous local invalidation plus Redis Pub/Sub cluster broadcast.

### 3.10 Opt-In Free Proxy Feeds with Strict Security Bounds (PR #148, commit `bb05dbb0`)
- **Mechanism**: `src/lib/freeProxyProviders/index.js` and `src/app/api/settings/free-proxies/route.js` import public, untrusted proxy records from explicitly allowlisted source feeds (oneproxy, proxifly, iplocate). Sources default off and enabling requires durable `acknowledgedRisk: true`; MIT attribution identifies the reference implementation, not a trust guarantee for proxy operators.
- **Strict Security Bounds**: Enforces a 2 MiB streaming download cap (`MAX_FEED_BYTES`), SSRF and private/loopback IP filtering (`validateCandidateProxy`), concurrency lease acquisition (`acquireFreeProxySyncLease`), single-write provenance, and creates pools in an inactive state by default.
- **UI Surface Status**: `FreeProxySourcesCard` is mounted on `/dashboard/proxy-pools` by PR #151. Mount reads policy only; a sync runs on explicit button click.

### 3.11 Built-In Provider Listing Completeness & Discovery (PR #149, commit `3cdbd654`)
- **Mechanism**: In `src/lib/models/listingCompleteness.js` and `src/app/api/providers/[id]/models/route.js`, validates pagination signals and structural completeness across OpenAI-compatible, NVIDIA, Gemini, Anthropic, and Cloudflare gateways.
- **Completeness Guards**: Evaluates OpenAI pagination signals (`evaluateOpenAIListing`), Anthropic cursor chains, Cloudflare account IDs and mapping (`mapCloudflareModelRow`), and Antigravity complete markers (`validateAntigravityComplete`) before allowing catalog pruning.
- **Proxy-Aware Discovery**: Routes discovery requests through `proxyAwareFetch` with fail-closed 503 behavior when a configured proxy cannot be honored.

### 3.12 Provider Detail Model Management & Overrides UI (PR #150, commit `e1fb2594`)
- **Mechanism**: Mounts `ModelManagementPanel` and `ModelOverrideModal` on `/dashboard/providers/[id]/page.js` against the merged import, test-batch, sync-policy, and override endpoints.
- **Interactive Controls**: Supports single-provider import, bounded batch testing with progress reporting, global/per-provider auto-sync scheduling, and modal-based capability override editing directly in the dashboard.
- **Known Follow-Ups**: Summary taxonomy alignment in `ModelManagementPanel.js:152-158` (legacy class names causing success/quota to display broken) and fresh-install test harness isolation are tracked and assigned to separate workers.

---

## 4. Pending Root Capabilities (Explicitly NOT Complete)

While foundational import, batch testing, sync scheduling, runtime override caching, listing completeness, and provider detail UI have shipped, the following capabilities remain confirmed undelivered:

1. **Importer enrichment**: Import and provider-sync callers do not pass the available `models.dev` metadata into `importProviderModels`; the separate legacy catalog sync is not evidence this integration is complete.
2. **Generated shipped defaults**: Regenerate NVIDIA NIM and Cloudflare defaults through the shared importer rather than hand-editing model entries. Preserve unknown capabilities instead of inventing heuristics.
3. **Live-listing validation**: Run an opt-in smoke script against real provider listings with a disposable isolated database, proving reconciliation and idempotency without production writes or paid inference. This is not an automatic startup job.
4. **Background proxy probes**: Probe settings and `nextProbeDelayMs` exist, but no background execution or dashboard probe controls are wired.
5. **Retry policy and scope coverage**: Global/per-provider request retry settings and the planned global/provider/account/combo/key proxy-fitness scope contract remain incomplete.

Fixed after this baseline by PR #151: test-batch summary counts, advanced capability flags (image generation/editing, web search/fetch) in the resolver and `/api/models`, `FreeProxySourcesCard` mounted on `/dashboard/proxy-pools`, single-React UI tests, and a CI step for the Spec 017 suites.

The per-provider Import button is shipped. A simultaneous cross-provider sweep is not treated as a substitute for the requested availability across provider types. Combo fallback preserves the original outer status and Retry-After; the narrow wrapped-quota improvement is not a claim of general nested-error normalization.

---

## 5. Architectural Resolutions & Task Mapping

| Spec 017 Task Area | Original Spec Requirement (`tasks.md`) | Current Implementation Status | Parent Architectural Resolution |
|---|---|---|---|
| **DB Migration 005** | T018: Add `005-model-capability-override-scope.js` | Merged as `005-model-metadata.js` (commit `142190b8`, PR #134), which adds `provider`, `model_id`, `source` to `model_capability_overrides` and creates table `imported_models`. | Formally mapped to `005-model-metadata.js`. |
| **Combo Cooldown Persistence** | T019: Add `006-combo-cooldown.js` adding nullable column `cooldownMs INTEGER` to `combos` table | Merged via PR #142 (`d77cbfe3`) using `settings.comboStrategies[comboName].memberCooldownMs`. | **Formally resolved & superseded**: Stored in settings key-value map, avoiding database schema migration lock contention. |
| **Wrapped Quota Fallback & Member Cooldown** | T039–T049 (User Story 7 / S2) | PR #130 (`isQuotaShapedTransientError`) skips the short transient delay; PR #142 (`d77cbfe3`) adds configurable cooldowns and caller scoping. | Outer HTTP status and Retry-After remain intact; this does not establish every nested-error attribution requirement. |
| **Sync Policy Backend** | T015 (`syncPolicyRepo.js`) | Shipped in PR #146 (`dbbc2705`) via `src/lib/models/providerSync.js`, SQLite `kv` scope `modelSyncPolicy`. | Equivalent persistence is implemented in the provider-sync service; no separate policy table is needed. |
| **Retry Policy Backend** | T016 (`retryPolicyRepo.js`) | Pending implementation. | Kept distinct from sync policy; handles request retry policy separately. |
| **Override Resolver & Cache** | T023 (`overrideCache.js`) | Shipped in PR #141 (resolver in `capabilities.js`) and PR #147 (`overrideCache.js`, `/api/models/overrides`). | Fully shipped with 50,000-row bounds, 5-second TTL, and cluster Pub/Sub coherence. |
| **Provider Detail UI** | T035–T038 (UI controls) | Shipped in PR #150 (`ModelManagementPanel.js`, `ModelOverrideModal.js`). | Shipped on provider detail page; follow-up taxonomy alignment tracked. |

---

## 6. Frozen Scope & Exclusions

- **Psiphon Proxy Pool & OpenCode Quota/Rotation**:
  - User-frozen. Strictly isolated; rotation cooldowns, session invalidation, and tunnel configurations remain unchanged as of the 2026-11-08 baseline.
- **Regionhop Release Pin & Update PR**:
  - Shipped via PR #143 (`f5701871`) with hash verification, weekly bump PR workflow, Docker ARGs, and BR exit region.
- **`CHANGELOG.md`**:
  - Reconciled with concise entries for PRs #143 and #145–#150 without duplication.

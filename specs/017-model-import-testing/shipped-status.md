# Spec 017: Model Import & Catalog Reconcile — Shipped Status & Evidence Reconciliation

**Feature**: `017-model-import-testing`  
**Slice**: Evidence Reconciliation & Scope Accounting  
**Date**: 2026-11-08  
**Verification Baseline**: Origin/master (`d77cbfe3`, PR #142 merged, CI Verify passing)  
**Status**: Partial Delivery / Foundation, Resolver, Gateway Pruning & Combo Cooldown Shipped (Feature In-Progress; Root Capabilities Pending)

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
- **Scope Note**: Pure resolver correction; runtime cache, API, and UI editor wiring remain pending follow-up slices.

### 3.5 Configurable Combo Member Cooldowns (PR #142, commit `d77cbfe3`)
- **Mechanism**: In `open-sse/config/comboCooldown.js` and `open-sse/services/combo.js`, supports configuring combo member failure cooldowns via `settings.comboStrategies[comboName].memberCooldownMs`.
- **Validation & Presets**: Preset choices: `"1m"` (60s), `"5m"` (300s), `"1h"` (3600s), or custom duration (10s to 24h) via `normalizeMemberCooldownMs`. Evaluates to `null` for unconfigured/default (`429`: 90s, `5xx`: 45s).
- **Caller Scoping & Upstream Retry-After**: Cooldowns are scoped per combo caller, honoring upstream `Retry-After` floors while excluding request-scoped policy failures. Failed settings saves trigger truthful compensating rollback reporting.
- **Schema Decision**: Formally supersedes T019 (no `006` schema migration needed); persisted in the existing settings key-value store.

### 3.6 Explicit Proxy Egress Attribution on 403 (PR #137, commit `d3809bb6`)
- **Mechanism**: In `src/lib/network/proxyHealthPolicy.js`, `classifyProxyFailure` (via `kindFor`) requires explicit source-IP or region denial tokens (e.g. `ip blocked`, `region not supported`) or proxy `CONNECT` failures before attributing an HTTP 403 to the outbound proxy pool.
- **Preserved Behavior**: 429 rate limits, 451 legal blocks, and 502/503/504 transport errors continue their standard proxy cooldown behavior; only HTTP 403 classification is narrowed to prevent false positives on permission, account, or billing errors.

---

## 4. Pending Root Capabilities (Explicitly NOT Complete)

The following root capabilities from Spec 017 and adjacent roadmap initiatives remain in-progress or planned:

1. **Runtime Overrides Integration**:
   - Applying `model_context_overrides` and `model_capability_overrides` dynamically during request translation and combo dispatch.
   - UI controls for editing and resetting capability overrides per provider/model.
2. **Batch Testing Engine**:
   - Explicit sequential bounded probes (not concurrent probes) across imported models.
   - Live latency, context-window boundary, and modality verification.
3. **Global & Per-Provider Synchronization**:
   - Background interval synchronization orchestrator for connected providers via approved `providerSync` module with KV policy.
   - Webhook or event-driven catalog refresh.
4. **"Import All Providers" Action**:
   - Control-plane action/button available across all provider types.
5. **models.dev Community Metadata Enrichment**:
   - Ingesting community model capabilities, limits, and context boundaries from models.dev into local SQLite metadata tables.
6. **Free Proxy Ingestion (Vetted Sources)**:
   - Opted-in explicit ingestion from vetted OmniRoute sources (not broad web scraping).
7. **Background Probing Service**:
   - Periodic non-intrusive health, egress IP, and latency probing for proxy pools and provider endpoints.
8. **Bun Performance Optimization**:
   - Spec 008 VERTICAL scaling preserved (single host, multi-core cluster supervisor); narrow benchmark-validated rare-overflow SHA path (2.6x raw / 33% full), not broad request speed claims, and no horizontal IPC scaling.

---

## 5. Architectural Resolutions & Task Mapping

| Spec 017 Task Area | Original Spec Requirement (`tasks.md`) | Current Implementation Status | Parent Architectural Resolution |
|---|---|---|---|
| **DB Migration 005** | T018: Add `005-model-capability-override-scope.js` | Merged as `005-model-metadata.js` (commit `142190b8`, PR #134), which adds `provider`, `model_id`, `source` to `model_capability_overrides` and creates table `imported_models`. | Formally mapped to `005-model-metadata.js`. |
| **Combo Cooldown Persistence** | T019: Add `006-combo-cooldown.js` adding nullable column `cooldownMs INTEGER` to `combos` table | Merged via PR #142 (`d77cbfe3`) using `settings.comboStrategies[comboName].memberCooldownMs`. | **Formally resolved & superseded**: Stored in settings key-value map, avoiding database schema migration lock contention. |
| **Combo Quota Bypass & Member Cooldown** | T039–T049 (User Story 7 / S2) | PR #130 (`isQuotaShapedTransientError`) bypassed transient delay; PR #142 (`d77cbfe3`) delivered configurable member cooldown presets/custom settings with caller-scoped routing and Retry-After floors. | Partially shipped (delay bypass & member cooldowns shipped; full nested error envelope normalization to client 429 remains pending). |
| **Sync Policy Backend** | T015 (`syncPolicyRepo.js`) and T016 (`retryPolicyRepo.js`) | Pending implementation. | Approved parent decision: new `providerSync` module with KV policy. |
| **Override Resolver & Cache** | T023 (`overrideCache.js`) | PR #141 landed per-field capability merging in `src/lib/models/capabilities.js`. In-memory caching and API routes (`/api/models/overrides`) remain pending. | Wire cache and API slice on top of PR #141 resolver logic. |

---

## 6. Frozen Scope & Exclusions

- **Psiphon Proxy Pool & OpenCode Quota/Rotation**:
  - User-frozen. Strictly isolated; no changes made to rotation cooldowns, session invalidation, or `ConsoleClient` management.
- **Regionhop Release Pin & Update PR**:
  - In-progress by concurrent worker. Excluded from this documentation slice to prevent git conflicts.
- **`CHANGELOG.md`**:
  - Excluded from this commit; owned by the Regionhop worker.

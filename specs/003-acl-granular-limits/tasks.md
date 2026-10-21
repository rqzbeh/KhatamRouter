---
description: "Dependency-ordered checklist of tasks for Wave 3 Unified ACL and Granular Limits"
---

# Tasks: Wave 3 - Unified ACL and Granular Limits

**Input**: Design documents from `/specs/003-acl-granular-limits/` (`spec.md`, `plan.md`)  
**Prerequisites**: `spec.md` (required), `plan.md` (required)  
**Tests**: Unit test suites `tests/unit/wave3-acl.test.js`, `tests/unit/wave3-internal-trust.test.js`, `tests/unit/wave3-connection-limiter.test.js`, `tests/unit/wave3-key-quota.test.js`, and baseline test `tests/__baseline__/verify-providers.mjs`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

---

## Phase 1: Internal Trust Security Service

**Purpose**: Build the constant-time, machine-bound `internalTrust` service for trusted loopback and IPC bypass.

- [ ] T001 [US2] Create `src/sse/services/internalTrust.js` implementing `verifyInternalToken(token)` using `crypto.timingSafeEqual` with memoized expected token from `getConsistentMachineId("9r-cli-auth")`, strict 16-hex shape validation (`/^[0-9a-f]{16}$/i`), and fail-closed error handling.
- [ ] T002 [US2] Implement `isInternalTrusted(request)` in `src/sse/services/internalTrust.js` reading `x-9r-cli-token` and provide `resetInternalTrustCache()` for clean unit test isolation.
- [ ] T003 [US2] Update `src/dashboardGuard.js` to delegate `x-9r-cli-token` validation to `isInternalTrusted` / `verifyInternalToken` instead of using non-constant-time `===` string equality.

---

## Phase 2: Unified Tri-State ACL Engine & Catalogue Filtering

**Purpose**: Upgrade key access control to support VansRouter tri-state ACL across kinds, providers, combos, and models with explicit 403/404 response semantics.

- [ ] T004 [US1] Create pure tri-state ACL helpers in `src/shared/utils/triStateAcl.js`: implement `parseTriState(val)` returning `null` (wildcard), empty Set (deny all), or Set of normalized strings (whitelist).
- [ ] T005 [US1] Update `src/sse/services/keyAccess.js` to support `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels`, maintaining backwards compatibility with legacy `accessRestricted` and `accessAllow` columns.
- [ ] T006 [US1, US5] Implement strict enforcement pipeline in `src/sse/services/keyAccess.js`:
  1. Internal-trust bypass (`isInternalTrusted`)
  2. API key validity
  3. Service kind check against `allowedKinds` (deny -> 403 Forbidden with `kind_not_allowed`)
  4. Combo check against `allowedCombos` (deny -> 403 Forbidden with `combo_not_allowed`)
  5. Provider check against `allowedProviders` (deny -> 403 Forbidden with `provider_not_allowed`)
  6. Model check against `allowedModels` (deny -> 404 Not Found with `model_not_found` to prevent model enumeration)
  All authorisation denials and policy lookup errors MUST fail closed.
- [ ] T007 [US1] Update `filterModelsListForKey(ctx, list)` in `src/sse/services/keyAccess.js` and `src/app/api/v1/models/route.js` to filter the catalog per authenticated key by kind, provider, combo, and model.

---

## Phase 3: Per-Connection Rate, Spacing & Concurrency Limiter

**Purpose**: Enforce connection-level rate limits, inter-call spacing, and concurrency ceilings from `providerConnections.rate_limit_overrides_json`.

- [ ] T008 [P] [US3] Create `open-sse/services/rateLimitManager/connectionLimiter.js`: implement `validateConnectionLimitOverrides(raw)` and `sanitizeConnectionLimitOverrides(raw)` stripping unknown fields and rejecting non-positive numbers (`rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, `maxWaitMs`, `executionMaxWaitMs`, `modelConcurrency`).
- [ ] T009 [P] [US3] Implement concurrency slot leasing in `open-sse/services/rateLimitManager/connectionLimiter.js`: `acquireConnectionSlot(connectionId, overrides, model, signal)` with queue wait timeouts (`maxWaitMs`) and `minTime` inter-call spacing.
- [ ] T010 [US3] Implement slot release and queue pump in `open-sse/services/rateLimitManager/connectionLimiter.js`: `releaseConnectionSlot(connectionId, model)` decrementing in-flight gauges and waking next queued request.

---

## Phase 4: Per-API-Key Sliding-Window Rate Limits & USD Spend Caps

**Purpose**: Enforce tenant rate limits (RPM/RPH/RPD), token quotas (TPM/TPD), and USD expenditure caps with fail-open infrastructure semantics.

- [ ] T011 [P] [US4, US5] Create `src/lib/quota/keyLimiter.js`: implement multi-window rate limiting over `api_keys.rate_limits` using `quotaStoreFactory()` (`RedisQuotaStore` / `SqliteQuotaStore`) sliding windows.
- [ ] T012 [P] [US4, US5] Implement USD spend cap check in `src/lib/quota/keyLimiter.js` against daily/weekly spending in `request_cost_ledger` when `usage_limit_enabled === 1`.
- [ ] T013 [US4, US5] Implement fail-open infrastructure error handling in `src/lib/quota/keyLimiter.js`: catch Redis/database exceptions, log non-fatal warning, and return `{ allowed: true, degraded: true }`. If a working storage confirms limit exceeded, format HTTP 429 response with `Retry-After` header.

---

## Phase 5: Repository Updates & Handler Wiring

**Purpose**: Connect database repositories and HTTP route handlers to the new ACL and rate limiting engines.

- [ ] T014 [US1, US4] Update `src/lib/db/repos/apiKeysRepo.js` to serialize and deserialize `allowedKinds`, `allowedProviders`, `allowedCombos`, `allowedModels`, `rate_limits`, `throttle_delay_ms`, `usage_limit_enabled`, `daily_usage_limit_usd`, and `weekly_usage_limit_usd`.
- [ ] T015 [US3] Update `src/lib/db/repos/connectionsRepo.js` to parse and sanitize `rate_limit_overrides_json` via `sanitizeConnectionLimitOverrides`.
- [ ] T016 [US1, US2, US4] Wire `internalTrust`, unified ACL, and `keyLimiter` into `src/sse/handlers/chat.js` and `src/sse/handlers/stt.js`.
- [ ] T017 [US3] Wire `connectionLimiter` slot acquisition and release around upstream dispatch in `open-sse/handlers/chatCore.js` and `src/sse/services/auth.js`.

---

## Phase 6: Unit Test Suites, Unlazy Gate Verification & Documentation

**Purpose**: Validate all Wave 3 acceptance criteria, verify Unlazy gates, and update project status documentation.

- [ ] T018 [P] [US1] Author unit test suite `tests/unit/wave3-acl.test.js` covering tri-state matrix (`null`, `[]`, `[...]`), 403 on denied kind/provider/combo, 404 on denied model, legacy compatibility, and `/v1/models` catalog filtering.
- [ ] T019 [P] [US2] Author unit test suite `tests/unit/wave3-internal-trust.test.js` covering constant-time validation, 16-hex shape checks, memoization, and fail-closed behavior.
- [ ] T020 [P] [US3] Author unit test suite `tests/unit/wave3-connection-limiter.test.js` covering override sanitization, concurrency slot acquisition/release, queue timeouts, and `minTime` inter-call delays.
- [ ] T021 [P] [US4, US5] Author unit test suite `tests/unit/wave3-key-quota.test.js` covering sliding-window rate limits (RPM/RPH/RPD), USD spend caps via `request_cost_ledger`, 429 Retry-After formatting, and fail-open resilience under Redis/DB errors.
- [ ] T022 [US1..US5] Execute all Unlazy gates in `.unlazy/wave-003/GATES.md` (G1, G2, G3, G4, G5) to verify 100% green gates and assert provider baseline equality.
- [ ] T023 [US1..US5] Update `README.md` and `ROADMAP.md` to reflect Wave 3 status, shipped capabilities, and operational documentation upon wave completion.

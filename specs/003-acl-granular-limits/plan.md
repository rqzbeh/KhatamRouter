# Implementation Plan: Wave 3 - Unified ACL and Granular Limits

**Feature Branch**: `003-acl-granular-limits`  
**Created**: 2026-10-21  
**Status**: Draft  
**Prerequisites**: Wave 2 (`002-db-migrations-hybrid-quota-store`) merged to master. `SCHEMA_VERSION = 3` with `rate_limit_overrides_json` and `apiKeys` limit columns present.

---

## Architecture & System Overview

Wave 3 establishes the security perimeter and traffic throttling engine for KhatamRouter. It combines the 9router model resolution foundation with the VansRouter multi-dimensional tri-state ACL and adds multi-tier rate limiting across connections and API keys.

```
Incoming Request
  │
  ▼
[ 1. Internal Trust Guard ] ────────► (Valid x-9r-cli-token) ──► [ BYPASS ALL GATES ] ──► Upstream
  │ (Fails closed on mismatch)                                                              ▲
  ▼                                                                                         │
[ 2. API Key Authentication ] ──────► (Invalid / Inactive) ────► 401 Unauthorized           │
  │                                                                                         │
  ▼                                                                                         │
[ 3. Unified Tri-State ACL ]                                                               │
  ├─ Kind Check (allowedKinds) ─────────► Denied ──► 403 Forbidden                          │
  ├─ Provider Check (allowedProviders) ─► Denied ──► 403 Forbidden                          │
  ├─ Combo Check (allowedCombos) ───────► Denied ──► 403 Forbidden                          │
  └─ Model Check (allowedModels) ───────► Denied ──► 404 Not Found (no leak)                │
  │ (All ACL checks FAIL CLOSED on error)                                                   │
  ▼                                                                                         │
[ 4. Per-API-Key Quota & Spend Limiter ]                                                    │
  ├─ Rate Limits (RPM / RPH / RPD via QuotaStore)                                           │
  ├─ Token Quotas (TPM / TPD)                                                               │
  └─ USD Budget Caps (Daily / Weekly via request_cost_ledger)                               │
  │ (Storage errors FAIL OPEN: degraded: true)                                              │
  │ Limit Exceeded ─────────────────────► 429 Too Many Requests (Retry-After)               │
  ▼                                                                                         │
[ 5. Routing, Combo Expansion & Account Selection ]                                         │
  │                                                                                         │
  ▼                                                                                         │
[ 6. Per-Connection Limits & Concurrency Gating ]                                          │
  ├─ In-Flight Concurrency (maxConcurrent, modelConcurrency)                               │
  ├─ Inter-Call Spacing (minTime delay)                                                     │
  └─ Queue Wait Ceiling (maxWaitMs) ────► Timeout / Exceeded ──► Fallback / 429             │
  │                                                                                         │
  ▼                                                                                         │
[ 7. Upstream Dispatch & Execution ] ───────────────────────────────────────────────────────┘
  │
  ▼
[ 8. Post-Flight Accounting ]
  ├─ Record token count and total USD cost to request_cost_ledger
  ├─ Update sliding-window token / spend counters
  └─ Release connection in-flight concurrency slot
```

---

## Detailed Module Designs

### 1. `src/sse/services/internalTrust.js`

**Purpose**: Verify the machine-bound `x-9r-cli-token` using constant-time comparisons with fail-closed semantics and in-memory caching.

**Contract & Specifications**:
- Header: `x-9r-cli-token`
- Salt: `9r-cli-auth`
- Token source: `getConsistentMachineId("9r-cli-auth")` from `@/shared/utils/machineId`
- Token format: Exactly 16 hexadecimal characters (`/^[0-9a-f]{16}$/i`)
- Comparison: Must use `crypto.timingSafeEqual` over equal-length UTF-8 Buffers.
- Shape verification:
  - If token is missing, null, undefined, not a string, or length $\neq 16$, or fails `/^[0-9a-f]{16}$/i`, return `false` immediately.
  - Never call `crypto.timingSafeEqual` with unequal buffer lengths (which throws in Node.js).
- Memoization:
  - Memoize the expected token in memory (`cachedInternalToken`) to eliminate repeated hashing or disk reads on hot proxy paths.
  - Provide a `resetInternalTrustCache()` export for testing.
- Exported functions:
  - `verifyInternalToken(candidateToken: string): Promise<boolean>`
  - `isInternalTrusted(request: Request): Promise<boolean>`
  - `getExpectedInternalToken(): Promise<string>`
  - `resetInternalTrustCache(): void`
- Integration:
  - Update `src/dashboardGuard.js` to replace `token === await getCliToken()` with `await verifyInternalToken(token)`.

---

### 2. `src/sse/services/keyAccess.js` & Unified Tri-State Engine

**Purpose**: Merge 9router's resolution-based `keyAccess.js` with VansRouter's multi-dimensional tri-state ACL, providing unified authorization across kinds, providers, combos, and models.

**Tri-State Evaluation Rules**:
For each dimension $D \in \{\text{allowedKinds}, \text{allowedProviders}, \text{allowedCombos}, \text{allowedModels}\}$:
1. `null` or `undefined`: **Wildcard** — every value in dimension $D$ is permitted.
2. `[]` (empty array): **Deny All** — no value in dimension $D$ is permitted.
3. `["val1", "val2", ...]`: **Whitelist** — only exact case-insensitive matches against resolved identifiers are permitted.

**Backwards Compatibility Mapping**:
When an API key row has legacy columns (`accessRestricted: 1` and `accessAllow: [...]`) but the new columns (`allowedKinds`, `allowedProviders`, `allowedCombos`, `allowedModels`) are null:
- `allowedKinds`: defaults to `null` (wildcard).
- `allowedCombos`: extracted from `accessAllow` for entries matching known combo names.
- `allowedModels`: extracted from `accessAllow` for entries containing `/` or matching known models.
- `allowedProviders`: extracted from `accessAllow` for bare provider strings (e.g. `tavily` for web search).

**Enforcement Order**:
1. `internalTrust`: Bypass if trusted.
2. API Key validity: 401 if missing/invalid when `requireApiKey` is active.
3. Kind check: 403 Forbidden if requested endpoint kind (e.g. `llm`, `stt`, `tts`, `embedding`, `webSearch`) is not permitted by `allowedKinds`.
4. Combo or Provider check:
   - If requested target is a combo: check `allowedCombos` -> 403 Forbidden if not allowed.
   - If requested target is a provider-as-model (webSearch/webFetch): check `allowedProviders` -> 403 Forbidden if not allowed.
   - If target is a model: check whether the model's provider is allowed by `allowedProviders` -> 403 Forbidden if provider is explicitly restricted and not listed.
5. Model check:
   - If target is a model (not a combo): check `allowedModels` against resolved canonical `provider/model` ID.
   - If not allowed: return **404 Not Found** (`code: "model_not_found"`), preventing model enumeration.

**Catalogue Filtering**:
- In `src/app/api/v1/models/route.js`, `filterModelsListForKey(ctx, models)` is upgraded to filter by `allowedKinds`, `allowedProviders`, `allowedCombos`, and `allowedModels`.
- Combos and models outside the key's permissions are stripped before returning the JSON catalog to the client.

---

### 3. `open-sse/services/rateLimitManager/connectionLimiter.js`

**Purpose**: Manage per-connection concurrency ceilings, inter-call delays, and throughput limits configured in `providerConnections.rate_limit_overrides_json`.

**Contract & Specifications**:
- Supported fields:
  - `rpm`: Max requests per minute (integer > 0)
  - `rpd`: Max requests per day (integer > 0)
  - `tpm`: Max tokens per minute (integer > 0)
  - `tpd`: Max tokens per day (integer > 0)
  - `minTime`: Minimum spacing between request starts in milliseconds (integer > 0)
  - `maxConcurrent`: Maximum concurrent in-flight requests on this connection (integer > 0)
  - `maxWaitMs`: Max time to wait in queue before aborting/failing over (integer > 0, default 5000)
  - `executionMaxWaitMs`: Max execution timeout in milliseconds (integer > 0)
  - `modelConcurrency`: Per-model concurrency limits `{ [modelId]: number }`
- Sanitization & Validation:
  - `validateConnectionLimitOverrides(raw: unknown): { ok: boolean, errors?: string[] }`
  - `sanitizeConnectionLimitOverrides(raw: unknown): ConnectionLimits | null`
  - Rejects negative numbers, `0`, `NaN`, `Infinity`, non-integer numbers for counts, and non-object values.
  - Strips unknown fields.
- Concurrency State Management:
  - Track in-flight requests per connection: `inFlightByConnection: Map<string, number>`.
  - Track in-flight requests per connection+model: `inFlightByConnectionModel: Map<string, number>`.
  - Track last request timestamp per connection for `minTime` spacing.
  - `acquireConnectionSlot(connectionId, overrides, model, signal)`:
    - Waits if `inFlight >= maxConcurrent` or model concurrency limit reached, up to `maxWaitMs`.
    - Enforces `minTime` delay if current time is less than `lastRequestAt + minTime`.
    - Returns slot lease or throws `ConnectionLimitExceededError` (allowing account fallback to try another connection).
  - `releaseConnectionSlot(connectionId, model)`:
    - Decrements in-flight counters and wakes next waiting request in queue.

---

### 4. `src/lib/quota/keyLimiter.js` & Per-API-Key Limits

**Purpose**: Enforce per-API-key rate limits (RPM, RPH, RPD), token quotas (TPM, TPD), and USD expenditure caps backed by `request_cost_ledger` and `QuotaStore`.

**Contract & Specifications**:
- Multi-Window Rate Limits:
  - Parsed from `api_keys.rate_limits` JSON string.
  - Supports `{ limit: number, window: number | string }` where window can be seconds (`60`), string notation (`"1m"`, `"1h"`, `"1d"`), or milliseconds.
  - Checked against `quotaStoreFactory()` using sliding-window keys: `khatam:quota:ratelimit:${keyId}:${windowSeconds}`.
- USD Spend Caps:
  - Evaluated when `usage_limit_enabled === 1`.
  - Daily limit: `daily_usage_limit_usd` against spend in `request_cost_ledger` for the current UTC date (`strftime('%Y-%m-%d', created_at) = CURRENT_DATE`).
  - Weekly limit: `weekly_usage_limit_usd` against spend for the current UTC week.
  - Optimized with Redis/SQLite cached accumulator in `api_key_quota_counters`.
- Fail-Open Contract:
  - If `QuotaStore` throws, Redis fails, or DB query fails:
    - Log warning: `[keyLimiter] Quota evaluation failed: ${err.message} (failing open)`.
    - Return `{ allowed: true, degraded: true }`.
    - Never throw on the inference path.
- 429 Response Formatting:
  - If limit exceeded:
    - Status: `429 Too Many Requests`
    - Body: `{ error: { message: "Rate limit exceeded for API key...", type: "requests", code: "rate_limit_exceeded" } }`
    - Header: `Retry-After: <seconds>` (calculated from `resetMs` of the violated window).
    - Headers: `x-ratelimit-limit-*`, `x-ratelimit-remaining-*`, `x-ratelimit-reset-*`.

---

### 5. Repository & Schema Layer Updates

- `src/lib/db/repos/apiKeysRepo.js`:
  - Update `rowToKey(row)` to deserialize `allowedKinds`, `allowedProviders`, `allowedCombos`, `allowedModels`, `rate_limits`, `throttle_delay_ms`, `usage_limit_enabled`, `daily_usage_limit_usd`, `weekly_usage_limit_usd`.
  - Update `updateApiKey` and `createApiKey` to accept and serialize these fields.
- `src/lib/db/repos/connectionsRepo.js`:
  - Update `rowToConn(row)` to include sanitized `rate_limit_overrides` from `row.rate_limit_overrides_json`.
  - Expose helper `getConnectionLimits(connectionId)` returning sanitized limits.

---

## Verification & Unlazy Gates Alignment

- **G1 (ACL Tri-State Matrix)**: `tests/unit/wave3-acl.test.js` tests all combinations of `null`, `[]`, and `[...]` across kinds, providers, combos, models, asserting 403 on denied kind/provider/combo, 404 on denied model, and catalogue filtering.
- **G2 (internalTrust)**: `tests/unit/wave3-internal-trust.test.js` tests constant-time validation, 16-hex shape validation, memoization, and fail-closed security.
- **G3 (Connection Limiter)**: `tests/unit/wave3-connection-limiter.test.js` tests sanitization of `rate_limit_overrides_json`, concurrency slot acquisition/release, queue timeouts, and `minTime` delays.
- **G4 (Per-Key Quotas & USD Caps)**: `tests/unit/wave3-key-quota.test.js` tests multi-window sliding limits (RPM/RPH/RPD), USD budget limits against `request_cost_ledger`, 429 Retry-After calculation, and fail-open resilience under Redis/DB errors.
- **G5 (Provider Baseline)**: `tests/__baseline__/verify-providers.mjs` verifies zero changes to provider registries.

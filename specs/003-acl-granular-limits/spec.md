# Feature Specification: Wave 3 - Unified ACL and Granular Limits

**Feature Branch**: `003-acl-granular-limits`  
**Created**: 2026-10-21  
**Status**: Draft  
**Input**: User description: "Wave 3: unified ACL and granular per-connection / per-key limits. Merge 9router keyAccess.js with VansRouter tri-state ACL (allowedKinds, allowedProviders, allowedCombos, allowedModels); explicit enforcement order; catalogue filtering on /v1/models; machine-bound timingSafeEqual internalTrust.js; per-connection limit overrides in provider_connections.rate_limit_overrides_json; per-API-key sliding-window rate/token limits and USD spend caps; explicit fail-open for limits infrastructure vs fail-closed for authorisation denials; 403 for denied kind/provider/combo, 404 for denied model, 429 for rate/token/spend limits."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unified Tri-State Access Control Lists (ACL) & Catalogue Filtering (Priority: P1)

As an API administrator, I need fine-grained, tri-state access control for every API key across service kinds (`allowedKinds`), providers (`allowedProviders`), combos (`allowedCombos`), and models (`allowedModels`), so that I can securely isolate access permissions for different teams, applications, and tiers without leaky defaults or model enumeration.

**Why this priority**: Core security foundation for multi-client routing. Merges 9router's flat `accessAllow` with VansRouter's multi-dimensional tri-state permissions while preserving backwards compatibility.

**Independent Test**: Can be tested by configuring an API key with various combinations of tri-state permissions:
- Setting a field to `null`/`undefined` to verify unrestricted access (wildcard).
- Setting a field to `[]` to verify complete rejection of that dimension (fail-closed).
- Setting a field to `["item1", "item2"]` to verify whitelist-only enforcement.
- Requesting unauthorized kinds/providers/combos to assert HTTP 403.
- Requesting unauthorized models to assert HTTP 404 (preventing model enumeration).
- Querying `/v1/models` to verify catalog entries are filtered to only permitted items.

**Acceptance Scenarios**:

1. **Given** an API key where a dimension (`allowedKinds`, `allowedProviders`, `allowedCombos`, or `allowedModels`) is `null` or `undefined`, **When** a request accesses that dimension, **Then** all values in that dimension are allowed (unrestricted wildcard).
2. **Given** an API key where a dimension is an empty array `[]`, **When** a request targets that dimension, **Then** all requests for that dimension are denied (empty whitelist denies all).
3. **Given** an API key where a dimension contains an explicit list `["openai", "anthropic"]`, **When** a request targets a member of the list, **Then** it is permitted; when it targets an unlisted item, it is denied.
4. **Given** a request traversing the gateway, **When** evaluated against policy, **Then** enforcement strictly follows this sequence:
   1. `internalTrust` bypass check (valid machine token bypasses all gates).
   2. API key validity and active status (`401 Unauthorized` if invalid/inactive).
   3. Service kind check against `allowedKinds` (`403 Forbidden` if denied).
   4. Combo or provider check against `allowedCombos` / `allowedProviders` (`403 Forbidden` if denied).
   5. Model check against `allowedModels` (`404 Not Found` if denied).
5. **Given** a client calling `GET /v1/models` or `GET /v1/models/{kind}`, **When** presenting an authenticated API key, **Then** the returned catalog contains only items permitted across all four tri-state dimensions for that key.
6. **Given** a legacy API key with `accessRestricted: 1` and `accessAllow: [...]`, **When** processed by the unified ACL engine, **Then** it seamlessly maps combos to `allowedCombos` and models to `allowedModels` without breaking existing keys.

---

### User Story 2 - Constant-Time Machine-Bound `internalTrust` Bypass (Priority: P1)

As an internal service, CLI launcher, or loopback reverse proxy, I need a cryptographically secure, constant-time verified token header (`x-9r-cli-token`) to bypass client-level API key requirements and rate limits, so that internal operations run without interference while defending against timing attacks and spoofing.

**Why this priority**: Critical inter-process trust boundary. Mitigates timing attacks on local IPC and ensures internal operations (like local CLI commands, background sync, and dashboard management) are never throttled or blocked by client ACLs.

**Independent Test**: Can be tested by invoking `verifyInternalToken()` and `isInternalTrusted(request)` with valid tokens, mutated tokens, truncated tokens, wrong-length tokens, non-hex strings, and missing headers:
- Assert that valid 16-hex tokens matching `getConsistentMachineId("9r-cli-auth")` pass.
- Assert that validation executes `crypto.timingSafeEqual` over fixed-size buffers.
- Assert that validation fails closed (`false`) on any error, missing token, or shape mismatch.
- Assert that expected token retrieval is memoized to avoid unnecessary disk I/O.

**Acceptance Scenarios**:

1. **Given** an incoming request with header `x-9r-cli-token`, **When** evaluated by `isInternalTrusted(request)`, **Then** the token must match the shape `/^[0-9a-f]{16}$/i` (exactly 16 hexadecimal characters).
2. **Given** a token candidate with invalid length or non-hex characters, **When** checked, **Then** it fails closed and returns `false` without throwing and without executing unequal-buffer comparisons in `crypto.timingSafeEqual`.
3. **Given** a 16-hex token matching the system's machine-bound token, **When** compared via `crypto.timingSafeEqual`, **Then** it returns `true`.
4. **Given** a trusted internal request, **When** processed by gateway handlers (`handleChat`, `handleStt`, etc.), **Then** all API key authentication, ACL checks, and rate limits are bypassed.
5. **Given** `src/dashboardGuard.js`, **When** validating `x-9r-cli-token`, **Then** it delegates to `src/sse/services/internalTrust.js` rather than using standard JavaScript equality (`===`).

---

### User Story 3 - Per-Connection Limits and Concurrency Ceilings (Priority: P1)

As an administrator managing upstream provider accounts, I need connection-level rate limits and concurrency ceilings configured in `providerConnections.rate_limit_overrides_json`, so that upstream provider quotas and account bans are prevented even under burst traffic.

**Why this priority**: Required for upstream account survival and multi-account load balancing. Prevents account-level bans caused by exceeding provider concurrency ceilings or RPM limits.

**Independent Test**: Can be tested by mocking provider connections with `rate_limit_overrides_json` configurations:
- Parsing overrides with `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, `maxWaitMs`, `executionMaxWaitMs`, and `modelConcurrency`.
- Verifying validation and sanitization: stripping unknown keys and rejecting non-positive numbers (`<= 0`, `NaN`, `null`).
- Executing concurrent requests to verify in-flight concurrency gating (`maxConcurrent`).
- Verifying inter-call interval enforcement (`minTime`).

**Acceptance Scenarios**:

1. **Given** a connection row in `providerConnections`, **When** `rate_limit_overrides_json` is parsed, **Then** only valid, positive numerical values for `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, `maxWaitMs`, `executionMaxWaitMs`, and `modelConcurrency` (map of model ID to positive integer) are retained.
2. **Given** an override payload with unknown keys or invalid types (e.g. `{"foo": 123, "rpm": -10, "maxConcurrent": "invalid"}`), **When** sanitized, **Then** unknown keys and non-positive values are completely stripped.
3. **Given** a connection with `maxConcurrent: 2`, **When** 3 simultaneous requests target this connection, **Then** the first 2 execute immediately while the 3rd waits up to `maxWaitMs` or is rejected/diverted to fallback.
4. **Given** a connection with `minTime: 200`, **When** two requests arrive 50ms apart, **Then** the second request delays dispatch until at least 200ms has elapsed since the first request began.

---

### User Story 4 - Granular Per-API-Key Limits & USD Spend Caps (Priority: P1)

As a platform owner, I need per-API-key rate limits (RPH, RPM, RPD), token quotas (TPM, TPD), and USD expenditure caps backed by `request_cost_ledger`, so that individual API keys cannot exhaust system resources or overrun financial budgets.

**Why this priority**: Enforces tenant fairness, financial budget protection, and service level agreements.

**Independent Test**: Can be tested using `quotaStoreFactory()` with sliding-window counters:
- Specifying `rate_limits` array `[{ limit: 10, window: 60 }]` to assert 429 upon the 11th request in a minute.
- Specifying `daily_usage_limit_usd` and asserting rejection when aggregated cost in `request_cost_ledger` reaches the cap.
- Verifying that 429 responses include standard `Retry-After: <seconds>` headers and OpenAI-format error envelopes.

**Acceptance Scenarios**:

1. **Given** an API key configured with `rate_limits: '[{"limit": 60, "window": "1m"}, {"limit": 1000, "window": "1d"}]'`, **When** evaluated, **Then** each window (RPM, RPH, RPD) is checked independently against sliding-window counters.
2. **Given** an API key that exceeds its rate limit, **When** rejected, **Then** the response status is HTTP 429, the error envelope conforms to `{ error: { message: "...", type: "requests", code: "rate_limit_exceeded" } }`, and `Retry-After` indicates seconds until reset.
3. **Given** an API key with `usage_limit_enabled: 1` and `daily_usage_limit_usd: 5.00`, **When** the cumulative cost in `request_cost_ledger` for the current UTC day exceeds $5.00, **Then** subsequent requests are rejected with HTTP 429 (`code: "budget_exceeded"`).
4. **Given** token limits (TPM/TPD), **When** evaluated, **Then** the pre-flight check evaluates estimated tokens and post-flight updates the counter with actual usage from `request_cost_ledger`.

---

### User Story 5 - Architectural Contrast: Fail-Closed Authorisation vs. Fail-Open Rate Limiting (Priority: P1)

As a gateway reliability engineer, I need authorisation decisions to fail closed and rate limiting infrastructure errors to fail open, so that security is never compromised while temporary infrastructure hiccups (e.g. Redis downtime) never disrupt user traffic.

**Why this priority**: The foundational operational invariant of Wave 3. Confusing these two semantics leads to either critical security vulnerabilities (leaking unauthenticated access) or severe availability outages (dropping traffic because a cache died).

**Independent Test**: Can be tested by simulating infrastructure failures:
- Corrupting or breaking database access during ACL evaluation -> asserts 403/500 denial (never allows request through).
- Simulating Redis disconnection or SQLite counter failure during rate limit evaluation -> asserts `{ allowed: true, degraded: true }` and permits request execution with warning log.

**Acceptance Scenarios**:

1. **Given** an authorisation check (API key verification or tri-state ACL evaluation), **When** an unexpected database error, null context, or malformed rule is encountered, **Then** the request FAILS CLOSED and is denied immediately with HTTP 403 or 500.
2. **Given** a rate or token limiting check, **When** Redis is unreachable, network timeouts occur, or the counter database table fails, **Then** the limiting engine FAILS OPEN, returns `{ allowed: true, degraded: true }`, logs a single non-fatal warning, and allows the inference request to proceed without interruption.
3. **Given** an active rate limiter whose storage IS functioning properly and reports that a limit has been exceeded, **When** evaluated, **Then** it rejects with HTTP 429. (Exceeded limit is a policy rejection, not an infrastructure failure).

---

## Response Semantics Specification

| Denial Reason | HTTP Status | Response Body Code | Response Message Format | Headers |
|---|---|---|---|---|
| Denied Service Kind (`allowedKinds`) | 403 Forbidden | `kind_not_allowed` | `This API key is not allowed to use service kind "${kind}"` | None |
| Denied Provider (`allowedProviders`) | 403 Forbidden | `provider_not_allowed` | `This API key is not allowed to use provider "${provider}"` | None |
| Denied Combo (`allowedCombos`) | 403 Forbidden | `combo_not_allowed` | `This API key is not allowed to use combo "${combo}"` | None |
| Denied Model (`allowedModels`) | 404 Not Found | `model_not_found` | `The model "${model}" does not exist or you do not have access to it.` | None |
| Exceeded Rate Limit (RPM/RPH/RPD) | 429 Too Many Requests | `rate_limit_exceeded` | `Rate limit reached for API key. Please retry after ${seconds}s.` | `Retry-After: <sec>`, `x-ratelimit-*` |
| Exceeded Token Limit (TPM/TPD) | 429 Too Many Requests | `token_limit_exceeded` | `Token quota exceeded for model "${model}". Please retry after ${seconds}s.` | `Retry-After: <sec>` |
| Exceeded USD Spend Cap | 429 Too Many Requests | `budget_exceeded` | `Daily/Weekly expenditure limit reached for this API key ($${spent}/$${limit}).` | None |

---

## Data Models & Schema Mappings

### 1. `apiKeys` Tri-State Fields

- `allowedKinds`: JSON array of service kinds: `["llm", "embedding", "image", "tts", "stt", "webSearch", "webFetch"]`.
  - `null` = all kinds allowed.
  - `[]` = no kinds allowed.
- `allowedProviders`: JSON array of provider IDs/aliases: `["openai", "anthropic", "github", ...]`.
  - `null` = all providers allowed.
  - `[]` = no providers allowed.
- `allowedCombos`: JSON array of combo names: `["Main", "Fast", ...]`.
  - `null` = all combos allowed.
  - `[]` = no combos allowed.
- `allowedModels`: JSON array of canonical model strings: `["openai/gpt-4o", "anthropic/claude-3-5-sonnet", ...]`.
  - `null` = all models allowed.
  - `[]` = no models allowed.
- `rate_limits`: JSON array of `{ limit: number, window: number | string }` (e.g. `[{"limit": 60, "window": "1m"}, {"limit": 1000, "window": "1h"}]`).
- `throttle_delay_ms`: Optional inter-request throttle delay in milliseconds.
- `usage_limit_enabled`: 0 = disabled, 1 = enabled.
- `daily_usage_limit_usd`: Real number representing max spend per UTC day.
- `weekly_usage_limit_usd`: Real number representing max spend per UTC week.

### 2. `providerConnections.rate_limit_overrides_json`

JSON object conforming to:
```json
{
  "rpm": 120,
  "rpd": 10000,
  "tpm": 100000,
  "tpd": 5000000,
  "minTime": 250,
  "maxConcurrent": 4,
  "maxWaitMs": 5000,
  "executionMaxWaitMs": 60000,
  "modelConcurrency": {
    "gpt-4o": 2,
    "claude-3-5-sonnet-20241022": 1
  }
}
```
All fields optional. Unknown keys stripped on validation. Negative or zero numbers rejected.

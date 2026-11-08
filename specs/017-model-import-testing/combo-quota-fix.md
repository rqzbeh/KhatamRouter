# Addendum: Quota-Shaped 5xx Transient Fallback Delay Bypass

**Date**: 2026-11-08
**Scope**: `open-sse/services/combo.js`, `tests/unit/combo-wrapped-quota.test.js`
**Status**: Frozen Correctness Slice (Prompt-Only Fallback Delay Bypass)

---

## 1. Problem Statement & Nuance

### 1.1 The Production Failure Mode
In production, a combo model member failed with an outer HTTP `503 Service Unavailable` response wrapping an upstream account quota exhaustion message:
```json
{
  "error": {
    "message": "[429]: You have reached the daily limit of 60 free-model requests for your account. Retry after 11114 seconds. (reset after 19s)"
  }
}
```
Or variant:
```json
{
  "error": {
    "message": "[429]: Daily quota exceeded. Rate limit resets in 11114 seconds."
  }
}
```

### 1.2 Baseline Analysis & Asymmetry
- **Variant A (`You have reached the daily limit of 60 free-model requests...`)**: Baseline `ERROR_RULES` did not contain a text rule for `"daily limit"`. `checkFallbackError(503, message)` returned `cooldownMs = 30000ms`. Because `30000 > 5000`, the transient delay condition (`cooldownMs <= 5000`) was skipped, allowing immediate fallback.
- **Variant B (`[429]: Daily quota exceeded. Rate limit resets in 11114 seconds.`)**: Matched `"quota exceeded"` and `"rate limit"`, setting `backoff: true` (`cooldownMs = 2000ms`). Under HTTP 503, `2000 <= 5000` was true, causing `combo.js` to execute a 2-second sleep (`await new Promise((r) => setTimeout(r, cooldownMs))`), blocking prompt failover to healthy combo members.

---

## 2. Narrowed Prompt-Only Solution

Rather than expanding scope to full nested status normalization or untrusted prose retry hint extraction (which risks rewriting genuine 4xx/5xx errors or overriding authoritative headers):
1. **Bounded Transient Delay Bypass**: Introduce `isQuotaShapedTransientError(status, errorBody, errorText)` strictly for HTTP 502, 503, and 504. When an explicit quota signal is detected, the 2-second transient wait is bypassed so failover to the next combo candidate is instantaneous.
2. **Explicit Quota Signals Checked**:
   - Structured nested `upstream_status: 429` or `upstreamStatus: 429`.
   - Structured error code/type `rate_limit_exceeded` or `insufficient_quota`.
   - Bounded explicit patterns: `[429]`, `upstream returned 429`, `HTTP 429`, `daily limit`, `daily quota`, `quota exceeded`, `rate limit exceeded`.
3. **Preserve Outer Status Everywhere**:
   - Upstream HTTP status is preserved as-is for member cooldown tracking (`markComboModelCooldown`), `lastStatus`, and client error envelopes. Outer 503 remains 503.
4. **Preserve Authoritative Retry-After Policy**:
   - No untrusted text parsing overrides the `Retry-After` header. Generic 503 errors (e.g. `server overloaded`) retain standard transient delay behavior regardless of header values.

---

## 3. Scope Boundaries & Future Normalization
- **Deferred to Future Wave**: Full nested error envelope transformation (e.g., rewriting an outer 503 into an inner 429 payload for clients) requires a comprehensive, designed schema mapping and is intentionally excluded from this narrow PR.
- **Controlled Scope**: Changes are strictly confined to `open-sse/services/combo.js` and dedicated tests in `tests/unit/combo-wrapped-quota.test.js`.

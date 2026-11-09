# Contract: Scoped Proxy-Rotation Failures & Configurable Retry Intervals

**Slices**: S8 (rotation), S5 (retry) · **Requirements**: FR-027..FR-035
**Evidence**: `open-sse/services/proxyPoolFitness.js` (scope `provider::model`), `open-sse/services/accountFallback.js` (`checkFallbackError`, `formatRetryAfter`), `open-sse/config/resilienceConfig.js`.

## Scoped rotation failures (FR-027..FR-031)

### Scope model
- `scopeType` ∈ `global | provider | account | combo | key`.
- `scopeId` REQUIRED for every non-`global` scope. A non-global scope without an id is rejected (`400`), never treated as global (FR-029).

### Record shape
```json
{ "scopeType": "account", "scopeId": "conn-42", "poolId": "pool-9", "reason": "rotate_failed", "at": "2026-11-08T00:00:00.000Z" }
```

### Invariants
- A rotation failure in one scope changes the availability/cooldown/disable of **0** other scopes (FR-028, SC-007).
- Classified as **transport health**, never quota/credential invalidation (FR-030); no credential cycling (FR-031).
- Preserves strict-proxy/Psiphon fail-closed: no direct-egress fallback (`open-sse/utils/proxyFetch.js`, `src/lib/network/connectionProxy.js`).
- Reuses the `provider::model` scope concept in `proxyPoolFitness.js` (`markPoolUnfit`/`clearPoolUnfit`) and generalizes to the 5 scopes.

## Configurable retry intervals (FR-032..FR-035)

### Policy storage
- `retryPolicy`: `{ globalMs, providers: { [id]: number } }` (settings repo / kv).
- Validated bounds; invalid rejected. Zero/near-zero must not create a hot loop (enforced floor).

### Effective wait rule (FR-033, SC-008)
```
effectiveMs = max(configuredMs, retryAfterMs_from_upstream_header)
```
- The configured interval is a **floor only** and MUST NEVER shorten upstream `Retry-After`.
- Server-side `parseRetryAfter` already handles numeric seconds + HTTP-date + bounds (`open-sse/services/combo.js:56`; existing tests in `tests/unit/combo-cooldown-correctness.test.js`).
- A long legitimate hint must not be truncated; a short hint must not be inflated into an unbounded stall.

### Access/regional boundary (FR-034)
- Retry configuration MUST NOT bypass, shorten, or defeat regional/access restrictions, and MUST NOT override a terminal quota/access decision.
- This rule is the hard precedence: access/regional → terminal (no retry); quota → terminal cooldown; rate-limit → bounded retry; transport → bounded retry.

### Per-provider override (FR-032)
- `providers[id]` overrides `globalMs` for that provider only; other providers keep the global default.

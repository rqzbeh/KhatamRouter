# Contract: Batch "Test All" API

**Slice**: S6 · **Requirements**: FR-019..FR-026, FR-036 · **Reference**: OmniRoute `/api/models/test-all` (behavioral only)

Behind dashboard auth (FR-037). Bounded input. Sequential, rate-respecting dispatch. Never logs secrets.

## POST `/api/models/test-batch`

**Request**
```json
{
  "providerId": "openrouter",
  "connectionId": "conn-42",
  "modelIds": ["vendor/a", "vendor/b", "vendor/c"],
  "autoDisable": false,
  "respectRateLimit": true
}
```
- `modelIds`: 1..`batchTestMax` (default 100).
- `autoDisable`: default **false** (opt-in). Soft-disable, reversible.
- `respectRateLimit`: default true (pace through existing limiter/backoff).

**Response 200**
```json
{
  "results": {
    "vendor/a": { "status": "ok", "classification": "success", "latencyMs": 812 },
    "vendor/b": { "status": "error", "classification": "hard_model_failure", "statusCode": 404,
                  "error": "model not found", "latencyMs": 220, "disabled": true },
    "vendor/c": { "status": "error", "classification": "quota_cost", "isQuota": true,
                  "statusCode": 429, "error": "daily limit reached", "disabled": false }
  },
  "summary": { "tested": 3, "total": 3, "disabled": 1 },
  "stoppedEarly": false
}
```

## Result classification (FR-020, FR-036)

| classification | triggers | disables when `autoDisable`? |
|---|---|---|
| `success` | 2xx usable response | no |
| `hard_model_failure` | model-specific terminal error (e.g. 404 model not found, invalid model) | **yes (only this)** |
| `quota_cost` | 429/403 with quota/credit/billing/insufficient-funds signals | no |
| `access_restriction` | explicit regional/access block (not generic 403) | no |
| `rate_limited` | transient 429 burst | no |
| `transport_indeterminate` | timeout, ECONNRESET, connection refused, proxy transport failure | no |

- Classification reuses `src/lib/resilience/failureClassification.js` + `QUOTA_PATTERNS`/`TERMINAL_QUOTA_PATTERNS` and the batch's own flags.
- A generic 403 is NOT automatically an access restriction; only explicit restriction signals qualify.

## Auto-disable (FR-021, FR-022, FR-025)

- Disable only when `classification === "hard_model_failure"` AND `autoDisable === true`.
- Write to `disabledModels` audit `{ id, reason, disabledAt, batchId }`.
- Never disable on `quota_cost`, `access_restriction`, `rate_limited`, `transport_indeterminate`, or `skipped`.
- Every disabled model is re-enableable via `DELETE /api/models/disabled` (FR-025/SC-012); audit retained.

## Storm halt (FR-024)

- Track consecutive `rate_limited` (threshold default 3) and, for burst-probe-prone providers, consecutive bot-block results (default 2).
- On threshold: stop the loop, set `stoppedEarly: true`, `stopReason: "consecutive_rate_limits" | "consecutive_bot_blocks"`.
- Untested/skipped models: NOT counted as failures; no disable inferred.

## Non-goals
- No provider flood: sequential only, `respectRateLimit` honored, bounded `modelIds`.
- No secrets in `error` (sanitize via existing error sanitizer).

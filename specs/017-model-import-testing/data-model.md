# Data Model: Model Import, Capability Discovery & Batch Testing

**Feature**: `017-model-import-testing` | **Date**: 2026-11-08

Persistence standard: `bun:sqlite` WAL (`src/lib/db/*`). Existing tables are extended; no new engine. Field names are conceptual; concrete columns follow the existing `schema.js`/repos conventions. All timestamps are ISO-8601 strings (existing convention).

---

## Existing tables extended

### `combos` (extend)
Existing columns (`src/lib/db/schema.js:117-126`): `id`, `name`, `kind`, `models`, `createdAt`, `updatedAt`.

Add:
- `cooldownMs` INTEGER NULL — per-combo failed-member cooldown (presets 60000 / 300000 / 3600000; validated bounds).
- (optional) `cooldownStrategy` TEXT NULL — reserved; default = fixed.

Validation: `cooldownMs` ∈ {60000, 300000, 3600000} (or documented bounds); NULL = use global default.

**combosRepo mapping (verified required)**: `src/lib/db/repos/combosRepo.js` must be updated in three places, or the column silently never persists:
- `rowToCombo` return object (today: `id,name,kind,models,createdAt,updatedAt`) → add `cooldownMs`.
- `createCombo` INSERT column list/params (today: `id,name,kind,models,createdAt,updatedAt`) → add `cooldownMs`.
- `updateCombo` UPDATE SET list (today: `name,kind,models,updatedAt`) → add `cooldownMs`.

### `providerNodes` (extend)
Existing: `id`, `type`, `name`, `data` (JSON holding `prefix`, `apiType`, `baseUrl`), `createdAt`, `updatedAt`.

Add (in `data` JSON, no migration needed unless indexed):
- `isSelfHosted` BOOLEAN — operator-declared local/self-hosted allowance (FR-062a).
- `allowInsecureTls` BOOLEAN — explicit, local-only self-signed TLS relaxation (FR-063a). MUST be rejected for non-self-hosted nodes.

### `model_context_overrides` (existing, supports provenance)
Existing columns (migrations `002`, `004`): `id`, `model_pattern`, `provider`, `model_id`, `context_window`, `max_output_tokens`, `source` (`manual` | `auto:discovery`), `created_at`, `updated_at`.

Write rules are the contract:
- `manual` rows are written only by the overrides API (S4) and MUST NEVER be written/updated/deleted by discovery/sync.
- `auto:discovery` rows are written/pruned by `reconcileContextWindows` (S1).

### `model_capability_overrides` (REQUIRES migration — verified gap)
Existing columns (`src/lib/db/schema.js`): `id`, `model_pattern`, `capabilities_json`, `created_at`, `updated_at`. **No `provider`, `model_id`, or `source` columns.**

Additive migration (registered in `src/lib/db/migrations/index.js`, next version after `004`, using `addColumnIfMissing`):
- `provider` TEXT NULL
- `model_id` TEXT NULL
- `source` TEXT DEFAULT `'manual'`  — must cover `manual` and `auto:discovery`
- index `(provider, model_id)` and optionally `(source)`
- **UNIQUE index** over `COALESCE(provider,'')` + `COALESCE(model_id, model_pattern)` + `COALESCE(source,'manual')` for deterministic, duplicate-free scoped overrides

**Deterministic ids + legacy NULL safety (verified)**: legacy `model_context_overrides`/`model_capability_overrides` rows created by migration `002` have `model_pattern NOT NULL` and `provider` NULL. Overrides MUST:
- Use deterministic ids: `manual:<provider>:<modelId>` and `auto:<provider>:<modelId>` (the reconciler already uses `id = auto:${provider}:${modelId}` + `INSERT OR REPLACE` — `src/lib/models/contextReconciler.js`).
- Match legacy rows by `model_pattern` when `provider` is NULL (the resolver's `findOverride` and `getExistingSource` already fall back to `model_pattern`); the migration's UNIQUE index must be NULL-safe (`COALESCE`) so legacy rows do not block new scoped rows.
- Be idempotent: a repeat POST with the same provider/model/field updates in place rather than inserting a duplicate.

**Schema version bump (verified)**: `src/lib/db/schema.js` sets `SCHEMA_VERSION = 5` and its own header requires a `+1` bump for every TABLES change; the bump drives the pre-change backup in `src/lib/db/migrate.js`. Every migration in this feature MUST bump it.

Rationale: FR-008a; the context table already has these columns but the capability table does not, so a provider-scoped capability override cannot be stored today.

> Note: migration `004` adds `source` to `model_capabilities` (a different table) and `provider`/`model_id`/`source` to `model_context_overrides` — it does NOT touch `model_capability_overrides`. The new migration must target `model_capability_overrides` explicitly.

### Resolution: per-field, not record-level (verified)
`resolveModelCapabilities` currently returns the first matching record wholesale (`buildResolved({ base: manual })`), so an override of one field discards other discovered/static fields. The contract is **per-field merge** across the cascade, with per-field provenance:

```
resolved[field] =
  manual[field] ?? auto:discovery[field] ?? providerStatic[field]
  ?? catalog[field] ?? exactModel[field] ?? pattern[field] ?? default[field]
```

This changes `resolveModelCapabilities` semantics (FR-009a) and must be covered by a per-field test (SC-026).

### `kv` (extend scopes, no schema change)
Existing: `kv(scope, key, value)` with atomic read-merge-write.

New scopes:
- `disabledModels` (existing scope) — **must remain backward-compatible**: callers (`src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, `src/app/api/models/disabled/route.js`) read a `string[]` of ids. Store audit as a parallel scope (e.g. `disabledModelAudit`) or return a `string[]` projection from `getDisabledModels()` so `{ id, reason, disabledAt, batchId }[]` metadata is added without breaking callers (FR-025a, SC-027).
- `syncPolicy` — `{ globalDefault: "enabled"|"disabled", providers: { [providerId]: "inherit"|"enabled"|"disabled" } }`.
- `retryPolicy` — `{ globalMs: number, providers: { [providerId]: number } }` (bounded).
- `freeProxySources` — `{ sources: { "1proxy"|"proxifly"|"iplocate": { enabled: boolean, lastSync?, lastError? } } }`.
- `gatewayTlsTrust` — optional; only for self-hosted nodes (keep minimal; prefer node JSON flag).

### `settings` (extend keys in `settingsRepo`)
Add settings keys (scope `settings`): `autoModelSyncDefault` (default `"disabled"`), `syncIntervalMs` (bounded, default 24h), `retryIntervalDefaultMs`, `batchTestStormThreshold` (default 3), `batchTestMax` (default 100).

---

## New / conceptual entities

### ImportedModel (catalog view)
- `provider` (built-in id or `openai-compatible`/`anthropic-compatible` node id)
- `connectionId` (originating connection)
- `modelId`
- `provenance`: `imported` | `manual` | `discovered`
- `lifecycle`: `active` | `stale` | `disabled`
- `capabilities`: resolved `CapabilityRecord` (below)
- Uniqueness key: `(provider, connectionId, modelId)` — idempotent upsert (FR-004).
- State transitions: `imported → active`; `active → stale` (vanished upstream, override preserved); `active ↔ disabled` (soft, reversible).

### CapabilityRecord (resolved, per field)
- `contextWindow`, `maxOutputTokens`
- `vision`, `tools`, `reasoning`, `audioInput`, `videoInput`, `pdf`, `search`, ... (existing capability keys; see `CAPACITY_META` in `src/shared/constants/models.js`)
- Per-field provenance: `manual` | `auto:discovery` | `static` | `catalog` | `pattern` | `default`
- Unknown fields represented as `null`/unset (never fabricated) — FR-007.

### ManualOverride
- `provider`, `modelId`, `field`, `value`, `source="manual"`, `updatedAt`
- Highest precedence **per field**; durable across refresh (FR-010); exposed with provenance (FR-012).
- Capability overrides require the `model_capability_overrides` migration (provider/model_id/source) — FR-008a.

### OverrideCache (runtime, synchronous path)
- An in-process, invalidated view of persisted overrides keyed by `(provider, modelId)`.
- Loaded from SQLite on startup/config-reload and invalidated on override write and `CONFIG_RELOAD` (scope `settings`).
- Purpose: the request path is synchronous (`resolveCaps` in `src/domain/requestCapabilities.js` calls `getCapabilitiesForModel` synchronously), so an async DB read cannot be added inline; the cache keeps resolution synchronous while override-aware (FR-009b).

### SyncPolicy
- `globalDefault`: `enabled` | `disabled` (default `disabled`)
- `providers[providerId]`: `inherit` | `enabled` | `disabled`
- Resolution table (SC-009):

| global \ provider | inherit | enabled | disabled |
|---|---|---|---|
| enabled | sync | sync | no sync |
| disabled | no sync | sync | no sync |

### ModelTestResult
- `modelId`, `status` (`ok`|`error`|`slow`)
- `classification`: `success` | `hard_model_failure` | `quota_cost` | `access_restriction` | `rate_limited` | `transport_indeterminate`
- `latencyMs`, `statusCode?`, `error?` (sanitized), flags `rateLimited`/`isQuota`/`isTransient`/`isTimeout`/`skipped`
- `disabled?` (true only when auto-disabled on hard failure)

### BatchTestRun
- `providerId`, `connectionId?`, `modelIds[]` (≤ max), `options { autoDisable, respectRateLimit }`
- `results: { [modelId]: ModelTestResult }`, `summary { added?, disabled, tested, total }`
- `stoppedEarly?`, `stopReason?` (`consecutive_rate_limits` | `consecutive_bot_blocks`)

### ProxyRotationFailure
- `scopeType`: `global` | `provider` | `account` | `combo` | `key`
- `scopeId` (required unless `global`; FR-029)
- `poolId`, `reason`, `at`
- Classification: transport health only (never quota/credential) — FR-030.

### RetryPolicy
- `globalMs`, `providers[providerId]`
- Bounds enforced; effective wait = `max(configuredMs, retryAfterMs)` (FR-033); never bypasses access/regional restriction (FR-034).

### ComboMemberCooldown (runtime, maps to in-memory + combo config)
- Key: `` `${scope}::${comboName}::${modelStr}` `` (existing)
- `untilEpochMs`, `reason`, `cooldownMs` (from combo config or default), `scope`
- Expiry: silent eligibility restore (FR-041); bounded map (existing `MAX_COOLDOWN_ENTRIES = 1000`).

### FreeProxySource
- `id`: `1proxy` | `proxifly` | `iplocate` (webshare excluded first slice)
- `enabled` (default false), `apiUrl`, `lastSync`, `lastError`
- Fetched items: `{ host, port, type (http|https), countryCode, qualityScore, latencyMs, anonymity, lastValidated }`
- Protocol filter: HTTP/HTTPS only; `socks4/socks5` rejected/deferred (R6).

### FreeProxyPool
- Pool record in `proxyPools` (`data.source = "free:<sourceId>"`) — distinguished from operator pools (FR-049).
- Members validated by the outbound-URL guard (private/loopback/link-local/metadata rejected — FR-050).
- Bound to strict-proxy/Psiphon connections retains fail-closed behavior (FR-052).

### GatewayUrlSafetyPolicy (conceptual)
- Applies at create/update/validate/discovery/sync.
- Layers: `assertPublicUrl` → `assertPublicUrlResolved` → `fetchPublic` (redirect re-validation, `maxRedirects` bounded).
- Local allowance: persisted `isSelfHosted` authorizes background work; a non-local/proxied request never inherits it (FR-062a).
- TLS: verify by default; `allowInsecureTls` only for self-hosted, never remote/strict-proxy (FR-063a).

### PsiphonVpsEvidence (conceptual, evidence-gated)
- `collectedAt`, `artifacts[]` (logs/timings/exit-IP/region/error signatures), `hypothesis?`, `reproduced: boolean`
- A fix (and its regression test) may exist only if `reproduced` is true; otherwise status = blocked.

---

## Relationships

- `ProviderNode 1—* ProviderConnection` (existing).
- `ImportedModel *—1 ProviderConnection`, *—1 ProviderNode (compatible gateways).
- `CapabilityRecord 1—1 ImportedModel`; `ManualOverride *—1 ImportedModel` (by provider+modelId).
- `SyncPolicy 1—* ProviderNode/Provider` (per-provider override).
- `BatchTestRun 1—* ModelTestResult`; a disabled result writes to `disabledModels` audit.
- `FreeProxyPool 1—* FreeProxySource-provenance`; pool members gated by outbound-URL guard.
- `ProxyRotationFailure` scoped to exactly one of global/provider/account/combo/key.

## Validation Rules (from requirements)

- Import idempotent on `(provider, connectionId, modelId)`; summary counts sum to input count (FR-004/FR-005).
- Manual override wins over discovery; 5 refresh cycles no overwrite (FR-010, SC-003).
- Unknown capability fields stay unknown (FR-007).
- Sync policy table is deterministic (SC-009); failed sync never truncates catalog (FR-017).
- Auto-disable only for `hard_model_failure` (FR-021/FR-022); disable records reason+time (FR-025).
- Non-global rotation scope requires `scopeId` (FR-029).
- Effective retry wait ≥ upstream `Retry-After` (FR-033).
- Cooldown presets restore silently at expiry (FR-041); scope-isolated (FR-042).
- Free-proxy sources default off (FR-048); unsafe hosts rejected (FR-050); credential never logged (FR-053).
- SSRF: all custom-gateway URLs pass literal + DNS + redirect re-validation (FR-058/FR-059); no unguarded raw fetch (FR-060); create/update guarded (FR-061).
- TLS verification on by default; relax only for declared-local (FR-063a).

# Contract: Model Import & Discovery API

**Slices**: S0 (guarded fetch), S1 (wiring), S3 (import), S4 (overrides)
**Requirements**: FR-001..FR-012, FR-058..FR-063a, FR-065

All endpoints are behind existing dashboard authentication (FR-037). Errors never include secrets.

## POST `/api/models/import`

Discover the model listing advertised by a connection and import it.

**Request**
```json
{
  "providerId": "openai-compatible-chat-abc123 | anthropic-compatible-7f2 | openrouter | ...",
  "connectionId": "conn-42",
  "mode": "merge" | "sync"
}
```

**Server behavior**
1. Resolve the connection/node; resolve its `baseUrl`.
2. Fetch listing through the **guarded** path:
   - literal check → DNS-aware check → redirect-re-validating `fetchPublic` with bounded `maxRedirects`.
   - self-hosted nodes use the persisted `isSelfHosted` allowance (background-safe); non-local/proxied requests never inherit it.
3. `normalizeDiscoveredModels(payload, providerId)` (never throws).
4. Upsert idempotently on `(provider, connectionId, modelId)`; do not overwrite `manual` overrides.
5. Reconcile discovered limits and capabilities per field (never clobber manual pins).
6. On a complete, successful authoritative listing, reconcile removal of obsolete previously imported models within that source/provider/connection scope. Remove them from active catalog visibility; retain manual overrides and user-created models, preserve audit evidence, and report affected combo references rather than silently replacing members. Do not remove a shared model if another active source still advertises it.
7. Failed, malformed, partial, fallback/static, filtered, or pagination-incomplete discovery is non-authoritative for removal and MUST NOT delete existing models. An empty listing alone is insufficient proof of retirement; require explicit validated authoritative-empty semantics. Report why pruning was skipped. Import defaults must not leave confirmed obsolete models active; an explicit merge-only mode, if retained for recovery, must be visibly non-reconciling.

**Response 200**
```json
{
  "added": 12, "updated": 3, "skipped": 1, "failed": 2,
  "removed": 2, "pruningSkippedReason": null, "complete": true,
  "failures": [ { "index": 7, "reason": "missing id" } ],
  "reconciled": { "written": 1, "removed": 0, "skippedManual": 2 }
}
```

**Errors**
- `400` invalid provider/connection or invalid URL.
- `403` URL refused by SSRF guard (`{"error":"URL not allowed","layer":"dns|literal|redirect"}`).
- `409` provider has no active connections.
- `502/504` upstream unreachable (sanitized).
- Never `500` due to a malformed model record (isolated, counted in `failed`).

**Invariants**
- Added + updated + skipped + failed sum to the number of input records (SC-001/SC-002); removed counts prior catalog records separately.
- Fixture tests must prove pruning on complete snapshots, no pruning on partial/fallback/failure, idempotency, manual override retention, source isolation, and shared-source retention.
- After implementation, run an opt-in, read-only live discovery against verified public provider endpoints through the actual discovery service, then import into a disposable isolated database, compare exact IDs and available metadata to the authoritative response, and repeat to verify idempotency. Do not modify production data or consume inference quota. Live listing smoke tests complement deterministic regression tests, not replace them.
- Re-import of identical listing yields `added=0`, `updated=N`.

## GET `/api/models/overrides?provider=&modelId=`

Return resolved capability record with **per-field provenance** (FR-012).

**Response 200**
```json
{
  "provider": "openrouter", "modelId": "vendor/model-x",
  "capabilities": { "vision": true, "contextWindow": 200000, "maxOutputTokens": 8192 },
  "provenance": { "vision": "manual", "contextWindow": "auto:discovery", "maxOutputTokens": "static" }
}
```

## POST `/api/models/overrides`

Write a `manual` override (highest precedence, durable, per-field).

**Request**
```json
{ "provider": "openrouter", "modelId": "vendor/model-x", "field": "contextWindow", "value": 400000 }
```
- Only documented fields accepted (context window, output limit, capability booleans).
- Writes `source="manual"` rows only, with deterministic `id = manual:<provider>:<modelId>`.
- Idempotent: a repeat POST for the same (provider, modelId, field) updates in place (no duplicate row); enforced by a NULL-safe UNIQUE index over `COALESCE(provider,'')`+`COALESCE(model_id, model_pattern)`+`COALESCE(source,'manual')`.
- Legacy rows with `provider` NULL are matched via `model_pattern` and are not broken by the new scoped rows.
- Discovery/sync MUST NOT modify these rows.

**Response** `200 { "ok": true, "provenance": { "contextWindow": "manual" } }`
**Errors** `400` invalid field/value; `403` if the provider/model is not importable.

## DELETE `/api/models/overrides?provider=&modelId=&field=`

Remove a manual override (reverts to next precedence layer). `200 { "ok": true, "provenance": { "contextWindow": "static" } }`.

## Runtime wiring contract (FR-065, SC-025)

- `resolveModelCapabilities({provider, model}, { manualOverrides, autoOverrides, catalogSource }, { persistedOverrides })` must be invoked by the request-path capability lookup (today `getCapabilitiesForModel` in `src/domain/requestCapabilities.js`) and by combo capability gating (`open-sse/services/combo.js` → `src/domain/requestCapabilities.js`).
- `getCapabilitiesForModel` remains the catalog floor fed into the resolver as `sources`.
- Proof: an integration test where a manual override changes a routing/capability decision, and a discovery test where a reconciled value changes the resolved record.

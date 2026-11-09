# Contract: Sync Policy API

**Slice**: S7 · **Requirements**: FR-013..FR-018, FR-064 · **Evidence**: `src/lib/modelCatalog/sync.js`, `src/lib/db/repos/settingsRepo.js`

Behind dashboard auth. Automatic sync is **off by default**.

## GET `/api/models/sync-policy`

```json
{
  "globalDefault": "disabled",
  "providers": {
    "openrouter": "inherit",
    "openai-compatible-chat-abc123": "enabled",
    "anthropic-compatible-7f2": "disabled"
  },
  "intervalMs": 86400000
}
```

## PUT `/api/models/sync-policy`

```json
{ "globalDefault": "enabled", "providers": { "openrouter": "enabled" } }
```

Validation
- `globalDefault` ∈ `enabled|disabled`.
- each provider value ∈ `inherit|enabled|disabled`.
- provider ids may be built-in ids or compatible node ids (`openai-compatible-*`, `anthropic-compatible-*`).
- `intervalMs` bounded (documented min/max); rejected otherwise.
- Unknown ids are rejected `400` (not silently ignored).

## Resolution semantics (FR-014, SC-009)

| global \ provider | inherit | enabled | disabled |
|---|---|---|---|
| enabled | sync | sync | no sync |
| disabled | no sync | sync | no sync |

- `inherit` = resolve to global default at run time.
- Applies identically to built-in providers and user-created compatible gateways (FR-015).

## Scheduler behavior (FR-016..FR-018, FR-064)

- Uses its own **sync interval** (`syncIntervalMs`), distinct from retry intervals.
- Bounded: finite fetch timeout, bounded concurrency, bounded redirect hops (via guarded fetch).
- Fail-open: a failed/partial sync retains the existing catalog (atomic `.tmp`+rename already in `src/lib/modelCatalog/sync.js`); never wipes.
- Preserves all `manual` overrides and manual metadata (discovery/sync never write `manual` rows).
- Must not block request routing (background timing).

## Credential handling (FR-063)

- Gateway credentials are scoped to their host; never forwarded across an origin/host change on redirect.
- Never logged, never included in sync result payloads or error bodies.

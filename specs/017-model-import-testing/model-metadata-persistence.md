# Spec 017 Addendum: Foundational Model Metadata Persistence & Executable Unlazy Gates

**Feature**: `017-model-import-testing`  
**Slice**: Foundational Model Metadata Persistence (DB Migrations & Repository)  
**Date**: 2026-11-08  
**Status**: Approved & Executable  

---

## 1. Scope & Strict Ownership Contract

This slice establishes the foundational persistence layer for model metadata, capability overrides, and imported catalog membership in 9Router. Per Spec 017 and system boundary rules, this slice strictly owns and modifies ONLY:

1. `specs/017-model-import-testing/model-metadata-persistence.md` (this design & gates document)
2. `src/lib/db/schema.js` (declarative schema update + `SCHEMA_VERSION = 6` bump)
3. `src/lib/db/migrations/005-model-metadata.js` (additive migration 005)
4. `src/lib/db/migrations/index.js` (migration registry update)
5. `src/lib/db/repos/modelMetadataRepo.js` (repository implementation)
6. `tests/unit/model-metadata-repo.test.js` (comprehensive test suite)

**Exclusions**: Combos migration (`006`), UI components, and runtime routing handlers remain untouched in this slice to ensure zero runtime behavior change and independent mergeability.

---

## 2. Architecture & Persistence Design

### 2.1 Schema Version Bump & Declarative Tables (`src/lib/db/schema.js`)

`SCHEMA_VERSION` is bumped from `5` to `6` to trigger the pre-migration backup in `migrate.js`.

The declarative schema in `schema.js` is updated in two places:
1. `model_capability_overrides` table definition is extended with:
   - `provider`: `TEXT NULL`
   - `model_id`: `TEXT NULL`
   - `source`: `TEXT DEFAULT 'manual'`
   - Indexes:
     - `idx_mcap_provider_model`: `(provider, model_id)`
     - `idx_mcap_source`: `(source)`
     - `idx_mcap_scope_unique`: `(provider, model_id, source) WHERE provider IS NOT NULL AND model_id IS NOT NULL` UNIQUE partial index
2. `imported_models` table is declared:
   - `id`: `TEXT PRIMARY KEY` (bounded, collision-free deterministic ID)
   - `provider`: `TEXT NOT NULL`
   - `connection_id`: `TEXT NOT NULL`
   - `model_id`: `TEXT NOT NULL`
   - `provenance`: `TEXT NOT NULL DEFAULT 'imported'`
   - `lifecycle`: `TEXT NOT NULL DEFAULT 'active'` (`'active'` | `'stale'` | `'disabled'`)
   - `capabilities_json`: `TEXT`
   - `metadata_json`: `TEXT`
   - `created_at`: `TEXT NOT NULL`
   - `updated_at`: `TEXT NOT NULL`
   - `last_seen_at`: `TEXT NOT NULL`
   - Indexes:
     - `idx_im_provider_conn`: `(provider, connection_id)`
     - `idx_im_provider_model`: `(provider, model_id)`
     - `idx_im_lifecycle`: `(lifecycle)`
     - `idx_im_unique_source`: `(provider, connection_id, model_id)` UNIQUE

### 2.2 Additive Migration 005 (`src/lib/db/migrations/005-model-metadata.js`)

- Version: `5`, Name: `"005-model-metadata"`.
- Uses `addColumnIfMissing` with `PRAGMA table_info` checks:
  - Adds `provider`, `model_id`, `source` to `model_capability_overrides`.
- Executes idempotent index creation:
  - `idx_mcap_provider_model` and `idx_mcap_source`.
  - `idx_mcap_scope_unique` on `model_capability_overrides`: partial unique index excluding legacy NULL-provider rows (`WHERE provider IS NOT NULL AND model_id IS NOT NULL`). Legacy duplicate wildcard rows remain valid and non-destructive.
  - `CREATE TABLE IF NOT EXISTS imported_models` with its supporting indexes.
  - No unique index added to `model_context_overrides` (reconciler manages uniqueness via `id`).
- Guaranteed re-run safety (idempotent; no duplicate column errors).

### 2.3 Unambiguous, Bounded Composite Key Generation

Naive delimiter joins (`a:b:c`) suffer from delimiter collision if `provider`, `connection_id`, or `model_id` contain colons or slashes.
We use a canonical length-prefixed and URI-encoded composite key format:
- For overrides:
  `ovr::<source>::<len(enc(provider))>-<enc(provider)>::<len(enc(modelId))>-<enc(modelId)>`
- For imported catalog:
  `imp::<len(enc(provider))>-<enc(provider)>::<len(enc(connId))>-<enc(connId)>::<len(enc(modelId))>-<enc(modelId)>`

Bounds:
- Maximum length is strictly bounded to 384 characters. If a model identifier is exceptionally long, a deterministic SHA-256 digest is appended to the bounded prefix.
- Zero delimiter ambiguity: URI encoding escapes all `:` into `%3A`, so `::` and `-` delimiters never clash.

### 2.4 Transactional Immediate Semantics & Rollbacks

All mutating repository methods use `adapter.immediate(fn)`:
- Takes the SQLite write lock upfront via `BEGIN IMMEDIATE` to prevent deadlock and `SQLITE_BUSY` contention during read-modify-write cycles.
- If any error or validation failure occurs within the transaction, the entire batch is rolled back immediately; no partial state is persisted.

### 2.5 Field-Level Distinction & Nullable Fields

- **Nullable unknown, not false**: In accordance with FR-007, an absent, `null`, or unverified capability or limit is stored as `null` (unknown), never coerced to `false` or `0`.
- **Reasoning validation**: Reason levels are validated against an enum/shape (`true`, `false`, `null`, or an object `{ supported: boolean, effortLevels: string[] }`).
- **No credentials**: All inputs are deeply scrubbed for credential patterns (`apiKey`, `token`, `secret`, `password`, `auth`). If credential keys are detected, they are discarded and excluded from storage.

### 2.6 Snapshot Pruning with Shared-Source Protection

When an authoritative import snapshot runs for `(provider, connection_id)`:
1. **Safety gates**:
   - `complete === true` is mandatory; partial, paginated, or failing listings immediately skip pruning with reason `'incomplete_snapshot'`.
   - Empty listings require `authoritativeEmpty === true`; otherwise pruning is skipped with reason `'authoritative_empty_required'`.
2. **Shared-source preservation**:
   - Obsolete models missing from connection A's snapshot are pruned from connection A.
   - If connection B also advertises the model for the same provider, the model remains active in the shared catalog!
3. **Manual override preservation**:
   - Operator manual overrides (`source = 'manual'`) are NEVER deleted or modified by snapshot pruning.

---

## 3. Executable Unlazy Acceptance Gates

The following 7 gates must pass sequentially with concrete verification commands.

| Gate | Name | Requirement / Invariant | Verification Command |
|---|---|---|---|
| **Gate 1** | Contract Completeness | Spec addendum, schema definitions, and migration registry are valid | File inspection & import verification |
| **Gate 2** | Full Migration Chain | Fresh DB and upgrade from v4 apply cleanly and idempotently | `bun x vitest run unit/model-metadata-repo.test.js -t "migration chain"` |
| **Gate 3** | Collision-Free Bounded IDs | Distinct composite parameters never yield identical keys; max length ≤ 384 | `bun x vitest run unit/model-metadata-repo.test.js -t "key generation"` |
| **Gate 4** | Immediate Transaction & Rollback | Atomicity: all-or-nothing writes; failure aborts without leaving partial state | `bun x vitest run unit/model-metadata-repo.test.js -t "transaction rollback"` |
| **Gate 5** | Field-Level & Nullable Safety | `null` is unknown not `false`; reason levels validated; credentials stripped | `bun x vitest run unit/model-metadata-repo.test.js -t "field-level"` |
| **Gate 6** | Shared-Source Snapshot Pruning | Pruning removes connection-specific models, protects shared models & manual overrides | `bun x vitest run unit/model-metadata-repo.test.js -t "snapshot pruning"` |
| **Gate 7** | Legacy Row Preservation | Legacy `provider IS NULL` rows preserved and resolved deterministically | `bun x vitest run unit/model-metadata-repo.test.js -t "legacy rows"` |

---

## 4. Repository Method Signatures (`modelMetadataRepo.js`)

```typescript
// Key generation
function buildOverrideId(source: string, provider: string, modelId: string): string;
function buildImportedModelId(provider: string, connectionId: string, modelId: string): string;

// Capabilities & Overrides
async function upsertCapabilityOverride(params: {
  provider?: string | null,
  modelId?: string | null,
  modelPattern?: string | null,
  capabilities: Record<string, any>,
  source?: 'manual' | 'auto:discovery'
}): Promise<CapabilityOverrideRecord>;

async function getCapabilityOverride(params: {
  provider?: string | null,
  modelId?: string | null,
  modelPattern?: string | null,
  source?: 'manual' | 'auto:discovery' | 'any'
}): Promise<CapabilityOverrideRecord | null>;

async function listCapabilityOverrides(params?: {
  provider?: string,
  source?: string,
  limit?: number,
  offset?: number
}): Promise<CapabilityOverrideRecord[]>;

async function deleteCapabilityOverride(params: {
  provider?: string | null,
  modelId?: string | null,
  modelPattern?: string | null,
  source?: 'manual' | 'auto:discovery'
}): Promise<{ deleted: boolean }>;

// Imported Catalog Membership & Snapshot Pruning
async function upsertImportedModel(params: {
  provider: string,
  connectionId: string,
  modelId: string,
  capabilities?: Record<string, any> | null,
  metadata?: Record<string, any> | null,
  provenance?: string,
  lifecycle?: 'active' | 'stale' | 'disabled'
}): Promise<ImportedModelRecord>;

async function batchUpsertImportedModels(params: {
  provider: string,
  connectionId: string,
  models: Array<{
    modelId: string,
    capabilities?: Record<string, any> | null,
    metadata?: Record<string, any> | null
  }>,
  provenance?: string
}): Promise<{ added: number, updated: number, total: number }>;

async function pruneImportedSnapshot(params: {
  provider: string,
  connectionId: string,
  activeModelIds: string[],
  options?: {
    complete?: boolean,
    authoritativeEmpty?: boolean
  }
}): Promise<{
  pruned: number,
  retainedShared: number,
  skipped: boolean,
  reason?: string | null
}>;

async function listImportedModels(params?: {
  provider?: string,
  connectionId?: string,
  lifecycle?: string,
  limit?: number,
  offset?: number
}): Promise<ImportedModelRecord[]>;

async function getResolvedModelMetadata(params: {
  provider: string,
  modelId: string
}): Promise<{
  provider: string,
  modelId: string,
  capabilities: Record<string, any>,
  provenance: Record<string, string>,
  metadata: Record<string, any>
}>;
```

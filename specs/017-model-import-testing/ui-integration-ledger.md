# Spec 017 UI Integration Slice Ledger: Model Management, Discovery & Capability Overrides

**Feature**: `017-model-import-testing`
**Slice**: UI Integration (Provider Detail Model Management Panel & Override Modal)
**Date**: 2026-11-08
**Status**: Frozen & Verified (Pending Backend PR145 / PR146 Merge)

---

## 1. Ownership & Boundary Contract

This slice strictly owns and modifies only the frontend provider detail page and its sub-components:

1. `src/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js` (NEW: compact multi-feature panel)
2. `src/app/(dashboard)/dashboard/providers/[id]/ModelOverrideModal.js` (NEW: per-model tri-state capability editor)
3. `src/app/(dashboard)/dashboard/providers/[id]/page.js` (Provider detail container: panel mount, model union, event dispatch)
4. `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js` (Added `onEditCaps` button)
5. `src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js` (Added `onEditCaps` and wired `onChanged`)
6. `src/app/(dashboard)/dashboard/providers/[id]/PassthroughModelsSection.js` (Added `onEditCaps`)
7. `tests/unit/model-management-ui.test.js` (NEW: comprehensive unit test suite via React 19.3.1 renderer)
8. `specs/017-model-import-testing/ui-integration-ledger.md` (this audit ledger)

**Explicit Exclusions**:
- Combos UI, Settings UI, Proxy Pools UI are untouched.
- Backend API routes remain under backend owner slices (PR145 and PR146).
- Zero Node.js dynamic code in client components (`fs`, `path`, etc. are prohibited in `"use client"` modules).
- No blanket ESLint ignore comments.

---

## 2. Architecture & UI Contracts

### 2.1 ModelManagementPanel (`ModelManagementPanel.js`)

A compact tabbed component mounted once per provider directly above the model listings within the Available Models card.

- **Props**:
  - `providerId` (`string`): The active provider identifier.
  - `connections` (`array`): Active connections filtered via `isActive !== false`.
  - `visibleModelIds` (`string[]`): Union of static, live, custom, suggested, and disabled models.
  - `onChanged` (`function`): Refresh callback updating custom models, aliases, and disabled lists, followed by dispatch of `customModelChanged` on `window`.

- **Four Core Features**:
  1. **Import Models (`POST /api/providers/:connectionId/import-models`)**:
     - Uses connection dropdown when multiple active connections exist.
     - Explains when no connection is configured ("Importing models requires an active connection (not supported without a connection until synthetic listings are available)") without disabling the provider permanently.
     - Displays full summary: added, updated, removed, preserved (manual), unchanged, and non-authoritative listing warnings.
     - Wires `onChanged` on success.
  2. **Batch Testing (`POST /api/models/test-batch`)**:
     - Explicit scope label: *"Tests use this provider’s configured account routing"*.
     - Cost warning: *"Tests send real requests and may consume quota/credits"*.
     - Checkbox: *"Disable confirmed failing models"* (default `false`, unchecked).
     - Chunking at hard backend boundary of 100 IDs (`BATCH_SIZE = 100`). Shows exact remaining count and pagination controls ("Next Batch") without silent truncation.
     - Cancellation via `AbortController`.
     - Explicit classifications: passed, broken, quota exceeded, access/auth error, transport error, disabled count, skipped count. Quota/access/transport errors are never mislabeled as broken models.
     - Reversible audit log readout via `GET /api/models/test-batch?providerId=:id`.
  3. **Automatic Sync Policy (`GET` / `PUT /api/models/sync-policy`)**:
     - Global policy controls: Global Default Toggle and Global Interval (1h - 168h / 7d).
     - Provider-specific policy: "inherit" (default) | "enabled" | "disabled", plus custom interval input.
     - Safe partial updates: Merges `providers[providerId]` with server's existing providers map so other provider policies are never clobbered.
     - Abort-safe loading, never defaulting to disabled while loading.
  4. **Capability Overrides Entry**:
     - Model selector across the visible + disabled models union.
     - "Edit Capabilities" button opening `ModelOverrideModal`.

### 2.2 ModelOverrideModal (`ModelOverrideModal.js`)

A modal for inspecting and editing manual capability overrides per model.

- **Contracts & Backend Alignment**:
  - `GET /api/models/overrides?provider=:provider&modelId=:modelId`:
    - Returns `{ resolved, provenance, manual }`.
    - Form initial state is populated **strictly from `data.manual`**. It never infers manual values from resolved catalog defaults.
  - **Tri-State Modality Fields**:
    - `supportsVision`, `supportsTools`, `supportsReasoning`, `supportsAudio`, `supportsVideo`, `supportsStreaming`, `supportsImageGeneration`, `supportsImageEditing`, `supportsWebSearch`, `supportsWebFetch`.
    - States: `"auto"` (inherited), `"true"` (explicitly enabled), `"false"` (explicitly disabled).
  - **Numeric Nullable Limits**:
    - `contextWindow`: positive integer or blank (auto).
    - `maxOutputTokens`: positive integer or blank (auto).
  - **Reasoning Object**:
    - `reasoning.supported`: tri-state (`"auto"`, `"true"`, `"false"`).
    - `reasoning.effortLevels`: array of string tokens (e.g. `["low", "medium", "high", "max"]`).
  - `PUT /api/models/overrides`:
    - Sends `{ provider, modelId, capabilities: manualDraft }`.
    - `manualDraft` contains only fields with explicit manual values. Fields left as `"auto"` are omitted, allowing atomic clearance of manual overrides and reverting to automatic defaults.
  - `DELETE /api/models/overrides?provider=:provider&modelId=:modelId`:
    - "Reset to Automatic" resets the entire manual override for the model.
  - **Provenance Readout**:
    - Collapsible section showing resolved context window, max output, and source provenance.

---

## 3. Verification & Test Evidence

### 3.1 Unit Test Suite (`tests/unit/model-management-ui.test.js`)
All 12 unit tests pass under Bun using React 19.3.1 (`react-test-renderer`):

```
 RUN  v5.0.5 /home/redsnow/KhatamRouter/.claude/worktrees/agent-aa593460c48caf483/tests

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  17:23:05
   Duration  272ms
```

### 3.2 Regression Verification
All existing capability, UI, and model tests pass with zero regressions:
- `tests/unit/capabilities.test.js` (35 passed)
- `tests/unit/capability-badges.test.js` (15 passed)
- `tests/unit/smart-router-ui.test.js` (6 passed)
- `tests/unit/model-select-zed-live-regression.test.js` (14 passed)
- `tests/unit/model-management-ui.test.js` (12 passed)

### 3.3 ESLint Cleanliness
All 6 owned frontend files pass ESLint with 0 errors and 0 warnings:
```bash
bun x eslint \
  "src/app/(dashboard)/dashboard/providers/[id]/page.js" \
  "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js" \
  "src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js" \
  "src/app/(dashboard)/dashboard/providers/[id]/PassthroughModelsSection.js" \
  "src/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js" \
  "src/app/(dashboard)/dashboard/providers/[id]/ModelOverrideModal.js"
```
Output: `(completed with no errors or warnings)`

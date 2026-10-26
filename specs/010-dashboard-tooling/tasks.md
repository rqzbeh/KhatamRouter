---
description: "Task list for Dashboard and Tooling implementation"
---

# Tasks: Dashboard and Tooling

**Input**: Design documents from `/specs/010-dashboard-tooling/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/`)  
**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/`  
**Tests**: Bun-hosted Vitest unit test suites (`tests/unit/connection-limits-modal.test.js`, `tests/unit/key-quota-tabs.test.js`, `tests/unit/capability-badges.test.js`, `tests/unit/cli-consolidated.test.js`, `tests/unit/wave8-integration.test.js`), baseline checks (`node tests/__baseline__/verify-providers.mjs`, `node tests/__baseline__/verify-alias.mjs`)  
**Organization**: Tasks are grouped by User Story and Phase with strictly disjoint file ownership to enable independent, parallel subagent execution across Wave 1 (Leaves 1.1.1, 1.1.2, 1.1.3, 1.1.4) and sequential integration in Wave 2 (Leaf 1.1.5).

---

## Phase 1: Setup & Environment Validation

**Purpose**: Verify repository, TypeScript configuration, and isolated test runtime.

- [ ] T001 [P] Verify Bun `v1.4.3+` and Vitest test environment  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `tests/unit/connection-limits-modal.test.js`  
  *Check oracle*: `bun x vitest --version && bun --version`

- [ ] T002 [P] Verify TypeScript compiler options for React JSX and `@/*` alias in root `tsconfig.json`  
  *Leaf*: leaf-1.1.4 (Wave 1)  
  *Files owned*: `cli/tsconfig.json`  
  *Check oracle*: `node -e 'const c = require("./tsconfig.json"); if (!c.compilerOptions.paths["@/*"]) process.exit(1); console.log("TSCONFIG_OK");'`

- [ ] T003 [P] Verify directory scaffolding for new dashboard and CLI components under `src/app/(dashboard)/dashboard/quota/components/` and `cli/src/ts/`  
  *Leaf*: leaf-1.1.4 (Wave 1)  
  *Files owned*: `cli/src/ts/**`  
  *Check oracle*: `node -e 'const fs = require("fs"); fs.mkdirSync("src/app/(dashboard)/dashboard/quota/components", {recursive: true}); fs.mkdirSync("cli/src/ts/commands", {recursive: true}); console.log("SCAFFOLD_OK");'`

---

## Phase 2: Foundational Schemas

**Purpose**: Shared interfaces and validation contracts required by user stories.

- [ ] T004 [P] Define schemas for connection limits in `src/shared/types/connectionLimits.js` matching `contracts/connection-limits.json`  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `src/shared/types/connectionLimits.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js -t "Schema|Types"`

- [ ] T005 [P] Define schemas for key quota and spend ledger in `src/shared/types/keyQuota.js` matching `contracts/key-quota.json`  
  *Leaf*: leaf-1.1.2 (Wave 1)  
  *Files owned*: `src/shared/types/keyQuota.js`  
  *Check oracle*: `bun x vitest run unit/key-quota-tabs.test.js -t "Types|Interfaces"`

- [ ] T006 [P] Note: CLI TypeScript interfaces removed per Principle II (plain JavaScript ESM)  
  *Leaf*: leaf-1.1.4 (Wave 1)  
  *Files owned*: `cli/cli.js`  

**Checkpoint**: Foundational schemas established; user story implementation can proceed in parallel.

---

## Phase 3: User Story 1 — Per-Connection Limits Modal (Priority: P1) 🎯 MVP

**Goal**: Provide a React dialog (`ConnectionLimitsModal.js`) for managing per-connection rate limits, spacing, wait ceilings, in-flight concurrency caps, and USD budget caps.  
**Independent Test**: `bun x vitest run unit/connection-limits-modal.test.js`

### Tests for User Story 1
- [ ] T007 [P] [US1] Create unit test suite for connection limits modal validation, overrides sanitization, and budget cap in `tests/unit/connection-limits-modal.test.js`  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `tests/unit/connection-limits-modal.test.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js`

### Implementation for User Story 1
- [ ] T008 [P] [US1] Add additive `maxBudgetUsd` validation and sanitization to `open-sse/services/rateLimitManager/overrides.js` preserving all existing field validations  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `open-sse/services/rateLimitManager/overrides.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js -t "Validation|Sanitization|Budget"`

- [ ] T009 [P] [US1] Implement backend API handler in `src/app/api/providers/[id]/limits/route.js` validating inputs with `validateConnectionLimitOverrides()` and persisting to `providerConnections.rate_limit_overrides_json`  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `src/app/api/providers/[id]/limits/route.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js -t "Persistence|Schema|API"`

- [ ] T010 [P] [US1] Implement React modal component `src/shared/components/ConnectionLimitsModal.js` supporting rate limits, pacing, wait ceilings, concurrency, modelConcurrency, and maxBudgetUsd  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `src/shared/components/ConnectionLimitsModal.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js -t "Render|ModelConcurrency|Budget"`

- [ ] T011 [US1] Add client-side input validation, error messaging, and form state management to `src/shared/components/ConnectionLimitsModal.js`  
  *Leaf*: leaf-1.1.1 (Wave 1)  
  *Files owned*: `src/shared/components/ConnectionLimitsModal.js`  
  *Check oracle*: `bun x vitest run unit/connection-limits-modal.test.js -t "Validation|ErrorMessaging"`

**Checkpoint**: User Story 1 is fully functional and testable independently via `tests/unit/connection-limits-modal.test.js`.

---

## Phase 4: User Story 2 — Key Quota Tabs & Spend Trends (Priority: P1)

**Goal**: Dedicated dashboard views providing real-time visualization of per-key quota utilization, sliding-window consumption, and historical spend trends.  
**Independent Test**: `bun x vitest run unit/key-quota-tabs.test.js`

### Tests for User Story 2
- [ ] T012 [P] [US2] Create unit test suite for key quota utilization calculations and spend ledger aggregations in `tests/unit/key-quota-tabs.test.js`  
  *Leaf*: leaf-1.1.2 (Wave 1)  
  *Files owned*: `tests/unit/key-quota-tabs.test.js`  
  *Check oracle*: `bun x vitest run unit/key-quota-tabs.test.js`

### Implementation for User Story 2
- [ ] T013 [P] [US2] Implement authenticated backend API route `src/app/api/keys/[id]/quota/route.js` for reading and updating `api_key_quota_limits` and querying `getCumulativeSpendForWindow`  
  *Leaf*: leaf-1.1.2 (Wave 1)  
  *Files owned*: `src/app/api/keys/[id]/quota/route.js`  
  *Check oracle*: `bun x vitest run unit/key-quota-tabs.test.js -t "API|FailOpen"`

- [ ] T014 [P] [US2] Implement spend trends visualization component `src/app/(dashboard)/dashboard/quota/components/SpendTrendsChart.js` plotting daily/hourly cost and token volume from `request_cost_ledger`  
  *Leaf*: leaf-1.1.2 (Wave 1)  
  *Files owned*: `src/app/(dashboard)/dashboard/quota/components/SpendTrendsChart.js`  
  *Check oracle*: `bun x vitest run unit/key-quota-tabs.test.js -t "SpendTrends|Ledger"`

- [ ] T015 [US2] Implement key quota overview view `src/app/(dashboard)/dashboard/quota/components/KeyQuotaView.js` with utilization percentage progress bars, window reset timers, and status badges  
  *Leaf*: leaf-1.1.2 (Wave 1)  
  *Files owned*: `src/app/(dashboard)/dashboard/quota/components/KeyQuotaView.js`  
  *Check oracle*: `bun x vitest run unit/key-quota-tabs.test.js -t "Utilization|ResetTimer"`

**Checkpoint**: User Story 2 is fully functional and testable independently via `tests/unit/key-quota-tabs.test.js`.

---

## Phase 5: User Story 3 — Capability Modality Badges (Priority: P2)

**Goal**: Visual badges highlighting all 9 model modalities (`vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`, `search`, `tools`, `reasoning`) across provider tables and combo builders.  
**Independent Test**: `bun x vitest run unit/capability-badges.test.js`

### Tests for User Story 3
- [ ] T016 [P] [US3] Create unit test suite for capability badges rendering and combo aggregation in `tests/unit/capability-badges.test.js`  
  *Leaf*: leaf-1.1.3 (Wave 1)  
  *Files owned*: `tests/unit/capability-badges.test.js`  
  *Check oracle*: `bun x vitest run unit/capability-badges.test.js`

### Implementation for User Story 3
- [ ] T017 [P] [US3] Implement capability metadata dictionary `src/shared/constants/capacityMeta.js` with icons, descriptions, and color tokens for all 9 modalities  
  *Leaf*: leaf-1.1.3 (Wave 1)  
  *Files owned*: `src/shared/constants/capacityMeta.js`  
  *Check oracle*: `bun x vitest run unit/capability-badges.test.js -t "Constants|ModalityColors"`

- [ ] T018 [US3] Implement enhanced badge component `src/shared/components/CapacityBadges.js` supporting individual model modalities and aggregated combo capabilities  
  *Leaf*: leaf-1.1.3 (Wave 1)  
  *Files owned*: `src/shared/components/CapacityBadges.js`  
  *Check oracle*: `bun x vitest run unit/capability-badges.test.js -t "BadgeRendering|Tooltips|ComboAggregation"`

- [ ] T019 [US3] Re-export `CapacityBadges.js` in `src/shared/components/index.js` preserving backward compatibility with legacy JavaScript callers  
  *Leaf*: leaf-1.1.3 (Wave 1)  
  *Files owned*: `src/shared/components/index.js`  
  *Check oracle*: `node -e 'const b = require("./src/shared/components"); console.log(typeof b.CapacityBadges);'`
  *Check oracle*: `bun x vitest run unit/capability-badges.test.js -t "BadgeRendering|Tooltips|ComboAggregation"`

- [ ] T019 [US3] Re-export `CapacityBadges.tsx` in `src/shared/components/index.js` preserving backward compatibility with legacy JavaScript callers  
  *Leaf*: leaf-1.1.3 (Wave 1)  
  *Files owned*: `src/shared/components/index.js`  
  *Check oracle*: `node -e 'const b = require("./src/shared/components"); console.log(typeof b.CapacityBadges);'`

**Checkpoint**: User Story 3 is fully functional and testable independently via `tests/unit/capability-badges.test.js`.

---

## Phase 6: User Story 4 — Standalone CLI Launcher Preservation (Priority: P2)

**Goal**: Preserve standalone launcher CLI (`cli/cli.js`) as plain JavaScript (ESM) per Principle II. TypeScript CLI core removed.

- [ ] T020 [P] [US4] Note: TypeScript CLI consolidation removed per Principle II (NO TypeScript)
- [ ] T021 [P] [US4] Note: `cli/tsconfig.json` removed
- [ ] T022 [P] [US4] Note: `cli/src/ts/` removed
- [ ] T023 [US4] Note: TS CLI dispatcher removed
- [ ] T024 [US4] Note: `cli/scripts/build-cli.js` plain JS build preserved

---

## Phase 7: Dashboard Integration, Wiring & Regression Baseline

**Purpose**: Wire newly built components into existing dashboard entry points and verify end-to-end regression invariants.  
**Prerequisites**: Phases 3, 4, and 5 complete and verified.  
**Independent Test**: `bun x vitest run unit/wave8-integration.test.js`, `node tests/__baseline__/verify-providers.mjs`, and `node tests/__baseline__/verify-alias.mjs`

- [ ] T025 [US1] Wire "Limits" modal trigger button into provider connection rows in `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "ConnectionRow|LimitsModal"`

- [ ] T026 [US2] Wire "API Key Quotas" tab into `/dashboard/quota` page in `src/app/(dashboard)/dashboard/quota/page.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/app/(dashboard)/dashboard/quota/page.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "QuotaPage|KeyQuotaTab"`

- [ ] T027 [US3] Wire capability badges into provider model rows in `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "ModelRow|CapabilityBadges"`

- [ ] T028 [US3] Wire capability badges into model selector modal in `src/shared/components/ModelSelectModal.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/shared/components/ModelSelectModal.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "ModelSelectModal|CapabilityBadges"`

- [ ] T029 [US3] Wire capability badges into combo editor form modal in `src/shared/components/ComboFormModal.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/shared/components/ComboFormModal.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "ComboFormModal|CapabilityBadges"`

- [ ] T030 [US3] Wire expanded capability badges into combo list page in `src/app/(dashboard)/dashboard/combos/page.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `src/app/(dashboard)/dashboard/combos/page.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js -t "CombosPage|CapabilityBadges"`

- [ ] T031 [US4] Preserve plain JavaScript launcher in `cli/cli.js` with `ensureBun()` check  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `cli/cli.js`  
  *Check oracle*: `bun x vitest run unit/cli-consolidated.test.js -t "EnsureBun|Prerequisite"`

- [ ] T032 [P] Implement end-to-end integration test in `tests/unit/wave8-integration.test.js`  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `tests/unit/wave8-integration.test.js`  
  *Check oracle*: `bun x vitest run unit/wave8-integration.test.js`

- [ ] T033 Execute provider baseline snapshot verification (`node tests/__baseline__/verify-providers.mjs`) to verify zero regressions  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `tests/unit/wave8-integration.test.js`  
  *Check oracle*: `node tests/__baseline__/verify-providers.mjs`

- [ ] T034 Execute model alias baseline snapshot verification (`node tests/__baseline__/verify-alias.mjs`) to verify zero regressions  
  *Leaf*: leaf-1.1.5 (Wave 2)  
  *Files owned*: `tests/unit/wave8-integration.test.js`  
  *Check oracle*: `node tests/__baseline__/verify-alias.mjs`

---

## Dependencies & Parallel Execution Order

### Phase Flow
```
Phase 1 (Setup)
    │
Phase 2 (Foundational Types)
    │
    ├───────────────────────┬───────────────────────┬───────────────────────┐
    ▼                       ▼                       ▼                       ▼
Phase 3 (US1 - Limits)   Phase 4 (US2 - Quotas)   Phase 5 (US3 - Badges)   Phase 6 (US4 - CLI)
[Wave 1 Leaf 1.1.1]     [Wave 1 Leaf 1.1.2]     [Wave 1 Leaf 1.1.3]     [Wave 1 Leaf 1.1.4]
    │                       │                       │                       │
    └───────────────────────┴───────────────────────┴───────────────────────┘
                                    │
                                    ▼
                      Phase 7 (Integration & Baselines)
                            [Wave 2 Leaf 1.5]
```

### Parallel Wave Opportunities
- **Wave 1 (4 parallel subagents)**:
  - Agent 1: Leaf 1.1.1 (Tasks T001, T004, T007 - T011) — `src/shared/types/connectionLimits.ts`, `open-sse/services/rateLimitManager/overrides.js`, `src/shared/components/ConnectionLimitsModal.tsx`, `src/app/api/providers/[id]/limits/**`, `tests/unit/connection-limits-modal.test.js`
  - Agent 2: Leaf 1.1.2 (Tasks T005, T012 - T015) — `src/shared/types/keyQuota.ts`, `src/app/(dashboard)/dashboard/quota/components/**`, `src/app/api/keys/[id]/quota/**`, `tests/unit/key-quota-tabs.test.js`
  - Agent 3: Leaf 1.1.3 (Tasks T016 - T019) — `src/shared/constants/capacityMeta.ts`, `src/shared/components/CapacityBadges.tsx`, `src/shared/components/index.js`, `tests/unit/capability-badges.test.js`
  - Agent 4: Leaf 1.1.4 (Tasks T002, T003, T006, T020 - T024) — `cli/src/ts/**`, `cli/tsconfig.json`, `cli/scripts/build-cli.js`, `tests/unit/cli-consolidated.test.js`
- **Wave 2 (1 subagent)**:
  - Agent 5: Leaf 1.1.5 (Tasks T025 - T034) — `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`, `src/shared/components/ModelSelectModal.js`, `src/shared/components/ComboFormModal.js`, `src/app/(dashboard)/dashboard/combos/page.js`, `src/app/(dashboard)/dashboard/quota/page.js`, `cli/cli.js`, `tests/unit/wave8-integration.test.js`, baseline snapshot verification (`verify-providers.mjs`, `verify-alias.mjs`).

# Implementation Plan: Dashboard and Tooling

**Branch**: `spec/010-wave8-dashboard-tooling`  
**Date**: 2026-10-26  
**Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/010-dashboard-tooling/spec.md`  

---

## Summary

Dashboard and Tooling (PR #71, PR #72) delivers user interface controls and administrative tooling in pure JavaScript:
1. **Limits modals**: React dialog (`ConnectionLimitsModal.js`) for managing per-connection rate limits (`rpm`, `rpd`), token limits (`tpm`, `tpd`), inter-request pacing (`minTime`), wait ceilings (`maxWaitMs`), in-flight concurrency caps (`maxConcurrent`, `modelConcurrency`), and budget caps (`maxBudgetUsd`).
2. **Key quota tabs**: Dedicated dashboard views (`KeyQuotaView.js`, `SpendTrendsChart.js`) on `/dashboard/quota` providing real-time visualization of per-key quota utilization, sliding-window consumption, and historical spend trends from `request_cost_ledger`.
3. **Capability badges**: Interface badges (`CapacityBadges.js`) highlighting model modalities (`vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`, `search`, `tools`, `reasoning`) across provider tables and combo builders.
4. **CLI preservation**: Preservation of the standalone plain JavaScript CLI launcher (`cli/cli.js`) under Bun per Principle II (TypeScript CLI core removed).

---

## Technical Context

**Language/Version**: Bun `v1.4.3+`, Node.js 18+ (for CLI compatibility), JavaScript (ESM) / Next.js 15 React 19.  
**Primary Dependencies**: Next.js App Router, React 19, Tailwind CSS, Lucide / Material Symbols Outlined, Vitest.  
**Storage**: SQLite (`bun:sqlite` WAL mode on `$DATA_DIR/db/data.sqlite`) storing `providerConnections.rate_limit_overrides_json`, `api_key_quota_limits`, `api_key_quota_counters`, and `request_cost_ledger`. Optional Redis (`ioredis`) for cluster rate limiting.  
**Testing**: Vitest (`bun x vitest run`) with runnable unit and component test oracles for each leaf.  
**Target Platform**: Linux, macOS, Windows (WSL2 / native).  
**Project Type**: Next.js App Router Dashboard + AI Gateway + CLI Launcher package.  
**Constraints**:
- Next.js App Router and Webpack bundler (`--webpack`) are preserved; no Turbopack.
- Plain JavaScript (ESM) per Principle II across all components.
- No breaking changes to public `/v1/*` or dashboard `/api/*` contracts.
- Every UI and tooling task requires a runnable automated test oracle in `tests/unit/`.
- CLI preserves published `9router` behavior, flags, and actionable `ensureBun()` checks.

---

## Constitution Check

*GATE: Verified against `.specify/memory/constitution.md`*

| Principle | Requirement | Status | Evidence |
|---|---|---|---|
| **I. Base Integrity** | Preserve `decolua/9router` base and Wave 9 ported capabilities | PASS | No existing provider executors or core routing handlers are removed or modified destructively. |
| **II. Runtime & Port Contract** | Bun `v1.4.3` single-runtime stack, default port `20128`, plain JS | PASS | All server operations run on Bun; CLI checks for Bun on startup; plain JS (ESM) with NO TypeScript. |
| **III. Storage Invariant** | `bun:sqlite` with WAL mode, optional Redis fallback | PASS | Uses existing `getAdapter()` SQLite repository methods; temporary `DATA_DIR` used in test oracles. |
| **IV. Graph Discovery** | Query `codebase-memory-mcp` and `check_index_coverage` | PASS | All relied-upon paths checked with `check_index_coverage`. |
| **V. Spec-Kit & Unlazy Gates** | Spec under `specs/010-*/`, Unlazy under `.unlazy/010-*/` | PASS | Specifications and gated ledgers prepared and validated with strict zero-error linting. |
| **VI. Resilience & Limits** | Fail-open on infrastructure errors, fail-closed on ACL/auth | PASS | Connection limits validate strictly; quota queries fail open on DB errors (`{ allowed: true, degraded: true }`). |

---

## Project Structure & File Ownership

File ownership for the dashboard tooling delivery:

```text
KhatamRouter/
├── specs/010-dashboard-tooling/
│   ├── spec.md
│   ├── plan.md
│   ├── research.md
│   ├── data-model.md
│   ├── quickstart.md
│   ├── checklists/requirements.md
│   └── contracts/
│       ├── connection-limits.json
│       ├── key-quota.json
│       └── cli-contract.md
│
├── Leaf 1.1: Connection Limits Modal
│   ├── src/shared/types/connectionLimits.js
│   ├── open-sse/services/rateLimitManager/overrides.js
│   ├── src/shared/components/ConnectionLimitsModal.js
│   ├── src/app/api/providers/[id]/limits/route.js
│   └── tests/unit/connection-limits-modal.test.js
│
├── Leaf 1.2: Key Quota Tabs & Spend Trends
│   ├── src/shared/types/keyQuota.js
│   ├── src/app/(dashboard)/dashboard/quota/components/KeyQuotaView.js
│   ├── src/app/(dashboard)/dashboard/quota/components/SpendTrendsChart.js
│   ├── src/app/api/keys/[id]/quota/route.js
│   └── tests/unit/key-quota-tabs.test.js
│
├── Leaf 1.3: Capability Modality Badges
│   ├── src/shared/constants/capacityMeta.js
│   ├── src/shared/components/CapacityBadges.js
│   ├── src/shared/components/index.js
│   └── tests/unit/capability-badges.test.js
│
└── Leaf 1.4: Integration & Dashboard Wiring
    ├── src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js
    ├── src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js
    ├── src/shared/components/ModelSelectModal.js
    ├── src/shared/components/ComboFormModal.js
    ├── src/app/(dashboard)/dashboard/combos/page.js
    ├── src/app/(dashboard)/dashboard/quota/page.js
    ├── cli/cli.js
    └── tests/unit/wave8-integration.test.js
```

---

## Detailed Component Designs

### 1. `src/shared/components/ConnectionLimitsModal.js`
- Dialog displaying tabs/sections for:
  - **Rate Limits**: `rpm`, `rpd`
  - **Token Limits**: `tpm`, `tpd`
  - **Spacing & Timeouts**: `minTime` (ms), `maxWaitMs` (ms), `executionMaxWaitMs` (ms)
  - **Concurrency**: `maxConcurrent` (connection in-flight ceiling)
  - **Model Concurrency**: Dynamic table mapping model name -> concurrency integer
  - **Budget Cap**: `maxBudgetUsd` (stored and displayed; request-time budget enforcement against request_cost_ledger is an explicit out-of-scope follow-up)
- Uses `src/shared/types/connectionLimits.js` for shape definitions.
- Fetches initial values from `connection.rate_limit_overrides_json`.
- Submits sanitized values to `PUT /api/providers/[id]/limits` (or `PUT /api/providers/[id]`).

### 2. `KeyQuotaView.js` & `SpendTrendsChart.js` (`src/app/(dashboard)/dashboard/quota/components/*.js`)
- Tab in `/dashboard/quota` rendered via `SegmentedControl` ("Provider Limits" vs "API Key Quotas").
- Displays:
  - Top summary cards: Active keys, keys at >80% quota, total spend today/7d/30d.
  - Per-key cards with progress bars for active window limits.
  - Spend Trends chart (`SpendTrendsChart.js`) plotting daily/hourly cost and token volume.
- Queries `GET /api/keys/[id]/quota` for real-time data with fail-open error handling.
- Uses `src/shared/types/keyQuota.js` for shape definitions.

### 3. `CapacityBadges.js` (merged) & `src/shared/constants/capacityMeta.js`
- Plain JavaScript constant `CAPACITY_META` in `src/shared/constants/capacityMeta.js` mapping 9 modalities to Material Symbols Outlined icons and Tailwind color tokens:
  - `vision` (visibility, blue)
  - `pdf` (description, orange)
  - `audioInput` (mic, purple)
  - `videoInput` (videocam, rose)
  - `imageOutput` (image, emerald)
  - `audioOutput` (volume_up, indigo)
  - `search` (travel_explore, cyan)
  - `tools` (build, green)
  - `reasoning` (neurology, amber)
- `src/shared/components/CapacityBadges.js` (merged into the pre-existing legacy component) renders badge elements.
- Integrates with `aggregateComboCapabilities` to display accurate combo modality tags.

### 4. Consolidated CLI (DROPPED)
- DROPPED: The consolidated TypeScript CLI under `cli/src/ts/` compiled with `esbuild` was DROPPED because the project is plain JavaScript only (PR #64, CLAUDE.md Principle II).
- The published plain JavaScript CLI (`cli/cli.js`) remains unchanged under Bun with the `ensureBun()` runtime guard.

---

## Verification Strategy & Oracles

Every leaf must pass its dedicated Vitest test suite using temporary `DATA_DIR` isolation:
1. **Leaf 1.1**: `bun x vitest run unit/connection-limits-modal.test.js`
2. **Leaf 1.2**: `bun x vitest run unit/key-quota-tabs.test.js`
3. **Leaf 1.3**: `bun x vitest run unit/capability-badges.test.js`
4. **Leaf 1.4**: DROPPED (`cli-consolidated.test.js` deleted; TS CLI dropped)
5. **Leaf 1.5**: `bun x vitest run unit/wave8-integration.test.js`, `node tests/__baseline__/verify-providers.mjs`, and `node tests/__baseline__/verify-alias.mjs`

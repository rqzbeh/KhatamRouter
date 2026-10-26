# Quickstart & Verification Guide: Dashboard and Tooling

**Branch**: `spec/010-wave8-dashboard-tooling`  
**Date**: 2026-10-26  
**Status**: Ready  

---

## Prerequisites

- Bun `v1.4.3+` installed and available on PATH (`bun --version`).
- Dependencies installed: `bun install` (from repo root).
- Tests dependency installed: `cd tests && bun install` (if vitest missing in `tests/node_modules`).

---

## Automated Verification Scenarios

### 1. Connection Limits Modal & Validation Tests
Tests the React limits modal component, field validations, and sanitization rules.
```bash
bun x vitest run unit/connection-limits-modal.test.js
```
*Expected Outcome*: All assertions pass verifying numeric bounds, integer flooring, `modelConcurrency` object mapping, and fail-closed validation.

### 2. Key Quota Utilization & Spend Trends API Tests
Tests key quota utilization calculation, sliding-window counter retrieval, and cost ledger aggregation.
```bash
bun x vitest run unit/key-quota-tabs.test.js
```
*Expected Outcome*: All assertions pass verifying authenticated quota read/write, spend summation across daily/weekly/monthly windows, and fail-open degraded handling.

### 3. Capability Modality Badges Tests
Tests `CapacityBadges.js` rendering and `aggregateComboCapabilities` modality mapping.
```bash
bun x vitest run unit/capability-badges.test.js
```
*Expected Outcome*: All 9 modality icons, labels, and colors render correctly; combo aggregation preserves union for inputs, intersection for tools, and primary reasoning.

### 4. No-TypeScript Guard Test
Verifies that no unallowlisted TypeScript files exist in the repository (Principle II).
```bash
bun x vitest run unit/no-typescript-guard.test.js
```
*Expected Outcome*: All assertions pass verifying plain JavaScript codebase with single custom-server.ts allowlist.

### 5. Provider Baselines & Regression Check
Verifies that no changes broke provider catalogs or aliases:
```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
```
*Expected Outcome*: Byte-for-byte identical baseline snapshot verification.

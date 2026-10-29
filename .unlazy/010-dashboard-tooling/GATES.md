# Acceptance Gates: Dashboard and Tooling

OWNS: open-sse/services/rateLimitManager/overrides.js, src/shared/types/**, src/shared/components/**, src/shared/constants/**, src/app/api/**, src/app/(dashboard)/dashboard/**, cli/**, tests/unit/connection-limits-modal.test.js, tests/unit/key-quota-tabs.test.js, tests/unit/capability-badges.test.js, tests/unit/wave8-integration.test.js, specs/010-dashboard-tooling/**

Scope: Plain JavaScript limits modals, key quota tabs and spend trends, capability modality badges, and preservation of existing CLI launcher.

- [ ] G1: Connection limits modal and API validation unit tests pass
  CHECK: bun x vitest run unit/connection-limits-modal.test.js && echo WAVE8_G1_LIMITS_OK
  EXPECT: WAVE8_G1_LIMITS_OK
  CWD: ../../tests
  EVIDENCE: pending

- [ ] G2: Key quota utilization and spend trends unit tests pass
  CHECK: bun x vitest run unit/key-quota-tabs.test.js && echo WAVE8_G2_QUOTA_OK
  EXPECT: WAVE8_G2_QUOTA_OK
  CWD: ../../tests
  EVIDENCE: pending

- [ ] G3: Capability badges modality and combo aggregation unit tests pass
  CHECK: bun x vitest run unit/capability-badges.test.js && echo WAVE8_G3_BADGES_OK
  EXPECT: WAVE8_G3_BADGES_OK
  CWD: ../../tests
  EVIDENCE: pending

- [ ] G4: Consolidated TypeScript CLI (DROPPED: superseded by plain-JavaScript-only rule PR #64; no TypeScript CLI ships)
  CHECK: echo CLI_TS_DROPPED
  EXPECT: CLI_TS_DROPPED
  CWD: ../..
  EVIDENCE: Dropped per Principle II (CLAUDE.md) and PR #64; published CLI is unchanged.

- [ ] G5: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: bun tests/__baseline__/verify-providers.mjs && echo WAVE8_G5_BASELINES_OK
  EXPECT: WAVE8_G5_BASELINES_OK
  CWD: ../..
  EVIDENCE: pending

# Wave 8 Acceptance Gates: Dashboard and Tooling

OWNS: open-sse/services/rateLimitManager/overrides.js, src/shared/types/**, src/shared/components/**, src/shared/constants/**, src/app/api/**, src/app/(dashboard)/dashboard/**, cli/**, tests/unit/connection-limits-modal.test.js, tests/unit/key-quota-tabs.test.js, tests/unit/capability-badges.test.js, tests/unit/cli-consolidated.test.js, tests/unit/wave8-integration.test.js, specs/010-dashboard-tooling/**

Scope: TSX limits modals, key quota tabs and spend trends, capability modality badges, and consolidated TypeScript CLI.

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

- [ ] G4: Consolidated TypeScript CLI command and flag tests pass
  CHECK: bun x vitest run unit/cli-consolidated.test.js && echo WAVE8_G4_CLI_OK
  EXPECT: WAVE8_G4_CLI_OK
  CWD: ../../tests
  EVIDENCE: pending

- [ ] G5: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: node tests/__baseline__/verify-providers.mjs && echo WAVE8_G5_BASELINES_OK
  EXPECT: WAVE8_G5_BASELINES_OK
  CWD: ../..
  EVIDENCE: pending

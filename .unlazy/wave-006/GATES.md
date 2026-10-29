# Wave 6 Acceptance Gates: Live Model Discovery and Capability Resolution

OWNS: src/lib/models/**, src/domain/requestCapabilities.js, open-sse/services/combo.js, src/lib/db/migrations/004-wave6-model-capabilities.js, tests/unit/wave6-models.test.js, specs/006-model-discovery-capabilities/**, .unlazy/wave-006/**

- [x] G1: Wave 6 model discovery, capability cascade and reconciler unit tests pass
  CHECK: bun x vitest run unit/wave6-models.test.js && echo WAVE6_G1_OK
  EXPECT: WAVE6_G1_OK
  CWD: ../../tests

- [x] G2: Fail-closed combo routing proven for image requests against text-only targets
  CHECK: bun x vitest run unit/wave6-models.test.js -t "Fail-Closed|fail-closed" && echo WAVE6_G2_OK
  EXPECT: WAVE6_G2_OK
  CWD: ../../tests

- [x] G3: Wave 1-5 regression suites still pass with the new capability wiring
  CHECK: bun x vitest run unit/wave1-bun-ts-redis-sqlite.test.js unit/wave2-migrations.test.js unit/wave2-quota-store.test.js unit/wave3-acl.test.js unit/wave3-limits.test.js unit/wave4-docs-claims.test.js unit/wave5-stealth.test.js unit/db-driver-chain.test.js unit/db-migration-chain.test.js unit/capabilities.test.js && echo WAVE6_G3_OK
  EXPECT: WAVE6_G3_OK
  CWD: ../../tests

- [x] G4: Provider catalog, alias and OAuth baseline snapshots remain identical
  CHECK: bun tests/__baseline__/verify-providers.mjs && bun tests/__baseline__/verify-alias.mjs && bun tests/__baseline__/verify-oauth-urls.mjs && echo WAVE6_G4_OK
  EXPECT: WAVE6_G4_OK
  CWD: ../..

- [x] G5: Core typecheck accepts the new modules
  CHECK: npx tsc --noEmit -p tsconfig.typecheck-core.json && echo WAVE6_G5_OK
  EXPECT: WAVE6_G5_OK
  CWD: ../..

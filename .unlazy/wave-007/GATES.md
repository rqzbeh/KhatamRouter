# Wave 7 Acceptance Gates: VansRouter Provider Parity

OWNS: open-sse/providers/**, open-sse/executors/**, open-sse/utils/**, open-sse/services/**, open-sse/config/**, open-sse/rtk/**, open-sse/handlers/chatCore.js, src/sse/handlers/chat.js, src/lib/db/repos/settingsRepo.js, scripts/migrate-registry.mjs, tests/unit/wave7-parity.test.js, tests/__baseline__/**, specs/007-vansrouter-parity/**, .unlazy/wave-007/**

- [x] G1: Wave 7 provider parity, freeTiers and ponytail unit tests pass
  CHECK: npx vitest run unit/wave7-parity.test.js && echo WAVE7_G1_OK
  EXPECT: WAVE7_G1_OK
  CWD: ../../tests

- [x] G2: LoopGuard negative and positive controls verified
  CHECK: npx vitest run unit/wave7-parity.test.js -t "LoopGuard" && echo WAVE7_G2_OK
  EXPECT: WAVE7_G2_OK
  CWD: ../../tests

- [x] G3: Stateless executor contract verified across sequential calls
  CHECK: npx vitest run unit/wave7-parity.test.js -t "Stateless Executor" && echo WAVE7_G3_OK
  EXPECT: WAVE7_G3_OK
  CWD: ../../tests

- [x] G4: Wave 1-6 regression test suites pass without regression
  CHECK: npx vitest run unit/wave1-bun-ts-redis-sqlite.test.js unit/wave2-migrations.test.js unit/wave2-quota-store.test.js unit/wave3-acl.test.js unit/wave3-limits.test.js unit/db-driver-chain.test.js unit/db-migration-chain.test.js unit/capabilities.test.js && echo WAVE7_G4_OK
  EXPECT: WAVE7_G4_OK
  CWD: ../../tests

- [x] G5: Provider catalog, alias and OAuth baseline verification checks pass
  CHECK: node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-oauth-urls.mjs && echo WAVE7_G5_OK
  EXPECT: WAVE7_G5_OK
  CWD: ../..

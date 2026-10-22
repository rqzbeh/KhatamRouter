# Wave 4 Acceptance Gates: Resilience, Circuit Breaking, and Pre-Dispatch Gates

OWNS: open-sse/config/resilienceConfig.js, src/shared/utils/circuitBreaker.js, src/lib/resilience/**, src/domain/executeTargetGates.js, src/domain/fallbackResilience.js, src/lib/db/migrations/003-wave4-circuit-breaker.js, tests/unit/wave4-resilience.test.js, specs/004-resilience-circuit-breaker/**

- [ ] G1: Circuit breaker state machine and 429 classification tests pass
  CHECK: npx vitest run unit/wave4-resilience.test.js -t "State Machine|429 Classification" && echo WAVE4_G1_OK
  EXPECT: WAVE4_G1_OK
  CWD: ../../tests

- [ ] G2: Ordered pre-dispatch gates and negative-control rejection tests pass
  CHECK: npx vitest run unit/wave4-resilience.test.js -t "Pre-Dispatch Gates|Negative Control" && echo WAVE4_G2_OK
  EXPECT: WAVE4_G2_OK
  CWD: ../../tests

- [ ] G3: Persistence and Redis fail-open degradation tests pass
  CHECK: npx vitest run unit/wave4-resilience.test.js -t "Persistence|Redis Fail-Open" && echo WAVE4_G3_OK
  EXPECT: WAVE4_G3_OK
  CWD: ../../tests

- [ ] G4: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: node tests/__baseline__/verify-providers.mjs && echo WAVE4_G4_OK
  EXPECT: WAVE4_G4_OK
  CWD: ../..

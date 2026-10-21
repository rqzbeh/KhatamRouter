# Wave 3 Acceptance Gates: Unified ACL and Granular Limits

OWNS: src/sse/services/**, src/sse/handlers/**, src/app/api/v1/models/**, src/dashboardGuard.js, open-sse/services/rateLimitManager/**, src/lib/quota/**, src/domain/**, src/lib/usage/**, tests/unit/wave3-*.test.js, specs/003-acl-granular-limits/**

- [ ] G1: ACL tri-state matrix unit tests pass
  CHECK: npx vitest run unit/wave3-acl.test.js && echo WAVE3_G1_OK
  EXPECT: WAVE3_G1_OK
  CWD: ../../tests

- [ ] G2: internalTrust timing-safe and fail-closed tests pass
  CHECK: npx vitest run unit/wave3-internal-trust.test.js && echo WAVE3_G2_OK
  EXPECT: WAVE3_G2_OK
  CWD: ../../tests

- [ ] G3: Connection-level rate and concurrency limiter unit tests pass
  CHECK: npx vitest run unit/wave3-connection-limiter.test.js && echo WAVE3_G3_OK
  EXPECT: WAVE3_G3_OK
  CWD: ../../tests

- [ ] G4: Per-key quota limits and USD spend cap unit tests pass
  CHECK: npx vitest run unit/wave3-key-quota.test.js && echo WAVE3_G4_OK
  EXPECT: WAVE3_G4_OK
  CWD: ../../tests

- [ ] G5: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: node tests/__baseline__/verify-providers.mjs && echo WAVE3_G5_OK
  EXPECT: WAVE3_G5_OK
  CWD: ../..

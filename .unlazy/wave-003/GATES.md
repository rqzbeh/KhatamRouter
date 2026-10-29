# Wave 3 Acceptance Gates: Unified ACL and Granular Limits

OWNS: src/sse/services/**, src/sse/handlers/**, src/app/api/v1/models/**, src/dashboardGuard.js, open-sse/services/rateLimitManager/**, src/lib/quota/**, src/domain/**, src/lib/usage/**, tests/unit/wave3-*.test.js, specs/003-acl-granular-limits/**

- [x] G1: ACL tri-state matrix unit tests pass
  CHECK: bun x vitest run unit/wave3-acl.test.js -t "Tri-State ACL|Enforcement Pipeline|Catalogue Filtering" && echo WAVE3_G1_OK
  EXPECT: WAVE3_G1_OK
  CWD: ../../tests

- [x] G2: internalTrust timing-safe and fail-closed tests pass
  CHECK: bun x vitest run unit/wave3-acl.test.js -t "Internal Trust" && echo WAVE3_G2_OK
  EXPECT: WAVE3_G2_OK
  CWD: ../../tests

- [x] G3: Connection-level rate and concurrency limiter unit tests pass
  CHECK: bun x vitest run unit/wave3-limits.test.js -t "Override Sanitisation|Limiter Dimensions|In-Process Concurrency|Window Expiry" && echo WAVE3_G3_OK
  EXPECT: WAVE3_G3_OK
  CWD: ../../tests

- [x] G4: Per-key quota limits, spend caps and fail-open unit tests pass
  CHECK: bun x vitest run unit/wave3-limits.test.js -t "Rate Limits List|USD Daily|Fail-Open" && echo WAVE3_G4_OK
  EXPECT: WAVE3_G4_OK
  CWD: ../../tests

- [x] G5: Provider catalog baseline snapshot is byte-for-byte identical
  CHECK: bun tests/__baseline__/verify-providers.mjs && echo WAVE3_G5_OK
  EXPECT: WAVE3_G5_OK
  CWD: ../..

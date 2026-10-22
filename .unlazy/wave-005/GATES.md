# Wave 5 Acceptance Gates: Stealth and Anti-Ban Suite

OWNS: src/lib/stealth/**, tests/unit/wave5-stealth.test.js, specs/005-stealth-antiban/**, .unlazy/wave-005/**

- [x] G1: Stealth and anti-ban suite unit tests pass with default-off isolation verified
  CHECK: npx vitest run unit/wave5-stealth.test.js && echo WAVE5_G1_OK
  EXPECT: WAVE5_G1_OK
  CWD: ../../tests

- [x] G2: Persian half-space preservation and zero-width obfuscation verified
  CHECK: npx vitest run unit/wave5-stealth.test.js -t "Persian|Zero-Width|Half-Space" && echo WAVE5_G2_OK
  EXPECT: WAVE5_G2_OK
  CWD: ../../tests

- [x] G3: Tool cloaking schema sanitisation and restore map verified
  CHECK: npx vitest run unit/wave5-stealth.test.js -t "Tool Cloak|Schema|Restore" && echo WAVE5_G3_OK
  EXPECT: WAVE5_G3_OK
  CWD: ../../tests

- [x] G4: Provider catalog and alias baseline snapshots remain identical
  CHECK: node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-oauth-urls.mjs && echo WAVE5_G4_OK
  EXPECT: WAVE5_G4_OK
  CWD: ../..

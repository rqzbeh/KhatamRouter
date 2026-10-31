# Acceptance Gates: Combo Cooldown Correctness & Cross-Client Isolation

OWNS: open-sse/services/combo.js, tests/integration/combo-cooldown-reliability.mjs, fixtures/combo-cooldown/**, tests/unit/combo-cooldown-correctness.test.js, .unlazy/combo-cooldown-correctness/**

Scope: Review and fix PR124 combo cooldown Map. Eliminate unsafe cross-client suppression by scoping cooldowns or making them request-scoped by default with explicit opt-in scope; retain upstream failure status (never map all-5xx to 429); parse and preserve upstream Retry-After (seconds and HTTP-date) without shortening to 90s; enforce bounded Map size and prune expired entries; drain discarded response bodies without cancelling returned responses; handle AbortSignal without blocking sleep; verify with real loopback HTTP endpoints and real fetch.

- [x] G1: Spec package and gate ledger adhere to strict quality rules
  CHECK: node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs --strict .unlazy/combo-cooldown-correctness/GATES.md
  EXPECT: LINT OK
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=a368e6b2469437bf6512b363e5ce1d0e434252cb80fd4415e3f904636a5022da; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/tmp/khatam-combo-correctness; path=f2c4e9ff709f/32 entries

- [x] G2: Real loopback HTTP server validates isolation, status preservation, Retry-After parsing, body drainage, and memory limits
  CHECK: bun tests/integration/combo-cooldown-reliability.mjs
  EXPECT: COMBO_COOLDOWN_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=61f0d49819c702cedeade7a8ff307c4e0344616e13d601a55fa54073f39d0cef; exit=0; EXPECT=matched; output-sha256=c63634e6e056db4714ca1b8a3b0ed188dafbfd29ac535a4583dc7cd5135d6612; output-bytes=1789; shell=/bin/sh; cwd=/tmp/khatam-combo-correctness; path=f2c4e9ff709f/32 entries

- [x] G3: Unit test suite confirms bounded map eviction, date/seconds headers, and signal cancellation
  CHECK: (cd tests && bun x vitest run unit/combo-cooldown-correctness.test.js) && echo COMBO_UNIT_CORRECTNESS_PASS
  EXPECT: COMBO_UNIT_CORRECTNESS_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=51fe62e1112b1206e6a47041d2bb3cc194782df326ea9192cb9aacc132a6df63; exit=0; EXPECT=matched; output-sha256=e08e31d633f30bca413c9b7feb6e6a6b593420c8434a3b8a7467478eeeefc294; output-bytes=211; shell=/bin/sh; cwd=/tmp/khatam-combo-correctness; path=f2c4e9ff709f/32 entries

- [x] G4: Full suite of existing combo tests runs cleanly without regressions
  CHECK: (cd tests && bun x vitest run unit/combo-empty-failover.test.js unit/combo-request-scoped-fallback.test.js unit/combo-routing.test.js unit/combo-capabilities.test.js unit/combo-credit-fallback.test.js unit/combo-fusion.test.js unit/combo-presets.test.js unit/combo-smart-router.test.js) && echo COMBO_REGRESSION_SUITE_PASS
  EXPECT: COMBO_REGRESSION_SUITE_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d99869a2a2cdac02eb0725b9dfd112d01a3d886792a4ddfc40ca9631c95c0f8; exit=0; EXPECT=matched; output-sha256=706f46b37a92909bcc5deda9357c57011435df36815b3674e4dc7c34586eecbd; output-bytes=84894; shell=/bin/sh; cwd=/tmp/khatam-combo-correctness; path=f2c4e9ff709f/32 entries

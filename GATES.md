# Gates: proxy scheduling and combo cooldown controls

OWNS: src/lib/freeProxyProviders/**, src/shared/services/initializeApp.js, tests/unit/free-proxy-*.test.js, tests/unit/cluster-leader-daemons.test.js, src/shared/components/ComboFormModal*, src/app/api/combos/**, src/lib/db/repos/combosRepo.js, open-sse/config/comboCooldown.js, open-sse/services/combo.js, tests/unit/combo*, README.md, ROADMAP.md, CHANGELOG.md, docs/ARCHITECTURE.md, .env.example

Scope: Complete pending automatic opt-in free-proxy synchronization and add a persisted per-combo cooldown switch without weakening unrelated security controls.

- [x] G1: Free-proxy scheduler and quality regression tests pass under Bun.
  CHECK: bun x --bun vitest run --root tests unit/free-proxy-scheduler.test.js unit/free-proxy-quality-gate.test.js unit/free-proxy-sources.test.js unit/free-proxy-api.test.js unit/free-proxy-card-wiring.test.js unit/cluster-leader-daemons.test.js unit/cluster-drain-signals.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=8702cf250a71573364d21fc8c84a4c2c48cff9fda8804543903fbb1018ab0f95; exit=0; EXPECT=matched; output-sha256=9e22a7dadadfd7649c160c7f89dc593db922f78698da6c75f123445ab293de39; output-bytes=17357; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G2: Combo cooldown enabled/default and disabled behavior has passing regression coverage.
  CHECK: bun x --bun vitest run --root tests unit/combo-disable-cooldown.test.js unit/combo-configurable-cooldown.test.js unit/combo-cooldown-correctness.test.js unit/combo-routing.test.js unit/combo-empty-failover.test.js unit/combo-credit-fallback.test.js unit/combo-request-scoped-fallback.test.js unit/wave8-integration.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=3a5f8850c223d951aae44d9c6dd33a480f2bde06b5bc9d2f3fc5a5d6f66f9e45; exit=0; EXPECT=matched; output-sha256=0e229a0c90068943a2e261df8c540077aede2a6ba3aaa7ab697fba0fc6432502; output-bytes=87089; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G3: Proxy JavaScript files pass targeted lint and diff whitespace checks.
  CHECK: bun x --bun eslint src/lib/freeProxyProviders/index.js src/lib/freeProxyProviders/scheduler.js src/shared/services/initializeApp.js tests/unit/free-proxy-quality-gate.test.js tests/unit/free-proxy-scheduler.test.js tests/unit/cluster-leader-daemons.test.js && git diff --check && printf 'PROXY_LINT_OK\n'
  EXPECT: PROXY_LINT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=613fb584588b576254685b7a56150419eca7f58d36cbe213f17851309787c5d0; exit=0; EXPECT=matched; output-sha256=2ab5fd899a94793e285c73e610b6c02532ddd04dbd31ddc5d85de327ab609217; output-bytes=14; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=e50692ecd034/32 entries

- [x] G4: Proxy imports remain opt-in and bounded, combo fallback remains bounded with unchanged authentication and SSRF protections, and documentation states the controls and limitations.
  EVIDENCE: Parent reviewed scheduler strict risk checks/shared lease/leader guard and combo runtime bypass/new-mark suppression, strict API boolean validation and UI persistence. Independent 73 proxy/lifecycle and 169 combo regressions pass; README, ROADMAP, CHANGELOG, environment template and architecture updated. Account auth/quota code and SSRF validation unchanged. Full integrated production build subsequently passed with proxy failover and strict initial selection.

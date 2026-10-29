# Acceptance Gates: Spec 013 — Upstream v0.5.112 Port

OWNS: specs/013-upstream-0-5-112/**, .unlazy/013-upstream-0-5-112/**, specs/README.md

Scope: Full upstream v0.5.112 port (14 commits) covering Gemini schema predicates, non-streaming SSE errors, NVIDIA reasoning alias, CodeBuddy channel headers, bulk-add opaque tokens, DeepSeek PoW hash solver with restored validation, Codex GPT-6.1 Terra, Qoder Sonus/Cantus, GitHub Copilot Claude 5.5 thinking rules, CommandCode CLI 1.88.0 headers, Nace Drex provider, MiniMax desktop named-pipe lease broker with loopback guard and Redis cluster cache, OpenCode Free TLS parity proof, and version 0.5.112 alignment with zero regressions.

- [x] G1: Baseline regression snapshots and safety guards verified
  CHECK: bun -v | grep -qE "1\.[345]" && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-oauth-urls.mjs && echo G1_PASS
  EXPECT: G1_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=7bd49ddfc1757faf8433c92e12abb71ca963947d90fdcc163bcd508cf78e8126; exit=0; EXPECT=matched; output-sha256=6ec8e6687a27d5b53fd34f9c58c4649cbfc31a6e8a97dbe40a1524ac501852df; output-bytes=1412; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G2: Core routing, error handling and param normalization verified
  CHECK: test -s tests/unit/gemini-schema-array-items-predicate.test.js && test -s tests/unit/nonstream-sse-error.test.js && test -s tests/unit/param-support.test.js && test -s tests/unit/codebuddy-channel-headers.test.js && test -s tests/unit/bulk-add-names.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/gemini-schema-array-items-predicate.test.js tests/unit/nonstream-sse-error.test.js tests/unit/param-support.test.js tests/unit/codebuddy-channel-headers.test.js tests/unit/bulk-add-names.test.js && cd tests && bun x vitest run unit/gemini-schema-array-items-predicate.test.js unit/nonstream-sse-error.test.js unit/param-support.test.js unit/codebuddy-channel-headers.test.js unit/codebuddy-intl-backoff.test.js unit/bulk-add-names.test.js && echo G2_PASS
  EXPECT: G2_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=4e921afc3cb11c1cf148da9665423f8de2eb9a7606e3220358991dcc719628f3; exit=0; EXPECT=matched; output-sha256=dd5c62b832693f65de7b8b339c9cdfa780a96285f571fa76af612fb4189e2bab; output-bytes=191; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G3: DeepSeek PoW noble-hashes module and input validation verified
  CHECK: test -s tests/unit/deepseek-pow-hash.test.js && [ $(grep -c 'expect(' tests/unit/deepseek-pow-hash.test.js) -ge 8 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/deepseek-pow-hash.test.js && cd tests && bun x vitest run unit/deepseek-pow-hash.test.js && echo G3_PASS
  EXPECT: G3_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=909c3f8b5f4b4f82a533c1dba7a104b54831b99f4c7957cfa79341efe9872bc6; exit=0; EXPECT=matched; output-sha256=aa6c7ee6de182e68be1e52f9fe8f04d40ad9db4e2a39edcb6777b04c73972187; output-bytes=192; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G4: Codex, Qoder and GitHub Copilot Claude 5.5 capabilities verified
  CHECK: test -s tests/unit/codex-gpt6-lite.test.js && test -s tests/unit/qoder-frontier-models.test.js && test -s tests/unit/github-claude-5-5-thinking.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/codex-gpt6-lite.test.js tests/unit/qoder-frontier-models.test.js tests/unit/github-claude-5-5-thinking.test.js && cd tests && bun x vitest run unit/codex-gpt6-lite.test.js unit/qoder-frontier-models.test.js unit/github-claude-5-5-thinking.test.js && echo G4_PASS
  EXPECT: G4_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=4635291ffc7991fde577f17b00a42fea1df8b3a030cfbde39ebe087e54af027e; exit=0; EXPECT=matched; output-sha256=1fda1494ada6bf5a92932f9d289856744e8024c68b2307df06c1e6ccd1488837; output-bytes=5577; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G5: CommandCode CLI 1.88.0 headers and Nace Drex provider verified
  CHECK: test -s tests/unit/commandcode-headers.test.js && test -s tests/unit/commandcode-usage.test.js && test -s tests/unit/nace-systemone-provider.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/commandcode-headers.test.js tests/unit/commandcode-usage.test.js tests/unit/nace-systemone-provider.test.js && cd tests && bun x vitest run unit/commandcode-headers.test.js unit/commandcode-usage.test.js unit/nace-systemone-provider.test.js && node __baseline__/verify-alias.mjs && node __baseline__/verify-providers.mjs && echo G5_PASS
  EXPECT: G5_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=2ae488c327386080998047dc3b35e47275bd129c6dea3dcfeeb57fec2015bb47; exit=0; EXPECT=matched; output-sha256=d0b56d63b42e065651bd6ca321629885a8493f30b46bc113f43184d7e1568267; output-bytes=1136; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G6: MiniMax Code lease broker, loopback guard and Redis cluster cache verified
  CHECK: test -s tests/unit/minimax-code-lease.test.js && [ $(grep -c 'expect(' tests/unit/minimax-code-lease.test.js) -ge 12 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/minimax-code-lease.test.js && grep -q "minimax-code/lease" src/dashboardGuard.js && cd tests && bun x vitest run unit/minimax-code-lease.test.js && echo G6_PASS
  EXPECT: G6_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=44c095c2432c1520968ba4c9237c14a1f049c942ca169bfa01a0de1b92c1a9df; exit=0; EXPECT=matched; output-sha256=fd37cac915c01bd4219db5cd5b9fd99945c3c09edee9144968649918cf129d84; output-bytes=191; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G7: OpenCode Free and Docker parity proof verified without runtime npm dependencies
  CHECK: test -s tests/unit/opencode-tls-client.test.js && [ $(grep -c 'expect(' tests/unit/opencode-tls-client.test.js) -ge 6 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/opencode-tls-client.test.js && cd tests && bun x vitest run unit/opencode-tls-client.test.js && cd .. && cmp Dockerfile Dockerfile.bun && echo G7_PASS
  EXPECT: G7_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=add8895d2d850bb30c1aba0afa8ef0f73d7d5e1e44483a40a7872777f187c735; exit=0; EXPECT=matched; output-sha256=674152bd82414f54bacfc2398d50d3258853b14bbba0540ac32a546ab34b42fd; output-bytes=191; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G8: Version 0.5.112 aligned in both packages and the branding guard passes
  CHECK: grep -q '"version": "0.5.112"' package.json && grep -q '"version": "0.5.112"' cli/package.json && grep -q "0.5.112" CHANGELOG.md && grep -q "85d73bd6" docs/UPSTREAM-PORTS.md && cd tests && bun x vitest run unit/display-branding-guard.test.js && echo G8_PASS
  EXPECT: G8_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=895ad134f70becce46feb75bba2d0ab3119fbbc7ca640dc6e32f5b632a26b363; exit=0; EXPECT=matched; output-sha256=5dff49d22ee66d049dfa1a12780adba4b04086641e83c3d96b91f1a0c45cc241; output-bytes=177; shell=/bin/sh; cwd=/tmp/khatam-013; path=f2c4e9ff709f/32 entries

- [x] G9: Full suite adds no failing test versus clean master (manual comparison, evidence below)
  EVIDENCE: manual 2026-10-30: clean master 4dc2f991 = 99 failed / 5084 passed of 5212; branch = 99 failed / 5274 passed of 5402 (+190 new tests); comm -13 of failing-assertion sets = empty; verify-no-regression output on master and branch is byte-identical (15 entries, pre-existing, mostly wave8-integration, request-details-tab).

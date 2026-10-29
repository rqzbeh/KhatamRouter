# Acceptance Gates: Spec 013 — Upstream v0.5.112 Port

OWNS: specs/013-upstream-0-5-112/**, .unlazy/013-upstream-0-5-112/**, specs/README.md

Scope: Full upstream v0.5.112 port (14 commits) covering Gemini schema predicates, non-streaming SSE errors, NVIDIA reasoning alias, CodeBuddy channel headers, bulk-add opaque tokens, DeepSeek PoW hash solver with restored validation, Codex GPT-6.1 Terra, Qoder Sonus/Cantus, GitHub Copilot Claude 5.5 thinking rules, CommandCode CLI 1.88.0 headers, Nace Drex provider, MiniMax desktop named-pipe lease broker with loopback guard and Redis cluster cache, OpenCode Free TLS parity proof, and version 0.5.112 alignment with zero regressions.

- [ ] G1: Baseline regression snapshots and safety guards verified
  CHECK: bun -v | grep -qE "1\.[345]" && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-oauth-urls.mjs && echo G1_PASS
  EXPECT: G1_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G2: Core routing, error handling and param normalization verified
  CHECK: test -s tests/unit/gemini-schema-array-items-predicate.test.js && test -s tests/unit/nonstream-sse-error.test.js && test -s tests/unit/param-support.test.js && test -s tests/unit/codebuddy-channel-headers.test.js && test -s tests/unit/bulk-add-names.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/gemini-schema-array-items-predicate.test.js tests/unit/nonstream-sse-error.test.js tests/unit/param-support.test.js tests/unit/codebuddy-channel-headers.test.js tests/unit/bulk-add-names.test.js && cd tests && bun x vitest run unit/gemini-schema-array-items-predicate.test.js unit/nonstream-sse-error.test.js unit/param-support.test.js unit/codebuddy-channel-headers.test.js unit/codebuddy-intl-backoff.test.js unit/bulk-add-names.test.js && echo G2_PASS
  EXPECT: G2_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G3: DeepSeek PoW noble-hashes module and input validation verified
  CHECK: test -s tests/unit/deepseek-pow-hash.test.js && [ $(grep -c 'expect(' tests/unit/deepseek-pow-hash.test.js) -ge 8 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/deepseek-pow-hash.test.js && cd tests && bun x vitest run unit/deepseek-pow-hash.test.js && echo G3_PASS
  EXPECT: G3_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G4: Codex, Qoder and GitHub Copilot Claude 5.5 capabilities verified
  CHECK: test -s tests/unit/codex-gpt6-lite.test.js && test -s tests/unit/qoder-frontier-models.test.js && test -s tests/unit/github-claude-5-5-thinking.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/codex-gpt6-lite.test.js tests/unit/qoder-frontier-models.test.js tests/unit/github-claude-5-5-thinking.test.js && cd tests && bun x vitest run unit/codex-gpt6-lite.test.js unit/qoder-frontier-models.test.js unit/github-claude-5-5-thinking.test.js && echo G4_PASS
  EXPECT: G4_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G5: CommandCode CLI 1.88.0 headers and Nace Drex provider verified
  CHECK: test -s tests/unit/commandcode-headers.test.js && test -s tests/unit/commandcode-usage.test.js && test -s tests/unit/nace-systemone-provider.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/commandcode-headers.test.js tests/unit/commandcode-usage.test.js tests/unit/nace-systemone-provider.test.js && cd tests && bun x vitest run unit/commandcode-headers.test.js unit/commandcode-usage.test.js unit/nace-systemone-provider.test.js && node __baseline__/verify-alias.mjs && node __baseline__/verify-providers.mjs && echo G5_PASS
  EXPECT: G5_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G6: MiniMax Code lease broker, loopback guard and Redis cluster cache verified
  CHECK: test -s tests/unit/minimax-code-lease.test.js && [ $(grep -c 'expect(' tests/unit/minimax-code-lease.test.js) -ge 12 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/minimax-code-lease.test.js && grep -q "minimax-code/lease" src/dashboardGuard.js && cd tests && bun x vitest run unit/minimax-code-lease.test.js && echo G6_PASS
  EXPECT: G6_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G7: OpenCode Free and Docker parity proof verified without runtime npm dependencies
  CHECK: test -s tests/unit/opencode-tls-client.test.js && [ $(grep -c 'expect(' tests/unit/opencode-tls-client.test.js) -ge 6 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/opencode-tls-client.test.js && cd tests && bun x vitest run unit/opencode-tls-client.test.js && cd .. && cmp Dockerfile Dockerfile.bun && echo G7_PASS
  EXPECT: G7_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G8: Full regression suite passes with version 0.5.112 alignment and zero regressions
  CHECK: grep -q '"version": "0.5.112"' package.json && grep -q '"version": "0.5.112"' cli/package.json && cd tests && bun x vitest run unit/display-branding-guard.test.js && rm -f /tmp/vitest-spec013.json && (bun x vitest run --reporter=json --outputFile=/tmp/vitest-spec013.json || test -s /tmp/vitest-spec013.json) && node __baseline__/verify-no-regression.mjs /tmp/vitest-spec013.json && echo G8_PASS
  EXPECT: G8_PASS
  CWD: ../..
  EVIDENCE: pending

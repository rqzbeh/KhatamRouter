# Acceptance Gates: Psiphon Rotating Proxy Pool

OWNS: specs/014-psiphon-proxy-pool/**, .unlazy/014-psiphon-proxy-pool/**, specs/README.md, src/lib/network/psiphon/**, src/lib/network/connectionProxy.js, src/sse/handlers/chat.js, src/sse/services/auth.js, open-sse/utils/proxyFetch.js, open-sse/handlers/chatCore.js, src/app/api/proxy-pools/**, src/lib/db/repos/proxyPoolsRepo.js, src/app/(dashboard)/dashboard/proxy-pools/page.js, tests/unit/psiphon-*.test.js, tests/fixtures/fake-psiphon.mjs, docs/PSIPHON.md, README.md, ROADMAP.md, CHANGELOG.md

Scope: new `psiphon` proxy-pool type that holds a best-latency Psiphon tunnel and rotates to a new IP and country on 429, FreeTierError, transport failure or usage threshold; fail-closed; operator-supplied binary.

- [ ] G1: Spec package exists with FR/SC ids and the manager contract
  CHECK: node -e 'const fs=require("fs");const d="specs/014-psiphon-proxy-pool/";for(const f of ["spec.md","plan.md","tasks.md","research.md"])fs.statSync(d+f);const s=fs.readFileSync(d+"spec.md","utf8");const n=(s.match(/### FR-014-\d\d/g)||[]).length;const c=(s.match(/- SC-014-\d\d/g)||[]).length;if(n<12||c<6)process.exit(1);if(!fs.readFileSync(d+"plan.md","utf8").includes("rotate(poolId"))process.exit(1);console.log("G1_PASS")'
  EXPECT: G1_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G2: specs index lists spec 014
  CHECK: grep -q "014-psiphon-proxy-pool" specs/README.md && echo G2_PASS
  EXPECT: G2_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G3: Gates ledger passes gate-lint
  CHECK: node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/014-psiphon-proxy-pool/GATES.md && echo G3_PASS
  EXPECT: G3_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G4: Tunnel manager tests pass (best ping, sticky, rotate new IP+country, single-flight, shutdown)
  CHECK: test -s tests/unit/psiphon-manager.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-manager.test.js) -ge 14 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-manager.test.js && ! grep -rqE "shell: *true|child_process.*exec\(" src/lib/network/psiphon && cd tests && bun x vitest run unit/psiphon-manager.test.js && echo G4_PASS
  EXPECT: G4_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G5: Rotate-and-retry, fail-closed and no direct replay proven; existing proxy suites stay green
  CHECK: test -s tests/unit/psiphon-rotation.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-rotation.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-rotation.test.js && cd tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x vitest run unit/psiphon-rotation.test.js unit/strict-proxy-enforcement.test.js unit/opencode-freetier-direct-replay.test.js unit/opencode-tls-client.test.js && echo G5_PASS
  EXPECT: G5_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G6: Pool API validation, status/rotate endpoints and lint pass
  CHECK: test -s tests/unit/psiphon-pool-api.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-pool-api.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-pool-api.test.js && (cd tests && bun x vitest run unit/psiphon-pool-api.test.js) && bun x eslint src/app/api/proxy-pools "src/app/(dashboard)/dashboard/proxy-pools" src/lib/network && echo G6_PASS
  EXPECT: G6_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G7: Docs state GPL boundary and env vars; docs-claims verifier passes
  CHECK: test -s docs/PSIPHON.md && grep -q "GPL-3.0" docs/PSIPHON.md && grep -q "PSIPHON_BIN" docs/PSIPHON.md && bun scripts/verify-docs-claims.mjs && echo G7_PASS
  EXPECT: G7_PASS
  CWD: ../..
  EVIDENCE: pending

- [ ] G8: No committed Psiphon binary or credentials in the diff
  CHECK: ! git diff --name-only origin/master...HEAD | grep -iE "ConsoleClient$|psiphon.*\.(exe|bin)$|client\.config" && ! git diff origin/master...HEAD | grep -E "^\+.*(PropagationChannelId|SponsorId)\"? *[:=] *\"[A-F0-9]{16}\"" && echo G8_PASS
  EXPECT: G8_PASS
  CWD: ../..
  EVIDENCE: pending

# Acceptance Gates: Psiphon Rotating Proxy Pool

OWNS: specs/014-psiphon-proxy-pool/**, .unlazy/014-psiphon-proxy-pool/**, specs/README.md, src/lib/network/psiphon/**, src/lib/network/connectionProxy.js, src/sse/handlers/chat.js, src/sse/services/auth.js, open-sse/utils/proxyFetch.js, open-sse/handlers/chatCore.js, src/app/api/proxy-pools/**, src/lib/db/repos/proxyPoolsRepo.js, src/app/(dashboard)/dashboard/proxy-pools/page.js, tests/unit/psiphon-*.test.js, tests/fixtures/fake-psiphon.mjs, docs/PSIPHON.md, README.md, ROADMAP.md, CHANGELOG.md

Scope: new `psiphon` proxy-pool type that holds a best-latency Psiphon tunnel and rotates to a new IP and country on 429, FreeTierError, transport failure or usage threshold; fail-closed; operator-supplied binary.

- [x] G1: Spec package exists with FR/SC ids and the manager contract
  CHECK: node -e 'const fs=require("fs");const d="specs/014-psiphon-proxy-pool/";for(const f of ["spec.md","plan.md","tasks.md","research.md"])fs.statSync(d+f);const s=fs.readFileSync(d+"spec.md","utf8");const n=(s.match(/### FR-014-\d\d/g)||[]).length;const c=(s.match(/- SC-014-\d\d/g)||[]).length;if(n<12||c<6)process.exit(1);if(!fs.readFileSync(d+"plan.md","utf8").includes("rotate(poolId"))process.exit(1);console.log("G1_PASS")'
  EXPECT: G1_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=9268e65195b2a200d6895bcdb5fe22fa83c69a7ec0e5da9e107039daf67e5463; exit=0; EXPECT=matched; output-sha256=676a70e3116eca2c7d676af6e59950958244c0ffb2fa26237aec0dfb1bec5478; output-bytes=8; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G2: specs index lists spec 014
  CHECK: grep -q "014-psiphon-proxy-pool" specs/README.md && echo G2_PASS
  EXPECT: G2_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=c079d488a5d9007849154c12257352694140e80894e45abf022eec8abb17bb77; exit=0; EXPECT=matched; output-sha256=e527eb34021010e94d7599e6580504df65aa4ec4462cc412f658b2180b89d38b; output-bytes=8; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G3: Gates ledger passes gate-lint
  CHECK: node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/014-psiphon-proxy-pool/GATES.md && echo G3_PASS
  EXPECT: G3_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=fe50529d93ed8cef744bc8052726f4016245dcef89710f97efcd3fdcdcc5e87c; exit=0; EXPECT=matched; output-sha256=e2c9e46490652d0247baeff2745860f31aed31ac2efe17fcf9b8a385dff48784; output-bytes=16; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G4: Tunnel manager tests pass (best ping, sticky, rotate new IP+country, single-flight, shutdown)
  CHECK: test -s tests/unit/psiphon-manager.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-manager.test.js) -ge 14 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/psiphon-manager.test.js && ! grep -rqE "shell: *true|child_process.*exec\(" src/lib/network/psiphon && cd tests && bun x vitest run unit/psiphon-manager.test.js && echo G4_PASS
  EXPECT: G4_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=a3ebee6dbcc7924f192aeef0066e2b00d33f1e3dd79e3649bcc6054a928a4df7; exit=0; EXPECT=matched; output-sha256=d0fcdd36942dd9b7e1ccc208fdc88df35935e21fc4d3fd8ea7739c6ed6ee3f9d; output-bytes=179; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G5: Rotate-and-retry, fail-closed and no direct replay proven; existing proxy suites stay green
  CHECK: test -s tests/unit/psiphon-rotation.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-rotation.test.js) -ge 10 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/psiphon-rotation.test.js && cd tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x vitest run unit/psiphon-rotation.test.js unit/strict-proxy-enforcement.test.js unit/opencode-freetier-direct-replay.test.js unit/opencode-tls-client.test.js && echo G5_PASS
  EXPECT: G5_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=767fd7d268a2dfc8425d0276f825894f68e7ce4d2a38588ca947eb0066e8ba72; exit=0; EXPECT=matched; output-sha256=43f260f89e77282985c8cdbab2111172d2aa7a4a5fac0e15f74d6e8138205c77; output-bytes=19017; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G6: Pool API validation, status/rotate endpoints and lint pass
  CHECK: test -s tests/unit/psiphon-pool-api.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-pool-api.test.js) -ge 10 ] && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/psiphon-pool-api.test.js && (cd tests && bun x vitest run unit/psiphon-pool-api.test.js) && bun x eslint src/app/api/proxy-pools "src/app/(dashboard)/dashboard/proxy-pools" src/lib/network && echo G6_PASS
  EXPECT: G6_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=563e2aaf4e6ca1c2c9bded9f5e368c4551a6f2c7572c5a2fbb99eab13ad7e536; exit=0; EXPECT=matched; output-sha256=56f8dac70d4fbaf7890642cd0224b98dee96e362faa025950611b98927812f80; output-bytes=7899; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G7: Docs state GPL boundary and env vars; docs-claims verifier passes
  CHECK: test -s docs/PSIPHON.md && grep -q "GPL-3.0" docs/PSIPHON.md && grep -q "PSIPHON_BIN" docs/PSIPHON.md && bun scripts/verify-docs-claims.mjs && echo G7_PASS
  EXPECT: G7_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=0fd097795bc220be325b3cdcba3e5bee483a9bb397414b9ab5414b344cc1ab4a; exit=0; EXPECT=matched; output-sha256=1f06b86e4aba411a0942d4e25bfb6a56a091f41488b5f8229fab11d80521e0b3; output-bytes=3964; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

- [x] G8: No committed Psiphon binary or credentials in the diff
  CHECK: ! git diff --name-only origin/master...HEAD | grep -iE "ConsoleClient$|psiphon.*\.(exe|bin)$|client\.config" && ! git diff origin/master...HEAD | grep -E "^\+.*(PropagationChannelId|SponsorId)\"? *[:=] *\"[A-F0-9]{16}\"" && echo G8_PASS
  EXPECT: G8_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=126d014bfd76eee3c471223674494066dcec5754d1c5826f9365b6a0397f736b; exit=0; EXPECT=matched; output-sha256=a462c77976278cab7193b17bbb3edb2040dadefa810c3da651e51f34ff87f926; output-bytes=8; shell=/bin/sh; cwd=/tmp/khatam-014; path=f2c4e9ff709f/32 entries

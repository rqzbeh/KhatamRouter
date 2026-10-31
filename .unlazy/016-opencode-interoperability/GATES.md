# Acceptance Gates: OpenCode Interoperability & Transport Lifecycle

OWNS: specs/016-opencode-interoperability/**, .unlazy/016-opencode-interoperability/**

Scope: Standard-compliant OpenCode provider translation, native transport lifecycle with fail-closed proxy preservation, bounded conversation identifier memory, strict host metadata privacy, generic deadline aborts, sidecar subprocess resource teardown, and explicit exclusion of unisolated host command execution (#5298) and client-gate evasion (#5328).

- [x] G1: Spec package and quality gates validated
  CHECK: test -s specs/016-opencode-interoperability/spec.md && test -s specs/016-opencode-interoperability/plan.md && test -s specs/016-opencode-interoperability/tasks.md && test -s .unlazy/016-opencode-interoperability/GATES.md && node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs --strict .unlazy/016-opencode-interoperability/GATES.md && echo G1_SPEC_PASS
  EXPECT: G1_SPEC_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=4a301c533dfc8fbabcfcafae9a168fb555dc41358c1bdbf8071be18ab7ede18d; exit=0; EXPECT=matched; output-sha256=2c90773b9488ffbc6d1857ad04eb768be386885efc6bc8d217bb7fe04c7f2b5a; output-bytes=21; shell=/bin/sh; cwd=/tmp/khatam-ports; path=f2c4e9ff709f/32 entries

- [x] G2: Bounded conversation identifiers and neutral host path privacy verified
  CHECK: test -s tests/unit/opencode-fingerprint.test.js && test -s tests/unit/opencode-session.test.js && ! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/opencode-fingerprint.test.js tests/unit/opencode-session.test.js && (cd tests && bun x vitest run unit/opencode-fingerprint.test.js unit/opencode-session.test.js) && echo G2_PRIVACY_PASS
  EXPECT: G2_PRIVACY_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=01592e7ea0b83206f3b1ab2598d5f36c6ae86b8db1db021fb2818f83b48a5220; exit=0; EXPECT=matched; output-sha256=c476d1b2ae7e6e96f737744ff7e21480ae3a49957e89462a4312412913f254e3; output-bytes=678; shell=/bin/sh; cwd=/tmp/khatam-ports; path=f2c4e9ff709f/32 entries

- [x] G3: Proxy-preserving transport contracts and header deadlines verified
  CHECK: test -s open-sse/services/opencodeTlsClient.js && grep -q "FETCH_CONNECT_TIMEOUT_MS" open-sse/config/runtimeConfig.js && ! grep -q "NODE_TLS_REJECT_UNAUTHORIZED *= *['\"]?0" open-sse/services/opencodeTlsClient.js && echo G3_TRANSPORT_PASS
  EXPECT: G3_TRANSPORT_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=b6100de01b6ac1348deda3f8da985e406093933ee85b3382f63374b64934635a; exit=0; EXPECT=matched; output-sha256=6c365a585296bec7bd659106d374b4dd1693314d7fe573b37f76577f887e3630; output-bytes=18; shell=/bin/sh; cwd=/tmp/khatam-ports; path=f2c4e9ff709f/32 entries

- [x] G4: Sidecar subprocess escalation and quota backoff verified
  CHECK: test -s src/lib/network/psiphon/psiphonManager.js && grep -q "sigkillTimeoutMs = 1500" src/lib/network/psiphon/psiphonManager.js && test -s src/sse/handlers/chat.js && echo G4_LIFECYCLE_PASS
  EXPECT: G4_LIFECYCLE_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=8564413d9d52889745a2588b903b58a1f8fba540f4ad11ba6ba777018d59e363; exit=0; EXPECT=matched; output-sha256=0721336fe78b16f8d5327850bb9a833a323b459dc2c1ac1be3db38fb2bc574f6; output-bytes=18; shell=/bin/sh; cwd=/tmp/khatam-ports; path=f2c4e9ff709f/32 entries

- [x] G5: Upstream review ledger and scope boundaries documented
  CHECK: grep -q "PR #5297" specs/016-opencode-interoperability/spec.md && grep -q "PR #5310" specs/016-opencode-interoperability/spec.md && grep -q "PR #5222" specs/016-opencode-interoperability/spec.md && grep -q "PR #5298" specs/016-opencode-interoperability/spec.md && grep -q "PR #5328" specs/016-opencode-interoperability/spec.md && echo G5_AUDIT_PASS
  EXPECT: G5_AUDIT_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=a53da7f0c60d38e39226b37963a41bccac69a0d843f6b0c4f135f4fcdbc53862; exit=0; EXPECT=matched; output-sha256=d424778c06c71cebce78cf3e5d1cf41851a63413d6743bae39142dcfc815ed5d; output-bytes=14; shell=/bin/sh; cwd=/tmp/khatam-ports; path=f2c4e9ff709f/32 entries

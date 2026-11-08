# Acceptance Gates: Regionhop Release Pin (v1.27.0) + BR region exposure

OWNS: src/lib/network/psiphon/regionhopRelease.json, src/lib/network/psiphon/downloader.js, src/lib/network/psiphon/regions.js, Dockerfile, Dockerfile.bun, scripts/ci/regionhop-bump.mjs, .github/workflows/regionhop-release.yml, tests/unit/regionhop-release-pin.test.js, tests/unit/regionhop-bump.test.js, tests/unit/psiphon-regions.test.js, docs/PSIPHON.md, CHANGELOG.md, .unlazy/regionhop-pin/**

Scope: pin the regionhop sidecar release in one manifest and verify its SHA-256 before extraction; make both Dockerfiles read the same pins with a retrying curl and a pre-extract sha256sum check; add a review-only weekly bump workflow with a tested pure rewrite; expose the new BR exit region as a selectable option without changing frozen rotation, quota, OpenCode retry, or selection behavior. Upstream publishes no checksums, so the recorded hashes are trust-on-first-download and detect corruption/tampering only.

- [x] G1: Manifest is the single source and both Dockerfiles pin exactly its version and hashes
  CHECK: cd tests && bun x --bun vitest run unit/regionhop-release-pin.test.js && echo REGIONHOP_PIN_MATCHED
  EXPECT: REGIONHOP_PIN_MATCHED
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=881a69f1404d2a357371f0700c24d9e2c6c2096c76249b874c7c032d90b44ab2; exit=0; EXPECT=matched; output-sha256=b476667cd5ff5ddb213361e1528f67ab0a8803aa9633ba5c5689500632a52a24; output-bytes=256; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G2: Downloader refuses a mismatched tarball, deletes it, and extracts nothing (loopback fixture)
  CHECK: cd tests && bun x --bun vitest run unit/regionhop-bump.test.js unit/regionhop-release-pin.test.js && echo REGIONHOP_HASH_GUARD_PASS
  EXPECT: REGIONHOP_HASH_GUARD_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=600b537516324a68981a35eebfd691e9b692967b8e06d6b7ef1108a872827412; exit=0; EXPECT=matched; output-sha256=378f97d680f1a02e1a2d5ea4472b59a84b8751efa0b1d160fec0f222d17eef12; output-bytes=263; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G3: BR is selectable through the same validation as existing regions and needs a >= v1.27.0 pin
  CHECK: cd tests && bun x --bun vitest run unit/psiphon-regions.test.js && echo PSIPHON_BR_SELECTABLE_PASS
  EXPECT: PSIPHON_BR_SELECTABLE_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=7ba3aa6a7a3e868a9338ed9df0bd85ee348fcd668d360bba24f56cbe44db9363; exit=0; EXPECT=matched; output-sha256=3479eae678b6b7f3afcea4df5c93000bb07f14903ec3655da4fd9805e1d5a49b; output-bytes=263; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G4: Existing downloader and full psiphon suites stay green
  CHECK: cd tests && bun x --bun vitest run unit/psiphon-downloader.test.js unit/psiphon-manager.test.js unit/psiphon-pool-api.test.js unit/wave75-docker-compose.test.js && echo PSIPHON_SUITES_PASS
  EXPECT: PSIPHON_SUITES_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=52b24fa1820901f20537df7afe9f47efb48e3296ec47db168e553496530f6e5e; exit=0; EXPECT=matched; output-sha256=0e1a821533e0c846ccf896468d572da244c301b337f8bb7a86726f11c61218b8; output-bytes=8525; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G5: Changed JavaScript lints clean under the repo ESLint config
  CHECK: bun x --bun eslint src/lib/network/psiphon/downloader.js src/lib/network/psiphon/regions.js "src/app/(dashboard)/dashboard/proxy-pools/page.js" scripts/ci/regionhop-bump.mjs tests/unit/regionhop-release-pin.test.js tests/unit/regionhop-bump.test.js tests/unit/psiphon-regions.test.js && echo REGIONHOP_LINT_PASS
  EXPECT: REGIONHOP_LINT_PASS
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=3abc7bd8f266257a85635df086a9c6a1e06576d4a429ca68507207b12a2a9bc4; exit=0; EXPECT=matched; output-sha256=b3eccb30c2391b860bf6eff61837727f5439a55ec80d8a0616de01c519c39855; output-bytes=20; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G6: Bump script reports NO_UPDATE_NEEDED against the live API after this bump
  CHECK: bun scripts/ci/regionhop-bump.mjs --dry-run 2>/dev/null | grep -qx NO_UPDATE_NEEDED && echo REGIONHOP_NO_UPDATE_NEEDED
  EXPECT: REGIONHOP_NO_UPDATE_NEEDED
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=648704f9d2902f182a8d352eb3af0dd3c8df2b28489e403a95fc687e055efb9a; exit=0; EXPECT=matched; output-sha256=91cf7b6905a642346742ddd567a60a66889cbd251a87bf502cab23eddecbac53; output-bytes=27; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

- [x] G7: Gate ledger passes its own quality lint
  CHECK: bun /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs --strict .unlazy/regionhop-pin/GATES.md
  EXPECT: LINT OK
  CWD: ../..
  EVIDENCE: automatic-evidence=v1; definition-sha256=870359706b9748d2c1fd45c8aca23a8e6a66fb1a96563bffc8f60bbda2adfe50; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter/.claude/worktrees/agent-a0b0ee6b130134f0b; path=9197cb7ec7f9/33 entries

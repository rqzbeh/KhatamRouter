# Gates: production proxy failover diagnosis

Scope: Diagnose actual VPS silent-failover and WARP exit-rotation failures without changing production state or consuming provider quota; reproduce verified defects before fixing.

- [x] G1: Read-only VPS evidence identifies deployed image/version, retry settings, candidate availability and sanitized failure sequence.
  EVIDENCE: Read-only inspection deployed7c3874b5 image/container start19:31UTC, modeall30s attempt120s deadline. Static account pool assignments have no rotation strategy; at19:46:48 proxy timeout then exhausted0 alternatives, returns before account fallback (combo fallback continues). Pools174 total:67 new free active,99 legacy free inactive,8manual active. No production writes/restarts/provider test requests.

- [x] G2: A deterministic regression reproduces the production failure at the real runtime seam before the fix and passes afterward.
  CHECK: bun x --bun vitest run --root tests unit/proxy-failover-runtime.test.js unit/proxy-failover-policy.test.js unit/proxy-failover-source-groups-and-timeouts.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=b808b881ccec507c391743b82cfb0b787ab2c3a91f0923f785a13221c90c2c2f; exit=0; EXPECT=matched; output-sha256=9cf460931417f0d214802e1084f9017f11482a0f2f8f1c7363b78d74b3f2ca75; output-bytes=90653; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=43ddf9f95584/31 entries

- [x] G3: WARP diagnosis distinguishes new exit selection from repeated same-daemon request and reports actual exit/health evidence without claiming unmeasured IP rotation.
  EVIDENCE: Bundled daemons health ready,WARPipv6 enabled active2standby2cooling15/13 at20:07UTC; counters do not prove publicIP change. Separate ofu-engine native logs show exit replacement on42919:30/19:33 but are not attributed to bundled daemons. Global failover suppresses sidecar retry branch; whole managed pool cooled16088s on upstream429. No outbound identity probes; quota attribution remains unproven. Managed-path regression/fix still required before completion.

- [x] G5: Public-feed import diagnosis explains actual inactive VPS rows, and verified imports are enabled by default without treating legacy inactive defaults as explicit operator disables.
  CHECK: bun x --bun vitest run --root tests unit/free-proxy-quality-gate.test.js unit/free-proxy-api.test.js unit/proxy-pool-patch.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f257dbaf3a16ae966fb721fa4fdd320c4bb3eebc6200a42dcdd3ecac8d9f9ad; exit=0; EXPECT=matched; output-sha256=721e91a02229d7dec8dd6cc0d5e0e976169982f4c463ba0159efe47549604622; output-bytes=16900; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=43ddf9f95584/31 entries

- [x] G6: Managed WARP regressions prove upstream rejection does not quarantine the entire healthy multi-exit daemon, and global failover preserves bounded transport recovery without bypassing account/usage restrictions.
  EVIDENCE: Parent red-before-green test: account429 wrongly cooled healthy daemon; fixed transport-only daemon quarantine. Dedicated WARP lane excludes unrelated HTTP proxies. All-enabled unavailable-daemon test red503 then green200 after one pre-dispatch restart; no upstream quota retry added. Nine suites114tests pass. Actual bundled public exit identity remains unmeasured.

- [x] G4: Targeted regressions, security review and build validate any fix; deployment/restart is not performed without authorization.
  EVIDENCE: Nine focused suites114tests passed, changed-file ESLint and diff check passed. Production Webpack build passed after managed-daemon recovery change; final empty-list WARP guard covered by focused tests. Parent security review preserves strict WARP routing/account quota and re-probes legacy imports before activation; no production writes/restarts.

# Gates: bounded proxy failover

OWNS: specs/021-proxy-failover/**

Scope: Implement and verify None, Custom additional-proxy count and All available eligible configured proxies; never direct-egress or bypass account protections.

- [x] G1: None, Custom positive integer and All policies persist through edit/save/reopen; malformed modes/counts are rejected.
  CHECK: bun x --bun vitest run --root tests unit/proxy-failover-policy.test.js unit/proxy-failover-settings-api.test.js unit/proxy-failover-runtime.test.js unit/proxy-failover-source-groups-and-timeouts.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=985eb046aea6b5beea06dda9ce6fd87cf6d985970b9f4eeca2cdb33bf3f85bd8; exit=0; EXPECT=matched; output-sha256=04ea352f3e485e2081926402f66afdc4733bb8dd8484c5c659f3607828df8eec; output-bytes=88610; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=b7a4c7e8eecc/31 entries

- [x] G2: Runtime tests prove success recovery, Custom N+1 exhaustion, All over more than ten distinct snapshot candidates, no revisits, random/round-robin selection and preservation of the real final error.
  CHECK: bun x --bun vitest run --root tests unit/proxy-failover-policy.test.js unit/proxy-failover-settings-api.test.js unit/proxy-failover-runtime.test.js unit/proxy-failover-source-groups-and-timeouts.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=985eb046aea6b5beea06dda9ce6fd87cf6d985970b9f4eeca2cdb33bf3f85bd8; exit=0; EXPECT=matched; output-sha256=6933506024684d3ebbbd74271b2877cb2e0b811d03c92baed651ae98c8ce2e38; output-bytes=88602; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=b7a4c7e8eecc/31 entries

- [x] G3: Tests prove no direct egress, no intermediate client errors, no retries after stream commitment, bounded per-attempt and overall deadlines, prompt cancellation/resource cleanup, and no authentication/account quota bypass.
  CHECK: bun x --bun vitest run --root tests unit/proxy-failover-policy.test.js unit/proxy-failover-settings-api.test.js unit/proxy-failover-runtime.test.js unit/proxy-failover-source-groups-and-timeouts.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=985eb046aea6b5beea06dda9ce6fd87cf6d985970b9f4eeca2cdb33bf3f85bd8; exit=0; EXPECT=matched; output-sha256=a3ce0cef7b936e4c4644edb419ae3b343a80d28b8df65bb3e37e99d1da463a97; output-bytes=88612; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=b7a4c7e8eecc/31 entries

- [x] G4: Targeted regressions, lint and production build pass on integrated changes.
  EVIDENCE: Parent independently ran combined 281-test regression set and final 118-test focused set; all changed JavaScript lint and diff checks passed; final production build including strict initial cooldown selection exited 0. Comprehensive integrated suite: 6448 passed, same 71 baseline assertion failures, zero new failure keys. CI container smoke remains required for delivery.

- [x] G6: Same-source sibling proxy regressions prove only the failed endpoint is cooled for the configured interval, retries and later requests skip it until expiry, and healthy siblings/other sources remain usable.
  CHECK: bun x --bun vitest run --root tests unit/proxy-failover-source-groups-and-timeouts.test.js unit/proxy-failover-runtime.test.js
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=f202035d3f0cbfba3dd49467e44f74d4c1e16baef8ef37f6034939a57265defe; exit=0; EXPECT=matched; output-sha256=b143cbdfd91c64374414d92d1445d4d850607c6a0206e9ec8c8a45e31e8540dc; output-bytes=85201; shell=/bin/sh; cwd=/home/redsnow/KhatamRouter; path=b7a4c7e8eecc/31 entries

- [x] G5: Security and integration review confirms replay safety, bounded nested retries and secret-free diagnostics; documentation accurately explains tradeoffs.
  EVIDENCE: Parent reviewed strict initial/alternative proxy flags, immutable credential clones, transport-marker clearing, finite candidate snapshot, real final response, deadline/cancel paths, 429 account/billing exclusions and per-endpoint cooldown. Fixed missing error-result import and all-cooling initial direct fallback; regressions prove zero dispatch when none eligible. Logs identify pool IDs only. README documents None/Custom/All, 30s/120s defaults and HTTP idle constraints. No live quota tests used.

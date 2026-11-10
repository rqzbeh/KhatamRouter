# Gates: integrated resilience delivery

OWNS: DELIVERY-GATES.md, README.md, ROADMAP.md, CHANGELOG.md

Scope: Finish requested proxy None/Custom/All silent retries with 429 and per-endpoint cooldown, combo cooldown toggle, free-proxy scheduling and provider model-test hang fix; verify integrated code and deliver authorized PR/merge.

- [x] G1: All feature acceptance ledgers pass independent re-verification on the final integrated working tree.
  EVIDENCE: GATES.md 4/4, MODEL-TEST-GATES.md 4/4 and specs/021-proxy-failover/GATES.md 6/6 met after parent tests and security corrections. Runtime tests include all-cooling/no-active zero-dispatch and actual handler retries.

- [x] G2: Comprehensive offline suite has no newly introduced failures relative to the same base/toolchain; targeted tests and registry baselines pass.
  EVIDENCE: Integrated offline suite 6448 passed/71 assertion failures; base db43e043 6324 passed/same71, normalized failure-key delta empty. Same root-CWD collection failures reproduce on base. Final focused118 tests and changed-file lint pass; provider/alias/OAuth baselines and docs claims pass. Required CI core/waves/sidecar/typecheck/baselines passed on c63faee8.

- [ ] G3: Production build and isolated container smoke pass for the delivered commit.
  EVIDENCE: production build passed locally; local Haiku Docker agent blocked by provider HTTP400 unsupported location before verification. Existing Verify CI container-smoke job must build/boot/probe delivered commit before merge; no local smoke success claimed.

- [x] G4: Security-first final diff review has no unresolved confirmed defects; no credentials, unrelated screenshot or local-only settings are committed.
  EVIDENCE: Parent reviewed strict egress, account/quota exclusions, finite budgets, per-endpoint cooldown, deadline/cancel and batch cleanup. No .env secrets/local settings/worktrees committed; freeproxy-card.png remains untracked and excluded. New tests are mocked; PR#156 contains explicit security and baseline-failure notes.

- [ ] G5: PR is opened with verification/security notes, required CI passes, merge completes, and master is verified at the merge commit.
  EVIDENCE: pending; authorized by user request to test comprehensively then open PR and merge

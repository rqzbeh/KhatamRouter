# Research decisions

## Release boundary

Decision: use tagged `.112` at `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d` and untagged `.116` package commit `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`; audit `.112` inclusively from `.111` at `3a978a631ad65529c06e48ce495092d5bba29f46`.
Rationale: independently verified git rev-list set equality gives 43 audited SHAs, 14 already covered and 29 new. Intermediate requested versions have no repository version transitions. Do not substitute a moving upstream HEAD.
Alternatives: tag-only lookup would incorrectly claim .116 unavailable; blind HEAD import would expand scope.

## Prior coverage

Decision: preserve proven local .112 adaptations. Its 15-file targeted regression run passed 251 tests under Bun; provider, alias, OAuth and documentation baseline scripts passed. See local-audit.md for source evidence.
Rationale: duplicate imports could undo stronger local controls.
Alternative: reapply all .112 changes without source reconciliation.

## Runtime applicability

Decision: two Node/npm dynamic-runtime fixes (`f0938ea7`, `e3139a43`) are architecturally inapplicable because the affected downloader/hooks were permanently removed. Their intended reliable dependency availability is supplied by Bun native SQLite and locked build-time wreq-js dependencies. Existing OpenCode Free terminal aliasing (`95dafae3`) remains unchanged and tested.
Rationale: importing those files violates the supported runtime rather than improving parity. This is explicit equivalence evidence, not omitted behavior.

## Port partition

Decision: four file-disjoint implementation leaves: translator/CommandCode, transport/OpenCode Go/CodeBuddy, image/quota/catalog, CLI/TTS/dashboard tools. Shared provider validation edits belong exclusively to transport; shared translator thinking/cache files belong exclusively to translator. Registry baseline regeneration belongs to integration only.
Rationale: upstream commits overlap shared files; behavior clusters must not race on those paths.

## Credential import hardening

Decision: CommandCode auto-import requires session authentication even with dashboard login disabled and loopback-only peer validation. Bound credential file reads, do not leak absolute paths or raw exceptions, and test denied callers before filesystem access.
Rationale: the endpoint accesses host credentials and cannot inherit optional dashboard authentication semantics.
Alternative: upstream's direct route copy without explicit guard registration is unacceptable.

## Bun adaptations and egress

Decision: all commands, tests, package hooks and child-process runtime invocations use Bun. Transport port must preserve fork-specific strict proxy handling and safe replay constraints; no unrelated Psiphon/OpenCode Free quota-rotation changes. Network retries must be bounded, preserve caller aborts and avoid replaying consumed request bodies.
Rationale: direct upstream transport replacement would regress fork security and behavior.

## Delivery and isolation

Decision: finish on isolated 019 worktree, reconcile latest master and peer docs before merge, then green required CI and merged-master verification. Docker operations remain delegated to Haiku. No live production deployment is assumed from an unspecified target.
Rationale: primary 018 is unfinished and explicitly not shippable; preserving it is required.

## Baseline correction

A pre-existing Spec017 display-branding guard failure was verified, peer-assigned and fixed in one string (`773448b7`, formerly `bcb03020` pre-rebase); the existing three branding tests independently pass. No ignore lists were added.

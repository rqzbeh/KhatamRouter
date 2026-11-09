# Tasks: 9router Release Parity

## Phase 1 — Setup

- [x] T001 Create isolated branch/worktree and Spec-Kit package at specs/019-upstream-05116/ without touching dirty primary 018.
- [x] T002 [P] Enumerate authoritative releases/SHAs in specs/019-upstream-05116/upstream-commits.json and upstream-inventory.md.
- [x] T003 [P] Audit prior .112 coverage and runtime/security/test constraints in specs/019-upstream-05116/local-audit.md.
- [x] T004 Verify exact inventory against git rev-list and run prior .112 targeted tests (251 passing) plus baselines; record research.md.
- [x] T005 Fix pre-existing batch executionNote branding in src/app/api/models/test-batch/route.js and independently run existing branding guard.

## Phase 2 — Foundations

- [x] T006 Define public/security/runtime boundaries in specs/019-upstream-05116/contracts/parity.md and evidence entities in data-model.md.
- [x] T007 Fix disjoint leaf file ownership and executable Unlazy gates in .unlazy/upstream-019/PLAN.md and gates/leaf-2.*.md before production port edits.

## Phase 3 — US1: Complete compatible upstream behavior

Independent test: each leaf's targeted upstream behavioral tests passes under Bun; negative/security cases remain enforced.

- [x] T008 [P] [US1] Port thinking intent/budgets, DashScope cache markers, Gemini tool responses and tool-reference dedupe in open-sse/services/provider.js, open-sse/translator/, open-sse/utils/toolDeduper.js and open-sse/handlers/chatCore.js; add corresponding tests.
- [x] T009 [US1] Adapt CommandCode v1.88.5 protocol/header/usage and bounded credential auto-import in open-sse/executors/commandcode.js, open-sse/shared/commandCodeHeaders.js, src/app/api/oauth/commandcode/auto-import/route.js, src/dashboardGuard.js and provider AddApiKeyModal.js; test authentication and remote denial.
- [x] T010 [P] [US1] Adapt transport retries/TLS/keepalive and Kiro regions in open-sse/utils/proxyFetch.js, open-sse/config/runtimeConfig.js, open-sse/executors/base.js, default.js and kiro.js; preserve strict proxy, body replay and abort constraints with negative tests.
- [x] T011 [US1] Port OpenCode Go endpoint/thinking updates and CodeBuddy system preservation in open-sse/providers/registry/opencode-go.js, open-sse/executors/opencode-go.js, codebuddy-intl.js, open-sse/services/usage/opencode-go.js and provider test/validate routes.
- [x] T012 [P] [US1] Port native Codex image routing/error handling/Image 2.6 models and Gemini MIME in open-sse/handlers/imageProviders/codex.js, imageGenerationCore.js, open-sse/providers/registry/codex.js, open-sse/translator/formats/gemini.js and relevant config/capability/pricing maps; add media regressions.
- [x] T013 [US1] Port Antigravity Argon quota, SenseNova models and Jina/Tavily format options in open-sse/services/usage/, src/sse/services/antigravityQuota.js, registry/sensenova.js, open-sse/handlers/fetch/index.js and affected dashboard helpers; add tests.
- [x] T014 [P] [US1] Adapt Bun-only PID launcher/tray diagnostics and PoW packaging in cli/cli.js, cli/src/cli/utils/launcherProcess.js, cli/hooks/trayRuntime.js, cli/src/cli/tray/tray.js and cli/scripts/build-cli.js; add CLI process/package tests.
- [x] T015 [US1] Port shared in-process TTS voice listing in src/lib/ttsVoices.js and both voice routes; expand Add All Active Models via src/shared/utils/selectableModels.js and GenericCliToolCard.js; add regression tests.

## Phase 4 — US2: Prove exhaustive parity

Independent test: independently recomputed SHA set equals disposition set; each applicable change has source/test evidence.

- [x] T016 [US2] Finalize every SHA disposition/evidence in specs/019-upstream-05116/upstream-commits.json and docs/UPSTREAM-PORTS.md; no pending applicable entries.
- [x] T017 [US2] Implement executable evidence consistency checks and negative controls in scripts/verify-019.mjs.
- [x] T018 [US2] Regenerate only affected registry baselines in tests/__baseline__/ and verify existing provider/alias/OAuth guards; no broad unrelated rewrites.

## Phase 5 — US3: Isolated verified shipment

Independent test: reviewed PR passes all required checks; merged master contains reviewed changes and unrelated primary work remains untouched.

- [x] T019 [US3] Independently re-run all leaf gates and review authentication, secret exposure, SSRF, headers, proxy and replay risks in changed source; fix any confirmed defects.
- [x] T020 [US3] Run integrated translator/provider/CLI/API regressions and Bun syntax/lint checks against affected files; update specs/019-upstream-05116/results.md.
- [x] T021 [US3] Pinned-revision build and HTTP verification performed; local Docker BLOCKED (missing CLI), CI container smoke (amd64/arm64) configured in verify.yml and required for merge.
- [x] T022 [US3] Update README.md, ROADMAP.md, CHANGELOG.md, specs/README.md and release metadata (0.5.116) to reflect delivered verified scope without overwriting peer Spec 017 docs.
- [ ] T023 [US3] Reconcile latest origin/master in isolated checkout, rerun impacted checks, create PR with explicit security notes, wait for required green CI and merge.
- [ ] T024 [US3] Verify merged master revision/checks, finalize gate evidence and clean up only own finished branch/worktree; preserve primary and peers.

## Dependencies and parallel execution

T001–T007 block source implementation. T008–T009 share translator ownership in leaf 2.1; T010–T011 share transport ownership in leaf 2.2; T012–T013 share media/catalog ownership in leaf 2.3; T014–T015 share CLI/services ownership in leaf 2.4. These four leaves may run concurrently with exact disjoint ownership and no registry baseline writes. T016–T024 follow parent verification of all four leaves. Integration owns baseline regeneration, release metadata and final documentation exclusively.

## Implementation strategy

Deliver all required stories as one reviewed upstream parity PR. Each behavior group is independently testable, but a partial group is not completion of the user request. All workers use Haiku; main session remains planner/reviewer. Commands and child-process tests use Bun only. No credentials or production data are needed for deterministic mocks, and no mocked result is labeled a live provider probe.

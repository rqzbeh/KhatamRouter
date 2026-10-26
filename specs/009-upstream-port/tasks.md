# Tasks: 009 Upstream Port Retrospective Verification & Acceptance Gates

**Branch**: `spec/009-upstream-port`  
**Scope**: 44 audit-confirmed upstream candidates (VansRouter 11, 9router 33) from VansRouter v0.91.61→v0.91.81 and 9router v0.5.104→v0.5.109  
**Status**: Completed and merged to master via PR #65 (commit 5882c50b)  
**Operating Discipline**: All implementation and repairs are executed strictly by **Sonnet Workflow subagents**; the main agent plans, orchestrates, reviews, and validates.  
**Scope Boundary (Non-Goal)**: Live GitHub repository migration/transfer is an explicit **NON-GOAL** for this specification. No repository rename, deletion, force push, or branch protection mutation shall be performed. Live repository migration is tracked as a separate future Spec-Kit initiative.  

---

## Execution Graph & Conflict Lanes

The 44 candidates are grouped into sequential same-file clusters (conflict lanes). Candidates sharing files MUST execute/verify sequentially in the order indicated to avoid race conditions or dirty working tree state. Parallel subagent runs are permitted ONLY across disjoint file clusters.

| Lane Identifier | Sequential Candidates Order | Shared Files / Touched Subsystems | Concurrency Rule |
|---|---|---|---|
| **S-gemini** | `a06ec5d8` → `13441197` → `1ea22bfa` | `open-sse/translator/formats/gemini.js`, `open-sse/translator/request/openai-to-gemini.js`, `src/app/api/providers/[id]/models/route.js`, `open-sse/executors/opencode.js` | Strictly sequential within lane |
| **S-deps** | `08ef047f` → `5883110b` | `package.json`, `bun.lock`, `docker-compose.yml`, `src/app/(dashboard)/dashboard/translator/page.js`, `src/shared/constants/monaco.js` | Strictly sequential within lane; disjoint from translator |
| **OpenCode Lane** | `01f1a1fe` → `356f3f5c` → `32c5f30a` → `b8331283` → `d07e5bc3` | `open-sse/executors/opencode.js`, `open-sse/providers/registry/opencode*.js`, `open-sse/providers/thinkingLevels.js`, `open-sse/translator/concerns/reasoning.js`, `open-sse/translator/concerns/thinkingUnified.js` | Strictly sequential within lane |
| **Antigravity / Cline Lane** | `39730d88` → `f172c3c4` → `82aeb907` → `cc0c2311` | `src/app/api/providers/[id]/models/route.js`, `open-sse/providers/registry/antigravity.js`, `open-sse/providers/registry/cline.js`, `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js` | Strictly sequential within lane |
| **CodeBuddy Lane** | `2063f090` → `3b137aa6` | `open-sse/executors/default.js`, `src/app/api/providers/[id]/test/testUtils.js`, `open-sse/config/errorConfig.js` | Strictly sequential within lane |
| **Combo Lane** | `b82f5c4a` → `5cdcddf5` → `ca7b5401` → `9b4ea9eb` → `f3f86fdd` | `open-sse/config/errorConfig.js`, `open-sse/services/accountFallback.js`, `open-sse/services/combo.js`, `open-sse/services/emptyFailover.js`, `src/app/(dashboard)/dashboard/combos/page.js`, `open-sse/services/systemoneRouter.js`, `src/sse/handlers/chat.js` | Strictly sequential; `f3f86fdd` (Smart Router) runs strictly AFTER prior combo changes |
| **RTK Custom Prompt Lane** | `8a842043` | `open-sse/handlers/chatCore.js`, `open-sse/rtk/customPrompt.js`, `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js` | Runs after base chatCore edits |
| **Provider & Correctness Singletons** | `34c66988`, `342ecb0d`, `5853a88a`, `7c42d8f8`, `95c9d03e`, `3ce2b828`, `a440ef43`, `e76a32a0`, `d56f8f18`, `b0655314`, `b08f12d5`, `2720cd2a`, `dbdbb648`, `31b8439b`, `4a76b8de`, `00dd3dfc`, `b6a9ca43`, `351b04cb`, `421f2262`, `161e3493`, `bc4a3cc7`, `a3ca2f9b` | Disjoint subsystem paths (nodesRepo, pi-settings, modelSearchFilter, paramSupport, streamHelpers, kiroConstants, headroom, sensenova, codexStt, etc.) | Parallel-safe across independent singleton files |

---

## Phase 1: Setup & Environment Verification

- [x] T001 Setup: Verify git branch topology, commit tree, and working tree cleanliness on `spec/009-upstream-port`. Exact repo paths: `.git/HEAD`, `specs/009-upstream-port/`. Expected regression command: `git status --porcelain && git log --oneline -5`.
- [x] T002 Setup: Preflight runtime dependencies, verify Bun 1.4.3+ environment, vitest test runner accessibility, and validate snapshot baseline in `tests/__baseline__/known-fails.txt`. Exact repo paths: `package.json`, `bun.lock`, `tests/package.json`, `tests/__baseline__/known-fails.txt`. Expected regression command: `bun -v && cd tests && bun x vitest --version`.

## Phase 2: Foundational Orchestration Gates

- [x] T003 Foundational: Verify Unlazy workflow ledger state, acceptance gate records, and plan alignment across `specs/009-upstream-port/plan.md` and `specs/009-upstream-port/spec.md`. Exact repo paths: `specs/009-upstream-port/plan.md`, `specs/009-upstream-port/spec.md`. Expected regression command: `test -f specs/009-upstream-port/spec.md && test -f specs/009-upstream-port/plan.md`.
- [x] T004 Foundational: Enforce subagent delegation invariants — verify main agent strictly coordinates, reviews, and plans while all repair and implementation tasks execute via Sonnet subagents. Exact repo paths: `specs/009-upstream-port/plan.md`, `CLAUDE.md`. Expected regression command: `grep -q 'sonnet' specs/009-upstream-port/plan.md`.

---

## Phase 3: User Story 1 — Security & Crash Blockers (P1)

Verification and acceptance gates for all 7 critical security, crash, and hang candidates:

- [x] T005 [US1] a06ec5d8f1fea97e064037037b359d991481343b: fix(translator,api): close two merge-blocking findings from the readiness sweep. Exact repo paths: open-sse/translator/formats/gemini.js, src/app/api/providers/[id]/models/route.js. Expected targeted test: `bun x vitest run unit/gemini-prototype-tool-call-id.test.js`.
- [x] T006 [US1] 13441197840bad0c296cc2dc1004d66f04915efb: fix(gemini): drop `items` from a schema node that is not an array. Exact repo paths: open-sse/translator/formats/gemini.js. Expected targeted test: `bun x vitest run unit/gemini-schema-items-non-array.test.js`.
- [x] T007 [US1] 1ea22bfa2f79006953d249f73122e754d6953bf6: fix(sync): resolve the defects a 10-auditor strict review found. Exact repo paths: open-sse/translator/request/openai-to-gemini.js, open-sse/translator/formats/gemini.js, open-sse/executors/opencode.js. Expected targeted test: `bun x vitest run unit/gemini-prototype-tool-call-id.test.js unit/opencode-session.test.js`.
- [x] T008 [US1] 2063f090f2b5e1fdc024a0f0ca8444a8c021e500: fix(codebuddy): validate token expiry and wire the 401 refresh path (issue #161). Exact repo paths: open-sse/executors/default.js, src/app/api/providers/[id]/test/testUtils.js. Expected targeted test: `bun x vitest run unit/codebuddy-token-expiry.test.js unit/codebuddy-refresh-wiring.test.js`.
- [x] T009 [US1] 08ef047f8c2ede799294ca4d3ccac4548f63452b: fix(security): bump undici to 7.30.1 and bind headroom to loopback. Exact repo paths: package.json, docker-compose.yml. Expected targeted test: `bun pm ls | grep undici && grep -q '127.0.0.1:8787:8787' docker-compose.yml`.
- [x] T010 [US1] 5883110b9d9db32b76d113a378c0ec2abf5943d7: fix(deps): upgrade Monaco to 0.57.0 and pin the copy the dashboard loads. Exact repo paths: package.json, src/app/(dashboard)/dashboard/translator/page.js, src/shared/constants/monaco.js. Expected targeted test: `bun x vitest run unit/monaco-version.test.js`.
- [x] T011 [US1] 342ecb0dd18454f4f623bed2ca1310ef17d8cf16: fix(pi-settings): declare existingProvider before use in POST. Exact repo paths: src/app/api/cli-tools/pi-settings/route.js. Expected targeted test: `bun x vitest run unit/cli-tools-api-key-resolution.test.js`.

---

## Phase 4: User Story 2 — Correctness & Resilience Bug Fixes (P1)

Verification and acceptance gates for all 25 correctness, resilience, and performance candidates:

- [x] T012 [US2] 01f1a1fe981e5c2b702a3dca9d1cae6f195dd690: fix(opencode): encode a real timestamp in ses_/msg_ ids (issue #162). Exact repo paths: open-sse/executors/opencode.js, src/app/api/providers/[id]/test/testUtils.js. Expected targeted test: `bun x vitest run unit/opencode-session-id.test.js`.
- [x] T013 [US2] 39730d88238bd1770d8bccd8bde1b86e0febc8d2: fix(antigravity): repair model discovery (upstream issue #4816) & stop dropping real models. Exact repo paths: src/app/api/providers/[id]/models/route.js. Expected targeted test: `bun x vitest run unit/antigravity-models-discovery.test.js`.
- [x] T014 [US2] 34c669880bfdec994d3ba524613be6912d0b1d6a: fix(models): honor node-scoped model disabling and purge node rows on delete [a8f63f4d]. Exact repo paths: src/lib/db/repos/nodesRepo.js. Expected targeted test: `bun x vitest run unit/provider-custom-models.test.js`.
- [x] T015 [US2] e76a32a085f9772ff8efae1a4523542d867e407b: fix(translator): keep reasoning on the Claude non-streaming path [1d4335d4]. Exact repo paths: open-sse/handlers/chatCore/nonStreamingHandler.js. Expected targeted test: `bun x vitest run unit/claude-nonstreaming-reasoning-alias.test.js`.
- [x] T016 [US2] d56f8f185d59b969bc30084110dbc12953a409d4: fix(handlers): close the last three audit findings. Exact repo paths: open-sse/handlers/chatCore/requestDetail.js. Expected targeted test: `bun x vitest run unit/ollama-usage.test.js`.
- [x] T017 [US2] 5853a88a22f68119a8f491f22bfa0df54fcad542: fix(search): reset regex state between model matches. Exact repo paths: src/shared/utils/modelSearchFilter.js. Expected targeted test: `bun x vitest run unit/model-search-filter.test.js`.
- [x] T018 [US2] 7c42d8f87bac934184f633f985c8a944c8c6336e: fix(openai): rename max_tokens to max_completion_tokens. Exact repo paths: open-sse/translator/concerns/paramSupport.js. Expected targeted test: `bun x vitest run unit/param-support.test.js`.
- [x] T019 [US2] b82f5c4a2e5f53c2723d49fe993062f9e7dba54a: fix(combos): try the next model when credits run out. Exact repo paths: open-sse/config/errorConfig.js. Expected targeted test: `bun x vitest run unit/combo-credit-fallback.test.js`.
- [x] T020 [US2] 5cdcddf55f4b08fbd45c3798c712608544c569d2: fix(combo): advance past a request-scoped 4xx instead of ending the combo. Exact repo paths: open-sse/services/accountFallback.js, open-sse/services/combo.js. Expected targeted test: `bun x vitest run unit/combo-request-scoped-fallback.test.js`.
- [x] T021 [US2] ca7b54011daf4532b3b7ececa90a125bafb99056: fix(combo): fall through on empty-content streaming responses. Exact repo paths: open-sse/services/combo.js, open-sse/services/emptyFailover.js, open-sse/config/runtimeConfig.js, open-sse/translator/schema/finishReasons.js, open-sse/translator/schema/streamEvents.js. Expected targeted test: `bun x vitest run unit/combo-empty-failover.test.js`.
- [x] T022 [US2] 95c9d03ed2fced1e01a1d0c6ba510f9b33c65f85: fix(stream): fill missing tool-call ids and restore renamed tool names (#4992, #4986). Exact repo paths: open-sse/handlers/chatCore/streamingHandler.js, open-sse/translator/index.js, open-sse/utils/stream.js, open-sse/utils/streamHelpers.js. Expected targeted test: `bun x vitest run unit/gemini-duplicate-tool-call-ids.test.js unit/claude-thinking-stream-boundaries.test.js`.
- [x] T023 [US2] d07e5bc3fbfd80ba870e91acb2a93f40f6a58f9f: fix(thinking): let a transport declare its thinking shape; nest reasoning on OpenCode Go /responses. Exact repo paths: open-sse/providers/registry/muse.js, open-sse/providers/registry/opencode-go.js, open-sse/translator/concerns/thinkingUnified.js. Expected targeted test: `bun x vitest run unit/opencode-go-muse-spark-responses.test.js`.
- [x] T024 [US2] 3ce2b828f33bce0c88374077bc20b6b24382a1fd: fix(kiro): normalize Anthropic model ids onto Kiro upstream aliases. Exact repo paths: open-sse/config/kiroConstants.js. Expected targeted test: `bun x vitest run unit/kiro-api-key-endpoint-routing.test.js`.
- [x] T025 [US2] b0655314b79c7a7bfb7288982cddb98503641429: fix(capabilities): give Grok 4.7 its 500k context window. Exact repo paths: open-sse/providers/capabilities.js, open-sse/providers/registry/grok-cli.js, open-sse/providers/registry/xai.js. Expected targeted test: `bun x vitest run unit/capabilities.test.js`.
- [x] T026 [US2] f172c3c4a622dc531b4ce47a24f7a61ed0f530da: fix(antigravity): use hub/2.24.0 User-Agent and add Gemini 4 Argon medium/low tiers (#4816). Exact repo paths: open-sse/providers/registry/antigravity.js, open-sse/providers/shared.js, open-sse/services/usage/google.js. Expected targeted test: `bun x vitest run unit/gemini-4-argon.test.js unit/antigravity-ide-version.test.js`.
- [x] T027 [US2] 32c5f30a0a2074269d7d4cb269d93e7db59d9877: fix(capabilities): send reasoning_effort for OpenCode's glm-5.3-flash-free. Exact repo paths: open-sse/providers/capabilities.js. Expected targeted test: `bun x vitest run unit/opencode-free-glm-thinking-format.test.js`.
- [x] T028 [US2] b833128338ab5c1af7a994767167c3ed0daf8ab5: fix(opencode-free): full reasoning support for oc/mimo-v2.6-flash-free and deepseek-v4.1-flash-free. Exact repo paths: open-sse/executors/opencode.js, open-sse/providers/registry/opencode.js, open-sse/providers/thinkingLevels.js, open-sse/translator/concerns/reasoning.js, open-sse/translator/concerns/thinkingUnified.js. Expected targeted test: `bun x vitest run unit/opencode-free-deepseek-effort.test.js unit/opencode-free-mimo-reasoning.test.js`.
- [x] T029 [US2] a440ef43b5e670aa041f7cc35081e9989fc997db: fix(headroom): compress native Gemini, Responses, and CommandCode tool outputs. Exact repo paths: open-sse/rtk/constants.js, open-sse/rtk/headroom.js, open-sse/translator/schema/blocks.js. Expected targeted test: `bun x vitest run unit/headroom.test.js unit/headroom-responses-format.test.js`.
- [x] T030 [US2] b08f12d5fd80d44e23f8266338ea6707d15b2cf7: fix(codex-image): skip ChatGPT Free accounts and use a Go-compatible main model. Exact repo paths: open-sse/handlers/imageProviders/codex.js, src/sse/handlers/imageGeneration.js. Expected targeted test: `bun x vitest run unit/codex-image-plan-gate.test.js unit/codex-current-provider-base-url.test.js`.
- [x] T031 [US2] 2720cd2a06e1154804b33ca5f7cdbb47a1792336: fix(qoder): stop failing queued models, route Sonus/Cantus, restore capabilities. Exact repo paths: open-sse/executors/qoder.js, open-sse/providers/capabilities.js, open-sse/shared/qoder/constants.js, open-sse/shared/qoder/cosy.js. Expected targeted test: `bun x vitest run unit/qoder-queue-stream.test.js unit/qoder-queue.test.js`.
- [x] T032 [US2] 31b8439bdf51858598aa4fd838e08e396a457cba: fix(usage): support /api/balance for ollama cloud quota tracking (#5026). Exact repo paths: open-sse/services/usage/misc.js, src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js. Expected targeted test: `bun x vitest run unit/ollama-usage.test.js`.
- [x] T033 [US2] 3b137aa6d513babcab45650e86554a0ec3176f98: fix(codebuddy): back off blocked international connections. Exact repo paths: open-sse/config/errorConfig.js. Expected targeted test: `bun x vitest run unit/codebuddy-intl-backoff.test.js`.
- [x] T034 [US2] 4a76b8de02f7711dfb8d78b6146dab94d21468bb: fix(commandcode): correct quota display and connection test. Exact repo paths: open-sse/services/usage/commandcode.js, src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js, src/app/api/providers/[id]/test/testUtils.js. Expected targeted test: `bun x vitest run unit/commandcode-usage.test.js`.
- [x] T035 [US2] 00dd3dfcbe76e967ace4f7166a017f3dcea45800: fix(media-providers): keep the connection card for non-STT OAuth media pages. Exact repo paths: src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js. Expected targeted test: `bun x vitest run unit/video-providers.test.js`.
- [x] T036 [US2] b6a9ca43f1aed8bf903c23b6df62da96a6c389bc: test: triage master's failing suite; fix GLM-5.2 effort, gpt-6.1-sol context, dead SSRF tests. Exact repo paths: open-sse/providers/capabilities.js, tests/unit/image-ssrf.test.js. Expected targeted test: `bun x vitest run unit/capabilities.test.js unit/search-ssrf-guard.test.js`.

---

## Phase 5: User Story 3 — Enhancements, Features & Providers (P2)

Verification and acceptance gates for all 12 enhancements, features, and new provider candidates:

- [x] T037 [US3] cc0c23118bbe37b34123b77c1a3fa1c7abc0850f6: fix(cline): auto-fetch the model catalogue after OAuth (issue #159). Exact repo paths: open-sse/providers/registry/cline.js, src/app/api/providers/[id]/models/route.js, src/app/api/v1/models/route.js. Expected targeted test: `bun x vitest run unit/cline-models-discovery.test.js`.
- [x] T038 [US3] 356f3f5c4717d0759eca6583d6a3fe978194a39a: fix(opencode): pin the free catalogue, the client fingerprint and the egress retry. Exact repo paths: open-sse/providers/registry/opencode.js, open-sse/executors/opencode.js. Expected targeted test: `bun x vitest run unit/opencode-fingerprint.test.js`.
- [x] T039 [US3] 82aeb907941baf9806689a46fe2248b2b865a76d: fix(antigravity): resolve tiered models from client reasoning effort. Exact repo paths: open-sse/config/providerModels.js, open-sse/handlers/chatCore.js. Expected targeted test: `bun x vitest run unit/gemini-4-argon.test.js`.
- [x] T040 [US3] 9b4ea9eb697a267babd96ae33c814e86c80a9c64: feat(combos): search box for the combo list. Exact repo paths: src/app/(dashboard)/dashboard/combos/page.js. Expected targeted test: `bun x vitest run unit/model-search-filter.test.js`.
- [x] T041 [US3] 8a8420430fb19aeb41119b2225d0ee97c5c2a9d2: feat(rtk): add a user-authored custom system prompt. Exact repo paths: open-sse/handlers/chatCore.js, open-sse/rtk/customPrompt.js, src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js. Expected targeted test: `bun x vitest run unit/custom-prompt.test.js`.
- [x] T042 [US3] f3f86fdd52f9e9e9538847dddf233293224733d2: feat(combos): add Smart Router (System One) with adaptive session stickiness (#4975). Exact repo paths: open-sse/services/combo.js, open-sse/services/systemoneRouter.js, src/app/(dashboard)/dashboard/combos/page.js, src/shared/components/SmartPolicyModal.js, src/sse/handlers/chat.js, src/sse/services/systemoneRouter.js. Expected targeted test: `bun x vitest run unit/combo-smart-router.test.js unit/smart-router-ui.test.js`.
- [x] T043 [US3] 351b04cb528d2270a527aba18a4be78fdeadafaa: feat(provider): add SenseNova provider support. Exact repo paths: open-sse/providers/registry/sensenova.js, open-sse/providers/registry/index.js, open-sse/providers/capabilities.js, open-sse/handlers/imageProviders/openai.js, src/app/api/providers/[id]/test/testUtils.js. Expected targeted test: `bun x vitest run unit/capabilities.test.js`.
- [x] T044 [US3] 421f226261750e52323e15d2d26fc964113d96a5: feat(stt): add Codex OAuth transcription provider. Exact repo paths: open-sse/handlers/codexStt.js, open-sse/handlers/codexSttAudio.js, open-sse/handlers/sttCore.js, open-sse/providers/registry/codex.js. Expected targeted test: `bun x vitest run unit/codex-stt.test.js`.
- [x] T045 [US3] dbdbb64897234f595fd2ebbdc53cf5f1f2ca26ea: fix(github): refresh Copilot fallback model catalog. Exact repo paths: open-sse/providers/registry/github.js. Expected targeted test: `bun x vitest run unit/github-model-catalog.test.js`.
- [x] T046 [US3] 161e34939ab878cb79dfdf241a696ec292508af4: feat(image, mitm): support reference image inputs for Gemini and ensure MITM directory (#4981). Exact repo paths: open-sse/handlers/imageGenerationCore.js, open-sse/handlers/imageProviders/gemini.js, src/mitm/paths.js. Expected targeted test: `bun x vitest run unit/gemini-native-endpoint.test.js`.
- [x] T047 [US3] bc4a3cc7342104172a150735b991e11982323e75: feat(ollama): support System One decision models (clef, clef-flash). Exact repo paths: open-sse/providers/registry/ollama.js, open-sse/providers/registry/ollama-local.js, open-sse/handlers/systemoneCore.js. Expected targeted test: `bun x vitest run unit/ollama-systemone.test.js`.
- [x] T048 [US3] a3ca2f9b5cb090f1babf11a8781d5c6148f83411: fix(dashboard): correct API key visibility guidance. Exact repo paths: src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js, public/i18n/literals/*.json. Expected targeted test: `bun x vitest run unit/api-key-visibility-guidance.test.js`.

---

## Phase 6: Closeout & Release Acceptance

- [ ] T049 Closeout: Run full vitest regression test suite and compare results against `tests/__baseline__/known-fails.txt`. Exact repo paths: `tests/`, `tests/__baseline__/known-fails.txt`. Expected regression command: `cd tests && bun x vitest run` (report status strictly as verified-in-workflow; never claim all green until full run executes).
- [x] T050 Closeout: Verify documentation and release artifacts synchronization across README.md, ROADMAP.md, and CHANGELOG.md reflecting Wave 9 upstream port completion. Exact repo paths: `README.md`, `ROADMAP.md`, `CHANGELOG.md`. Expected regression command: `git diff --stat HEAD~1`.
- [x] T051 Closeout: Verify scope boundary integrity confirming that live GitHub repository migration remains strictly excluded as a NON-GOAL and no repository/remote mutations occurred. Exact repo paths: `.git/config`, `specs/009-upstream-port/spec.md`. Expected regression command: `git remote -v`.
- [ ] T052 Closeout: Generate final retrospective verification and acceptance report summarizing all 44 candidates, landed commit mapping, and verification evidence. Exact repo paths: `specs/009-upstream-port/results/verification-report.md`. Expected regression command: `test -f specs/009-upstream-port/tasks.md`.

---

## Already-Landed Commit Map

The implementation for 42 of the 44 candidates is already committed on branch `spec/009-upstream-port` through the following verified commits:

| Landed Commit SHA | Commit Message Subject | Associated Upstream Candidate SHAs | User Story & Lane |
|---|---|---|---|
| `eaf244f168f8dd74fa2ddf46b31d3980badddcf3` | fix(security): bump undici to 7.30.1 and bind headroom to loopback | `08ef047f8c2ede799294ca4d3ccac4548f63452b` | US1 (S-deps) |
| `c6711901a756a8ebe1db00cb355eb4686a7d51c5` | fix(deps): upgrade Monaco to 0.57.0 and pin copy dashboard loads | `5883110b9d9db32b76d113a378c0ec2abf5943d7` | US1 (S-deps) |
| `15c7648a972b7c0170ce013f124342bb0b0078ef` | fix(security): prevent prototype pollution in gemini sanitizer and add timeout guards | `a06ec5d8f1fea97e064037037b359d991481343b` | US1 (S-gemini) |
| `61db02518cdc8fe5248553ea6b02e89f0695944a` | fix(translator): strip items from non-array schema nodes in gemini translator | `13441197840bad0c296cc2dc1004d66f04915efb` | US1 (S-gemini) |
| `720cbcdb4ac8c53e55429803201076396b36f11b` | fix(translator): guard gemini tool response caches against prototype shadowing | `1ea22bfa2f79006953d249f73122e754d6953bf6` | US1 (S-gemini) |
| `0936b5acf6a2178fc0b21e80aa5c47b7b59eb8d7` | fix(codebuddy): validate token expiry, wire 401 refresh, back off blocked intl connections | `2063f090f2b5e1fdc024a0f0ca8444a8c021e500`, `3b137aa6d513babcab45650e86554a0ec3176f98` | US1 & US2 (CodeBuddy Lane) |
| `b60480739b255a90e4a66667eeede55ffce63973` | fix(combos): enhance combo resilience with credit advance, 4xx rotation, empty-SSE | `b82f5c4a2e5f53c2723d49fe993062f9e7dba54a`, `5cdcddf55f4b08fbd45c3798c712608544c569d2`, `ca7b54011daf4532b3b7ececa90a125bafb99056`, `9b4ea9eb697a267babd96ae33c814e86c80a9c64`, `e76a32a085f9772ff8efae1a4523542d867e407b` | US2 & US3 (Combo Lane, Claude Reasoning) |
| `95451d6b75889fb86241005fd5679e5f0bee322c` | fix(antigravity,cline): repair models discovery, add hub UA argon tiers, tiered models | `39730d88238bd1770d8bccd8bde1b86e0febc8d2`, `f172c3c4a622dc531b4ce47a24f7a61ed0f530da`, `82aeb907941baf9806689a46fe2248b2b865a76d`, `cc0c23118bbe37b34123b77c1a3fa1c7abc0850f6` | US2 & US3 (Antigravity/Cline Lane) |
| `5cb3e649e8d0860e5aa29dafdf918cc8e28c837e` | fix(core): port 8 correctness singletons node cleanup, pi settings, regex search, param rename | `34c669880bfdec994d3ba524613be6912d0b1d6a`, `342ecb0dd18454f4f623bed2ca1310ef17d8cf16`, `5853a88a22f68119a8f491f22bfa0df54fcad542`, `7c42d8f87bac934184f633f985c8a944c8c6336e`, `95c9d03ed2fced1e01a1d0c6ba510f9b33c65f85`, `3ce2b828f33bce0c88374077bc20b6b24382a1fd`, `a440ef43b5e670aa041f7cc35081e9989fc997db`, `d56f8f185d59b969bc30084110dbc12953a409d4` | US1 & US2 (Singletons) |
| `e5549485e8c74db05b07938d99584a80e0afd747` | fix(opencode,thinking): support full reasoning, transport thinking shape, monotonic timestamps | `01f1a1fe981e5c2b702a3dca9d1cae6f195dd690`, `356f3f5c4717d0759eca6583d6a3fe978194a39a`, `32c5f30a0a2074269d7d4cb269d93e7db59d9877`, `b833128338ab5c1af7a994767167c3ed0daf8ab5`, `d07e5bc3fbfd80ba870e91acb2a93f40f6a58f9f` | US2 & US3 (OpenCode Lane) |
| `c4af14f4b427058d3639b241b0f5d0ee6d5b380f` | fix(tests): align codebuddy backoff expectations with requestScoped classification | Test alignment for `3b137aa6` and `5cdcddf5` | US2 (Test Suite Guard) |
| `d28d628f49976f5e6ba7267fe66f47e42de34e84` | feat(rtk): add user-authored custom system prompt | `8a8420430fb19aeb41119b2225d0ee97c5c2a9d2` (part 1: core & UI) | US3 (RTK Lane) |
| `bd03b835b92940f1ed304dd0c3dc324ce75f1b42` | feat(rtk): wire custom system prompt through request path and settings | `8a8420430fb19aeb41119b2225d0ee97c5c2a9d2` (part 2: settingsRepo & chat.js) | US3 (RTK Lane) |
| `ccb8dc84882ff23989dc2d1843e505108a8d46ac` | feat(stt): port Codex OAuth transcription provider (cx/transcribe) | `421f226261750e52323e15d2d26fc964113d96a5` | US3 (STT Provider) |
| `273dff231a37f81114ec65367de4f730e6ee3380` | feat(providers): port providers batch for SenseNova, Ollama System One, Copilot, Codex, Qoder | `351b04cb528d2270a527aba18a4be78fdeadafaa`, `bc4a3cc7342104172a150735b991e11982323e75`, `dbdbb64897234f595fd2ebbdc53cf5f1f2ca26ea`, `b08f12d5fd80d44e23f8266338ea6707d15b2cf7`, `2720cd2a06e1154804b33ca5f7cdbb47a1792336`, `31b8439bdf51858598aa4fd838e08e396a457cba`, `4a76b8de02f7711dfb8d78b6146dab94d21468bb`, `00dd3dfcbe76e967ace4f7166a017f3dcea45800`, `a3ca2f9b5cb090f1babf11a8781d5c6148f83411`, `b6a9ca43f1aed8bf903c23b6df62da96a6c389bc` | US2 & US3 (Providers Batch) |
| `84dffab96705124980a8ffce519b7eeaa36df7e4` | feat(combos): add Smart Router with Redis-backed session stickiness | `f3f86fdd52f9e9e9538847dddf233293224733d2` (part 1: core router & Redis stickiness) | US3 (Smart Router Lane) |
| `902dc3aabf514e72a07ec705234f3fba915e9544` | fix(combos): add SmartPolicyModal barrel export and systemone kind filter | `f3f86fdd52f9e9e9538847dddf233293224733d2` (part 2: UI barrel & kind filtering) | US3 (Smart Router Lane) |
| `ff292a12af0500b07a6bfbf853877fb80902bd07` | fix(capabilities): give Grok 4.7 its 500k context window | `b0655314b79c7a7bfb7288982cddb98503641429` | US2 (Capabilities) |
| `3c0ba50b3d67f5b12ee94ce258525b6a71bbbf71` | feat(image, mitm): support reference image inputs for Gemini and ensure MITM directory | `161e34939ab878cb79dfdf241a696ec292508af4` | US3 (Gemini/MITM) |
| `66068ea8e507b01f0403fda43812d84dc64c8db6` | docs(upstream): record Wave 9 upstream ports, audit ledger, and security hardening | Documentation & release artifacts synchronization | Closeout |
| `5882c50b4007716ae45b26861855a0dc13e6217d` | feat(upstream): port audited VansRouter and 9router fixes (#65) | PR #65 merge commit to master | Release Merge |

---

## Verification Completed Status

All 44 candidates from the upstream catalog have been implemented, verified, and merged to `master` via PR #65:

1. **`b0655314b79c7a7bfb7288982cddb98503641429`** (US2): Landed in commit `ff292a12af0500b07a6bfbf853877fb80902bd07` (Grok 4.7 500k context window registered).
2. **`161e34939ab878cb79dfdf241a696ec292508af4`** (US3): Landed in commit `3c0ba50b3d67f5b12ee94ce258525b6a71bbbf71` (Gemini reference image inputs and MITM directory).

---

## Parallel Opportunities

1. **S-gemini vs S-deps**: Disjoint file sets allow concurrent execution between Gemini translator sanitizer verification (`a06ec5d8`, `13441197`, `1ea22bfa`) and dependency upgrades (`08ef047f`, `5883110b`).
2. **Singletons in US2 & US3**: Disjoint singletons (e.g. `34c66988` nodesRepo, `342ecb0d` pi-settings, `5853a88a` regex filter, `7c42d8f8` param renaming, `3ce2b828` kiro aliases, `dbdbb648` github models, `351b04cb` sensenova) can be verified concurrently across independent subagents.
3. **Non-overlapping Providers**: Codex STT (`421f2262`), SenseNova (`351b04cb`), and Ollama System One (`bc4a3cc7`) touch disjoint files and can verify in parallel.

---

## Independent Acceptance Criteria per User Story

### User Story 1 (US1) Acceptance Criteria
- **AC-US1-1**: `undici` is pinned to `^7.30.1` and headroom port is bound strictly to `127.0.0.1:8787:8787` in `docker-compose.yml`.
- **AC-US1-2**: Monaco editor loader is pinned to version `0.57.0` in `src/shared/constants/monaco.js` (closing unpinned CDN loads).
- **AC-US1-3**: Gemini translator prototype-pollution (`__proto__`) and prototype-method shadowing (`toString`, `valueOf`, `constructor`) crash paths are closed using `Object.defineProperty`, `Object.hasOwn`, and `Object.create(null)`.
- **AC-US1-4**: Models discovery route handlers wrap external upstream `fetch` calls with `timedFetch` (8-second timeout guard).
- **AC-US1-5**: CodeBuddy token validation checks JWT `exp` timestamp in `testUtils.js`, and `DefaultExecutor.refreshCredentials` wires 401 refresh recovery.
- **AC-US1-6**: Pi-settings route declares `existingProvider` before object spread, preventing fatal HTTP 500 `ReferenceError`.

### User Story 2 (US2) Acceptance Criteria
- **AC-US2-1**: Combo failover advances to next member when account credits are exhausted (`insufficient credit`, `credit balance too low`).
- **AC-US2-2**: Combo failover rotates past request-scoped 4xx rejections (context overflow, validation error) without permanently cooling healthy accounts.
- **AC-US2-3**: Streaming combo requests peek the first content-bearing frame via `emptyFailover.js` and advance to the next member on empty HTTP 200 streams.
- **AC-US2-4**: OpenCode session IDs encode real monotonic 48-bit timestamps (`ses_`/`msg_`), and dedicated request/session ID stores prevent eviction churn.
- **AC-US2-5**: Antigravity models discovery queries Google live production endpoint and preserves models with `MODEL_PLACEHOLDER_*` tags; User-Agent is updated to `hub/2.24.0` with Gemini 4 Argon medium/low tiers.
- **AC-US2-6**: Stream handling synthesizes missing tool-call IDs on fragments and restores renamed tool names on passthrough.
- **AC-US2-7**: Headroom token saver compresses native Gemini, Responses, and CommandCode tool outputs fail-open within a depth bound of 8.
- **AC-US2-8**: Qoder executor handles `10605` queue capacity signals as transient retries and routes Sonus/Cantus models.

### User Story 3 (US3) Acceptance Criteria
- **AC-US3-1**: RTK custom system prompt allows user-authored prompt injection with length-only logging, settings persistence, and fail-open guarantees.
- **AC-US3-2**: Smart Router (System One) dynamically evaluates request complexity with **strictly Redis-backed** session stickiness (`getRedisClient`, `withRedisKey`), multi-instance replica support, and no in-process Map storage.
- **AC-US3-3**: SenseNova provider is registered with `sensenova-6.8-flash-lite`, U1.5 image models, and connection test validation.
- **AC-US3-4**: Codex OAuth transcription provider (`cx/transcribe`) is registered, reuses Codex credentials, converts audio to 24 kHz PCM16 WAV via ffmpeg, and enforces SSRF guards on fetched audio URLs.
- **AC-US3-5**: Cline public model catalogue auto-discovery fetches and exposes models dynamically upon OAuth connection.
- **AC-US3-6**: Combo dashboard UI provides an interactive search box filtering models and combo names with clear actions.

---

## Task Summary & Verification Status

- **Total Tasks**: 52 tasks  
  - Setup & Foundational: 4 tasks (`T001` - `T004`)  
  - User Story 1 (Security & Crash Blockers): 7 candidate tasks (`T005` - `T011`)  
  - User Story 2 (Correctness & Resilience Bug Fixes): 25 candidate tasks (`T012` - `T036`)  
  - User Story 3 (Enhancements, Features & Providers): 12 candidate tasks (`T037` - `T048`)  
  - Closeout & Acceptance: 4 tasks (`T049` - `T052`)  
- **Candidate Total**: Exactly 44 distinct candidates (VansRouter 11, 9router 33)  
- **Landed Implementation**: All 44 candidates verified committed and merged to `master` in PR #65 (`5882c50b`)  
- **Pending Verification**: 0 candidates (all 44 upstream candidates landed)  
- **Test Status Reporting**: Status reported as **verified-in-workflow** with targeted test gates; full test suite execution against `tests/__baseline__/known-fails.txt` is gated under closeout task `T049` (never claimed green prior to full execution).  
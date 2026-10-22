# Tasks: Wave 7 — VansRouter Provider Parity

**Feature Branch**: `wave7-vansrouter-parity`
**Status**: In Progress

---

## Phase 1: Shared Utilities & Helpers
- [x] Task 1.1: Export `capRetryAttemptsByAccountCount` in `open-sse/config/runtimeConfig.js`.
- [x] Task 1.2: Create `open-sse/utils/cookie.js` exporting `cleanCookie`.
- [x] Task 1.3: Create `open-sse/services/proxyPoolFitness.js` with fail-open in-memory fitness map.

## Phase 2: Provider Registry & Executors
- [x] Task 2.1: Port 5 specialized executors:
  - `open-sse/executors/agentrouter.js`
  - `open-sse/executors/qwen.js`
  - `open-sse/executors/zcode.js`
  - `open-sse/executors/freebuff.js`
  - `open-sse/executors/muse-spark-web.js`
- [x] Task 2.2: Register executors in `open-sse/executors/index.js`.
- [x] Task 2.3: Port all 30 missing provider registry files into `open-sse/providers/registry/`.
- [x] Task 2.4: Update `scripts/migrate-registry.mjs` with index regeneration and regenerate `open-sse/providers/registry/index.js`.

## Phase 3: Free-Tier Catalog Derivation
- [x] Task 3.1: Add `modelHasFree` and `modelFreeRefresh` in `open-sse/providers/models/schema.js`.
- [x] Task 3.2: Create `open-sse/providers/freeTiers.js` with `listFreeTiers()`.
- [x] Task 3.3: Re-export `listFreeTiers` and `FREE_REFRESH_VALUES` from `open-sse/providers/index.js`.

## Phase 4: Token Savers (Ponytail & LoopGuard)
- [x] Task 4.1: Update `open-sse/rtk/ponytailPrompt.js` with full `lite`, `full`, `ultra` prompts.
- [x] Task 4.2: Create `open-sse/utils/loopGuard.js` with `detectLoop` and `applyLoopGuard`.
- [x] Task 4.3: Wire `loopGuardEnabled: false` default into `settingsRepo.js`, `src/sse/handlers/chat.js`, and `open-sse/handlers/chatCore.js`.

## Phase 5: Testing, Baselines & Validation
- [x] Task 5.1: Create `tests/unit/wave7-parity.test.js` with stateless executor tests, loopGuard positive/negative controls, freeTiers tests, and provider registration tests.
- [x] Task 5.2: Update provider and alias baselines via snapshot scripts; verify zero secret leaks.
- [x] Task 5.3: Verify all test gates, regression suites, and baseline checks pass.
- [x] Task 5.4: Execute container smoke test.

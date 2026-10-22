# Implementation Plan: Wave 7 — VansRouter Provider Parity

**Feature Branch**: `wave7-vansrouter-parity`
**Status**: Ready for Implementation

---

## 1. Architecture Overview

Wave 7 achieves parity with VansRouter across three core areas:

1. **Provider Registry & Executors**:
   - Port 30 missing providers from VansRouter into `open-sse/providers/registry/{id}.js`.
   - Port 5 specialized executors into `open-sse/executors/`: `agentrouter.js`, `qwen.js`, `zcode.js`, `freebuff.js`, `muse-spark-web.js`.
   - Provide supporting utilities: `open-sse/utils/cookie.js` (`cleanCookie`), `open-sse/services/proxyPoolFitness.js` (fail-open fitness cache), and `capRetryAttemptsByAccountCount` in `open-sse/config/runtimeConfig.js`.
   - Update `open-sse/executors/index.js` to register the new executors.
   - Script-driven regeneration of `open-sse/providers/registry/index.js` via `scripts/migrate-registry.mjs`.

2. **Free-Tier Catalog Derivation**:
   - Add `modelHasFree` and `modelFreeRefresh` helpers to `open-sse/providers/models/schema.js`.
   - Create `open-sse/providers/freeTiers.js` with `listFreeTiers()` and export from `open-sse/providers/index.js`.

3. **Token Savers & Loop Prevention**:
   - Update the EXISTING `open-sse/rtk/ponytailPrompt.js` (single file, already consumed by `open-sse/rtk/ponytail.js` -> `injectPonytail`) with the richer multi-intensity prompts (`lite`, `full`, `ultra`). No parallel plural file is added.
   - Create `open-sse/utils/loopGuard.js` with stateless `detectLoop(body)` and `applyLoopGuard()`.
   - Wire `loopGuardEnabled` into `settingsRepo.js` (default `false`) and `handleChatCore` (default off).

---

## 2. File Modification & Ownership Boundaries

| Component | Target Files | Nature of Change |
|---|---|---|
| Providers Registry | `open-sse/providers/registry/{a6api,agentrouter,ai21,alibaba,baseten,bytez,codestral,databricks,deepinfra,freebuff,friendliai,galadriel,gigachat,heroku,hive,llamagate,meta,muse-spark-web,nanogpt,nscale,ovhcloud,predibase,publicai,qwen,snowflake,upstage,volcengine,wandb,zcode,zenmux}.js` | Add 30 provider registry definitions |
| Registry Index | `open-sse/providers/registry/index.js`, `scripts/migrate-registry.mjs` | Regenerate index; add auto-generation routine |
| Executors | `open-sse/executors/{agentrouter,qwen,zcode,freebuff,muse-spark-web}.js`, `open-sse/executors/index.js` | Add 5 executors and register them |
| Utilities & Helpers | `open-sse/utils/cookie.js`, `open-sse/services/proxyPoolFitness.js`, `open-sse/config/runtimeConfig.js` | `cleanCookie`, fail-open fitness, `capRetryAttemptsByAccountCount` |
| Free Tiers | `open-sse/providers/models/schema.js`, `open-sse/providers/freeTiers.js`, `open-sse/providers/index.js` | Schema getters and catalog derivation |
| Ponytail RTK | `open-sse/rtk/ponytailPrompt.js` (existing single file) | Upgrade lite/full/ultra prompt text; default stays `ponytailEnabled: false` |
| LoopGuard | `open-sse/utils/loopGuard.js`, `open-sse/handlers/chatCore.js`, `src/lib/db/repos/settingsRepo.js`, `src/sse/handlers/chat.js` | Stateless detection and optional breakout injection |
| Baselines | `tests/__baseline__/providers-baseline.json`, `tests/__baseline__/alias-baseline.json` | Updated snapshot for new providers without secret leakage |
| Unit Tests | `tests/unit/wave7-parity.test.js` | Comprehensive unit tests for parity features |

---

## 3. Risk Mitigation & Security Invariants

1. **No Secret Leakage**:
   - Public OAuth client IDs/secrets are kept in split expressions or redacted in snapshots (`REDACTED_PUBLIC_OAUTH_CLIENT_ID`).
   - Executor `buildHeaders` never caches or persists credentials.
2. **Stateless Executor Contract**:
   - Sequential calls with different API keys must never retain previous keys.
3. **Fail-Open Semantics**:
   - LoopGuard, Ponytail, and proxy pool fitness fail open on malformed input or missing infrastructure.
4. **Alias Collision Prevention**:
   - `muse-spark-web` does not claim `alias: "muse"` so existing Meta Model API `muse` is unharmed.

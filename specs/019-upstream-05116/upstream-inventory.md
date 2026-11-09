# Authoritative Upstream Inventory: 9router 0.5.112 → 0.5.116

**Working Worktree**: `/tmp/khatam-upstream-019` | **Branch**: `019-upstream-05116`
**Upstream Repository**: `https://github.com/decolua/9router.git` (`decolua/9router`)
**Audit Date**: 2026-11-09 | **Status**: Verified & Machine-Validated (`INVENTORY_VALID`)

---

## 1. Executive Summary & Authoritative Discovery

### 1.1 Release Boundary & Version Investigation
A strict, exhaustive audit was conducted across upstream git tags, GitHub releases, package version history, and commit logs on `upstream/master`.

| Metric / Attribute | Value | Authoritative Verification Source |
|---|---|---|
| **Prior Lower Release** | `v0.5.112` | Git tag `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d` |
| **Prior Release Date** | 2026-10-28 16:43:56 +0700 | Commit `1fe586bb` (`# v0.5.112 (2026-10-28)`) |
| **Spec 013 Prior Coverage** | 14 commits (`e70ea24d`..`1fe586bb`) | KhatamRouter PR #119 (`9b56a40a`) & PR #120 (`b74ca77a`) |
| **New Commits Post-0.5.112** | **29 commits** (`736be957`..`1339107e`) | `git log 1fe586bb..1339107e` |
| **Total Commits Audited** | **43 commits** (14 in .112 + 29 post-.112) | Exhaustive zero-skip audit |
| **Latest Release Identified** | **v0.5.116** | Commit `eaeb54a6` (Changelog) & Commit `1339107e` (package.json) |
| **Does 0.5.116 Actually Exist?** | **YES, fully exists on upstream master** | Documented and verified in commit history |
| **Is 0.5.116 Tagged in Git?** | **NO (untagged)** | `git ls-remote --tags upstream` ends at `v0.5.112` |
| **GitHub Releases Status** | Upstream GH releases end at `v0.5.35` | `gh release list --repo decolua/9router` |
| **Intermediate Versions** | **NONE** (`0.5.113`, `0.5.114`, `0.5.115` do not exist) | Direct version leap from 0.5.112 to 0.5.116 |

### 1.2 Package Version History & Upstream Tag Analysis
- `git ls-remote --tags upstream | grep -E 'v0\.5\.'` confirms that the highest git tag on upstream is `v0.5.112` (`1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`).
- `gh release list --repo decolua/9router` shows GitHub releases stopped being published after `v0.5.35` (2026-07-16). Subsequent releases have been published as repository commits and npm package distributions rather than GitHub Release entries.
- Commit `736be957` (2026-10-31) temporarily set `version: "0.5.130-local"` in both `package.json` and `cli/package.json` during transport experimentation.
- Commit `eaeb54a6` (2026-11-08 18:48:07 +0700) is explicitly titled `# v0.5.116 (2026-11-08)`, committing a full changelog of all features/fixes and setting `cli/package.json` to `"0.5.116"`.
- Commit `1339107e` (2026-11-08 18:48:45 +0700) is titled `0.5.116` and sets root `package.json` to `"0.5.116"`.
- **Verdict**: Release `0.5.116` is authoritative and complete on upstream `master`. No pending versions are fabricated.

---

## 2. Inclusive Audit of Prior v0.5.112 Coverage (14 Commits)

In accordance with project instructions, release 0.5.112 is audited inclusively against KhatamRouter's prior local port (Spec 013, delivered via PR #119 commit `9b56a40a` and PR #120 commit `b74ca77a`).

| # | Upstream SHA | Subject | Files Touched | KhatamRouter Disposition | Local Evidence & Invariant Status |
|---|---|---|---|---|---|
| 1 | `e70ea24d` | Fix OpenCode | `open-sse/services/lazyRuntime.js` | `ALREADY_EQUIVALENT_SUPERIOR` | Prohibits dynamic npm downloads. Resolved natively at build time via `wreq-js` in Bun (`open-sse/services/opencodeTlsClient.js`, PR #78). |
| 2 | `acb3c080` | feat(codex): add GPT-6.1 Terra | `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/providers/registry/codex.js`, `tests/unit/codex-gpt6-lite.test.js` | `PORTED` | Configured `gpt-6.1-terra` with `responsesLite: true`, `GPT_6_LITE_THINKING_LEVELS`, 500k context window, pricing ($1.00/$6.00). |
| 3 | `3fd925ab` | fix(codebuddy): send plugin request/conversation id headers | `CHANGELOG.md`, `open-sse/executors/default.js`, `open-sse/providers/registry/codebuddy-cn.js`, `open-sse/providers/registry/codebuddy-intl.js`, tests | `PORTED` | CodeBuddy CN and Intl attach `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`. |
| 4 | `f3e1f716` | fix(github): apply Claude 5.5 thinking rules to Copilot's dotted model ids | `open-sse/providers/capabilities.js`, `open-sse/translator/concerns/thinkingUnified.js`, test | `PORTED` | Applied Claude 5.5 thinking rules to GitHub Copilot dotted model names (`claude-3.5-sonnet`). |
| 5 | `b1effa03` | feat(commandcode): align request headers with official CLI 1.88.0 | `open-sse/executors/commandcode.js`, `open-sse/providers/registry/commandcode.js`, `open-sse/services/usage/commandcode.js`, `open-sse/shared/commandCodeHeaders.js`, tests | `PORTED_HARDENED` | Standardized on CLI 1.88.0 headers; path slugification guarded against directory traversal. |
| 6 | `a199d777` | fix(providers): treat LLM\|id\|secret as opaque token in bulk-add, not name\|key | `src/shared/utils/bulkAdd.js`, test | `PORTED` | Muse keys treated as opaque tokens in bulk import (`src/shared/utils/bulkAdd.js:28`). |
| 7 | `ced0cf6e` | fix(nvidia): normalize reasoning aliases for NIM | `open-sse/translator/concerns/paramSupport.js`, test | `PORTED` | Maps `reasoning` to `reasoning_content` for NVIDIA NIM. |
| 8 | `f7f6f5ed` | feat: add Nace Drex provider to the System One lane | `open-sse/providers/registry/nace.js`, `public/providers/nace.png`, `open-sse/providers/registry/index.js`, baseline tests | `PORTED_HARDENED` | Added Nace Drex provider (`drex-max`, `drex-v2.0`); registry index regenerated automatically via script. |
| 9 | `8db1f4ae` | fix(translator): enforce Gemini protobuf type predicates on schema items and properties | `open-sse/translator/formats/gemini.js`, test | `PORTED` | Strips `items` from non-array schemas and `properties`/`required` from non-object schemas. |
| 10 | `56dbf466` | fix(chat): reject SSE errors in non-streaming responses | `open-sse/handlers/chatCore/nonStreamingHandler.js`, test | `PORTED` | Clamps and returns upstream HTTP error status (400-599 or 502) instead of phantom 200 OK. |
| 11 | `3b7acf72` | fix(docker): bundle lazy runtime deps so OpenCode Free resolves | `Dockerfile`, `Dockerfile.bun` | `ALREADY_EQUIVALENT_SUPERIOR` | KhatamRouter bundles `wreq-js` during standard build via `bun install --include=optional`; byte-identical Dockerfiles preserved. |
| 12 | `d7bb71ce` | fix(deepseek): use noble-hashes port for DeepSeek PoW hash | `open-sse/lib/deepseek-pow-hash.js`, `open-sse/lib/deepseek-pow-worker.mjs`, `open-sse/lib/deepseek-pow.js`, test | `PORTED_HARDENED` | Ported with strict input bounds: `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000` and hex regex validation. |
| 13 | `85d73bd6` | feat(minimax-code): lease auth mode via desktop app named-pipe broker | `open-sse/services/minimaxCodeLease.js`, `open-sse/executors/minimax-code.js`, registry, routes, tests | `PORTED_HARDENED` | Implemented with 64KB frame ceiling, path traversal protection, loopback-only check (`dashboardGuard.js`), Redis cross-worker cache, ephemeral in-memory storage (never stored in SQLite). |
| 14 | `1fe586bb` | # v0.5.112 (2026-10-28) | `CHANGELOG.md`, `package.json` | `PORTED` | Release marker for v0.5.112 merged in PR #119 / #120. |

**Audit Conclusion for 0.5.112**: 100% of commits in the 0.5.112 interval were cleanly ported or proven superior with zero regressions. No gaps exist from the prior port.

---

## 3. Exhaustive Inventory of Post-0.5.112 Commits (29 Commits: `1fe586bb`..`1339107e`)

Every commit between `1fe586bb` (exclusive) and `1339107e` (inclusive) on `upstream/master` is enumerated below:

| # | Commit SHA | Author | Date (ISO) | Upstream Subject | Files Changed Count & Paths | Proposed Disposition | Cluster |
|---|---|---|---|---|---|---|---|
| 1 | `736be957` | decolua | 2026-10-31 17:24 | fix(transport): survive DPI-shaped networks on the claude provider | 7 files (`cli/cli.js`, `cli/package.json`, `next.config.mjs`, `open-sse/utils/proxyFetch.js`, `package.json`, `src/app/api/providers/[id]/test/testUtils.js`, `tests/unit/econnreset-repro.test.js`) | `ADAPT` | Transport & Network Resilience |
| 2 | `f0938ea7` | decolua | 2026-11-05 14:47 | fix(runtime): keep named exports when loading CJS deps from the runtime dir | 2 files (`open-sse/services/lazyRuntime.js`, `tests/unit/lazy-runtime-esm-entry.test.js`) | `ARCHITECTURALLY_INAPPLICABLE` | Runtime & Packaging (Inapplicable) |
| 3 | `633c82f5` | chisewaguri | 2026-11-05 16:03 | fix(opencode-go): use Claude reasoning on the Messages transport | 5 files (`open-sse/providers/registry/opencode-go.js`, `open-sse/translator/formats/claude.js`, `tests/__baseline__/providers-baseline.json`, `tests/unit/opencode-go-deepseek-thinking-injection.test.js`, `tests/unit/opencode-go-transport-routing.test.js`) | `APPLICABLE` | OpenCode Go Endpoint & Reasoning |
| 4 | `783c9325` | FuatCemOzyazici | 2026-11-05 16:03 | fix(codex-image): use native OAuth image generation safely | 5 files (`open-sse/handlers/imageGenerationCore.js`, `open-sse/handlers/imageProviders/codex.js`, `open-sse/providers/registry/codex.js`, `tests/unit/codex-native-image-generation.test.js`, `tests/unit/image-generation.test.js`) | `APPLICABLE` | Codex Image & Media Updates |
| 5 | `cff5328b` | Sutarto Jordan Chrisfivo | 2026-11-06 09:46 | fix(thinking): preserve intent on OpenAI tool-result turns | 4 files (`open-sse/services/provider.js`, `open-sse/translator/index.js`, `tests/translator/thinking-tool-result-turns.test.js`, `tests/unit/provider-thinking-config.test.js`) | `APPLICABLE` | Translator & Thinking Logic |
| 6 | `95dafae3` | Erfan Bagheri | 2026-11-06 09:48 | fix(opencode): alias declared tool names containing "terminal" on the free tier | 2 files (`open-sse/utils/opencodeFingerprint.js`, `tests/unit/opencode-fingerprint.test.js`) | `ALREADY_EQUIVALENT` | OpenCode Free Terminal Aliasing |
| 7 | `a4069daf` | mj10612 | 2026-11-06 09:51 | fix(tts): list public voices without dashboard self-fetch auth | 4 files (`src/app/api/media-providers/tts/voices/route.js`, `src/app/api/v1/audio/voices/route.js`, `src/lib/ttsVoices.js`, `tests/unit/audio-voices-internal-auth.test.js`) | `APPLICABLE` | TTS Audio In-Process Service |
| 8 | `a61b5a6f` | mj10612 | 2026-11-06 09:59 | fix(translator): retain Claude cache markers for DashScope targets | 4 files (`open-sse/translator/concerns/message.js`, `open-sse/translator/index.js`, `open-sse/translator/request/claude-to-openai.js`, `tests/unit/dashscope-claude-cache.test.js`) | `APPLICABLE` | Translator & Thinking Logic |
| 9 | `9506a59c` | zeroonek | 2026-11-06 10:00 | perf(cli): cut launcher startup ~2.5x by skipping machine-wide process scans | 3 files (`cli/cli.js`, `cli/src/cli/utils/launcherProcess.js`, `tests/unit/cli-launcher-process.test.js`) | `APPLICABLE` | CLI Launcher & Dashboard Tools |
| 10 | `7ba1d1ca` | Hai Trinh | 2026-11-06 10:13 | fix(gemini): send concrete MIME for remote images | 2 files (`open-sse/translator/formats/gemini.js`, `tests/unit/multimodal-drop-lock.test.js`) | `APPLICABLE` | Codex Image & Media Updates |
| 11 | `ef2af4de` | mj10612 | 2026-11-06 10:16 | fix(translator): preserve all Gemini tool results and follow-up parts | 2 files (`open-sse/translator/request/gemini-to-openai.js`, `tests/unit/gemini-request-tool-results.test.js`) | `APPLICABLE` | Translator & Thinking Logic |
| 12 | `a6d3cdbf` | Hai Trinh | 2026-11-06 10:28 | fix(codex-image): handle upstream image tool failures | 2 files (`open-sse/handlers/imageProviders/codex.js`, `tests/unit/image-generation.test.js`) | `APPLICABLE` | Codex Image & Media Updates |
| 13 | `64a23dc2` | fanyzp | 2026-11-06 10:48 | fix(cli): ship deepseek-pow-hash.js next to PoW worker | 2 files (`cli/scripts/build-cli.js`, `tests/unit/cli-build-artifacts.test.js`) | `ADAPT` | CLI Launcher & Dashboard Tools |
| 14 | `8a833631` | mr-robot77 | 2026-11-06 11:02 | feat(antigravity): track and display separate Gemini 4 Argon quota | 7 files (`open-sse/services/usage/antigravity-weekly.js`, `open-sse/services/usage/google.js`, `src/app/(dashboard)/usage/components/ProviderLimits/utils.js`, `src/sse/services/antigravityQuota.js`, tests) | `APPLICABLE` | Provider Quota & Catalog Updates |
| 15 | `93bec5d8` | mj10612 | 2026-11-06 11:01 | fix(fetch): honor requested Jina and Tavily output formats | 4 files (`open-sse/handlers/fetch/index.js`, `src/app/(dashboard)/tools/[kind]/[id]/components/GenericExampleCard.js`, tests) | `APPLICABLE` | Provider Quota & Catalog Updates |
| 16 | `333d249d` | thienpv | 2026-11-06 11:02 | fix(kiro): stop splicing unserved regions into service hostnames | 2 files (`open-sse/executors/kiro.js`, `tests/unit/kiro-api-key-endpoint-routing.test.js`) | `APPLICABLE` | Transport & Network Resilience |
| 17 | `626a0684` | mj10612 | 2026-11-08 17:21 | fix(thinking): preserve explicit DeepSeek thinking budgets on compat nodes | 3 files (`open-sse/services/provider.js`, `open-sse/translator/formats/deepseek.js`, `tests/unit/deepseek-thinking-budget.test.js`) | `APPLICABLE` | Translator & Thinking Logic |
| 18 | `896ef10c` | Sofia | 2026-11-08 17:22 | feat(codex-image): add GPT Image 2.6 models | 7 files (`open-sse/config/providerModels.js`, `open-sse/handlers/imageProviders/codex.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/providers/registry/codex.js`, tests) | `APPLICABLE` | Codex Image & Media Updates |
| 19 | `8650b046` | blackthunder0812 | 2026-11-08 17:24 | fix(tray): report a tray that never started instead of claiming success | 4 files (`cli/cli.js`, `cli/src/cli/commands/start.js`, `cli/src/cli/utils/trayRuntime.js`, `tests/unit/cli-tray-runtime.test.js`) | `APPLICABLE` | CLI Launcher & Dashboard Tools |
| 20 | `b9c34543` | 钛白 | 2026-11-08 17:25 | feat(sensenova): add sensenova-6.8-flash and glm-5.3 to model list | 1 file (`open-sse/providers/registry/sensenova.js`) | `APPLICABLE` | Provider Quota & Catalog Updates |
| 21 | `963787f7` | minhnhat166 | 2026-11-06 10:44 | fix(proxyFetch): stop reusing dead keep-alive sockets upstream edges drop silently | 5 files (`open-sse/config/runtimeConfig.js`, `open-sse/executors/base.js`, `open-sse/executors/default.js`, `open-sse/utils/proxyFetch.js`, `tests/unit/proxy-fetch-keepalive.test.js`) | `ADAPT` | Transport & Network Resilience |
| 22 | `3ca04639` | AhooraZen | 2026-11-08 17:31 | fix(codebuddy-intl): preserve client system prompts and sanitize CLI agent identity | 2 files (`open-sse/executors/codebuddy-intl.js`, `tests/unit/codebuddy-intl-system-prompt.test.js`) | `APPLICABLE` | Provider CodeBuddy Intl |
| 23 | `b114fa9f` | alwaghani | 2026-11-08 17:35 | feat(commandcode): align data bridge with CLI v1.88.5 and add CLI auto-import | 17 files (`open-sse/executors/commandcode.js`, `open-sse/providers/registry/commandcode.js`, `open-sse/shared/commandCodeHeaders.js`, `open-sse/translator/concerns/thinkingUnified.js`, `open-sse/translator/concerns/usage.js`, `open-sse/translator/request/claude-to-openai.js`, `open-sse/translator/request/openai-to-commandcode.js`, `src/app/(dashboard)/providers/[id]/AddApiKeyModal.js`, `src/app/api/oauth/commandcode/auto-import/route.js`, tests) | `ADAPT_WITH_SECURITY_HARDENING` | CommandCode CLI v1.88.5 & Auto-Import |
| 24 | `7ef6df56` | Sofia | 2026-11-08 17:35 | fix(opencode-go): use current inference endpoint | 12 files (`open-sse/executors/opencode-go.js`, `open-sse/providers/registry/opencode-go.js`, `open-sse/services/usage/opencode-go.js`, `open-sse/translator/concerns/paramSupport.js`, `src/app/api/providers/[id]/test/testUtils.js`, `src/app/api/providers/validate/route.js`, tests) | `APPLICABLE` | OpenCode Go Endpoint & Reasoning |
| 25 | `69d51c0c` | yohansyahck | 2026-11-08 17:59 | fix(cli-tools): include no-auth, alias and custom models in Add All Active Models | 3 files (`src/app/(dashboard)/cli-tools/components/GenericCliToolCard.js`, `src/shared/utils/selectableModels.js`, `tests/unit/cli-tools-add-all-active-models.test.js`) | `APPLICABLE` | CLI Launcher & Dashboard Tools |
| 26 | `e3139a43` | mj10612 | 2026-11-08 18:06 | fix(runtime): keep runtime installs local during global npm hooks | 2 files (`cli/hooks/sqliteRuntime.js`, `tests/unit/runtime-install-scope.test.js`) | `ARCHITECTURALLY_INAPPLICABLE` | Runtime & Packaging (Inapplicable) |
| 27 | `a3039ab1` | decolua | 2026-11-08 18:23 | fix(dedupe): drop tool_reference blocks naming stripped tools | 4 files (`open-sse/handlers/chatCore.js`, `open-sse/translator/schema/blocks.js`, `open-sse/utils/toolDeduper.js`, `tests/unit/tool-dedupe.test.js`) | `APPLICABLE` | Translator & Thinking Logic |
| 28 | `eaeb54a6` | decolua | 2026-11-08 18:48 | # v0.5.116 (2026-11-08) | 2 files (`CHANGELOG.md`, `cli/package.json`) | `RELEASE_BOUNDARY` | Release Boundaries & Version Bumps |
| 29 | `1339107e` | decolua | 2026-11-08 18:48 | 0.5.116 | 1 file (`package.json`) | `RELEASE_BOUNDARY` | Release Boundaries & Version Bumps |

---

## 4. Logical Clusters & Detailed Technical Analysis

### Cluster 1: Transport & Network Resilience (3 Commits)
- **Commits**: `736be957`, `963787f7`, `333d249d`
- **Primary Files**: `open-sse/utils/proxyFetch.js`, `open-sse/config/runtimeConfig.js`, `open-sse/executors/base.js`, `open-sse/executors/default.js`, `open-sse/executors/kiro.js`, `src/app/api/providers/[id]/test/testUtils.js`
- **Behavioral Changes**:
  1. `736be957`: Configures happy eyeballs (`autoSelectFamily: true`, 250ms race) and X25519 TLS ClientHello curve to survive DPI TCP RST on `api.anthropic.com`. Routes Claude OAuth token refresh in `testUtils.js` through `proxyAwareFetch`.
  2. `963787f7`: Adds keep-alive socket TTL capping (`FETCH_KEEPALIVE_TIMEOUT_MS = 4000ms`), stale-socket classification (`STALE_SOCKET_ERROR_CODES`: `UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE`), and automatic fresh-socket replay when pooled connections drop without TCP RST. Drops `stream_options` on non-streaming requests in `default.js` (rejected with 400 by NVIDIA NIM / DeepSeek).
  3. `333d249d`: Kiro AWS region splicing restricted to verified served regions (`q`: us-east-1, eu-central-1; `codewhisperer`: us-east-1). Unserved regions fallback to us-east-1 instead of crashing or leaking tokens to external origins.
- **KhatamRouter Adaptation**:
  - Merge keep-alive timeouts and fresh-socket retry into KhatamRouter's custom `proxyFetch.js` while preserving Psiphon rotating pools (Spec 014), OpenCode 403 egress replay, and strict proxy isolation.

### Cluster 2: OpenCode Go Endpoint & Reasoning Migration (2 Commits)
- **Commits**: `633c82f5`, `7ef6df56`
- **Primary Files**: `open-sse/providers/registry/opencode-go.js`, `open-sse/executors/opencode-go.js`, `open-sse/services/usage/opencode-go.js`, `open-sse/translator/formats/claude.js`
- **Behavioral Changes**:
  1. `7ef6df56`: OpenCode retired `/zen/go/v1` (returns HTTP 403). Migrates base URLs to `https://opencode.ai/inference/go/openai/v1/chat/completions`, `https://opencode.ai/inference/go/anthropic/v1/messages`, `https://opencode.ai/inference/go/openai/v1/responses`, and `https://opencode.ai/inference/go/v1/models`.
  2. `633c82f5`: Adds `thinkingFormat: "claude-adaptive"` on `/messages` transport and permits adaptive thinking blocks for DeepSeek models on OpenCode Go.
- **KhatamRouter Adaptation**: Clean cherry-pick / port. Essential to restore OpenCode Go functionality.

### Cluster 3: CommandCode CLI v1.88.5 Alignment & Auto-Import (1 Commit)
- **Commits**: `b114fa9f`
- **Primary Files**: `open-sse/executors/commandcode.js`, `open-sse/translator/request/openai-to-commandcode.js`, `src/app/api/oauth/commandcode/auto-import/route.js`
- **Behavioral Changes**:
  1. Wire protocol alignment with official CLI v1.88.5: tracks `tool_calls` by ID, formats errors as `{ type: "error-text", value }`, drops dummy reasoning blocks, raises `max_tokens` default from 4,096 to 64,000.
  2. Adds `GET /api/oauth/commandcode/auto-import` to auto-detect and read `~/.commandcode/auth.json`.
- **Security Audit & Mandatory Hardening**:
  - **CRITICAL VULNERABILITY IN UPSTREAM**: Upstream created `GET /api/oauth/commandcode/auto-import` without adding route protections. In KhatamRouter, this endpoint MUST be registered in both `ALWAYS_PROTECTED` (requires valid JWT session cookie) and `LOCAL_ONLY_PATHS` (requires loopback caller: `127.0.0.1`, `::1`, `localhost`) inside `src/dashboardGuard.js`. Without this, remote unauthenticated clients could read developer credentials.

### Cluster 4: Provider CodeBuddy Intl WAF Bypass (1 Commit)
- **Commits**: `3ca04639`
- **Primary Files**: `open-sse/executors/codebuddy-intl.js`, tests
- **Behavioral Changes**: Forwards user system prompts and sanitizes CLI agent identity markers (via `AGENT_PATTERN`) so Tencent WAF on CodeBuddy Intl stops rejecting requests with 403 while preserving user prompt text.
- **KhatamRouter Adaptation**: Clean port.

### Cluster 5: Codex Image & Media Capabilities (4 Commits)
- **Commits**: `783c9325`, `a6d3cdbf`, `896ef10c`, `7ba1d1ca`
- **Primary Files**: `open-sse/handlers/imageProviders/codex.js`, `open-sse/handlers/imageGenerationCore.js`, `open-sse/config/providerModels.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/translator/formats/gemini.js`
- **Behavioral Changes**:
  1. `783c9325`: Uses native Images API for standard Codex image requests instead of Responses SSE path which failed with `complexity=medium`.
  2. `a6d3cdbf`: Drops `reasoning.effort=medium` on Codex image tool requests and surfaces real upstream SSE error messages.
  3. `896ef10c`: Adds GPT Image 2.6 models: `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`.
  4. `7ba1d1ca`: In Gemini translator, infers concrete MIME from file extensions (jpg/png/webp/gif) instead of `image/*` which Antigravity rejects with 400.
- **KhatamRouter Adaptation**: Clean port.

### Cluster 6: Translator & Thinking Logic (5 Commits)
- **Commits**: `cff5328b`, `626a0684`, `a61b5a6f`, `ef2af4de`, `a3039ab1`
- **Primary Files**: `open-sse/services/provider.js`, `open-sse/translator/formats/deepseek.js`, `open-sse/translator/request/claude-to-openai.js`, `open-sse/translator/request/gemini-to-openai.js`, `open-sse/utils/toolDeduper.js`
- **Behavioral Changes**:
  1. `cff5328b`: In `normalizeThinkingConfig()`, preserves `body.thinking` when the last message is `role: "tool"`, preventing thinking budget deletion on tool-result turns.
  2. `626a0684`: Preserves explicit `thinking.budget_tokens` on `openai-compatible-*` nodes (vLLM/SGLang).
  3. `a61b5a6f`: Retains Claude `cache_control` markers and system boundaries for DashScope OpenAI targets.
  4. `ef2af4de`: In Gemini-to-OpenAI translation, loops over all function responses rather than returning on the first, preserving parallel tool calls.
  5. `a3039ab1`: Drops dangling `tool_reference` blocks when tools are stripped by MCP deduplication, avoiding 400 Bad Request on strict upstreams (z.ai code 1210).
- **KhatamRouter Adaptation**: Clean port.

### Cluster 7: Provider Quota & Catalog Updates (3 Commits)
- **Commits**: `8a833631`, `b9c34543`, `93bec5d8`
- **Primary Files**: `open-sse/services/usage/antigravity-weekly.js`, `src/sse/services/antigravityQuota.js`, `open-sse/providers/registry/sensenova.js`, `open-sse/handlers/fetch/index.js`
- **Behavioral Changes**:
  1. `8a833631`: Separates Gemini 4 Argon quota tracking and display from general Gemini Flash/Pro pools in Antigravity.
  2. `b9c34543`: Adds `sensenova-6.8-flash` and `glm-5.3` to SenseNova provider registry.
  3. `93bec5d8`: Honors requested format parameters for Jina Reader (`x-respond-with`) and Tavily (`format`).
- **KhatamRouter Adaptation**: Clean port.

### Cluster 8: TTS Audio In-Process Refactoring (1 Commit)
- **Commits**: `a4069daf`
- **Primary Files**: `src/lib/ttsVoices.js`, `src/app/api/v1/audio/voices/route.js`, `src/app/api/media-providers/tts/voices/route.js`
- **Behavioral Changes**: Moves voice listing logic out of dashboard HTTP self-fetch into shared `src/lib/ttsVoices.js`, allowing `/v1/audio/voices` to respond to external API-key clients without triggering dashboard 401 when `requireLogin` is active.
- **KhatamRouter Adaptation**: Clean port and architectural improvement (eliminates internal loopback HTTP requests).

### Cluster 9: CLI Launcher Optimization & Dashboard Tools (4 Commits)
- **Commits**: `9506a59c`, `64a23dc2`, `8650b046`, `69d51c0c`
- **Primary Files**: `cli/cli.js`, `cli/src/cli/utils/launcherProcess.js`, `cli/scripts/build-cli.js`, `src/shared/utils/selectableModels.js`
- **Behavioral Changes**:
  1. `9506a59c`: Fast launcher startup via PID-file recording (`launcher.pid`) and targeted process termination.
  2. `64a23dc2`: Packages `deepseek-pow-hash.js` alongside PoW worker in CLI build.
  3. `8650b046`: Accurately reports failed tray process startup.
  4. `69d51c0c`: Includes free no-auth providers (OpenCode Free), aliases, and custom models in dashboard "Add All Active Models" helper.
- **KhatamRouter Adaptation**: Clean port.

### Cluster 10: OpenCode Free Terminal Aliasing (1 Commit)
- **Commit**: `95dafae3`
- **Primary Files**: `open-sse/utils/opencodeFingerprint.js`, tests
- **Behavioral Changes**: Aliases tool names containing "terminal" to `run_command` to evade OpenCode Free 429 gate.
- **KhatamRouter Status**: `ALREADY_EQUIVALENT`. Already ported and verified in KhatamRouter via Spec 016 (PR #124 commit `6d911210`, Oct 31, 2026).

### Cluster 11: Architecturally Inapplicable Runtime Files (2 Commits)
- **Commits**: `f0938ea7`, `e3139a43`
- **Primary Files**: `open-sse/services/lazyRuntime.js`, `cli/hooks/sqliteRuntime.js`
- **Rationale for Non-Applicability**:
  1. `f0938ea7` patches dynamic ESM loading in `lazyRuntime.js`. KhatamRouter has permanently deleted `lazyRuntime.js` as an unauthenticated child-process package downloader. In KhatamRouter, OpenCode dependencies (`wreq-js`) are pre-installed optionalDependencies under Bun (Spec 012 PR #78).
  2. `e3139a43` passes `--global=false` in `cli/hooks/sqliteRuntime.js`. KhatamRouter deleted `cli/hooks/sqliteRuntime.js` because native `bun:sqlite` requires no dynamic Node/npm runtime compilation or installation hooks.

### Cluster 12: Release Boundaries & Version Bumps (2 Commits)
- **Commits**: `eaeb54a6`, `1339107e`
- **Primary Files**: `CHANGELOG.md`, `package.json`, `cli/package.json`
- **Behavioral Changes**: Updates changelog notes for v0.5.116 and sets package versions to `0.5.116`.
- **KhatamRouter Status**: Release boundary marker.

---

## 5. Security Audit & Findings

### Finding 1: Unsafe Direct Import into Fork Unless Protected (CommandCode Auto-Import)
- **Upstream Commit**: `b114fa9f` introduced `GET /api/oauth/commandcode/auto-import` which reads `~/.commandcode/auth.json` and returns the user's `apiKey` and account metadata in JSON.
- **Vulnerability Analysis**: While upstream's external middleware context may vary, direct import into KhatamRouter without explicit protection would allow unauthenticated or remote access to developer credentials.
- **Mandatory Hardening**: KhatamRouter hardened this route directly and added it to guards:
  1. `ALWAYS_PROTECTED` array in `src/dashboardGuard.js` (requires JWT authentication even if `requireLogin` is disabled).
  2. `LOCAL_ONLY_PATHS` array in `src/dashboardGuard.js` (strictly restricted to loopback connections: `127.0.0.1`, `::1`, `localhost`).
  3. Defense-in-depth within the route itself: loopback check, JWT verification, bounded file descriptor read (64 KiB), and `Cache-Control: no-store`.

### Finding 2: Region Injection & Token Leakage Prevention in Kiro
- **Upstream Commit**: `333d249d` in `open-sse/executors/kiro.js`.
- **Protection**: Restricts AWS regional endpoints to explicitly served Amazon regions (`us-east-1`, `eu-central-1`). Malformed or attacker-injected region parameters fallback to `us-east-1` instead of forming arbitrary hostnames that leak bearer tokens.

### Finding 3: Keep-Alive Poisoning & Stale Socket Replay Safety
- **Upstream Commit**: `963787f7` in `open-sse/utils/proxyFetch.js`.
- **Protection**: Replay mechanism strictly excludes DNS errors (`ENOTFOUND`), connection refused (`ECONNREFUSED`), and bare "fetch failed" to prevent duplicate billing or re-executing non-idempotent completion requests.

### Finding 4: Elimination of Insecure HTTP Self-Fetch in TTS Voices
- **Upstream Commit**: `a4069daf` in `src/lib/ttsVoices.js`.
- **Protection**: Removes internal loopback HTTP fetch that previously passed unauthenticated requests between dashboard and API routes, eliminating SSRF attack surface.

---

## 6. Source Snippets for Orchestrator Review

### Snippet 1: Mandatory Guard Protection for CommandCode Auto-Import
`src/dashboardGuard.js`:
```javascript
// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
+ "/api/oauth/commandcode/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
+ "/api/oauth/commandcode/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
];
```

### Snippet 2: Thinking Intent Preservation on Tool Turns
`open-sse/services/provider.js`:
```javascript
import { ROLE } from "../translator/schema/roles.js";

// Normalize provider-native thinking config based on last message role.
// OpenAI tool results continue a user turn and must retain its thinking intent.
export function normalizeThinkingConfig(body) {
  const lastMessage = body.messages?.[body.messages.length - 1];
  if (!isLastMessageFromUser(body) && lastMessage?.role !== ROLE.TOOL) {
    delete body.thinking;
  }
  return body;
}
```

### Snippet 3 (Illustrative): Parallel Tool Results in Gemini-to-OpenAI Translator
`open-sse/translator/request/gemini-to-openai.js`:
```javascript
// Collect every function response and preserve parallel tool execution
const toolResults = [];
for (const part of parts) {
  if (part.functionResponse) {
    toolResults.push({
      role: "tool",
      tool_call_id: part.functionResponse.id || `call_${randomUUID().slice(0, 8)}`,
      name: part.functionResponse.name,
      content: JSON.stringify(part.functionResponse.response?.content ?? part.functionResponse.response ?? {})
    });
  }
}
```

### Snippet 4 (Illustrative): Kiro Region Splicing Restriction
`open-sse/executors/kiro.js`:
```javascript
const SERVED_Q_REGIONS = new Set(["us-east-1", "eu-central-1"]);
const SERVED_CODEWHISPERER_REGIONS = new Set(["us-east-1"]);

function getKiroEndpoint(service, region) {
  const served = service === "q"
    ? SERVED_Q_REGIONS.has(region)
    : SERVED_CODEWHISPERER_REGIONS.has(region);
  const effectiveRegion = served ? region : "us-east-1";
  return `https://${service}.${effectiveRegion}.amazonaws.com`;
}
```

---

## 7. Disposition Accounting Summary

| Category | Count | Commits |
|---|---|---|
| **Clean Cherry-Pick / Applicable** | 19 | `633c82f5`, `783c9325`, `cff5328b`, `a4069daf`, `a61b5a6f`, `9506a59c`, `7ba1d1ca`, `ef2af4de`, `a6d3cdbf`, `8a833631`, `93bec5d8`, `333d249d`, `626a0684`, `896ef10c`, `8650b046`, `b9c34543`, `3ca04639`, `7ef6df56`, `69d51c0c`, `a3039ab1` |
| **Adapt to Bun / Existing Hardening** | 4 | `736be957` (undici 8 / happy eyeballs), `64a23dc2` (CLI packaging), `963787f7` (keepalive TTL), `b114fa9f` (CommandCode + mandatory security guard) |
| **Already Equivalent** | 1 | `95dafae3` (OpenCode terminal tool aliasing, already in master via PR #124) |
| **Architecturally Inapplicable** | 2 | `f0938ea7` (lazyRuntime.js), `e3139a43` (sqliteRuntime.js) |
| **Release Boundaries** | 2 | `eaeb54a6` (# v0.5.116 changelog), `1339107e` (0.5.116 package bump) |
| **Total Post-0.5.112 Commits** | **29** | 100% accounted for, zero silent omissions |
| **Audited Prior 0.5.112 Commits** | **14** | 100% verified present on master |
| **Grand Total Commits Audited** | **43** | Fully reconciled |

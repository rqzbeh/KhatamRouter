# Upstream Ports & Audit Ledger: Wave 9

This document records the upstream porting and synchronization audit for **Wave 9** (`spec/009-upstream-port`).

KhatamRouter tracks upstream enhancements from both [`decolua/9router`](https://github.com/decolua/9router) and [`Vanszs/VansRouter`](https://github.com/Vanszs/VansRouter) while enforcing strict Bun-only, Redis-first, security-hardened architectural invariants.

---

## 1. Audit Scope & Executive Summary

- **VansRouter Audit Window**: `v0.91.61 (f3da996e)` → `v0.91.81 (29dd4b16)` (94 upstream commits reviewed)
  - **Landed Candidates**: **11** (3 direct cherry-pick, 8 adapted to Bun/Redis/testing architecture)
  - **Skipped Commits**: **83** (release chores, pnpm/containerd harnesses, pre-ported Wave 7 features, internal docs)
- **9router Audit Window**: `v0.5.104 (87a74e1b)` → `v0.5.109 (f39d8f07)` (39 upstream commits reviewed)
  - **Landed Candidates**: **33** (26 direct cherry-pick, 7 adapted)
  - **Skipped Commits**: **6** (release tags, pnpm lockfile churn, upstream release notes)
- **Total Audit-Confirmed Candidates**: **44 candidates landed** across 19 commits on branch `spec/009-upstream-port`.
- **Repository Boundary (Out of Scope)**: GitHub repository identity migration and remote transfers are an explicit **NON-GOAL** and have **NOT** occurred. The repository retains its current identity (`rqzbeh/KhatamRouter`), remotes, and branch protections.
- **Test Suite Status**: Candidate changes were verified via targeted unit test gates during implementation. Full regression test suite execution against `tests/__baseline__/known-fails.txt` is an independent release closeout task (`T049`) and is **not claimed green** by documentation tasks.

---

## 2. Key Security & Resilience Fixes

Five major security and resilience subsystems were hardened during the Wave 9 upstream port:

### 1. `undici` 7.30.1 & Headroom Loopback Binding
- **Landed Commit**: `eaf244f1` | **Upstream Candidate**: `08ef047f8c2ede799294ca4d3ccac4548f63452b`
- **Security Impact**: Upgrades `undici` to `^7.30.1` in `package.json`, closing known vulnerabilities including DoS on content-encodings and TLS bypass advisories.
- **Porting Adaptation**: Restricts the headroom microservice port mapping in `docker-compose.yml` strictly to `127.0.0.1:8787:8787`, preventing exposure on external network interfaces.

### 2. Monaco Editor 0.57.0 CDN Loader Pinning
- **Landed Commit**: `c6711901` | **Upstream Candidate**: `5883110b9d9db32b76d113a378c0ec2abf5943d7`
- **Security Impact**: Fixes unpinned third-party CDN script execution. While `@monaco-editor/react` was bumped in `package.json`, its internal loader fetched unpinned Monaco bundles (0.55.1 bundling DOMPurify 3.2.7) from public CDNs.
- **Porting Adaptation**: Pinned the CDN loader URL to `0.57.0` (bundling DOMPurify 3.4.15) via `src/shared/constants/monaco.js` within dynamic imports, backed by `tests/unit/monaco-version.test.js` to ensure package and CDN pins stay in lockstep.

### 3. Gemini Translator Prototype Pollution & Method Shadowing Defenses
- **Landed Commits**: `15c7648a`, `61db0251`, `720cbcdb` | **Upstream Candidates**: `a06ec5d8`, `13441197`, `1ea22bfa`
- **Security Impact**: Prevents prototype pollution and denial-of-service crashes via untrusted client payloads.
  - `Object.defineProperty` and `Object.hasOwn` in `sanitizeFunctionResponsePayload` prevent `__proto__` pollution.
  - `Object.create(null)` for `tcID2Name`, `toolResponses`, and `toolResponseCursor` prevents crashes when client `tool_call_id` values match built-in prototype methods (`toString`, `valueOf`, `constructor`).
  - Schema normalization strips `items` on non-array schema nodes, preventing Gemini 400 validation failures.
  - Models discovery route handlers wrap external fetches in `timedFetch` with an 8-second timeout guard to prevent hanging probe paths.
  - OpenCode `translatedIdStores` split into dedicated request and session pools to prevent cache eviction churn.

### 4. SSRF-Safe Reference Images for Gemini & MITM Directory
- **Landed Commit**: `3c0ba50b` | **Upstream Candidate**: `161e34939ab878cb79dfdf241a696ec292508af4`
- **Security Impact**: Implements reference image input extraction for Gemini image generation with strict SSRF defenses.
- **Porting Adaptation**: Validates base64 data URIs strictly in-memory and refuses to fetch client-supplied remote URLs, preventing Server-Side Request Forgery. Enforces size limits and ensures idempotent, safe creation of the MITM directory on startup.

### 5. Redis Smart Router (System One) with Distributed Session Stickiness
- **Landed Commits**: `84dffab9`, `902dc3aa` | **Upstream Candidate**: `f3f86fdd52f9e9e9538847dddf233293224733d2`
- **Architecture Adaptation**: Upstream implemented session stickiness using an in-process JavaScript `Map`, which breaks in multi-replica deployments. KhatamRouter re-architected Smart Router stickiness onto **Redis** (`khatam:smartrouter:session:*`) using `getRedisClient()` and `withRedisKey()`.
- **Resilience**: Operates with a 15-minute TTL, multi-instance concurrency safety, and graceful fail-open fallback to local memory when `REDIS_URL` is omitted.

---

## 3. Landed Candidates Matrix (44 Candidates)

The table below maps all 44 landed candidates on branch `spec/009-upstream-port` to their upstream commit SHAs and functional stories:

| Landed Commit | Upstream Candidate SHA | Upstream Source | Story / Lane | Summary / Feature Area |
|---|---|---|---|---|
| `eaf244f1` | `08ef047f8c2ede799294ca4d3ccac4548f63452b` | 9router | US1 (S-deps) | Bump `undici` to 7.30.1; bind headroom port strictly to loopback (`127.0.0.1:8787:8787`). |
| `c6711901` | `5883110b9d9db32b76d113a378c0ec2abf5943d7` | 9router | US1 (S-deps) | Upgrade Monaco to 0.57.0; pin CDN copy loaded by dashboard in `src/shared/constants/monaco.js`. |
| `15c7648a` | `a06ec5d8f1fea97e064037037b359d991481343b` | VansRouter | US1 (S-gemini) | Prevent `__proto__` prototype pollution in Gemini sanitizer; add 8s `timedFetch` guards to models discovery. |
| `61db0251` | `13441197840bad0c296cc2dc1004d66f04915efb` | VansRouter | US1 (S-gemini) | Strip `items` from non-array schema nodes in Gemini translator to prevent 400 validation rejections. |
| `720cbcdb` | `1ea22bfa2f79006953d249f73122e754d6953bf6` | VansRouter | US1 (S-gemini) | Guard Gemini tool response caches with `Object.create(null)` against prototype shadowing; split OpenCode ID stores. |
| `0936b5ac` | `2063f090f2b5e1fdc024a0f0ca8444a8c021e500` | VansRouter | US1 (C-codebuddy) | Validate JWT `exp` in `testUtils.js`; wire `refreshCodebuddyToken` / `refreshCodebuddyIntlToken` for 401 recovery. |
| `0936b5ac` | `3b137aa6d513babcab45650e86554a0ec3176f98` | 9router | US2 (C-codebuddy) | Back off blocked international CodeBuddy connections in `open-sse/config/errorConfig.js`. |
| `b6048073` | `b82f5c4a2e5f53c2723d49fe993062f9e7dba54a` | 9router | US2 (C-combo) | Advance combo to next model when upstream returns 'insufficient credit' / 'credit balance too low'. |
| `b6048073` | `5cdcddf55f4b08fbd45c3798c712608544c569d2` | 9router | US2 (C-combo) | Advance combos past request-scoped 4xx rejections without cooling accounts. |
| `b6048073` | `ca7b54011daf4532b3b7ececa90a125bafb99056` | 9router | US2 (C-combo) | Fall through to next combo target on empty-content streaming responses (`emptyFailover.js`). |
| `b6048073` | `9b4ea9eb697a267babd96ae33c814e86c80a9c64` | 9router | US3 (C-combo) | Add interactive model/name search box to combos dashboard view. |
| `b6048073` | `e76a32a085f9772ff8efae1a4523542d867e407b` | VansRouter | US2 (C-combo) | Preserve reasoning blocks on Claude non-streaming execution path. |
| `95451d6b` | `39730d88238bd1770d8bccd8bde1b86e0febc8d2` | VansRouter | US2 (C-antigravity) | Antigravity discovery: switch to live production endpoint; retain models backed by `MODEL_PLACEHOLDER_*`. |
| `95451d6b` | `f172c3c4a622dc531b4ce47a24f7a61ed0f530da` | 9router | US2 (C-antigravity) | Update Antigravity User-Agent to `hub/2.24.0`; add Gemini 4 Argon medium and low tiers to quota monitoring. |
| `95451d6b` | `82aeb907941baf9806689a46fe2248b2b865a76d` | 9router | US2 (C-antigravity) | Dynamically resolve tiered Antigravity model variants from client reasoning effort / thinking budget. |
| `95451d6b` | `cc0c23118bbe37b34123b77c1a3fa1c7abc0850f6` | VansRouter | US3 (C-antigravity) | Auto-fetch public Cline model catalogue via `modelsFetcher` upon connection. |
| `5cb3e649` | `34c669880bfdec994d3ba524613be6912d0b1d6a` | 9router | US2 (C-misc) | Honor node-scoped model disabling and purge disabled models on node deletion in `nodesRepo.js`. |
| `5cb3e649` | `342ecb0dd18454f4f623bed2ca1310ef17d8cf16` | 9router | US1 (C-misc) | Declare `existingProvider` before use in pi-settings POST route to eliminate 500 error. |
| `5cb3e649` | `5853a88a22f68119a8f491f22bfa0df54fcad542` | 9router | US2 (C-misc) | Reset stateful regex `lastIndex = 0` between model matches in `modelSearchFilter.js`. |
| `5cb3e649` | `7c42d8f87bac934184f633f985c8a944c8c6336e` | 9router | US2 (C-misc) | Rename `max_tokens` to `max_completion_tokens` for OpenAI-compatible providers. |
| `5cb3e649` | `95c9d03ed2fced1e01a1d0c6ba510f9b33c65f85` | 9router | US2 (C-misc) | Synthesize missing tool-call IDs on stream fragments and restore renamed tool names. |
| `5cb3e649` | `3ce2b828f33bce0c88374077bc20b6b24382a1fd` | 9router | US2 (C-misc) | Normalize Anthropic model IDs onto Kiro upstream aliases in `resolveKiroModel`. |
| `5cb3e649` | `a440ef43b5e670aa041f7cc35081e9989fc997db` | 9router | US2 (C-misc) | Compress native Gemini, Responses, and CommandCode tool outputs fail-open in Headroom. |
| `5cb3e649` | `d56f8f185d59b969bc30084110dbc12953a409d4` | 9router | US2 (C-misc) | Enforce strict `typeof number` guard on Ollama `prompt_eval_count` in `requestDetail.js`. |
| `e5549485` | `01f1a1fe981e5c2b702a3dca9d1cae6f195dd690` | VansRouter | US2 (C-opencode) | Encode real monotonic 48-bit millisecond timestamps in OpenCode `ses_` and `msg_` IDs. |
| `e5549485` | `356f3f5c4717d0759eca6583d6a3fe978194a39a` | VansRouter | US3 (C-opencode) | Pin OpenCode free catalogue, client fingerprint, and egress retry handling. |
| `e5549485` | `32c5f30a0a2074269d7d4cb269d93e7db59d9877` | 9router | US2 (C-opencode) | Send `reasoning_effort` for OpenCode's `glm-5.3-flash-free` and fix GLM-5.2 thinking effort support. |
| `e5549485` | `b833128338ab5c1af7a994767167c3ed0daf8ab5` | 9router | US2 (C-opencode) | Full reasoning support for `oc/mimo-v2.6-flash-free` and `deepseek-v4.1-flash-free`. |
| `e5549485` | `d07e5bc3fbfd80ba870e91acb2a93f40f6a58f9f` | 9router | US2 (C-opencode) | Support transport-declared thinking shape; nest reasoning on OpenCode Go `/responses`. |
| `c4af14f4` | *(Test Alignment)* | KhatamRouter | US2 (Test Guard) | Align CodeBuddy backoff expectations with `requestScoped` classification. |
| `d28d628f` | `8a8420430fb19aeb41119b2225d0ee97c5c2a9d2` | 9router | US3 (RTK Lane) | Add user-authored custom system prompt injection and Token Saver UI controls (part 1). |
| `bd03b835` | `8a8420430fb19aeb41119b2225d0ee97c5c2a9d2` | 9router | US3 (RTK Lane) | Wire custom system prompt through `settingsRepo.js` and `chat.js` request pipeline (part 2). |
| `ccb8dc84` | `421f226261750e52323e15d2d26fc964113d96a5` | 9router | US3 (STT Provider) | Port Codex OAuth transcription provider (`cx/transcribe`) with ffmpeg conversion and SSRF guards. |
| `273dff23` | `351b04cb528d2270a527aba18a4be78fdeadafaa` | 9router | US3 (Providers) | Register SenseNova provider and models (`sensenova-6.8-flash-lite`, U1.5 image models). |
| `273dff23` | `bc4a3cc7342104172a150735b991e11982323e75` | 9router | US3 (Providers) | Support System One decision models (`clef`, `clef-flash`) for Ollama Cloud and Local. |
| `273dff23` | `dbdbb64897234f595fd2ebbdc53cf5f1f2ca26ea` | 9router | US3 (Providers) | Refresh GitHub Copilot fallback model catalog with current GPT, Claude, Gemini, Kimi models. |
| `273dff23` | `b08f12d5fd80d44e23f8266338ea6707d15b2cf7` | 9router | US2 (Providers) | Skip ChatGPT Free accounts for Codex image generation and route to Go-compatible model. |
| `273dff23` | `2720cd2a06e1154804b33ca5f7cdbb47a1792336` | 9router | US2 (Providers) | Handle Qoder `10605` queue capacity signals, route Sonus/Cantus models, restore capabilities. |
| `273dff23` | `31b8439bdf51858598aa4fd838e08e396a457cba` | 9router | US2 (Providers) | Support `/api/balance` endpoint for Ollama cloud quota and credit tracking. |
| `273dff23` | `4a76b8de02f7711dfb8d78b6146dab94d21468bb` | 9router | US2 (Providers) | Correct CommandCode quota display formatting and connection test response parsing. |
| `273dff23` | `00dd3dfcbe76e967ace4f7166a017f3dcea45800` | 9router | US2 (Providers) | Preserve provider connection cards on non-STT OAuth media provider pages. |
| `273dff23` | `a3ca2f9b5cb090f1babf11a8781d5c6148f83411` | 9router | US3 (Providers) | Correct API key visibility guidance copy across i18n locales in Endpoint modal. |
| `273dff23` | `b6a9ca43f1aed8bf903c23b6df62da96a6c389bc` | 9router | US2 (Providers) | Triage GLM-5.2 effort and SSRF tests; calibrate test suite expectations. |
| `84dffab9` | `f3f86fdd52f9e9e9538847dddf233293224733d2` | 9router | US3 (Smart Router) | Implement Smart Router with Redis-backed session stickiness (`khatam:smartrouter:session:*`). |
| `902dc3aa` | `f3f86fdd52f9e9e9538847dddf233293224733d2` | 9router | US3 (Smart Router) | Export `SmartPolicyModal` from barrel; add `systemone` kind filter to `ModelSelectModal`. |
| `ff292a12` | `b0655314b79c7a7bfb7288982cddb98503641429` | 9router | US2 (Capabilities) | Register Grok 4.7 with explicit 500k context window in `capabilities.js`, `grok-cli.js`, `xai.js`. |
| `3c0ba50b` | `161e34939ab878cb79dfdf241a696ec292508af4` | 9router | US3 (Image/MITM) | Support reference image inputs for Gemini with SSRF defense; ensure safe MITM directory creation. |

---

## 4. Skipped Upstream Commits & Rationale

During the Wave 9 upstream audit, 83 commits from VansRouter and 6 commits from 9router were evaluated and intentionally excluded:

### VansRouter Skipped Commits (83 Commits)
1. **Release Chores & Version Bumps (32 commits)**: Version tag bumps (`v0.91.62` through `v0.91.81`), package version adjustments, and automated release pipeline triggers.
2. **pnpm & Containerd Tooling (18 commits)**: Upstream pnpm lockfile updates, pnpm-specific script hooks, and containerd integration harnesses that conflict with KhatamRouter's strict Bun v1.4.4+ and Dockerfile.bun runtime architecture.
3. **Pre-Ported Parity (21 commits)**: Capabilities already ported in Wave 7 (VansRouter Parity: 30 new provider registries, specialized executors `agentrouter`/`qwen`/`zcode`/`freebuff`/`muse-spark-web`, LoopGuard, Ponytail prompts, and `listFreeTiers()` catalog derivation).
4. **Desktop & Packaging Specifics (8 commits)**: Electron/Tauri packaging scripts, tray-menu customizations, and Windows/macOS installer configurations specific to VansRouter distribution.
5. **Internal Docs & Notes (4 commits)**: Upstream-specific documentation, internal contributor notes, and untracked translation snippets.

### 9router Skipped Commits (6 Commits)
1. **Release Tags & Bumps (3 commits)**: Upstream version tag increments (`v0.5.105` through `v0.5.109`).
2. **Lockfile Churn (2 commits)**: Upstream pnpm lockfile updates superseded by Bun package management (`bun.lock`).
3. **Release Announcements (1 commit)**: Upstream release announcements and external community links.

---

## 5. Architectural Invariants Enforced

All ported code conforms to KhatamRouter's architectural contract:
- **Strict Bun Runtime**: Zero legacy Node.js SQLite drivers (`better-sqlite3`, `node:sqlite`, `sql.js`). Database persistence strictly uses `bun:sqlite` with WAL mode.
- **Redis-Backed Distributed State**: Upstream in-memory session mappings (such as Smart Router's session cache) are re-implemented using Redis primitives (`khatam:` namespace) with TTLs and transparent fail-open fallback.
- **Fail-Open Quota & Rate Limiting**: Limit evaluation degrades safely under infrastructure outages without dropping valid user traffic.
- **Retained Webpack Bundler**: Webpack retained (`--webpack`) following the formal rejection of Turbopack (Spec 0075) to prevent bundle bloat and dynamic tracing regressions.
- **Security-First Ingestion**: Request bodies bounded to 128 MiB JSON / 64 MiB h2c; strict CRLF enforcement; immediate rejection of HTTP smuggling attempts combining Content-Length and Transfer-Encoding.

---

# Upstream Ports & Audit Ledger: Pre-Wave-8 Decolua PR Batch

This section records the upstream porting and synchronization audit for the 5 requested `decolua/9router` pull requests (`#4988`, `#5222`, `#5150`, `#5179`, `#5193`) ported prior to Wave 8.

## 1. Summary & Ported PRs Matrix

| PR | Landed Commit | Upstream PR Title / Summary | Subsystem / Files Changed | Security Hardening / Deviations |
|---|---|---|---|---|
| [`#5150`](https://github.com/decolua/9router/pull/5150) | `e3e324bf` | `fix(translator): downgrade deepseek json_schema to json_object` | `open-sse/translator/concerns/paramSupport.js`<br>`tests/unit/param-support.test.js` | Added defensive null/primitive checks and optional chaining (`response_format?.type`) to prevent gateway runtime crashes on malformed inputs. |
| [`#5179`](https://github.com/decolua/9router/pull/5179) | `a8c3f780` | `fix(capabilities): cap oc/deepseek-v4.1-flash-free context window` | `open-sse/providers/capabilities.js`<br>`tests/unit/capabilities.test.js` | Capped `opencode/deepseek-v4.1-flash-free` at 200,000 / 32,000 (preserving `<= 330,000` cap) rather than raising to 330,000, avoiding advertising higher token limits than safe models.dev baseline. |
| [`#5193`](https://github.com/decolua/9router/pull/5193) | `73de8878` | `fix(providers): avoid network probe on opencode free tier connection test` | `src/app/api/providers/[id]/test/testUtils.js`<br>`tests/unit/opencode-test-no-probe.test.js` | Omitted unauthenticated network probe to `zen/v1/models` on free tier connection test; returns `valid: true` directly to eliminate unneeded egress and prevent IP flagging. |
| [`#5222`](https://github.com/decolua/9router/pull/5222) | `1235db41` | `feat(opencode): port session timestamps and CLI fingerprint (#5222)` | `open-sse/executors/opencode.js`<br>`open-sse/utils/opencodeFingerprint.js`<br>`tests/unit/opencode-fingerprint.test.js`<br>`tests/unit/opencode-session.test.js` | Host reconnaissance defense: replaced upstream `process.cwd()` and `os.tmpdir()` leaks with fixed neutral constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`); retained backward-compatible constants and ID pools. |
| [`#4988`](https://github.com/decolua/9router/pull/4988) | `1b8869d2` | `feat(proxy): replay proxied 403 FreeTierError once on direct egress` | `open-sse/utils/proxyFetch.js`<br>`tests/unit/opencode-freetier-direct-replay.test.js` | Strict host allowlist (OpenCode origins only), strictProxy contract enforcement, 64 KiB body buffering ceiling (DoS prevention), single direct replay attempt, safe header handling, and query param/credential log redaction. |

## 2. Detailed Upstream PR Breakdown & Security Audit

### PR #5150: DeepSeek Response Format json_schema Downgrade
- **Upstream PR**: [decolua/9router#5150](https://github.com/decolua/9router/pull/5150)
- **Landed Commit**: `e3e324bf`
- **What Was Ported**:
  DeepSeek API documentation specifies support only for `response_format: { type: "json_object" }`; passing `{ type: "json_schema" }` results in HTTP 400 rejection with message `"This response_format type is unavailable now"`. In `open-sse/translator/concerns/paramSupport.js`, `json_schema` is safely downgraded to `json_object` when targeting DeepSeek providers and models, allowing structured JSON requests to proceed.
- **Security Audit & Deviations**:
  - Upstream checked `body.response_format.type === 'json_schema'` directly, which throws a TypeError if `response_format` is null, boolean, or primitive.
  - KhatamRouter applied defensive programming using optional chaining (`body.response_format?.type === 'json_schema'`) and guarded against non-object payloads.
  - Added unit test coverage verifying that null, non-object, and missing `response_format` fields pass through safely without runtime exceptions.

### PR #5179: OpenCode deepseek-v4.1-flash-free Context Window Cap
- **Upstream PR**: [decolua/9router#5179](https://github.com/decolua/9router/pull/5179)
- **Landed Commit**: `a8c3f780`
- **What Was Ported**:
  Upstream OpenCode backend enforces a ~330,000 prompt token limit on `deepseek-v4.1-flash-free` (upstream issue #5097), rejecting requests that exceed this limit with HTTP 400 errors.
- **Security Audit & Deviations**:
  - Upstream 9router previously matched a generic 1M pattern and clamped it down to 330,000.
  - In KhatamRouter, `MODEL_CAPABILITIES` already listed this model safely at 200,000 contextWindow and 32,000 maxOutput based on verified models.dev free-lane specifications.
  - Rather than increasing the advertised context window to 330,000 (which could encourage prompt sizes that hit latency or soft-rate limits), KhatamRouter explicitly set `PROVIDER_CAPABILITIES.opencode` for `deepseek-v4.1-flash-free` to `contextWindow: 200000, maxOutput: 32000`. This strictly honors the `<= 330,000` cap and satisfies regression checks without inflating client expectations beyond verified limits.

### PR #5193: Avoid Network Probe on OpenCode Free Tier Connection Test
- **Upstream PR**: [decolua/9router#5193](https://github.com/decolua/9router/pull/5193)
- **Landed Commit**: `73de8878`
- **What Was Ported**:
  The dashboard connection test button for `opencode` free tier previously dispatched an HTTP GET to `https://opencode.ai/zen/v1/models`. Because the free lane requires no secret or user credentials ("Bearer public") and the legacy probe user-agent was rejected with 403 FreeTierError, the probe caused spurious test failures. In `src/app/api/providers/[id]/test/testUtils.js`, `testConnection` for `opencode` now returns `{ valid: true }` directly.
- **Security Audit & Deviations**:
  - Eliminates unnecessary network egress from the gateway host on connection tests for an unauthenticated public tier.
  - Prevents the gateway IP from being flagged or rate-limited by upstream Zen endpoints during manual dashboard test clicks.
  - Preserves the authenticated live chat probe for `opencode-go` without modification.

### PR #5222: OpenCode Session Timestamps and CLI Fingerprint
- **Upstream PR**: [decolua/9router#5222](https://github.com/decolua/9router/pull/5222)
- **Landed Commit**: `1235db41`
- **What Was Ported**:
  - Real monotonic 48-bit millisecond timestamps (`Date.now()`) encoded in `ses_` translated session IDs, memoized by `(clientTool, sessionId)` with bounded cache and TTL cleanup.
  - Default User-Agent bumped to `opencode/latest/2.1.4/cli`.
  - Accept shell tool description platform wordings (`linux`, `darwin`, `win32`) in tool definitions.
  - Idempotent and fail-open injection of `<env>` environment marker block across Chat Completions, Responses, and Claude message shapes.
  - Claude-shaped body fingerprint placement for messages models (such as `union-alpha`) via top-level `system` field.
- **Security Audit & Deviations**:
  - **Host Reconnaissance Vulnerability in Upstream**: Upstream 9router generated the `<env>` fingerprint block by reading `process.cwd()` and `path.join(os.tmpdir(), 'opencode')`. In a gateway/proxy deployment, this leaks the server's internal filesystem hierarchy, directory names, OS usernames, and environment paths to external upstreams on every OpenCode request.
  - **KhatamRouter Hardening**: Replaced dynamic host path evaluation with fixed, neutral constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`). This completely satisfies upstream fingerprint parsing while strictly preventing host layout disclosure.
  - **Backward Compatibility**: Maintained KhatamRouter exports (`OPENCODE_UA`, `OPENCODE_CLIENT`, `translatedIdStores`, `MAX_TRANSLATED_IDS`) and isolated request ID stores to ensure zero breakage of existing integrations.

### PR #4988: OpenCode Free Tier 403 Replay on Direct Egress
- **Upstream PR**: [decolua/9router#4988](https://github.com/decolua/9router/pull/4988)
- **Landed Commit**: `1b8869d2`
- **What Was Ported**:
  When an OpenCode free-tier request routed through an outbound proxy receives an HTTP 403 `FreeTierError` (indicating upstream has flagged the proxy IP), `proxyFetch` safely inspects the response and attempts a single direct replay.
- **Security Audit & Deviations**:
  - **Strict Host Restricting**: Direct replay is strictly gated to OpenCode origins (`opencode.ai` and subdomains via `isOpenCodeHost`). Other providers never trigger 403 body inspection or direct replay, eliminating any accidental IP leakage for non-OpenCode traffic.
  - **Strict Proxy Contract Preservation**: Replay is strictly forbidden if `proxyOptions.strictProxy === true` or if direct fallback is disabled, ensuring strict proxy isolation is never bypassed.
  - **Memory Exhaustion (DoS) Defense**: Response body inspection for 403 responses is strictly bounded to 64 KiB (`MAX_FREE_TIER_BODY_BYTES`) with Content-Length pre-checks and stream chunk limits with reader cancellation. This prevents malicious upstreams from consuming unbounded server memory.
  - **Single Replay & Privacy-Preserving Logging**: At most one direct replay is performed with unmodified method, headers, and body. Log output redacts URL paths, queries, and credentials, logging only the parsed host name.
  - **Stream / Consumed Body Safety**: If the request body stream is locked or consumed, replay is bypassed and a reconstructed response from buffered text is returned safely.

---

# Upstream Ports & Audit Ledger: Decolua 9router Window v0.5.109 → v0.5.111

This section records the upstream porting and synchronization audit for `decolua/9router` across window `v0.5.109 (f39d8f07)` → `v0.5.111 (3a978a63)`.

## 1. Summary & Ported Commits Matrix

| Upstream Commit | Landed Commit | Subject / Title | Subsystem / Files Changed | Security Hardening / Deviations |
|---|---|---|---|---|
| `763fb687` | `e2c9edc9` | `fix(thinking): keep effort max for GPT-5.6 / GPT-6 on OpenAI Compatible nodes` | `open-sse/providers/thinkingLevels.js`<br>`tests/unit/openai-compatible-gpt6-max-effort.test.js` | Preserves `reasoning_effort: "max"` for GPT-5.6 / GPT-6 across generic OpenAI-compatible providers. |
| `0ad0a722` | `17dd3ef3` | `fix(claude): keep adaptive thinking for Haiku 5.5 on the passthrough` | `open-sse/translator/formats/claude.js`<br>`tests/unit/claude-haiku-adaptive-thinking.test.js` | Allows adaptive thinking configuration on Claude Haiku 5.5 passthrough routes without stripping parameters. |
| `2924e055` | `746ec263` | `fix(deepseek): send the upstream model id the API actually accepts` | `open-sse/providers/registry/deepseek.js`<br>`tests/unit/deepseek-v41-flash-upstream-id.test.js` | Maps deepseek alias IDs onto upstream API accepted wire IDs (`deepseek-ai/DeepSeek-V3` / `deepseek-ai/DeepSeek-R1`). |
| `95009651` | `ec860137` | `fix(translator): convert image_url parts inside tool messages to Claude images` | `open-sse/translator/request/openai-to-claude.js`<br>`tests/unit/tool-result-image-url.test.js` | **SSRF & Resource Exhaustion Defense**: strictly allows `data:` URIs only; rejects remote `http(s):` URLs and foreign schemes; enforces 10 MiB pre-decode base64 length ceiling; restricts media types to safe raster formats (`image/jpeg`, `image/png`, `image/gif`, `image/webp`); fails open by dropping unsupported parts instead of forwarding or throwing. |
| `483c10f5` | `9d59ffd8` | `fix(opencode): normalize colliding fingerprint tool definitions in place` | `open-sse/utils/opencodeFingerprint.js`<br>`tests/unit/opencode-fingerprint.test.js` | **Host Reconnaissance Defense**: retains fixed neutral constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`) preventing server directory disclosure; omits native binary TLS client references (`opencodeTlsClient.js`). |
| `86adae35` | `b2cb75b6` | `fix(headroom): preserve native Claude PDFs and tool history` | `open-sse/rtk/headroom.js`<br>`tests/unit/headroom-claude-documents.test.js`<br>`tests/unit/headroom.test.js` | Preserves loopback-only Headroom binding validation and fail-open contract where any message count/order/role/id mismatch leaves original request untouched; imports schema constants. |
| `5cd4a756` | `0f154083` | `feat(opencode-go): add Kimi K3.1 Pro` | `open-sse/providers/registry/opencode-go.js`<br>`open-sse/providers/capabilities.js`<br>`open-sse/providers/pricing.js` | Adds Kimi K3.1 Pro model to OpenCode Go catalog; preserves KhatamRouter 200k/32k capability pins for deepseek-v4.1-flash-free. |
| `a3bdaf6d` | `1e861329` | `feat(commandcode): add Kimi K3.1 Pro to the model catalog` | `open-sse/providers/registry/commandcode.js`<br>`tests/unit/commandcode-kimi-k3-1-pro.test.js` | Adds Kimi K3.1 Pro to CommandCode model catalog. |
| `fbac1220` | `9ee7dfde` | `fix(codex-image): drive image_generation from gpt-6-sol` | `open-sse/handlers/imageProviders/codex.js`<br>`open-sse/providers/capabilities.js`<br>`open-sse/providers/registry/codex.js` | Drives image generation from `gpt-6-sol` instead of legacy models; inserts `*gpt-6*image*` ahead of generic `*gpt-6*` in capabilities table. |
| `b9c27225` | `1323db66`<br>`ce035deb` | `feat(providers): add Runcrate` | `open-sse/providers/registry/runcrate.js`<br>`open-sse/providers/registry/index.js`<br>`src/app/api/providers/[id]/test/testUtils.js`<br>`src/app/api/providers/validate/route.js`<br>`tests/unit/runcrate-provider.test.js` | Adds Runcrate provider with next free index `p165`; strips upstream UTM tracking query parameters from website URL; adds dedicated `validateUrl` routing against authenticated billing balance endpoint; updates registry parity test. |
| `31a9d262` | `8e088e64`<br>`fc3e5f6b` | `feat(tts): add Ollama Local TTS provider support (Phonon)` | `open-sse/handlers/ttsProviders/ollamaLocal.js`<br>`open-sse/handlers/ttsProviders/_base.js`<br>`open-sse/config/ttsModels.js`<br>`src/shared/constants/ttsProviders.js`<br>`src/sse/handlers/tts.js`<br>`src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js`<br>`tests/unit/ollama-local-tts.test.js` | **SSRF & Buffer Exhaustion Defense**: enforces URL scheme whitelist (http/https only); rejects credentials in host URL; bounds base audio streaming buffer at 50 MiB with clean error on oversized chunks; enforces 120s synthesis and 10s discovery timeouts; constrains base URL strictly to admin-configured credentials or default `http://localhost:11434`; requires router ACL check before upstream call; adds WAV/PCM format support and in-browser preview. |
| `10cd6c08` | `fc7fe6c7` | `feat(ollama): add embedding provider adapter and endpoint support` | `open-sse/handlers/embeddingProviders/ollamaLocal.js`<br>`open-sse/handlers/embeddingsCore.js`<br>`open-sse/providers/registry/ollama-local.js`<br>`tests/unit/ollama-local-embeddings.test.js` | **SSRF & Timeout Defense**: enforces URL scheme whitelist (http/https only); rejects credentials in host URL; adds 10s fetch timeout; constrains host resolution strictly to admin-configured credentials or default `http://localhost:11434`; requires router ACL check before upstream call; supports dynamic dimensions and automated model discovery. |
| `72cb589e`<br>`50dcaa0c` | `cafcb7fc`<br>`b91c501b` | `fix(cli-tools): stop resetting Pi model caps and let users pick them & keep hand-set name` | `src/app/(dashboard)/dashboard/cli-tools/components/GenericCliToolCard.js`<br>`src/app/api/cli-tools/pi-settings/route.js`<br>`tests/unit/cli-tools-pi-settings.test.js` | Preserves KhatamRouter branding toast in pi-settings; preserves functional `'9router'` provider key in `~/.pi/agent/models.json`; exports helper functions for testability; retains custom Pi model names across Apply. |
| `ce060c79` | `port/opencode-bun-native` | `fix(opencode): restore the free tier with the TLS client Hello it accepts` | `open-sse/services/opencodeTlsClient.js`<br>`open-sse/executors/opencode.js`<br>`open-sse/executors/base.js`<br>`open-sse/utils/proxyFetch.js`<br>`open-sse/utils/opencodeFingerprint.js` | **Bun-Native Port with Security Hardening**: uses `wreq-js@3.2.0` via optional dependency with dynamic `import()` (zero runtime child-process spawning / no `lazyRuntime.js`); real fail-open to native Bun `fetch` on load error with single diagnostic warning; strictly scopes `directFetch` to `*.opencode.ai` while preserving proxy priority and `strictProxy`; retains fixed neutral dummy constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`) preventing host reconnaissance leaks. |
| `1da5b0d7` | `port/opencode-bun-native` | `fix(opencode): cap oc/deepseek-v4.1-flash-free context window at 330k` | `open-sse/providers/capabilities.js`<br>`tests/unit/capabilities.test.js` | Capped `oc/deepseek-v4.1-flash-free` context window at 330,000 (`maxOutput: 128000`), ensuring client compaction precedes backend prompt limits per upstream #5097. |

## 2. Deliberately Skipped Upstream Commits & Rationale

> ⚠️ **MANDATORY POLICY NOTE — USER CONSENT REQUIRED**:  
> Skipping upstream commits is strictly forbidden without explicit, informed user consent. Every upstream commit must be evaluated for porting. When architectural adaptations are required (e.g. Bun compatibility, security hardening, container immutability), the commit must be adapted natively rather than skipped or bypassed.

1. **`3a978a63` (release chore: bump version to v0.5.111)**:
   - **Status**: Reconciled and aligned.
   - **Details**: Package versioning in KhatamRouter is aligned at `0.5.111` across root `package.json` and `cli/package.json`. Upstream's release changelog entries for v0.5.111 were merged into KhatamRouter's `CHANGELOG.md`. Upstream's raw commit was not cherry-picked verbatim solely to preserve KhatamRouter-specific branding, scripts, dependencies, and security hardening.

---

### Previously Evaluated & Now Ported Commits

The following commits were initially evaluated as skipped in early review, but have now been fully ported to KhatamRouter under branch `port/opencode-bun-native` (Spec `012-opencode-wreq-bun`) following explicit user instruction and Bun-native adaptation:

1. **`ce060c79` (wreq-js TLS client for OpenCode free tier — NOW PORTED)**:
   - **Ported Status**: Fully ported and adapted natively to Bun 1.4.3.
   - **Bun-Native Architecture & Security Hardening**:
     - **Optional Dependency Packaging**: Upstream used `lazyRuntime.js` to execute `npm i --no-save wreq-js` at runtime via child process, which broke in containerized/immutable environments and failed under Bun-only setups. KhatamRouter declared `wreq-js@3.2.0` as a standard `optionalDependencies` entry in `package.json`, bundled with platform native bindings (`@wreq-js/binding-linux-x64-gnu`) and loaded via standard dynamic `import("wreq-js")` with zero runtime child-process spawning.
     - **Host Allowlist & Proxy Priority**: `directFetch` in `open-sse/utils/proxyFetch.js` is strictly gated to `opencode.ai` and `*.opencode.ai` subdomains. Outbound proxies retain strict priority over `directFetch`, and `strictProxy: true` configuration fails closed if proxy resolution fails.
     - **Real Fail-Open to Bun Native Fetch**: Upstream failed closed with unhandled `OpencodeTlsUnavailableError`. KhatamRouter implements a real fail-open fallback: if `wreq-js` is unavailable (e.g., unsupported platform architecture), `opencodeTlsFetch` emits at most one warning (`[OpenCode TLS] wreq-js unavailable; falling back to native Bun fetch`) and transparently delegates to native `globalThis.fetch()`, which already shares BoringSSL cipher parity.
     - **Host Reconnaissance Defense**: Upstream leaked local system paths in `<env>` marker prompts via `process.cwd()` and `os.tmpdir()`. KhatamRouter preserves fixed neutral dummy constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`), preventing host filesystem and username disclosure.

2. **`1da5b0d7` (cap oc/deepseek-v4.1-flash-free context window at 330k — NOW PORTED)**:
   - **Ported Status**: Fully ported.
   - **Adaptation**: Updated `open-sse/providers/capabilities.js` to explicitly pin `deepseek-v4.1-flash-free` with `contextWindow: 330000` and `maxOutput: 128000`, replacing the earlier 200,000 / 32,000 conservative pin. This ensures client IDEs (e.g. VS Code Copilot) compact conversations before hitting the backend's prompt limit (upstream issue #5097).

---

# Upstream Ports & Audit Ledger: Decolua 9router Window v0.5.111 → v0.5.112 (Spec 013)

This section records the upstream porting and synchronization audit for `decolua/9router` across release window `v0.5.111 (3a978a63)` → `v0.5.112 (1fe586bb)`, covering all 14 commits (`e70ea24d` through `1fe586bb`).

## 1. Summary & Ported Commits Matrix (14 Commits)

| Upstream Commit | Subject / Title | Status | Our Files Changed | Tests | Deliberate Deviations / Architectural Hardening |
|---|---|---|---|---|---|
| `e70ea24d` | `Fix OpenCode` | already present superior | `open-sse/services/opencodeTlsClient.js` | `tests/unit/opencode-tls-client.test.js` | **No lazyRuntime/npm**: Upstream introduced dynamic runtime child-process `npm` installs (`lazyRuntime.js`). KhatamRouter strictly operates on Bun with pre-installed `wreq-js` native bindings (PR #78), proving full byte and protocol parity without runtime package fetching. |
| `acb3c080` | `feat(codex): add GPT-6.1 Terra` | ported | `open-sse/providers/registry/codex.js`<br>`open-sse/providers/capabilities.js`<br>`open-sse/providers/pricing.js` | `tests/unit/codex-gpt6-lite.test.js` | None. Configured `gpt-6.1-terra` with `responsesLite: true`, `GPT_6_LITE_THINKING_LEVELS`, 500k context window, 128k output cap, and accurate pricing ($1.00 input, $5.00 output). |
| `3fd925ab` | `fix(codebuddy): send plugin request/conversation id headers` | ported | `open-sse/executors/default.js`<br>`open-sse/providers/registry/codebuddy-cn.js`<br>`open-sse/providers/registry/codebuddy-intl.js` | `tests/unit/codebuddy-channel-headers.test.js`<br>`tests/unit/codebuddy-intl-backoff.test.js` | None. Implemented `codebuddyHeaders` hook generating UUIDs for `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID` for `codebuddy-cn` and `codebuddy-intl`; ported combo integration tests verifying request-scoped error handling. |
| `f3e1f716` | `fix(github): apply Claude 5.5 thinking rules to Copilot's dotted model ids` | ported | `open-sse/providers/capabilities.js`<br>`open-sse/translator/concerns/thinkingUnified.js` | `tests/unit/github-claude-5-5-thinking.test.js` | None. Applied Claude 5.5 thinking rules to dotted Copilot model IDs (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) and preserved requested thinking display format. |
| `b1effa03` | `feat(commandcode): align request headers with official CLI 1.88.0` | ported | `open-sse/shared/commandCodeHeaders.js`<br>`open-sse/executors/commandcode.js`<br>`open-sse/providers/registry/commandcode.js`<br>`open-sse/services/usage/commandcode.js`<br>`open-sse/translator/request/openai-to-commandcode.js`<br>`src/app/api/providers/validate/route.js` | `tests/unit/commandcode-headers.test.js`<br>`tests/unit/commandcode-usage.test.js` | None. Implemented shared `commandCodeHeaders.js` with decamelizing path slugification and threadId/x-session-id UUID synchronization. |
| `a199d777` | `fix(providers): treat LLM\|id\|secret as opaque token in bulk-add, not name\|key` | ported | `src/shared/utils/bulkAdd.js` | `tests/unit/bulk-add-names.test.js` | None. Preserved `LLM\|` tokens as opaque API keys during bulk import without destructive pipe splitting. |
| `ced0cf6e` | `fix(nvidia): normalize reasoning aliases for NIM` | ported | `open-sse/translator/concerns/paramSupport.js` | `tests/unit/param-support.test.js` | None. Normalized assistant turn `reasoning` field aliases to `reasoning_content` for provider `nvidia` to eliminate duplicate-field 400 errors. |
| `f7f6f5ed` | `feat: add Nace Drex provider to the System One lane` | ported with hardening | `open-sse/providers/registry/nace.js`<br>`public/providers/nace.png`<br>`open-sse/providers/registry/index.js`<br>`tests/__baseline__/alias-baseline.json`<br>`tests/__baseline__/providers-baseline.json` | `tests/unit/nace-systemone-provider.test.js` | **Nace via migrate-registry**: Provider index `open-sse/providers/registry/index.js` was regenerated via `scripts/migrate-registry.mjs` instead of hand-edited, preserving automated registry invariants. |
| `8db1f4ae` | `fix(translator): enforce Gemini protobuf type predicates on schema items and properties` | ported | `open-sse/translator/formats/gemini.js` | `tests/unit/gemini-schema-array-items-predicate.test.js` | None. Stripped `items` from non-array schemas and `properties`/`required` from non-object schemas; structural type selection prioritized in multi-type arrays. |
| `56dbf466` | `fix(chat): reject SSE errors in non-streaming responses` | ported | `open-sse/handlers/chatCore/nonStreamingHandler.js` | `tests/unit/nonstream-sse-error.test.js` | None. Extracted and clamped upstream SSE error frames (400-599 or 502) in non-streaming chat, returning `createErrorResult` and logging failure. |
| `3b7acf72` | `fix(docker): bundle lazy runtime deps so OpenCode Free resolves` | already present superior | `Dockerfile`<br>`Dockerfile.bun` | `tests/unit/opencode-tls-client.test.js`<br>`specs/013-upstream-0-5-112/results/dockerfile-identity.txt` | **No lazyRuntime/npm**: Upstream bundled npm packages into the container runner to service dynamic runtime installs. KhatamRouter relies on pre-installed `wreq-js` under Bun runtime, keeping `Dockerfile` and `Dockerfile.bun` 100% byte-identical. |
| `d7bb71ce` | `fix(deepseek): use noble-hashes port for DeepSeek PoW hash` | ported with hardening | `open-sse/lib/deepseek-pow-hash.js` | `tests/unit/deepseek-pow-hash.test.js` | **Restored PoW validation**: Replaced vendored Keccak implementation with noble-hashes Keccak-f[1600], while restoring all input validation dropped by upstream: 64-hex challenge regex (`/^[0-9a-fA-F]{64}$/`), `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, integer and type assertions, and timeout safeguards. |
| `85d73bd6` | `feat(minimax-code): lease auth mode via desktop app named-pipe broker` | ported with hardening | `open-sse/services/minimaxCodeLease.js`<br>`open-sse/executors/minimax-code.js`<br>`open-sse/services/minimaxCodeUsage.js`<br>`src/dashboardGuard.js`<br>`src/app/api/oauth/[provider]/[action]/route.js`<br>`src/sse/handlers/chat.js`<br>`src/sse/services/tokenRefresh.js`<br>`src/app/(dashboard)/dashboard/providers/components/MinimaxLeaseButton.js`<br>`src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`<br>`src/app/(dashboard)/dashboard/providers/[id]/page.js` | `tests/unit/minimax-code-lease.test.js`<br>`tests/unit/minimax-lease-guard.test.js` | **MiniMax broker hardening + Redis single-flight**:<br>1. Loopback-only enforcement in `dashboardGuard.js` via `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS`.<br>2. Strict path traversal and null-byte rejection via canonical `dataDir` validation (`validateAndCanonicalizeDataDir`).<br>3. Bounded 64KB frame decoding preventing memory exhaustion DoS.<br>4. Multi-worker Redis token cache with TTL margin and distributed single-flight locking across clustered workers.<br>5. Guaranteed ephemeral in-memory handling: leased tokens are NEVER persisted to SQLite (`providerConnections`), dropping `accessToken`/`refreshToken`/`expires*` at the persistence boundary in `updateProviderCredentials` and `chat.js`.<br>6. Usage service strictly resolves via `getLeaseToken` on lease connections.<br>7. Canonical dataDir comparison in `route.js` ensuring idempotency for paths with or without trailing slash. |
| `1fe586bb` | `# v0.5.112 (2026-10-28)` | release chore | `package.json`<br>`cli/package.json`<br>`CHANGELOG.md`<br>`docs/UPSTREAM-PORTS.md` | `tests/unit/display-branding-guard.test.js` | Aligned version to `0.5.112` across root and CLI packages while preserving KhatamRouter fork branding, vertical scale architecture, and security hardening. |

## 2. Detailed Upstream Commits Audit & Architectural Deviations

### Commit `e70ea24d` & `3b7acf72`: OpenCode TLS Client & Container Architecture
- **Upstream Strategy**: Upstream implemented `lazyRuntime.js` to run child-process `npm install` on demand, and later bundled those dependencies into Docker images (`3b7acf72`) to work around runtime install failures.
- **KhatamRouter Resolution (Already Present Superior)**: KhatamRouter rejected runtime child-process package installation as an architectural invariant violation. As proven in Spec 012 / PR #78, native `wreq-js` running under Bun fulfills all TLS handshake requirements. `Dockerfile` and `Dockerfile.bun` remain 100% byte-identical (`specs/013-upstream-0-5-112/results/dockerfile-identity.txt`) without bundling dynamic npm runners.

### Commit `d7bb71ce`: DeepSeek PoW Hash
- **Upstream Strategy**: Upstream replaced a ~430-line vendored Keccak implementation with an inlined noble-hashes port, but dropped validation checks during the refactor.
- **KhatamRouter Resolution (Ported with Hardening)**: KhatamRouter adopted the compact noble-hashes Keccak-f[1600] / SHA3-256 algorithm in `open-sse/lib/deepseek-pow-hash.js`, but explicitly restored all strict input bounds: challenge string length and 64-character hexadecimal format verification (`/^[0-9a-fA-F]{64}$/`), non-negative integer assertions for difficulty, difficulty ceiling cap (`MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`), and infinite-loop timeout guards.

### Commit `85d73bd6`: MiniMax Code Named-Pipe Lease Broker
- **Upstream Strategy**: Upstream added local named-pipe/unix-domain-socket IPC allowing gateway instances to borrow authentication tokens from the MiniMax Code desktop app, avoiding single-use refresh token invalidation races.
- **KhatamRouter Resolution (Ported with Hardening)**:
  - **Persistence Boundary Defense (Critical Security Fix)**: Prevented leased access tokens from being written to SQLite (`providerConnections`). In `src/sse/services/tokenRefresh.js` and `src/sse/handlers/chat.js`, lease connections and ephemeral tokens are stripped before database writes while keeping in-memory credentials valid for request retries.
  - **Network Boundary Hardening**: Bound `/api/oauth/minimax-code/lease-connect` and `lease-status` to `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS` in `src/dashboardGuard.js`, preventing remote access or header spoofing.
  - **Distributed Redis Caching & Single-Flight**: Enhanced the in-process cache with multi-worker Redis token caching and distributed locking with TTL safety margin, failing open to local memory.
  - **Protocol Bounds & Path Canonicalization**: Enforced 64KB frame size limits (`AUTH_LEASE_MAX_FRAME_BYTES`) and canonical path normalization (`validateAndCanonicalizeDataDir`) preventing directory traversal or cross-directory cache pollution.

### Commit `f7f6f5ed`: Nace Drex Provider
- **Upstream Strategy**: Upstream registered `nace` directly and manually updated registries.
- **KhatamRouter Resolution (Ported with Hardening)**: Registered `open-sse/providers/registry/nace.js`, added asset `public/providers/nace.png`, and regenerated `open-sse/providers/registry/index.js` using `scripts/migrate-registry.mjs`, ensuring provider baseline snapshots match committed registries.

---

# Upstream Ports & Audit Ledger: VansRouter Sync Window v0.91.81 → v0.91.89 (PR #122)

This section records the synchronization of upstream enhancements from `Vanszs/VansRouter` through `v0.91.89` (merged via PR #122), along with the critical OpenCode session cache invalidation fix.

## 1. Summary & Ported Commits Matrix

| Area / Feature | VansRouter Commits | Our Files Changed | Tests | Architectural Hardening & Fork Resolution |
|---|---|---|---|---|
| **OpenCode 429 Session Invalidation** | N/A (KhatamRouter fix) | `open-sse/executors/opencode.js`<br>`src/sse/handlers/chat.js` | `tests/unit/psiphon-rotation.test.js` | **Fresh Session on Rotate**: Added `invalidateOpencodeSession` to `open-sse/executors/opencode.js` and wired it into `src/sse/handlers/chat.js` during Psiphon burn rotations. Retrying requests now get a fresh session ID on the fresh IP, preventing OpenCode backend from repeating 429 due to flagged session reuse. |
| **CodeBuddy Intl Stable UUID & Channel Headers** | `2c7b2527`<br>`a01e86f8` | `open-sse/executors/codebuddy-intl.js` | `tests/unit/codebuddy-intl-conversation-headers.test.js` | Generates deterministic RFC-4122-v5-shaped UUIDs from session/conversation keys (`stableUuidFrom`), keeping `X-Conversation-ID` stable across retries and reusing the channel's `X-Request-ID`. |
| **SQLite NUL Byte Stripping** | `c8d3d31b` | `src/lib/db/driver.js`<br>`src/lib/db/helpers/nullBytes.js` | `tests/unit/db-null-byte-params.test.js` | Wraps database statements (`run`/`get`/`all`) to automatically strip embedded NUL (`\0`) bytes in bound parameters across all SQLite adapters. Prevents unexpected string truncations. |
| **ProviderLimits Race & Provider Scoping** | `f1d824b0` | `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`<br>`src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` | `tests/unit/quota-tracker-request-race.test.js` | Adds `createLatestRequestTracker` to reject superseded asynchronous connection fetches (latest-wins) and `scopeConnectionsToProvider` to strictly scope rendered connection rows to the active provider filter. |
| **Streaming Tool Name Restoration & ID Synthesis** | `1d480a2d` | `open-sse/utils/stream.js`<br>`open-sse/utils/streamHelpers.js` | `tests/unit/opencode-fingerprint-passthrough-restore.test.js`<br>`tests/unit/stream-tool-call-id.test.js` | In `stream.js`, restored caller tool names on passthrough streams when renamed by OpenCode fingerprint tools (`toolNameMap`), and supported 9-argument signature for passthrough logging. |
| **Kiro Model Normalization & Grok 4.7 Window** | `6f6f2a61`<br>`bbad970b`<br>`d261f6f3` | `open-sse/config/kiroConstants.js`<br>`open-sse/providers/capabilities.js` | `tests/unit/kiro-model-normalization.test.js`<br>`tests/unit/grok-4.7-context-window.test.js` | Normalized Anthropic model IDs to Kiro upstream aliases in `kiroConstants.js`, and pinned Grok 4.7 context window to 500,000 tokens. |


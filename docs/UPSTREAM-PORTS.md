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
2. **pnpm & Containerd Tooling (18 commits)**: Upstream pnpm lockfile updates, pnpm-specific script hooks, and containerd integration harnesses that conflict with KhatamRouter's strict Bun v1.4.3+ and Dockerfile.bun runtime architecture.
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

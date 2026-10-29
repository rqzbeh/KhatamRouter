# Spec 013: Upstream v0.5.112 Port (14 Commits, Core Routing, MiniMax Named-Pipe Lease Broker, DeepSeek PoW Boundary)

## 1. Executive Summary & Purpose

KhatamRouter is an enhanced, security-hardened fork of 9Router (`decolua/9router`) standardized strictly on the **Bun runtime** and native `bun:sqlite` persistence with Redis multi-worker state coordination. This specification governs the complete porting of the upstream **v0.5.112 release window (commits e70ea24d through 1fe586bb, covering 14 commits)**.

In accordance with user decisions and fork governance rules:
1. **Strict Superset & Zero Omissions**: Every upstream commit is audited, categorized, and ported. No features are dropped. Capabilities depending on modules not yet ported into master are either ported alongside or cleanly bounded with contractual interfaces for designated successor specs (e.g., DeepSeek PoW module in Spec 013 consumed by Spec 015 Web-Cookie Providers).
2. **Bun-Only Architecture Invariant**: No child-process `npm` installs or dynamic runtime downloaders (`lazyRuntime.js`) will enter the codebase. Features solved natively under Bun in previous waves (such as OpenCode Free TLS via `wreq-js` in PR #78) are mathematically proven for parity with explicit line-by-line verification tasks.
3. **Security-First Hardening**: The upstream MiniMax desktop lease broker feature is fortified with strict canonical path traversal validation, loopback-only access restrictions (`dashboardGuard.js` `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS`), bounded 64KB frame decoding, and guaranteed ephemeral in-memory token handling.
4. **Redis Enhancement**: Where upstream operates purely in-process, KhatamRouter introduces a distributed Redis token cache with TTL margin and single-flight distributed locking across clustered workers, with graceful fail-open fallback to in-memory coordination.

---

## 2. Architectural Context & Scope Boundaries

### 2.1 In Scope
- **US1: Model Catalog & Capabilities Alignment**:
  - Add Codex `gpt-6.1-terra` model to registry, pricing, and capabilities (`open-sse/providers/registry/codex.js:57`, `open-sse/providers/capabilities.js:301`, `open-sse/providers/pricing.js:93`).
  - Add Qoder frontier reasoning pair `smodel` (Sonus) and `cmodel` (Cantus) to both `qoder` and `qoder-cn` registries (`open-sse/providers/registry/qoder.js:46`, `open-sse/providers/registry/qoder-cn.js:46`), wiring them into `open-sse/shared/qoder/constants.js:180`.
  - Align GitHub Copilot Claude 5.5 thinking rules for dotted model identifiers (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) in `open-sse/providers/capabilities.js:101,270` and `open-sse/translator/concerns/thinkingUnified.js:293,460`.
- **US2: Core Routing, Protocol & Error Handling Fixes**:
  - Enforce Gemini protobuf schema predicates: remove `items` from non-array types and remove `properties`/`required` from non-object types (`open-sse/translator/formats/gemini.js:304,374`).
  - Reject upstream SSE error frames in non-streaming responses, extracting and clamping HTTP status codes (400-599 or 502) and preventing phantom 200 OK completions (`open-sse/handlers/chatCore/nonStreamingHandler.js:249`).
  - Normalize NVIDIA NIM reasoning aliases: map assistant turn `reasoning` to `reasoning_content` to prevent duplicate-field 400 errors (`open-sse/translator/concerns/paramSupport.js:36,82`).
  - Issue official plugin conversation/request headers (`X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`) for CodeBuddy CN and intl gateways (`open-sse/executors/default.js:50`, `open-sse/providers/registry/codebuddy-cn.js:40`, `open-sse/providers/registry/codebuddy-intl.js:40`).
  - Treat `LLM|id|secret` (Muse) key strings as opaque tokens in bulk key import, auto-naming them `LLM 1, LLM 2, ...` without destructive pipe splitting (`src/shared/utils/bulkAdd.js:28`).
- **US3: Provider Additions & Header Alignments**:
  - Register Nace Drex provider (`nace`) in the System One lane supporting `drex-max` and `drex-v2.0` (`open-sse/providers/registry/nace.js`, `public/providers/nace.png`).
  - Align CommandCode request headers and session continuity with official CLI 1.88.0 (`open-sse/shared/commandCodeHeaders.js`, `open-sse/executors/commandcode.js:29`, `open-sse/providers/registry/commandcode.js:25`, `open-sse/services/usage/commandcode.js:86`, `open-sse/translator/request/openai-to-commandcode.js:204`).
  - Regenerate provider registry index (`open-sse/providers/registry/index.js`) and regression baselines (`tests/__baseline__/alias-baseline.json`, `tests/__baseline__/providers-baseline.json`).
- **US4: MiniMax Code Desktop App Lease Broker**:
  - Implement length-prefixed binary/JSON wire protocol over Windows named pipes (`\\.\pipe\mcode-auth-lease-<hash>`) and Unix domain sockets (`<dataDir>/run/mcode-auth-lease-v1.sock`) (`open-sse/services/minimaxCodeLease.js`).
  - Harden against path traversal attacks by validating canonical dataDir absolute paths.
  - Enforce loopback-only network policy in `src/dashboardGuard.js:54,92` for lease endpoints (`ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS`).
  - Implement Redis cluster caching for leased access tokens with TTL safety margin and distributed single-flight locking, failing open to in-process caching.
  - Provide desktop UI connect button (`MinimaxLeaseButton.js`), connection row status (`ConnectionRow.js:140`), and usage attribution (`minimaxCodeUsage.js:208`).
- **US5: DeepSeek PoW Hash Module & Boundary**:
  - Port `open-sse/lib/deepseek-pow-hash.js` using pure-JS Keccak-f[1600] / SHA3-256 (noble-hashes port).
  - Restore all input validation dropped by upstream: 64-hex challenge regex (`/^[0-9a-fA-F]{64}$/`), `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, integer and type assertions, and timeout safeguards.
  - Formally define the interface contract for consumption by Spec 015 (Web-Cookie Providers).
- **US6: Release Alignment, Docker & OpenCode Parity Proof**:
  - Align version numbers to `0.5.112` across `package.json:3` and `cli/package.json:3`.
  - Record full upstream audit ledger in `docs/UPSTREAM-PORTS.md` and merge release notes into `CHANGELOG.md`.
  - Provide line-by-line parity proof demonstrating that KhatamRouter master (via PR #78 `wreq-js` on Bun) strictly satisfies and exceeds upstream commits `e70ea24d` and `3b7acf72` without runtime npm dependencies.

### 2.2 Explicit Out of Scope
- Porting the full `deepseek-web` browser provider: deferred to **Spec 015 (webcookie-providers)**; Spec 013 delivers the standalone PoW solver library.
- Grok-web image and video models (`grok-image`, `grok-video`): deferred to **Spec 015** because `GrokWebExecutor` currently handles only text chat completions and lacks image/video generation endpoint adapters.
- Dynamic runtime package downloading via npm: strictly prohibited by fork constitution.

---

## 3. User Stories

### US1: Model Catalog & Capabilities Alignment (Priority: P1)
As an API consumer or developer using KhatamRouter,
I want the latest upstream models (Codex GPT-6.1 Terra, Qoder Sonus/Cantus, and GitHub Copilot Claude 5.5 thinking variants) available in the model discovery catalogue and capability maps,
So that my client applications can access new frontier models with accurate context window limits, pricing, and thinking parameters.

### US2: Core Routing, Protocol & Error Handling Fixes (Priority: P1)
As an AI agent sending complex tool calls and structured schemas across providers,
I want Gemini protobuf schemas sanitized of illegal type attributes, non-streaming SSE errors propagated accurately with upstream HTTP status codes, NVIDIA reasoning aliases normalized, CodeBuddy channel headers attached, and bulk-added keys parsed reliably,
So that requests do not fail with upstream 400 Bad Request or phantom 200 OK errors.

### US3: Provider Additions & Request Header Alignment (Priority: P1)
As an enterprise or agentic user,
I want access to the Nace Drex decision models via the System One protocol lane and CommandCode requests aligned with official CLI 1.88.0 identity headers,
So that System One calibrated probability routing works seamlessly and CommandCode upstream accepts requests without session drops.

### US4: MiniMax Code Desktop App Broker Lease Mode (Priority: P1)
As a MiniMax Code subscriber running the desktop application,
I want KhatamRouter to securely borrow short-lived access tokens from my desktop app via local IPC without storing single-use refresh tokens,
So that my CLI, desktop app, and local gateway can share one account without race conditions or token invalidations, backed by Redis cross-worker caching.

### US5: DeepSeek PoW Hash Module & Web Provider Boundary (Priority: P1)
As a developer preparing for full web-cookie provider integration,
I want an inlined, secure, pure-JavaScript Keccak-f[1600] PoW hash solver with strict input validation and difficulty bounds,
So that proof-of-work challenges can be solved efficiently without external native dependencies and with complete defense against unbounded loops.

### US6: Release Alignment, Docker & OpenCode Parity Proof (Priority: P1)
As a maintainer and operator of KhatamRouter,
I want repository versions aligned to v0.5.112, release ledgers updated, and explicit proof that OpenCode Free runs natively on Bun without runtime npm spawners or Dockerfile divergence,
So that container images remain deterministic, secure, and byte-identical across standard and Bun Dockerfiles.

---

## 4. Functional Requirements (FR)

### US1: Model Catalog & Capabilities
- **FR-013-01**: The system MUST register `gpt-6.1-terra` under the `codex` provider (`open-sse/providers/registry/codex.js:57`) with `responsesLite: true` and `thinkingLevels: GPT_6_LITE_THINKING_LEVELS`.
- **FR-013-02**: The system MUST configure `gpt-6.1-terra` capabilities in `open-sse/providers/capabilities.js:301` with `contextWindow: 500000`, `maxOutput: 128000`, `vision: true`, `reasoning: true`, `search: true`, and `thinkingFormat: "openai"`.
- **FR-013-03**: The system MUST configure `gpt-6.1-terra` pricing in `open-sse/providers/pricing.js:93` with `{ input: 1.00, output: 5.00, cached: 0.05, reasoning: 5.00, cache_creation: 1.25 }`.
- **FR-013-04**: The system MUST add `smodel` (Sonus) and `cmodel` (Cantus) to the `models` arrays of both `open-sse/providers/registry/qoder.js:46` and `open-sse/providers/registry/qoder-cn.js:46`.
- **FR-013-05**: The system MUST apply Claude 5.5 thinking rules to dotted model identifiers (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) in `open-sse/providers/capabilities.js:101,270` such that Opus 5.5 sets `thinkingCanDisable: false`, Sonnet 5.5 sets `thinkingOffType: "between_tools"`, and both set `forcedToolChoice: false`.
- **FR-013-06**: The system MUST preserve requested thinking `display` in `open-sse/translator/concerns/thinkingUnified.js:293,460` for always-on adaptive models when targeting Claude models.
- **FR-013-07**: The system MUST formally catalogue `grok-image` and `grok-video` as deferred to Spec 015, ensuring no unsupported media models are registered without executor support.

### US2: Core Routing & Translation
- **FR-013-08**: The system MUST enforce Gemini protobuf schema predicates in `open-sse/translator/formats/gemini.js:304,374`: non-array schemas MUST NOT contain `items`, and non-object schemas MUST NOT contain `properties` or `required`.
- **FR-013-09**: When flattening multi-type arrays in Gemini schemas (`flattenTypeArrays`), the system MUST select structural types (`object`, `array`) before falling back to scalar primitives.
- **FR-013-10**: In non-streaming chat responses (`open-sse/handlers/chatCore/nonStreamingHandler.js:249`), if an upstream SSE payload contains an `error` frame, the system MUST reject the request, logging `FAILED <status>` and returning `createErrorResult` with the upstream status (clamped 400-599 or 502) and error message.
- **FR-013-11**: The system MUST normalize assistant message `reasoning` field aliases to `reasoning_content` for provider `nvidia` in `open-sse/translator/concerns/paramSupport.js:36,82` prior to upstream forwarding.
- **FR-013-12**: The default executor (`open-sse/executors/default.js:50`) MUST provide a `codebuddyHeaders` hook generating UUIDs for `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, and `X-Conversation-Message-ID` (`X-Request-ID` matching `X-Conversation-Request-ID`).
- **FR-013-13**: Registries `codebuddy-cn` and `codebuddy-intl` (`open-sse/providers/registry/codebuddy-cn.js:40`, `open-sse/providers/registry/codebuddy-intl.js:40`) MUST register `codebuddyHeaders` in their `auth.hooks` configuration.
- **FR-013-14**: When a CodeBuddy request encounters a client-side 400 error (e.g. malformed body), the system MUST mark the error as `requestScoped: true` in `accountFallback.js`, allowing combos to advance without persisting an account cooldown.
- **FR-013-15**: In bulk connection import (`src/shared/utils/bulkAdd.js:28`), lines starting with `LLM|` (case-insensitive, non-Cloudflare) MUST be preserved as the full opaque `apiKey` and assigned auto-incrementing names `LLM 1, LLM 2, ...`.

### US3: Provider Additions & Request Headers
- **FR-013-16**: The system MUST register provider `nace` in `open-sse/providers/registry/nace.js` for the System One lane, configuring models `drex-max` and `drex-v2.0` with `baseUrl: "https://console.nace.ai/v1/systemone"`.
- **FR-013-17**: The system MUST include public asset `public/providers/nace.png` and regenerate `open-sse/providers/registry/index.js` using `scripts/migrate-registry.mjs` without manual editing.
- **FR-013-18**: The system MUST provide `open-sse/shared/commandCodeHeaders.js` implementing official CommandCode CLI 1.88.0 headers (`User-Agent: "cli"`, `x-command-code-version: "1.88.0"`, `x-cli-environment: "production"`, `x-cli-surface: "cli"`, `x-taste-learning: "false"`, `x-project-slug`, and `x-session-id`).
- **FR-013-19**: Path slugification in `slugifyPath` MUST decamelize and transliterate working directories to produce URL-safe slugs matching `@sindresorhus/slugify` output.
- **FR-013-20**: CommandCode requests in translator, executor, and usage service (`open-sse/executors/commandcode.js:29`, `open-sse/services/usage/commandcode.js:86`, `open-sse/translator/request/openai-to-commandcode.js:204`) MUST synchronize `threadId` and `x-session-id` via `toCommandCodeSessionUuid`.
- **FR-013-21**: Regression snapshots `tests/__baseline__/alias-baseline.json` and `tests/__baseline__/providers-baseline.json` MUST be updated and verified against committed providers.

### US4: MiniMax Code Desktop App Broker Lease Mode
- **FR-013-22**: The system MUST implement length-prefixed JSON framing in `open-sse/services/minimaxCodeLease.js` with a 4-byte big-endian uint32 length prefix, capped strictly at `AUTH_LEASE_MAX_FRAME_BYTES = 65536` (64 KB).
- **FR-013-23**: The system MUST connect over local IPC using Windows named pipes (`\\.\pipe\mcode-auth-lease-<16-hex-sha256>`) on win32 or Unix domain sockets (`<dataDir>/run/mcode-auth-lease-v1.sock`) on POSIX platforms, reading capability token from `<dataDir>/run/mcode-auth-lease-v1.cap`.
- **FR-013-24**: The system MUST validate `dataDir` resolving to an absolute, canonical path and reject relative paths, null bytes, and traversal attempts (`..`).
- **FR-013-25**: The system MUST protect MiniMax lease endpoints in `src/dashboardGuard.js:54,92` by including `/api/oauth/minimax-code/lease` and `/api/oauth/minimax-code-global/lease` in both `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS`.
- **FR-013-26**: Non-loopback requests to lease endpoints MUST be rejected with HTTP 403 Forbidden.
- **FR-013-27**: Leased access tokens MUST remain ephemeral in memory or Redis cache and MUST NEVER be written to SQLite disk persistence or plaintext logs.
- **FR-013-28**: When Redis is available, the system MUST cache the leased token in Redis under key `khatam:mcode:lease:<digest>` with TTL equal to remaining validity minus a 60-second safety margin, and MUST coordinate concurrent leases across cluster workers using a single-flight distributed lock (`khatam:lock:mcode:lease:<digest>`).
- **FR-013-29**: If Redis is unconfigured or unreachable, the lease manager MUST fail open to in-process memory caching without throwing or dropping requests.
- **FR-013-30**: MiniMax Code executor (`open-sse/executors/minimax-code.js:45`) and usage service (`open-sse/services/minimaxCodeUsage.js:208`) MUST transparently inject leased access tokens for connections having `authType === "mcode-lease"`.

### US5: DeepSeek PoW Hash Module & Boundary
- **FR-013-31**: The system MUST implement `open-sse/lib/deepseek-pow-hash.js` using an inlined pure-JS Keccak-f[1600] / SHA3-256 algorithm with round 0 skipped (`DeepSeekHashV1`).
- **FR-013-32**: The solver function `findDeepSeekPowNonce` MUST enforce input validation: `prefix` must be a string, `challenge` must match `/^[0-9a-fA-F]{64}$/`, and `difficulty` must be an integer between 1 and `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`.
- **FR-013-33**: Invalid inputs to `findDeepSeekPowNonce` MUST throw `TypeError` or `RangeError` with descriptive failure reasons.
- **FR-013-34**: The module MUST remain self-contained without imports to core routing until consumed by Spec 015.

### US6: Release Alignment, Docker & OpenCode Parity Proof
- **FR-013-35**: Package manifests `package.json:3` and `cli/package.json:3` MUST be bumped to version `0.5.112`.
- **FR-013-36**: `CHANGELOG.md` MUST incorporate upstream v0.5.112 release notes while preserving all KhatamRouter Wave 8 vertical scale and Bun runtime entries.
- **FR-013-37**: `docs/UPSTREAM-PORTS.md` MUST record the audit classification and justification for all 14 commits in the range `v0.5.111..v0.5.112`.
- **FR-013-38**: The system MUST verify that `Dockerfile` and `Dockerfile.bun` remain byte-identical and that OpenCode Free resolves and executes under Bun via `open-sse/services/opencodeTlsClient.js` without runtime package installations.

---

## 5. Success Criteria (SC)

- **SC-013-01**: All 14 upstream commits in the `v0.5.111..v0.5.112` window are catalogued with exact SHA, title, classification, and test coverage in the parity matrix.
- **SC-013-02**: Codex `gpt-6.1-terra` passes model discovery and capability tests with its 500,000 context window and responses-lite headers.
- **SC-013-03**: Qoder `smodel` and `cmodel` appear in provider model lists for both intl and CN variants and resolve static configuration fallbacks.
- **SC-013-04**: GitHub Copilot Claude 5.5 dotted model IDs (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) successfully translate to upstream with correct thinking parameters (`between_tools`, `adaptive`) and zero 400 errors.
- **SC-013-05**: Gemini protobuf translation passes unit tests verifying that no non-array schema contains `items` and no non-object schema contains `properties` or `required`.
- **SC-013-06**: Non-streaming chat handler propagates upstream SSE error status codes (400-599 or 502) without generating corrupted 200 OK completions.
- **SC-013-07**: Assistant turn `reasoning` properties sent to provider `nvidia` are normalized to `reasoning_content` with zero duplicate field collisions.
- **SC-013-08**: CodeBuddy CN and intl requests emit all 4 required plugin headers and advance combos on malformed requests without account cooldown.
- **SC-013-09**: Bulk-add key import correctly handles `LLM|id|secret` tokens, producing valid `LLM <n>` named connections.
- **SC-013-10**: Nace Drex provider registers in the System One lane and successfully completes mock decision requests with calibrated probabilities.
- **SC-013-11**: CommandCode requests match official CLI 1.88.0 headers and preserve session continuity via `x-session-id`.
- **SC-013-12**: MiniMax Code lease mode negotiates local IPC auth within 64KB frame limits, blocks remote access via `dashboardGuard.js`, and caches tokens in Redis across workers.
- **SC-013-13**: DeepSeek PoW hash solver accurately solves standard test vectors and rejects invalid inputs with strict type/range assertions.
- **SC-013-14**: Package manifests align to `0.5.112`, `Dockerfile` and `Dockerfile.bun` remain byte-identical, and branding guard passes with zero unauthorized display strings.
- **SC-013-15**: Full Vitest test suite executes under Bun with zero regressions against `known-fails.txt`.

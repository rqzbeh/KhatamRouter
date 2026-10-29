# Plan 013: Upstream v0.5.112 Port Architecture & Implementation Plan

## 1. Architecture & Execution Strategy

Spec 013 adopts a multi-package, test-first execution plan structured into four cohesive packages that mirror upstream dependency flows while enforcing KhatamRouter's runtime invariants:
- **Runtime**: Strictly Bun (no Node.js fallbacks, no `npm` invocations, no child-process package downloaders).
- **Persistence & State**: Native `bun:sqlite` with WAL journal mode; state synchronization across clustered worker processes powered by Redis.
- **Security-First**: Immediate loopback access control for IPC endpoints, parameter sanitization, and ephemeral credential isolation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             UPSTREAM v0.5.112 PORT                          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                               ▼
 ┌───────────┐                   ┌───────────┐                   ┌───────────┐
 │ PACKAGE 1 │                   │ PACKAGE 2 │                   │ PACKAGE 3 │
 │ Core      │                   │ Registry  │                   │ Auth &    │
 │ Routing & │                   │ & Models  │                   │ Desktop   │
 │ Protocols │                   │           │                   │ Lease     │
 └─────┬─────┘                   └─────┬─────┘                   └─────┬─────┘
       │                               │                               │
       └───────────────────────────────┼───────────────────────────────┘
                                       ▼
                                 ┌───────────┐
                                 │ PACKAGE 4 │
                                 │ Release & │
                                 │ Parity    │
                                 │ Closeout  │
                                 └───────────┘
```

---

## 2. Package Decomposition & Sequencing

### Package 1: Core Routing, Translation & Protocols
**Sequence**: 1 of 4 (Foundation)  
**Commits**: `e70ea24d`, `3fd925ab`, `ced0cf6e`, `8db1f4ae`, `56dbf466`, `d7bb71ce`  
**Focus**: Low-level protocol adapters, error bubbling, schema sanitization, and cryptographic primitives.

1. **Gemini Protobuf Type Constraints (`open-sse/translator/formats/gemini.js:304,374`)**:
   - `flattenTypeArrays`: prioritize structural types (`object`, `array`) when resolving multi-type schemas before scalar primitives (`string`, `number`, `boolean`).
   - `enforceTypeConstraints`: in Phase 6 of `cleanJSONSchemaForAntigravity`, recursively strip `items` from any schema where `type !== "array"`, and strip `properties` and `required` where `type !== "object"`. Prevents upstream Antigravity protobuf deserialization rejections.
2. **Non-Streaming SSE Error Rejection (`open-sse/handlers/chatCore/nonStreamingHandler.js:249`)**:
   - Inspect parsed SSE payloads for `parsed.error`.
   - If present, parse `parsed.error.status`, clamp integer values to range `400..599` (defaulting to 502), log `FAILED <status>`, and return `createErrorResult(status, message)`. Prevents partial or failed streams from masquerading as successful 200 OK completions.
3. **NVIDIA Reasoning Alias Normalization (`open-sse/translator/concerns/paramSupport.js:36,82`)**:
   - Add rule `{ provider: "nvidia", renameMessageFields: { reasoning: "reasoning_content" } }` to `STRIP_RULES`.
   - In assistant message sanitization loop, rename `msg.reasoning` to `msg.reasoning_content` if unset, then delete `msg.reasoning`. Prevents NVIDIA NIM duplicate-field HTTP 400 errors.
4. **CodeBuddy Gateway Channel Headers & Backoff (`open-sse/executors/default.js:50`, `codebuddy-cn.js:40`, `codebuddy-intl.js:40`)**:
   - Add `codebuddyHeaders` hook issuing `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, and `X-Conversation-Message-ID`.
   - Register hook in `codebuddy-cn` and `codebuddy-intl` auth options.
   - Update `tests/unit/codebuddy-intl-backoff.test.js` to assert `requestScoped: true` on unclassified 400 client rejections so combos advance without account cooldown.
5. **Bulk Key Import Opaque Token Handling (`src/shared/utils/bulkAdd.js:28`)**:
   - Retain full string for lines matching `/^LLM\|/i` (non-Cloudflare), assigning `baseName: "LLM"`. Prevents key truncation when importing Muse keys.
6. **DeepSeek PoW Noble-Hashes Port (`open-sse/lib/deepseek-pow-hash.js`)**:
   - Port upstream's pure-JS Keccak-f[1600] algorithm (round 0 skipped) to replace old 450-line file.
   - Restore critical input validation: challenge hex regex (`/^[0-9a-fA-F]{64}$/`), `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, integer type checks, and bounded loop iterations.

### Package 2: Provider Registry & Model Catalogs
**Sequence**: 2 of 4 (Registry & Catalogs)  
**Commits**: `acb3c080`, `f3e1f716`, `b1effa03`, `f7f6f5ed`  
**Focus**: Provider additions, model capabilities, pricing, and external API header contracts.

1. **Codex GPT-6.1 Terra (`open-sse/providers/registry/codex.js:57`)**:
   - Register model `{ id: "gpt-6.1-terra", name: "GPT 6.1 Terra", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS }`.
   - Add capability entry in `open-sse/providers/capabilities.js:301` with `contextWindow: 500000`, `maxOutput: 128000`, `thinkingFormat: "openai"`.
   - Add pricing in `open-sse/providers/pricing.js:93`.
2. **Qoder Frontier Reasoning Pair (`open-sse/providers/registry/qoder.js:46`, `qoder-cn.js:46`)**:
   - Add missing `smodel` (Sonus) and `cmodel` (Cantus) to `models` array in both intl and CN registries.
   - Ensure fallback to `open-sse/shared/qoder/constants.js:180` static model configuration when upstream catalog omits them.
3. **GitHub Copilot Claude 5.5 Thinking Rules (`open-sse/providers/capabilities.js:101,270`, `open-sse/translator/concerns/thinkingUnified.js:293,460`)**:
   - Extend dashed-id rules to dotted identifiers (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`).
   - Opus 5.5: `thinkingCanDisable: false`, `forcedToolChoice: false`.
   - Sonnet 5.5: `thinkingOffType: "between_tools"`, `forcedToolChoice: false`.
   - Haiku 5.5: override under `PROVIDER_CAPABILITIES.github` with `thinkingFormat: "claude-adaptive"`, `maxOutput: 128000`.
   - Preserve thinking `display` for always-on adaptive models targeting Claude.
4. **CommandCode CLI 1.88.0 Header Alignment (`open-sse/shared/commandCodeHeaders.js`, `commandcode.js:29`)**:
   - Create shared helper `buildCommandCodeHeaders` implementing official CLI headers.
   - Implement `slugifyPath` matching `@sindresorhus/slugify` defaults to derive `x-project-slug` from `process.cwd()`.
   - Synchronize conversation `threadId` with `x-session-id` via `toCommandCodeSessionUuid`.
5. **Nace Drex System One Provider (`open-sse/providers/registry/nace.js`, `public/providers/nace.png`)**:
   - Register provider `nace` with models `drex-max` and `drex-v2.0` in the System One decision lane.
   - Add icon asset `public/providers/nace.png`.
   - Run `bun run scripts/migrate-registry.mjs` to regenerate `open-sse/providers/registry/index.js`.
   - Update `tests/__baseline__/alias-baseline.json` and `tests/__baseline__/providers-baseline.json`.

### Package 3: Auth & Desktop Integration
**Sequence**: 3 of 4 (Desktop Lease & UI)  
**Commits**: `a199d777`, `85d73bd6`  
**Focus**: Local IPC protocol client, security boundaries, and multi-worker Redis token caching.

1. **MiniMax Desktop Named-Pipe/Socket IPC Client (`open-sse/services/minimaxCodeLease.js`)**:
   - Wire format: 4-byte big-endian uint32 payload length prefix followed by JSON payload, max 64 KB (`AUTH_LEASE_MAX_FRAME_BYTES`).
   - Transport: Windows named pipe `\\.\pipe\mcode-auth-lease-<16-hex-sha256>` or Unix domain socket `<dataDir>/run/mcode-auth-lease-v1.sock`.
   - Read capability token from `<dataDir>/run/mcode-auth-lease-v1.cap` (43-char base64url).
   - Implement methods: `requestStatus(dataDir)` (5s timeout) and `requestLease(dataDir, minValidityMs)` (10s timeout).
2. **Security Hardening & Loopback Isolation (`src/dashboardGuard.js:54,92`)**:
   - Validate `dataDir` resolution: reject non-absolute paths, check canonical paths, and prevent directory traversal or probing arbitrary unix sockets.
   - Add `/api/oauth/minimax-code/lease` and `/api/oauth/minimax-code-global/lease` to both `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS`.
   - Require loopback host/peer or valid CLI machine token; reject external access with HTTP 403 Forbidden.
   - Enforce ephemeral credential storage: leased tokens stay in memory/Redis and are NEVER stored in SQLite or logged.
3. **Redis Cluster Token Cache & Distributed Lock (`src/lib/redis/client.js`)**:
   - Cache leased access tokens in Redis under key `khatam:mcode:lease:<digest>` with TTL = `(expiresAtMs - now - 60000) / 1000`.
   - Coordinate concurrent worker lease requests with a single-flight distributed lock (`khatam:lock:mcode:lease:<digest>`, 5s lock TTL).
   - Fail open to in-process memory cache if Redis is unconfigured or unavailable.
4. **MiniMax Executor & Usage Integration (`open-sse/executors/minimax-code.js:45`, `minimaxCodeUsage.js:208`)**:
   - Inject leased access token into requests for connections with `authType === "mcode-lease"`.
   - Invalidate cache and re-lease on upstream 401 response.
   - Fetch usage metrics using leased token without requiring stored refresh tokens.
5. **Dashboard UI Components**:
   - Provide `MinimaxLeaseButton.js` triggering `/api/oauth/${providerId}/lease-connect`.
   - Update `ConnectionRow.js:140` to display "Desktop Lease" badge and `desktop_windows` icon.
   - Update `src/app/(dashboard)/dashboard/providers/[id]/page.js` to include lease connect button for `minimax-code` and `minimax-code-global`.

### Package 4: Release, Parity Proof & Closeout
**Sequence**: 4 of 4 (Release & Verification)  
**Commits**: `3b7acf72`, `1fe586bb`  
**Focus**: Manifest alignment, documentation, parity proof, and regression validation.

1. **Version Alignment**: Bump version to `0.5.112` in root `package.json:3` and `cli/package.json:3`.
2. **Documentation & Changelog**:
   - Update `CHANGELOG.md` merging upstream v0.5.112 notes with KhatamRouter Wave 8 vertical scale notes.
   - Update `docs/UPSTREAM-PORTS.md` recording all 14 commits with SHA, classification, and implementation details.
3. **OpenCode Free & Docker Parity Proof**:
   - Formally document and verify via unit tests that PR #78 (`7fbd38e0`, `open-sse/services/opencodeTlsClient.js`) provides full functional parity for OpenCode Free on Bun without `lazyRuntime.js` or Dockerfile package installations.
   - Verify that `Dockerfile` and `Dockerfile.bun` remain 100% byte-identical.
4. **Regression Verification**:
   - Execute full test suite (`cd tests && bun x vitest run`) ensuring zero regressions against `known-fails.txt`.
   - Run baseline verification scripts (`verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`).

---

## 3. Security Architecture & Threat Modeling

| Threat | Attack Vector | KhatamRouter Countermeasure |
|---|---|---|
| **Arbitrary Socket Probing** | Attacker specifies malicious `dataDir` (e.g. `/var/run/docker.sock`) | Strict validation: `resolveMcodeDataDir` canonicalizes paths, enforces directory existence checks, and verifies that the path points to a valid MiniMax directory containing `<dataDir>/run/mcode-auth-lease-v1.cap`. |
| **Remote Token Theft** | Remote attacker calls `/api/oauth/minimax-code/lease-connect` via network | Restricted to loopback via `dashboardGuard.js` `LOCAL_ONLY_PATHS` and `ALWAYS_PROTECTED`. Rejects non-loopback calls with 403 Forbidden. |
| **IPC Memory Exhaustion** | Malicious local process floods IPC socket with unbounded frames | `FrameDecoder` strictly enforces `AUTH_LEASE_MAX_FRAME_BYTES = 64KB` (65,536 bytes) per frame. Exceeding frames immediately trigger socket closure. |
| **Credential Persistence Leak** | Leased desktop token written to SQLite database or backup files | Leased tokens are kept exclusively in volatile process memory or Redis cache with short TTL. Never written to SQLite tables. Plaintext tokens stripped from logs. |
| **Unbounded PoW Computation** | Attacker supplies massive difficulty parameter coercing server into CPU lockup | `findDeepSeekPowNonce` strictly asserts `difficulty <= 250_000` (`MAX_DEEPSEEK_POW_DIFFICULTY`) and validates hex format, throwing `RangeError` on violation. |
| **Arbitrary Package Execution** | Upstream `lazyRuntime.js` spawning `npm install` at runtime | Upstream dynamic downloader is rejected. `wreq-js` is pre-packaged via `optionalDependencies` and loaded natively in Bun. |

---

## 4. Testing & Verification Matrix

```
┌─────────────────────────────────┬───────────────────────────────────────────┐
│ Feature Area                    │ Test File / Verification Target           │
├─────────────────────────────────┼───────────────────────────────────────────┤
│ Gemini Schema Predicates        │ tests/unit/gemini-schema-array-items-     │
│                                 │ predicate.test.js                         │
│ Non-Streaming SSE Errors        │ tests/unit/nonstream-sse-error.test.js    │
│ NVIDIA Reasoning Aliases        │ tests/unit/param-support.test.js          │
│ CodeBuddy Headers & Backoff     │ tests/unit/codebuddy-channel-headers.     │
│                                 │ test.js, codebuddy-intl-backoff.test.js   │
│ Bulk Add Opaque Tokens          │ tests/unit/bulk-add-names.test.js         │
│ DeepSeek PoW Noble Hashes       │ tests/unit/deepseek-pow-hash.test.js      │
│ Codex GPT-6.1 Terra             │ tests/unit/codex-gpt6-lite.test.js        │
│ Qoder Frontier Models           │ tests/unit/qoder-frontier-models.test.js  │
│ GitHub Copilot Claude 5.5       │ tests/unit/github-claude-5-5-thinking.    │
│                                 │ test.js                                   │
│ CommandCode Headers 1.88.0      │ tests/unit/commandcode-headers.test.js,   │
│                                 │ tests/unit/commandcode-usage.test.js      │
│ Nace Drex Provider              │ tests/unit/nace-systemone-provider.test.js│
│ MiniMax Desktop Lease Protocol  │ tests/unit/minimax-code-lease.test.js     │
│ OpenCode Free & Docker Parity   │ tests/unit/opencode-tls-client.test.js    │
│ Baseline Snapshots              │ tests/__baseline__/verify-*.mjs           │
└─────────────────────────────────┴───────────────────────────────────────────┘
```

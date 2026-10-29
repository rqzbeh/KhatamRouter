# Research 013: Upstream v0.5.112 Port Technical Deep Dive

## 1. Upstream Commit Analysis (v0.5.111..v0.5.112, 14 Commits)

### Commit 1: `e70ea24d` — "Fix OpenCode"
- **Upstream Intent**: Upstream dynamically invokes `npm install wreq-js@latest playwright-core@latest` into `~/.9router/runtime` via child processes in `open-sse/services/lazyRuntime.js`. Commit `e70ea24d` attempts to fix bundler-stubbed imports by calling `import(/* webpackIgnore: true */ "node:module")` to get `createRequire` and creating an anchoring `package.json`.
- **KhatamRouter Analysis**: KhatamRouter strictly prohibits dynamic runtime package downloads via npm as an architectural security invariant. In PR #78 (`7fbd38e0`, Spec 012), KhatamRouter already solved OpenCode Free under Bun natively: `wreq-js` is declared in `package.json` `optionalDependencies`, installed during build via `bun install --include=optional`, and loaded cleanly in `open-sse/services/opencodeTlsClient.js:16`.
- **Classification**: `ALREADY_PRESENT_SUPERIOR`.
- **Action Required**: Add explicit verification tasks in Spec 013 proving line-by-line behavioral parity against upstream without importing `lazyRuntime.js`.

### Commit 2: `acb3c080` — "feat(codex): add GPT-6.1 Terra"
- **Upstream Intent**: Adds OpenAI Codex internal model `gpt-6.1-terra` with `responsesLite: true` and `GPT_6_LITE_THINKING_LEVELS` (`open-sse/providers/registry/codex.js:57`, `open-sse/providers/capabilities.js:301`, `open-sse/providers/pricing.js:93`).
- **KhatamRouter Analysis**: Applies cleanly. In KhatamRouter, `open-sse/config/providerModels.js` dynamically indexes registry entries, so adding `gpt-6.1-terra` immediately makes it accessible to routing, capabilities discovery, and pricing tracking.
- **Classification**: `CLEAN_CHERRY_PICK`.

### Commit 3: `3fd925ab` — "fix(codebuddy): send plugin request/conversation id headers"
- **Upstream Intent**: The CodeBuddy gateway (CN + intl) rejects calls lacking official plugin headers with `400 / 11128 "request illegal"`. Upstream adds a `codebuddyHeaders` hook issuing `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, and `X-Conversation-Message-ID` (`open-sse/executors/default.js:50`), registers it in `codebuddy-cn` and `codebuddy-intl` registries, and updates backoff tests to mark unclassified 400 errors as `requestScoped: true`.
- **KhatamRouter Analysis**: Applies cleanly with adaptation. In KhatamRouter, the test file is named `tests/unit/codebuddy-intl-backoff.test.js` (not `codebuddy-block-backoff.test.js`). The `requestScoped: true` contract matches KhatamRouter's account fallback logic.
- **Classification**: `ADAPT`.

### Commit 4: `f3e1f716` — "fix(github): apply Claude 5.5 thinking rules to Copilot's dotted model ids"
- **Upstream Intent**: GitHub Copilot lists Claude 5.5 models with dotted IDs (`claude-opus-5.5`, `claude-sonnet-5.5`). Upstream updates `MODEL_CAPABILITIES` and `PROVIDER_CAPABILITIES.github` in `open-sse/providers/capabilities.js:101,270` and adjusts `applyFormat` in `open-sse/translator/concerns/thinkingUnified.js:293,460` to preserve thinking `display` for always-on adaptive models.
- **KhatamRouter Analysis**: Applies cleanly. Directly resolves 400 Bad Request errors when Claude Code sends auto-mode permission requests (non-streaming, thinking disabled) to GitHub Copilot models.
- **Classification**: `CLEAN_CHERRY_PICK`.

### Commit 5: `b1effa03` — "feat(commandcode): align request headers with official CLI 1.88.0"
- **Upstream Intent**: Replaces hardcoded version `0.25.7` with official CLI 1.88.0 identity headers via `open-sse/shared/commandCodeHeaders.js`. Synchronizes conversation `threadId` with `x-session-id`.
- **KhatamRouter Analysis**: Applies cleanly. We must ensure `slugifyPath` does not leak directory structure and test cases conform to KhatamRouter's branding guard (`tests/unit/display-branding-guard.test.js`).
- **Classification**: `ADAPT`.

### Commit 6: `a199d777` — "fix(providers): treat LLM|id|secret as opaque token in bulk-add, not name|key"
- **Upstream Intent**: Muse keys use the format `LLM|id|secret`. Splitting on the first pipe previously mangled the key into name `LLM` and a truncated secret. Lines starting with `LLM|` are now kept whole and auto-named `LLM 1, LLM 2, ...` (`src/shared/utils/bulkAdd.js:28`).
- **KhatamRouter Analysis**: Applies cleanly with zero merge friction.
- **Classification**: `CLEAN_CHERRY_PICK`.

### Commit 7: `ced0cf6e` — "fix(nvidia): normalize reasoning aliases for NIM"
- **Upstream Intent**: NVIDIA NIM rejects requests carrying both `reasoning` and `reasoning_content` with duplicate-field 400. Adds `{ provider: 'nvidia', renameMessageFields: { reasoning: 'reasoning_content' } }` to `STRIP_RULES` in `open-sse/translator/concerns/paramSupport.js:36,82`.
- **KhatamRouter Analysis**: Applies cleanly with zero merge friction.
- **Classification**: `ADAPT`.

### Commit 8: `f7f6f5ed` — "feat: add Nace Drex provider to the System One lane"
- **Upstream Intent**: Adds `nace` provider (`open-sse/providers/registry/nace.js`, `public/providers/nace.png`) serving decision models `drex-max` and `drex-v2.0` on the System One protocol.
- **KhatamRouter Analysis**: Must NOT hand-edit `open-sse/providers/registry/index.js`; regenerate using `scripts/migrate-registry.mjs`. Update baseline snapshots accordingly.
- **Classification**: `ADAPT`.

### Commit 9: `8db1f4ae` — "fix(translator): enforce Gemini protobuf type predicates on schema items and properties"
- **Upstream Intent**: Google Antigravity protobuf rejects schemas where non-arrays have `items` or non-objects have `properties`/`required`. Upstream introduces `enforceTypeConstraints` and enhances `flattenTypeArrays` in `open-sse/translator/formats/gemini.js:304,374`.
- **KhatamRouter Analysis**: Applies cleanly. Crucial for agentic workflows using structured JSON schemas against Gemini models.
- **Classification**: `ADAPT`.

### Commit 10: `56dbf466` — "fix(chat): reject SSE errors in non-streaming responses"
- **Upstream Intent**: Upstream SSE error frames inside non-streaming requests were swallowed into generic 502 or phantom 200 responses. Inspects `parsed.error`, extracts upstream status (clamped 400-599 or 502), and returns `createErrorResult` (`open-sse/handlers/chatCore/nonStreamingHandler.js:249`).
- **KhatamRouter Analysis**: Applies cleanly with zero merge friction.
- **Classification**: `CLEAN_CHERRY_PICK`.

### Commit 11: `3b7acf72` — "fix(docker): bundle lazy runtime deps so OpenCode Free resolves"
- **Upstream Intent**: Upstream Dockerfile ran `npm install wreq-js playwright-core` into `/opt/lazy-runtime` during Docker build to compensate for Next standalone tracing.
- **KhatamRouter Analysis**: Superseded by PR #78 (`7fbd38e0`). KhatamRouter installs `wreq-js` during standard build via `bun install --include=optional`, copies it directly into the runner stage, and tests it natively. Upstream's patch would reintroduce `npm` into Dockerfiles and break `Dockerfile` / `Dockerfile.bun` byte-identity.
- **Classification**: `ALREADY_PRESENT_SUPERIOR`.

### Commit 12: `d7bb71ce` — "fix(deepseek): use noble-hashes port for DeepSeek PoW hash"
- **Upstream Intent**: Rewrote `open-sse/lib/deepseek-pow-hash.js` using a 136-line pure JS Keccak/SHA3-256 implementation derived from `@noble/hashes`. However, upstream dropped input validation (difficulty ceiling, hex regex check).
- **KhatamRouter Analysis**: User decision: port `open-sse/lib/deepseek-pow-hash.js` WITH restored input validation (`MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, 64-character hex regex, integer assertions) and establish an explicit interface boundary for Spec 015 (Web-Cookie Providers).
- **Classification**: `ADAPT_WITH_HARDENING`.

### Commit 13: `85d73bd6` — "feat(minimax-code): lease auth mode via desktop app named-pipe broker"
- **Upstream Intent**: Allows connections to lease short-lived access tokens from the running MiniMax Code desktop app over local IPC (named pipes on Windows, Unix domain sockets on POSIX). Avoids invalidating single-use refresh tokens.
- **KhatamRouter Analysis**: Requires significant hardening: canonical dataDir validation, loopback-only route protection in `src/dashboardGuard.js:54,92`, and multi-worker Redis token caching with distributed single-flight locking.
- **Classification**: `ADAPT_WITH_HARDENING_AND_REDIS`.

### Commit 14: `1fe586bb` — "# v0.5.112 (2026-10-28)"
- **Upstream Intent**: Release closeout commit bumping `package.json` and `cli/package.json` to `0.5.112` and documenting changes in `CHANGELOG.md`.
- **KhatamRouter Analysis**: Bump versions, merge upstream release notes while preserving KhatamRouter vertical scale and Bun runtime entries, and update `docs/UPSTREAM-PORTS.md`.
- **Classification**: `ADAPT`.

---

## 2. Deep Dive: MiniMax Code Desktop Broker IPC Protocol

### 2.1 Wire Protocol & Transport
- **Length-Prefixed Framing**: Every frame begins with a 4-byte big-endian `uint32` indicating the byte length of the UTF-8 JSON payload.
  $$\text{Total Frame Bytes} = 4 + \text{Payload Length}$$
- **Frame Ceiling**: Capped strictly at $64\text{ KB} = 65,536\text{ bytes}$ (`AUTH_LEASE_MAX_FRAME_BYTES`). Any incoming frame header declaring $> 65,536$ bytes immediately triggers `PROTOCOL_MISMATCH` and socket destruction.
- **Local Transports**:
  - Windows: Named pipe `\\.\pipe\mcode-auth-lease-<16-hex-sha256-of-normalized-dataDir>`.
  - POSIX: Unix domain socket at `<dataDir>/run/mcode-auth-lease-v1.sock`.
- **Capability Handshake**: Before communicating over the pipe, the client reads the 43-character base64url capability token stored in `<dataDir>/run/mcode-auth-lease-v1.cap`. Every request frame must include this capability string.

### 2.2 Redis Cross-Worker Caching & Single-Flight Coordination
In a multi-process deployment (e.g. KhatamRouter with $N$ worker processes), if multiple workers concurrently request leased tokens, the local desktop IPC socket could become a bottleneck or race.
We design a Redis-backed multi-worker coordination layer:
1. **Cache Lookup**: Worker checks Redis key `khatam:mcode:lease:<digest>`. If valid (`expiresAtMs - now > 60000`), returns token immediately.
2. **Distributed Lock**: If cache miss, worker attempts to acquire `SET khatam:lock:mcode:lease:<digest> <workerId> NX PX 5000`.
   - **Lock Winner**: Interacts with local IPC pipe, writes resulting token to Redis with TTL = `Math.max(1, Math.floor((expiresAtMs - now - 60000) / 1000))`, deletes lock, and returns token.
   - **Lock Contenders**: Poll Redis cache for up to 3 seconds until the winner populates the cache.
3. **Fail-Open**: If Redis is unconfigured or fails, the module gracefully falls back to the in-process `createTokenManager` Map.

---

## 3. Deep Dive: DeepSeek PoW Noble-Hashes Port & Validation

### 3.1 Algorithm
- DeepSeek uses `DeepSeekHashV1`: a variant of NIST FIPS 202 SHA3-256 (Keccak-f[1600]) where the first permutation round (round 0) is skipped, executing only rounds 1 through 23.
- Upstream replaced the clean-room reference implementation (450 lines) with an inlined 136-line pure-JS implementation derived from `@noble/hashes`.

### 3.2 Vulnerability in Upstream & KhatamRouter Hardening
- **Upstream Defect**: In the rewrite, upstream removed:
  1. `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000` ceiling check.
  2. Hex regex check on the challenge string.
  3. Safe integer type assertions.
- **Security Consequence**: A malicious or malformed upstream challenge could supply a difficulty of $10^9$ or a non-hex string, forcing the event loop into an unbounded, non-yielding synchronous computation and causing a complete denial of service (DoS).
- **Hardening Applied**:
  - Enforce `/^[0-9a-fA-F]{64}$/` pattern check on challenge.
  - Enforce `Number.isSafeInteger(difficulty) && difficulty >= 1 && difficulty <= 250_000`.
  - Throw `TypeError` or `RangeError` immediately upon invalid input.

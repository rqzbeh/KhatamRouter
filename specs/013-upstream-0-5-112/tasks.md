# Tasks 013: Upstream v0.5.112 Port Implementation Tasks

## Execution Rules & Discipline
1. **Strict Ordering**: Tasks must be implemented in the exact dependency sequence listed below.
2. **Test-First Discipline**: Every functional implementation task is preceded by a dedicated unit test task defining non-skip test assertions.
3. **Disjoint File Ownership**: Every task strictly owns a disjoint set of files. No two tasks may modify or claim the same path.
4. **Stub-Proof Oracles**: Verification commands must check for test existence, assert that `expect(` count meets or exceeds required bounds, verify that no `.skip`, `.todo`, or `xit` tokens are present, and run the test under Bun.

---

## Task Inventory

| Task ID | Phase | User Story | Task Summary | Gate | Owns (Disjoint Paths) |
|---|---|---|---|---|---|
| **T001** | Phase 1 | Setup | Preflight environment check and regression baseline capture | G1 | `specs/013-upstream-0-5-112/results/preflight.txt` |
| **T002** | Phase 2 | US2 | Unit tests for Gemini protobuf schema predicates | G2 | `tests/unit/gemini-schema-array-items-predicate.test.js` |
| **T003** | Phase 2 | US2 | Implement Gemini schema array items & property constraints | G2 | `open-sse/translator/formats/gemini.js` |
| **T004** | Phase 2 | US2 | Unit tests for non-streaming chat SSE error propagation | G2 | `tests/unit/nonstream-sse-error.test.js` |
| **T005** | Phase 2 | US2 | Reject upstream SSE errors in non-streaming responses | G2 | `open-sse/handlers/chatCore/nonStreamingHandler.js` |
| **T006** | Phase 2 | US2 | Unit tests for NVIDIA reasoning alias normalization | G2 | `tests/unit/param-support.test.js` |
| **T007** | Phase 2 | US2 | Normalize NVIDIA reasoning aliases to reasoning_content | G2 | `open-sse/translator/concerns/paramSupport.js` |
| **T008** | Phase 2 | US2 | Unit tests for CodeBuddy channel verification headers & backoff | G2 | `tests/unit/codebuddy-channel-headers.test.js` |
| **T009** | Phase 2 | US2 | Implement CodeBuddy channel headers hook and register in auth | G2 | `open-sse/executors/default.js`, `open-sse/providers/registry/codebuddy-cn.js`, `open-sse/providers/registry/codebuddy-intl.js` |
| **T010** | Phase 2 | US2 | Unit tests for bulk connection import of opaque LLM tokens | G2 | `tests/unit/bulk-add-names.test.js` |
| **T011** | Phase 2 | US2 | Preserve opaque LLM\|id\|secret tokens in bulk import | G2 | `src/shared/utils/bulkAdd.js` |
| **T012** | Phase 3 | US5 | Unit tests for DeepSeek PoW solver & input validation bounds | G3 | `tests/unit/deepseek-pow-hash.test.js` |
| **T013** | Phase 3 | US5 | Implement pure-JS Keccak DeepSeek PoW solver with validation | G3 | `open-sse/lib/deepseek-pow-hash.js` |
| **T014** | Phase 4 | US1 | Unit tests for Codex GPT-6.1 Terra & Qoder frontier models | G4 | `tests/unit/codex-gpt6-lite.test.js`, `tests/unit/qoder-frontier-models.test.js` |
| **T015** | Phase 4 | US1 | Add Codex Terra & Qoder Sonus/Cantus to registries & pricing | G4 | `open-sse/providers/registry/codex.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/providers/registry/qoder.js`, `open-sse/providers/registry/qoder-cn.js` |
| **T016** | Phase 4 | US1 | Unit tests for GitHub Copilot Claude 5.5 dotted IDs thinking | G4 | `tests/unit/github-claude-5-5-thinking.test.js` |
| **T017** | Phase 4 | US1 | Implement Claude 5.5 thinking rules & display preservation | G4 | `open-sse/translator/concerns/thinkingUnified.js` |
| **T018** | Phase 4 | US3 | Unit tests for CommandCode CLI 1.88.0 headers & session sync | G5 | `tests/unit/commandcode-headers.test.js`, `tests/unit/commandcode-usage.test.js` |
| **T019** | Phase 4 | US3 | Implement CommandCode shared headers, slugify & session UUID | G5 | `open-sse/shared/commandCodeHeaders.js`, `open-sse/executors/commandcode.js`, `open-sse/providers/registry/commandcode.js`, `open-sse/services/usage/commandcode.js`, `open-sse/translator/request/openai-to-commandcode.js`, `src/app/api/providers/validate/route.js` |
| **T020** | Phase 4 | US3 | Unit tests for Nace Drex System One provider | G5 | `tests/unit/nace-systemone-provider.test.js` |
| **T021** | Phase 4 | US3 | Register Nace provider, add icon asset, and regenerate index | G5 | `open-sse/providers/registry/nace.js`, `public/providers/nace.png`, `open-sse/providers/registry/index.js`, `tests/__baseline__/alias-baseline.json`, `tests/__baseline__/providers-baseline.json` |
| **T022** | Phase 5 | US4 | Unit tests for MiniMax desktop named-pipe lease broker IPC | G6 | `tests/unit/minimax-code-lease.test.js` |
| **T023** | Phase 5 | US4 | Implement MiniMax desktop broker client & Redis cache/lock | G6 | `open-sse/services/minimaxCodeLease.js` |
| **T024** | Phase 5 | US4 | Wire MiniMax executor and usage to transparently inject lease | G6 | `open-sse/executors/minimax-code.js`, `open-sse/services/minimaxCodeUsage.js` |
| **T025** | Phase 5 | US4 | Harden dashboardGuard loopback check & lease OAuth routes | G6 | `src/dashboardGuard.js`, `src/app/api/oauth/[provider]/[action]/route.js` |
| **T026** | Phase 5 | US4 | Dashboard UI lease connect button & connection badge | G6 | `src/app/(dashboard)/dashboard/providers/components/MinimaxLeaseButton.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/page.js` |
| **T027** | Phase 6 | US6 | OpenCode Free TLS client parity proof & Dockerfile check | G7 | `tests/unit/opencode-tls-client.test.js`, `specs/013-upstream-0-5-112/results/dockerfile-identity.txt` |
| **T028** | Phase 6 | US6 | Bump version 0.5.112, update CHANGELOG and UPSTREAM-PORTS | G8 | `package.json`, `cli/package.json`, `CHANGELOG.md`, `docs/UPSTREAM-PORTS.md` |

---

## Detailed Task Specifications

### Phase 1: Setup & Preflight Baseline

#### T001: Preflight Environment Check & Baseline Snapshot
- **User Story**: Setup
- **Depends on**: None
- **Owns**: `specs/013-upstream-0-5-112/results/preflight.txt`
- **Description**: Verify Bun version (>= 1.4.3), verify git status is clean on worktree branch `spec/013-upstream-0-5-112`, ensure baseline tests pass, and capture preflight summary.
- **Gate**: `G1`
- **Oracle / Test Command**:
  ```bash
  mkdir -p specs/013-upstream-0-5-112/results && bun -v > specs/013-upstream-0-5-112/results/preflight.txt && test -s specs/013-upstream-0-5-112/results/preflight.txt && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-oauth-urls.mjs && echo T001_PASS
  ```

---

### Phase 2: Package 1 — Core Routing, Protocols & Error Handling

#### T002: Unit Tests for Gemini Protobuf Schema Predicates
- **User Story**: US2
- **Depends on**: T001
- **Owns**: `tests/unit/gemini-schema-array-items-predicate.test.js`
- **Description**: Port and expand upstream test suite verifying that non-array schemas have `items` stripped, non-object schemas have `properties`/`required` stripped, and multi-type arrays prioritize structural types.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/gemini-schema-array-items-predicate.test.js && [ $(grep -c 'expect(' tests/unit/gemini-schema-array-items-predicate.test.js) -ge 6 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/gemini-schema-array-items-predicate.test.js && cd tests && bun x vitest run unit/gemini-schema-array-items-predicate.test.js && echo T002_PASS
  ```

#### T003: Implement Gemini Schema Array Items & Property Constraints
- **User Story**: US2
- **Depends on**: T002
- **Owns**: `open-sse/translator/formats/gemini.js`
- **Description**: Implement `enforceTypeConstraints` and update `flattenTypeArrays` in `open-sse/translator/formats/gemini.js:304,374` to strictly enforce Gemini Schema protobuf predicates.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  grep -q "enforceTypeConstraints" open-sse/translator/formats/gemini.js && grep -q "cleanJSONSchemaForAntigravity" open-sse/translator/formats/gemini.js && cd tests && bun x vitest run unit/gemini-schema-array-items-predicate.test.js && echo T003_PASS
  ```

#### T004: Unit Tests for Non-Streaming Chat SSE Error Propagation
- **User Story**: US2
- **Depends on**: T001
- **Owns**: `tests/unit/nonstream-sse-error.test.js`
- **Description**: Test that upstream SSE `error` frames in non-streaming responses are parsed, mapped to proper HTTP status codes (400-599 or 502), and logged without calling `onRequestSuccess` or persisting usage.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/nonstream-sse-error.test.js && [ $(grep -c 'expect(' tests/unit/nonstream-sse-error.test.js) -ge 12 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/nonstream-sse-error.test.js && cd tests && bun x vitest run unit/nonstream-sse-error.test.js && echo T004_PASS
  ```

#### T005: Reject Upstream SSE Errors in Non-Streaming Responses
- **User Story**: US2
- **Depends on**: T004
- **Owns**: `open-sse/handlers/chatCore/nonStreamingHandler.js`
- **Description**: Update `handleNonStreamingResponse` in `open-sse/handlers/chatCore/nonStreamingHandler.js:249` to detect `parsed.error`, clamp the HTTP status code, log `FAILED <status>`, and return `createErrorResult`.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  grep -q "parsed.error" open-sse/handlers/chatCore/nonStreamingHandler.js && grep -q "upstreamStatus >= 400" open-sse/handlers/chatCore/nonStreamingHandler.js && cd tests && bun x vitest run unit/nonstream-sse-error.test.js && echo T005_PASS
  ```

#### T006: Unit Tests for NVIDIA Reasoning Alias Normalization
- **User Story**: US2
- **Depends on**: T001
- **Owns**: `tests/unit/param-support.test.js`
- **Description**: Test that assistant turn messages sent to provider `nvidia` normalize `reasoning` to `reasoning_content` to prevent duplicate-field rejection by NIM.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/param-support.test.js && [ $(grep -c 'expect(' tests/unit/param-support.test.js) -ge 8 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/param-support.test.js && cd tests && bun x vitest run unit/param-support.test.js && echo T006_PASS
  ```

#### T007: Normalize NVIDIA Reasoning Aliases to reasoning_content
- **User Story**: US2
- **Depends on**: T006
- **Owns**: `open-sse/translator/concerns/paramSupport.js`
- **Description**: Add rule `{ provider: "nvidia", renameMessageFields: { reasoning: "reasoning_content" } }` to `STRIP_RULES` in `open-sse/translator/concerns/paramSupport.js:36,82` and implement the renaming loop over assistant messages.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  grep -q 'provider: "nvidia"' open-sse/translator/concerns/paramSupport.js && grep -q "renameMessageFields" open-sse/translator/concerns/paramSupport.js && cd tests && bun x vitest run unit/param-support.test.js && echo T007_PASS
  ```

#### T008: Unit Tests for CodeBuddy Channel Verification Headers & Backoff
- **User Story**: US2
- **Depends on**: T001
- **Owns**: `tests/unit/codebuddy-channel-headers.test.js`
- **Description**: Verify that `codebuddy-cn` and `codebuddy-intl` issue `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, and `X-Conversation-Message-ID`, and verify that `tests/unit/codebuddy-intl-backoff.test.js` marks client 400 errors as `requestScoped: true`.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/codebuddy-channel-headers.test.js && [ $(grep -c 'expect(' tests/unit/codebuddy-channel-headers.test.js) -ge 8 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/codebuddy-channel-headers.test.js && cd tests && bun x vitest run unit/codebuddy-channel-headers.test.js unit/codebuddy-intl-backoff.test.js && echo T008_PASS
  ```

#### T009: Implement CodeBuddy Channel Headers Hook and Register in Auth
- **User Story**: US2
- **Depends on**: T008
- **Owns**: `open-sse/executors/default.js`, `open-sse/providers/registry/codebuddy-cn.js`, `open-sse/providers/registry/codebuddy-intl.js`
- **Description**: Add `codebuddyHeaders` hook to `HEADER_HOOKS` in `open-sse/executors/default.js:50` and add `hooks: ["codebuddyHeaders"]` to `codebuddy-cn.js:40` and `codebuddy-intl.js:40`.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  grep -q "codebuddyHeaders" open-sse/executors/default.js && grep -q "codebuddyHeaders" open-sse/providers/registry/codebuddy-cn.js && grep -q "codebuddyHeaders" open-sse/providers/registry/codebuddy-intl.js && cd tests && bun x vitest run unit/codebuddy-channel-headers.test.js && echo T009_PASS
  ```

#### T010: Unit Tests for Bulk Connection Import of Opaque LLM Tokens
- **User Story**: US2
- **Depends on**: T001
- **Owns**: `tests/unit/bulk-add-names.test.js`
- **Description**: Test that lines starting with `LLM|` (case-insensitive, non-Cloudflare) preserve the full string as the API key and auto-generate `LLM 1, LLM 2, ...` connection names.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/bulk-add-names.test.js && [ $(grep -c 'expect(' tests/unit/bulk-add-names.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/bulk-add-names.test.js && cd tests && bun x vitest run unit/bulk-add-names.test.js && echo T010_PASS
  ```

#### T011: Preserve Opaque LLM|id|secret Tokens in Bulk Import
- **User Story**: US2
- **Depends on**: T010
- **Owns**: `src/shared/utils/bulkAdd.js`
- **Description**: Update `parseLine` in `src/shared/utils/bulkAdd.js:28` to detect `/^LLM\|/i` lines and return `{ baseName: "LLM", apiKey: line.trim() }`.
- **Gate**: `G2`
- **Oracle / Test Command**:
  ```bash
  grep -q "LLM\|" src/shared/utils/bulkAdd.js && cd tests && bun x vitest run unit/bulk-add-names.test.js && echo T011_PASS
  ```

---

### Phase 3: Package 1 (Crypto) — DeepSeek PoW Solver & Boundary

#### T012: Unit Tests for DeepSeek PoW Solver & Input Validation Bounds
- **User Story**: US5
- **Depends on**: T001
- **Owns**: `tests/unit/deepseek-pow-hash.test.js`
- **Description**: Test pure-JS `findDeepSeekPowNonce` against standard test vectors, difficulty bounds ($1 \le d \le 250,000$), hex regex format enforcement, and invalid input rejection (`TypeError`, `RangeError`).
- **Gate**: `G3`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/deepseek-pow-hash.test.js && [ $(grep -c 'expect(' tests/unit/deepseek-pow-hash.test.js) -ge 8 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/deepseek-pow-hash.test.js && cd tests && bun x vitest run unit/deepseek-pow-hash.test.js && echo T012_PASS
  ```

#### T013: Implement Pure-JS Keccak DeepSeek PoW Solver with Validation
- **User Story**: US5
- **Depends on**: T012
- **Owns**: `open-sse/lib/deepseek-pow-hash.js`
- **Description**: Port inlined noble-hashes Keccak-f[1600] implementation to `open-sse/lib/deepseek-pow-hash.js`, restoring `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, 64-character hex regex, and safe integer type validation.
- **Gate**: `G3`
- **Oracle / Test Command**:
  ```bash
  grep -q "MAX_DEEPSEEK_POW_DIFFICULTY" open-sse/lib/deepseek-pow-hash.js && grep -q "findDeepSeekPowNonce" open-sse/lib/deepseek-pow-hash.js && cd tests && bun x vitest run unit/deepseek-pow-hash.test.js && echo T013_PASS
  ```

---

### Phase 4: Package 2 — Model Catalogs & Provider Registry

#### T014: Unit Tests for Codex GPT-6.1 Terra & Qoder Frontier Models
- **User Story**: US1
- **Depends on**: T001
- **Owns**: `tests/unit/codex-gpt6-lite.test.js`, `tests/unit/qoder-frontier-models.test.js`
- **Description**: Test Codex `gpt-6.1-terra` capabilities (500k context, responses-lite headers) and pricing, and test that Qoder `smodel` and `cmodel` appear in both `qoder` and `qoder-cn` registries with static fallback config.
- **Gate**: `G4`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/codex-gpt6-lite.test.js && test -s tests/unit/qoder-frontier-models.test.js && [ $(grep -c 'expect(' tests/unit/codex-gpt6-lite.test.js) -ge 6 ] && [ $(grep -c 'expect(' tests/unit/qoder-frontier-models.test.js) -ge 4 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/codex-gpt6-lite.test.js tests/unit/qoder-frontier-models.test.js && cd tests && bun x vitest run unit/codex-gpt6-lite.test.js unit/qoder-frontier-models.test.js && echo T014_PASS
  ```

#### T015: Add Codex Terra & Qoder Sonus/Cantus to Registries & Pricing
- **User Story**: US1
- **Depends on**: T014
- **Owns**: `open-sse/providers/registry/codex.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/providers/registry/qoder.js`, `open-sse/providers/registry/qoder-cn.js`
- **Description**: Register `gpt-6.1-terra` in `codex.js:57`, add capabilities (500k context) in `capabilities.js:301`, add pricing in `pricing.js:93`, and add `smodel` and `cmodel` to `qoder.js:46` and `qoder-cn.js:46`.
- **Gate**: `G4`
- **Oracle / Test Command**:
  ```bash
  grep -q "gpt-6.1-terra" open-sse/providers/registry/codex.js && grep -q "smodel" open-sse/providers/registry/qoder.js && grep -q "cmodel" open-sse/providers/registry/qoder-cn.js && cd tests && bun x vitest run unit/codex-gpt6-lite.test.js unit/qoder-frontier-models.test.js && echo T015_PASS
  ```

#### T016: Unit Tests for GitHub Copilot Claude 5.5 Dotted IDs Thinking
- **User Story**: US1
- **Depends on**: T001
- **Owns**: `tests/unit/github-claude-5-5-thinking.test.js`
- **Description**: Port and execute tests verifying that Copilot's dotted Claude 5.5 models (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) follow adaptive thinking rules and preserve requested thinking display.
- **Gate**: `G4`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/github-claude-5-5-thinking.test.js && [ $(grep -c 'expect(' tests/unit/github-claude-5-5-thinking.test.js) -ge 12 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/github-claude-5-5-thinking.test.js && cd tests && bun x vitest run unit/github-claude-5-5-thinking.test.js && echo T016_PASS
  ```

#### T017: Implement Claude 5.5 Thinking Rules & Display Preservation
- **User Story**: US1
- **Depends on**: T016
- **Owns**: `open-sse/translator/concerns/thinkingUnified.js`
- **Description**: Update `applyFormat` in `open-sse/translator/concerns/thinkingUnified.js:293,460` to accept model parameter, enforce adaptive rules for dotted Claude 5.5 IDs, and retain requested display.
- **Gate**: `G4`
- **Oracle / Test Command**:
  ```bash
  grep -q "claude-adaptive" open-sse/translator/concerns/thinkingUnified.js && cd tests && bun x vitest run unit/github-claude-5-5-thinking.test.js && echo T017_PASS
  ```

#### T018: Unit Tests for CommandCode CLI 1.88.0 Headers & Session Sync
- **User Story**: US3
- **Depends on**: T001
- **Owns**: `tests/unit/commandcode-headers.test.js`, `tests/unit/commandcode-usage.test.js`
- **Description**: Verify that CommandCode requests emit official CLI 1.88.0 headers, slugify paths correctly, synchronize `threadId` and `x-session-id`, and assert usage query headers.
- **Gate**: `G5`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/commandcode-headers.test.js && test -s tests/unit/commandcode-usage.test.js && [ $(grep -c 'expect(' tests/unit/commandcode-headers.test.js) -ge 10 ] && [ $(grep -c 'expect(' tests/unit/commandcode-usage.test.js) -ge 6 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/commandcode-headers.test.js tests/unit/commandcode-usage.test.js && cd tests && bun x vitest run unit/commandcode-headers.test.js unit/commandcode-usage.test.js && echo T018_PASS
  ```

#### T019: Implement CommandCode Shared Headers, Slugify & Session UUID
- **User Story**: US3
- **Depends on**: T018
- **Owns**: `open-sse/shared/commandCodeHeaders.js`, `open-sse/executors/commandcode.js`, `open-sse/providers/registry/commandcode.js`, `open-sse/services/usage/commandcode.js`, `open-sse/translator/request/openai-to-commandcode.js`, `src/app/api/providers/validate/route.js`
- **Description**: Create `open-sse/shared/commandCodeHeaders.js` and wire it into CommandCode executor, registry, usage service, translator, and provider validation route.
- **Gate**: `G5`
- **Oracle / Test Command**:
  ```bash
  test -s open-sse/shared/commandCodeHeaders.js && grep -q "1.88.0" open-sse/shared/commandCodeHeaders.js && cd tests && bun x vitest run unit/commandcode-headers.test.js unit/commandcode-usage.test.js && echo T019_PASS
  ```

#### T020: Unit Tests for Nace Drex System One Provider
- **User Story**: US3
- **Depends on**: T001
- **Owns**: `tests/unit/nace-systemone-provider.test.js`
- **Description**: Verify Nace Drex provider registration in the System One lane, model catalog (`drex-max`, `drex-v2.0`), URL resolution, and System One mock decision handling.
- **Gate**: `G5`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/nace-systemone-provider.test.js && [ $(grep -c 'expect(' tests/unit/nace-systemone-provider.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/nace-systemone-provider.test.js && cd tests && bun x vitest run unit/nace-systemone-provider.test.js && echo T020_PASS
  ```

#### T021: Register Nace Provider, Add Icon Asset, and Regenerate Index
- **User Story**: US3
- **Depends on**: T020
- **Owns**: `open-sse/providers/registry/nace.js`, `public/providers/nace.png`, `open-sse/providers/registry/index.js`, `tests/__baseline__/alias-baseline.json`, `tests/__baseline__/providers-baseline.json`
- **Description**: Add `open-sse/providers/registry/nace.js` and `public/providers/nace.png`, run `bun run scripts/migrate-registry.mjs` to regenerate `index.js`, and update baseline snapshots.
- **Gate**: `G5`
- **Oracle / Test Command**:
  ```bash
  test -s open-sse/providers/registry/nace.js && test -s public/providers/nace.png && grep -q 'import.*from "./nace.js"' open-sse/providers/registry/index.js && cd tests && bun x vitest run unit/nace-systemone-provider.test.js && node __baseline__/verify-alias.mjs && node __baseline__/verify-providers.mjs && echo T021_PASS
  ```

---

### Phase 5: Package 3 — MiniMax Desktop App Broker Lease Mode

#### T022: Unit Tests for MiniMax Desktop Named-Pipe Lease Broker IPC
- **User Story**: US4
- **Depends on**: T001
- **Owns**: `tests/unit/minimax-code-lease.test.js`
- **Description**: Test wire protocol frame codec (4-byte length prefix, 64KB cap, chunk fragmentation), endpoint resolution on win32/POSIX, capability verification, and in-memory/Redis token caching.
- **Gate**: `G6`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/minimax-code-lease.test.js && [ $(grep -c 'expect(' tests/unit/minimax-code-lease.test.js) -ge 12 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/minimax-code-lease.test.js && cd tests && bun x vitest run unit/minimax-code-lease.test.js && echo T022_PASS
  ```

#### T023: Implement MiniMax Desktop Broker Client & Redis Cache/Lock
- **User Story**: US4
- **Depends on**: T022
- **Owns**: `open-sse/services/minimaxCodeLease.js`
- **Description**: Implement `open-sse/services/minimaxCodeLease.js` supporting Bun `node:net` IPC over Windows named pipes and Unix domain sockets, bounded 64KB framing, capability handshake, canonical dataDir validation, and multi-worker Redis token cache + lock.
- **Gate**: `G6`
- **Oracle / Test Command**:
  ```bash
  grep -q "AUTH_LEASE_MAX_FRAME_BYTES = 64 \* 1024" open-sse/services/minimaxCodeLease.js && grep -q "resolveLeaseEndpoint" open-sse/services/minimaxCodeLease.js && cd tests && bun x vitest run unit/minimax-code-lease.test.js && echo T023_PASS
  ```

#### T024: Wire MiniMax Executor and Usage to Transparently Inject Lease
- **User Story**: US4
- **Depends on**: T023
- **Owns**: `open-sse/executors/minimax-code.js`, `open-sse/services/minimaxCodeUsage.js`
- **Description**: In `open-sse/executors/minimax-code.js:45`, inject leased access tokens for `mcode-lease` connections and handle 401 cache invalidation. In `minimaxCodeUsage.js:208`, borrow leased tokens to query account usage.
- **Gate**: `G6`
- **Oracle / Test Command**:
  ```bash
  grep -q "isLeaseConnection" open-sse/executors/minimax-code.js && grep -q "getLeaseToken" open-sse/services/minimaxCodeUsage.js && cd tests && bun x vitest run unit/minimax-code-lease.test.js && echo T024_PASS
  ```

#### T025: Harden dashboardGuard Loopback Check & Lease OAuth Routes
- **User Story**: US4
- **Depends on**: T023
- **Owns**: `src/dashboardGuard.js`, `src/app/api/oauth/[provider]/[action]/route.js`
- **Description**: Add `/api/oauth/minimax-code/lease` and `/api/oauth/minimax-code-global/lease` to `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS` in `src/dashboardGuard.js:54,92`. Add `lease-status` (GET) and `lease-connect` (POST) actions to `route.js`.
- **Gate**: `G6`
- **Oracle / Test Command**:
  ```bash
  grep -q "minimax-code/lease" src/dashboardGuard.js && grep -q "lease-connect" src/app/api/oauth/\[provider\]/\[action\]/route.js && echo T025_PASS
  ```

#### T026: Dashboard UI Lease Connect Button & Connection Badge
- **User Story**: US4
- **Depends on**: T025
- **Owns**: `src/app/(dashboard)/dashboard/providers/components/MinimaxLeaseButton.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- **Description**: Implement `MinimaxLeaseButton.js` in plain JavaScript (no TypeScript), add "Desktop Lease" badge to `ConnectionRow.js:140`, and wire the button into `page.js`.
- **Gate**: `G6`
- **Oracle / Test Command**:
  ```bash
  test -s src/app/\(dashboard\)/dashboard/providers/components/MinimaxLeaseButton.js && grep -q "Desktop Lease" src/app/\(dashboard\)/dashboard/providers/\[id\]/ConnectionRow.js && grep -q "MinimaxLeaseButton" src/app/\(dashboard\)/dashboard/providers/\[id\]/page.js && echo T026_PASS
  ```

---

### Phase 6: Package 4 — OpenCode Parity Proof, Release Alignment & Closeout

#### T027: OpenCode Free TLS Client Parity Proof & Dockerfile Check
- **User Story**: US6
- **Depends on**: T001
- **Owns**: `tests/unit/opencode-tls-client.test.js`, `specs/013-upstream-0-5-112/results/dockerfile-identity.txt`
- **Description**: Verify that `open-sse/services/opencodeTlsClient.js` passes all parity tests under Bun without `lazyRuntime.js`, and verify that `Dockerfile` and `Dockerfile.bun` remain 100% byte-identical.
- **Gate**: `G7`
- **Oracle / Test Command**:
  ```bash
  test -s tests/unit/opencode-tls-client.test.js && [ $(grep -c 'expect(' tests/unit/opencode-tls-client.test.js) -ge 6 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/opencode-tls-client.test.js && cd tests && bun x vitest run unit/opencode-tls-client.test.js && cd .. && cmp Dockerfile Dockerfile.bun > specs/013-upstream-0-5-112/results/dockerfile-identity.txt && echo "DOCKERFILES_IDENTICAL" >> specs/013-upstream-0-5-112/results/dockerfile-identity.txt && echo T027_PASS
  ```

#### T028: Bump Version 0.5.112, Update CHANGELOG and UPSTREAM-PORTS
- **User Story**: US6
- **Depends on**: T003, T005, T007, T009, T011, T013, T015, T017, T019, T021, T024, T026, T027
- **Owns**: `package.json`, `cli/package.json`, `CHANGELOG.md`, `docs/UPSTREAM-PORTS.md`
- **Description**: Align version numbers to `0.5.112` across `package.json:3` and `cli/package.json:3`. Update `CHANGELOG.md` with upstream v0.5.112 release notes (preserving Wave 8 vertical scale notes). Document all 14 commits in `docs/UPSTREAM-PORTS.md`.
- **Gate**: `G8`
- **Oracle / Test Command**:
  ```bash
  grep -q '"version": "0.5.112"' package.json && grep -q '"version": "0.5.112"' cli/package.json && grep -q "0.5.112" CHANGELOG.md && grep -q "85d73bd6" docs/UPSTREAM-PORTS.md && cd tests && bun x vitest run unit/display-branding-guard.test.js && echo T028_PASS
  ```

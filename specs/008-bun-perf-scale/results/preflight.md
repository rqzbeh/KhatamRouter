# Wave 8 Preflight Baseline Report (008-bun-perf-scale)

**Environment**: Linux WSL2 (`Linux 6.18.54.1-microsoft-standard-WSL2 x86_64`)  
**Worktree**: `/home/redsnow/KhatamRouter/.claude/worktrees/wave8-perf`  
**Branch**: `feat/wave8-bun-perf-scale` (base: `57d60fbd`)  
**Date**: 2026-10-26  

---

## 1. Runtime & Dependency Verification

- **Bun Runtime**: `bun -v 1.4.3` (verified: Bun 1.4.3 `c6da4a4d3`, native `bun:sqlite`).
- **Root Dependencies**:
  ```bash
  bun install
  ```
  Result: 595 packages installed in 4.45s.
- **Tests Dependencies**:
  ```bash
  cd tests && bun install
  ```
  Result: 46 packages installed in 3.15s, Vitest 4.1.12.

---

## 2. Full Vitest Test Suite Execution

The full Vitest test suite was executed in `tests/` using Bun with an isolated temporary data directory (`DATA_DIR_ALLOW_TEMP=1`, `DATA_DIR=$(mktemp -d /tmp/9r-test-data-XXXXXX)`):

```bash
cd tests && bun x vitest run
```

### Aggregate Results
| Metric | Total | Passed | Failed |
|---|---|---|---|
| **Test Files / Suites** | 1,472 | 1,403 | 69 |
| **Individual Tests** | 4,901 | 4,788 | 88 |
| **Pass Rate** | 97.7% | — | — |

---

## 3. Comparison with Baseline (`tests/__baseline__/known-fails.txt`)

`tests/__baseline__/known-fails.txt` lists 87 catalogued historical test failures.

- **Matched Known Failures**: 86 / 87
- **Known Failures Now Passing (1 test)**:
  - `tests/translator/thinking-unified.test.js :: applyThinking per provider format GLM-5.2 also gets reasoning_effort (supported from 5.2 onward)`
- **New Red Tests (2 tests)**:
  - `tests/unit/strict-proxy-enforcement.test.js :: strictProxy refuses a direct connection (#4333) throws when a pool is assigned but no proxy url resolved`
    - Failure mode: `Error: Test timed out in 5000ms` attempting network connection to `api.example.com`.
  - `tests/unit/strict-proxy-enforcement.test.js :: strictProxy refuses a direct connection (#4333) throws when the pool is enabled but carries an empty url`
    - Failure mode: `Error: Test timed out in 5000ms` attempting network connection to `api.example.com`.

---

## 4. Expected-Red Status per CLAUDE.md

| CLAUDE.md Item | Expected Behavior | Measured Status in Preflight |
|---|---|---|
| `tests/__baseline__/known-fails.txt` | Catalogued pre-Wave-7.5 failures | 86 failed as expected; 1 passing (`thinking-unified.test.js`) |
| `unit/embeddings.cloud.test.js` | Missing `cloud/` worker directory | Excluded by `tests/vitest.config.js` (`exclude: ["**/embeddings.cloud.test.js"]`) |
| `unit/xai-oauth-service.test.js` | Times out (5s) if discovery unreachable | **Passed** (all 5 tests passed; discovery endpoint reachable/mocked) |
| `real/*.real.test.js` & `translator/real/*.real.test.js` | Live provider credentials required | Excluded by `tests/vitest.config.js` (`exclude: ["**/real/**", "**/*.real.test.js"]`) |

---

## 5. Full Inventory of All 88 Failed Tests

### `tests/translator/bugs-claudeCode-context.test.js` (1 failed)
- `[KNOWN]` `Claude Code CLI context → OpenAI tool_result image block is preserved`

### `tests/translator/bugs-gemini-cursor-commandcode.test.js` (1 failed)
- `[KNOWN]` `OpenAI → CommandCode image content is preserved as native CommandCode image blocks`

### `tests/translator/bugs-openai-bridge.test.js` (1 failed)
- `[KNOWN]` `bug: Claude → OpenAI bridge data loss tool_result with image block is not turned into raw JSON / dropped`

### `tests/translator/bugs-toClaude-context.test.js` (1 failed)
- `[KNOWN]` `OpenAI → Claude context mapping assistant reasoning_content becomes a thinking block`

### `tests/translator/claude-kiro-direct.test.js` (9 failed)
- `[KNOWN]` `Claude → Kiro (direct route) injects thinking_mode tag when model implies thinking`
- `[KNOWN]` `Claude → Kiro (direct route) does not send additionalModelRequestFields for Kiro models without effort support`
- `[KNOWN]` `Claude → Kiro (direct route) normalizes an unsupported Kiro intensity suffix while preserving agentic behavior`
- `[KNOWN]` `Claude → Kiro (direct route) maps output_config.effort high to Kiro CLI-style additionalModelRequestFields for effort models`
- `[KNOWN]` `Claude → Kiro (direct route) keeps the legacy thinking fallback for unsupported GPT-5.6 effort auto`
- `[KNOWN]` `Claude → Kiro (direct route) keeps the legacy thinking fallback for unsupported GPT-5.6 effort minimal`
- `[KNOWN]` `Claude → Kiro (direct route) keeps the legacy thinking fallback for unsupported GPT-5.6 effort ultra`
- `[KNOWN]` `Claude → Kiro (direct route) sends Claude system as top-level systemPrompt and keeps a user-content fallback`
- `[KNOWN]` `Claude → Kiro (direct route) keeps top-level systemPrompt stable across turns`

### `tests/unit/claude-header-forwarding.test.js` (1 failed)
- `[KNOWN]` `proxyAwareFetch — api.anthropic.com routing routes api.anthropic.com to gotScraping (non-streaming) and returns ok response`

### `tests/unit/cline-free-tier-models.test.js` (1 failed)
- `[KNOWN]` `cline-free namespace pricing still bills the paid twin at its published rate`

### `tests/unit/codex-image-fetch.test.js` (2 failed)
- `[KNOWN]` `CodexExecutor image handling fetches 1MB remote image and inlines it as base64 data URI`
- `[KNOWN]` `CodexExecutor image handling execute() prefetches images before sending to upstream`

### `tests/unit/codex-refresh-token.test.js` (1 failed)
- `[KNOWN]` `Codex Refresh Token getRefreshLeadMs (early refresh config) should return provider-specific lead time for OAuth providers`

### `tests/unit/combo-autoswitch.test.js` (2 failed)
- `[KNOWN]` `detectRequiredCapabilities web_search tool -> search`
- `[KNOWN]` `reorderByCapabilities keeps order when no model matches`

### `tests/unit/combo-caps-resolver.test.js` (1 failed)
- `[KNOWN]` `aggregateComboCapabilities: resolveCaps override falls back to the pattern default without a resolver`

### `tests/unit/commandcode-to-openai.test.js` (1 failed)
- `[KNOWN]` `commandcode-to-openai — error event stringifies object errors so client sees readable message`

### `tests/unit/cursor-models.test.js` (1 failed)
- `[KNOWN]` `Cursor live model catalog fetches the account-specific catalog and caches it`

### `tests/unit/db-concurrent.test.js` (3 failed)
- `[KNOWN]` `DB Concurrency — atomic safety 100 parallel saveRequestUsage → no count loss`
- `[KNOWN]` `DB Concurrency — atomic safety daily summary aggregates correctly under parallel writes`
- `[KNOWN]` `DB Concurrency — atomic safety mixed concurrent: usage + details + connections + aliases`

### `tests/unit/executor-const-guard.test.js` (1 failed)
- `[KNOWN]` `antigravity retry (intentional change: 429=6, 503=3) 429 attempts = 6`

### `tests/unit/force-stream-config.test.js` (2 failed)
- `[KNOWN]` `forceStream provider config keeps forced-stream providers streaming for JSON clients when body.stream is undefined`
- `[KNOWN]` `forceStream provider config keeps forced-stream providers streaming for JSON clients when body.stream is false`

### `tests/unit/glm-oauth.test.js` (1 failed)
- `[KNOWN]` `glm registry entry (dual-auth) keeps the direct api.z.ai anthropic transport (no separate gateway)`

### `tests/unit/image-fetch-hardening.test.js` (1 failed)
- `[KNOWN]` `fetchImageAsBase64 hardening accepts valid PNG from public host`

### `tests/unit/kiro-external-idp.test.js` (1 failed)
- `[KNOWN]` `Kiro external_idp (CLIProxyAPI) import and refresh adds CodeWhisperer external IdP headers and endpoint ordering`

### `tests/unit/kiro-terminal-integrity.test.js` (2 failed)
- `[KNOWN]` `Kiro terminal integrity recovery surfaces retry HTTP failures as SSE after heartbeat commits headers`
- `[KNOWN]` `Kiro terminal integrity recovery bounds the retry HTTP error body`

### `tests/unit/mimo-free.live.test.js` (1 failed)
- `[KNOWN]` `MiMo Free anti-abuse gate (live) chat WITH Chrome User-Agent → 200`

### `tests/unit/oauth-cursor-auto-import.test.js` (8 failed)
- `[KNOWN]` `GET /api/oauth/cursor/auto-import returns not-found when no macOS cursor db paths are accessible`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import returns descriptive error if macOS db file exists but cannot be opened`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import extracts tokens using exact keys`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import unwraps JSON-encoded string values`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import falls back to fuzzy key matching on macOS when exact keys are missing`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import returns login-prompt error when tokens are missing even after fallback`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import linux uses single hardcoded path and original error message`
- `[KNOWN]` `GET /api/oauth/cursor/auto-import unsupported platform returns 400`

### `tests/unit/openai-to-claude.test.js` (1 failed)
- `[KNOWN]` `openaiToClaudeResponse omits empty Read pages tool argument before emitting Claude input deltas`

### `tests/unit/openai-to-commandcode.test.js` (2 failed)
- `[KNOWN]` `openaiToCommandCodeRequest — native image blocks maps OpenAI image_url data URI to CommandCode {type:image,image,mimeType}`
- `[KNOWN]` `openaiToCommandCodeRequest — native image blocks maps Claude/OpenAI base64 image source to a data-URI image block`

### `tests/unit/openai-to-kiro.test.js` (19 failed)
- `[KNOWN]` `openaiToKiroRequest thinking budget maps reasoning_effort low to max_thinking_length 1024`
- `[KNOWN]` `openaiToKiroRequest thinking budget maps reasoning_effort high to max_thinking_length 24576`
- `[KNOWN]` `openaiToKiroRequest thinking budget keeps the legacy thinking fallback for unsupported GPT-5.6 effort auto`
- `[KNOWN]` `openaiToKiroRequest thinking budget keeps the legacy thinking fallback for unsupported GPT-5.6 effort minimal`
- `[KNOWN]` `openaiToKiroRequest thinking budget keeps the legacy thinking fallback for unsupported GPT-5.6 effort ultra`
- `[KNOWN]` `openaiToKiroRequest thinking budget keeps the thinking-alias fallback when GPT effort is blank`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send additionalModelRequestFields for legacy Kiro model ids`
- `[KNOWN]` `openaiToKiroRequest thinking budget normalizes unsupported Kiro intensity suffix for claude-sonnet-4.5-thinking-agentic(high)`
- `[KNOWN]` `openaiToKiroRequest thinking budget normalizes unsupported Kiro intensity suffix for glm-5-thinking-agentic(medium)`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send additionalModelRequestFields for date-suffixed Claude 4 model ids`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send additionalModelRequestFields for pre-4 legacy Kiro model ids`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send additionalModelRequestFields for prefixed pre-4 legacy Kiro model ids`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send Claude-specific additionalModelRequestFields for prefixed non-Claude aliases`
- `[KNOWN]` `openaiToKiroRequest thinking budget does not send Claude-specific additionalModelRequestFields for non-Claude aliases`
- `[KNOWN]` `openaiToKiroRequest thinking budget clamps reasoning_effort max to Kiro max_thinking_length 32000`
- `[KNOWN]` `openaiToKiroRequest thinking budget clamps OpenAI Responses reasoning.effort xhigh to max_thinking_length 32000`
- `[KNOWN]` `openaiToKiroRequest thinking budget uses Claude thinking.budget_tokens as max_thinking_length`
- `[KNOWN]` `openaiToKiroRequest thinking budget uses the default budget for synthetic -thinking models with no explicit config`
- `[KNOWN]` `openaiToKiroRequest thinking budget keeps top-level systemPrompt stable across turns`

### `tests/unit/request-details-tab.test.js` (2 failed)
- `[KNOWN]` `request details — tab crash-risk cases oversized field → stored truncated + reparseable (no circular)`
- `[KNOWN]` `getDistinctProviders — providers route (no full-row parse) returns unique provider list without parsing data blobs`

### `tests/unit/security-audit.test.js` (13 failed)
- `[KNOWN]` `AUDIT-002: API key masking source should contain maskApiKey function`
- `[KNOWN]` `AUDIT-002: API key masking getUsageHistory should use apiKeyMasked instead of apiKey`
- `[KNOWN]` `AUDIT-002: API key masking getUsageStats should use apiKeyMasked in byApiKey entries`
- `[KNOWN]` `AUDIT-002: API key masking byApiKey object keys should use masked key, not raw key`
- `[KNOWN]` `AUDIT-003: Proxy URL validation source should contain validateProxyUrl function`
- `[KNOWN]` `AUDIT-018: XSS escaping in OAuth callback source should contain escapeHtml function`
- `[KNOWN]` `AUDIT-018: XSS escaping in OAuth callback should escape ampersand, angle brackets, and quotes`
- `[KNOWN]` `AUDIT-018: XSS escaping in OAuth callback should use safeMessage in rendered HTML, not raw message`
- `[KNOWN]` `AUDIT-004: Atomic lock file for MITM startup manager.js should define LOCK_FILE constant`
- `[KNOWN]` `AUDIT-004: Atomic lock file for MITM startup should use O_EXCL flag (wx) for atomic creation`
- `[KNOWN]` `AUDIT-004: Atomic lock file for MITM startup should clean up lock file on all exit paths`
- `[KNOWN]` `AUDIT-001: Synchronous restart guard mitmIsRestarting should be set before first await expression`
- `[KNOWN]` `AUDIT-001: Synchronous restart guard mitmIsRestarting should be set before first await expression`

### `tests/unit/strict-proxy-enforcement.test.js` (3 failed)
- `[NEW]` `strictProxy refuses a direct connection (#4333) throws when a pool is assigned but no proxy url resolved`
- `[NEW]` `strictProxy refuses a direct connection (#4333) throws when the pool is enabled but carries an empty url`
- `[KNOWN]` `strictProxy refuses a direct connection (#4333) does not block a caller that sets strictProxy with no proxy configured`

### `tests/unit/translator-helpers-edge.test.js` (1 failed)
- `[KNOWN]` `normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1) hoists mid-conversation system messages into top-level system`

### `tests/unit/translator-request-normalization.test.js` (4 failed)
- `[KNOWN]` `request normalization claudeToOpenAIRequest flattens text-only content arrays into string`
- `[KNOWN]` `request normalization filterToOpenAIFormat flattens text-only arrays to string`
- `[KNOWN]` `request normalization translateRequest keeps /v1/messages Claude->OpenAI text payloads string-safe`
- `[KNOWN]` `request normalization parseSSELine supports provider raw NDJSON stream lines`

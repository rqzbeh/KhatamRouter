# Feature Specification: Wave 7 — VansRouter Provider Parity

**Feature Branch**: `wave7-vansrouter-parity`
**Created**: 2026-10-22
**Status**: Draft
**Input**: User description: "WAVE 7: VansRouter provider parity. Port ONLY providers absent from KhatamRouter - report added vs skipped explicitly. Regenerate registry index with the existing script; never hand-edit it. Port freeTiers into the existing config pattern. Port Ponytail lite/full/ultra onto the EXISTING rtk implementation, default unchanged. Port loopGuard behind loopGuardEnabled, default unchanged. Stateless executor contract test: no state leaks across two sequential buildHeaders calls. tests/unit/wave7-parity.test.js incl. loopGuard negative control (varied calls must not flag)."

---

## User Scenarios & Testing

### User Story 1 - Provider Registry Parity (Priority: P1)

Users routing LLM requests require full upstream provider coverage available in VansRouter. KhatamRouter must achieve parity by porting all 30 providers absent from its registry, including both standard OpenAI-compatible providers and executor-backed providers. The static registry index must be regenerated automatically via script rather than hand-edited, preserving all existing provider definitions and adding new ones cleanly.

**Why this priority**: Core routing gateway value depends on supporting upstreams accurately with proper baseUrl, model catalogs, and auth contracts.

**Independent Test**: Load `REGISTRY`, `PROVIDERS`, and `PROVIDER_MODELS` and verify that all 30 new providers (e.g. `a6api`, `agentrouter`, `qwen`, `zcode`, `freebuff`, `zenmux`, `deepinfra`, `volcengine`) are registered, resolvable via alias, and carry proper transport settings.

**Acceptance Scenarios**:
1. **Given** 30 providers from VansRouter absent in KhatamRouter, **When** inspected, **Then** all 30 are ported into `open-sse/providers/registry/{id}.js` without omitting any or clobbering existing providers.
2. **Given** the regenerated registry index, **When** imported, **Then** every provider entry resolves with valid `id`, `transport`, and `models`.
3. **Given** existing provider `muse`, **When** `muse-spark-web` is registered, **Then** `muse` alias resolution remains mapped to official `muse` and does not collide.

---

### User Story 2 - Specialized Provider Executors & Stateless Contract (Priority: P1)

Specialized upstreams (`agentrouter`, `qwen`, `zcode`, `freebuff`, `muse-spark-web`) require custom request transformations, auth formatting, and error recovery beyond standard OpenAI-compatible defaults. Crucially, executors must be strictly stateless across requests: invoking `buildHeaders` sequentially with different credentials must never bleed headers or tokens across callers.

**Why this priority**: Leaking API keys or tokens between sequential requests across tenants or accounts is a critical security vulnerability.

**Independent Test**: Create an executor instance, call `buildHeaders` with credential A, then immediately with credential B. Assert that the second call's result contains none of credential A's secrets or identifiers.

**Acceptance Scenarios**:
1. **Given** `AgentRouterExecutor`, **When** `buildHeaders` is called, **Then** it generates Claude CLI spoof headers with unique session ID and `x-api-key`.
2. **Given** `QwenExecutor`, **When** `buildHeaders` is called, **Then** it generates Qwen Stainless and DashScope headers with Bearer token.
3. **Given** `ZcodeExecutor`, **When** `buildHeaders` is called, **Then** it generates ZCode Electron client headers with Bearer token.
4. **Given** `FreebuffExecutor`, **When** `buildHeaders` is called, **Then** it produces standard headers and never retains per-request run IDs across invocations.
5. **Given** `MuseSparkWebExecutor`, **When** `buildHeaders` is called, **Then** it produces Meta GraphQL headers with ecto cookie.
6. **Given** any executor, **When** two sequential calls are made with different API keys, **Then** no state or header value leaks between the calls.

---

### User Story 3 - Free-Tier Catalog Derivation (Priority: P2)

Users and dashboard interfaces need to know which providers and models offer free tiers or trial credits, along with their refresh cadence (`daily`, `weekly`, `monthly`, `rolling`, `one-time`). KhatamRouter must derive this catalog dynamically from registry metadata via `listFreeTiers()`.

**Why this priority**: Gives users discovery of zero-cost models without manual maintenance of parallel catalog files.

**Independent Test**: Call `listFreeTiers()` and verify that providers with `hasFree: true`, `category: "free"`, or `category: "freeTier"`, plus individual models flagged `hasFree: true`, are returned in deterministic cadence order.

**Acceptance Scenarios**:
1. **Given** providers with `category: "free"` or `category: "freeTier"`, **When** `listFreeTiers()` is called, **Then** a provider-level row (`modelId: null`) is generated for each.
2. **Given** individual models with `hasFree: true`, **When** `listFreeTiers()` is called, **Then** model-level rows are included with their respective refresh cadence.
3. **Given** the output rows, **When** sorted, **Then** ordering is deterministic by cadence (`daily` -> `weekly` -> `monthly` -> `rolling` -> `one-time`), then provider name, then model ID.

---

### User Story 4 - Ponytail Multi-Intensity Token Saver (Priority: P2)

The Ponytail token saver biases code generation toward minimal diffs and standard libraries. It must support three intensity levels (`lite`, `full`, `ultra`) with strict boundaries (security, validation, and explicit requirements are never simplified away) and 2026 skepticism rules, mounted cleanly onto the existing RTK prompt injection pipeline with default setting unchanged.

**Why this priority**: Reduces output token cost for coding tasks while maintaining developer-controlled intensity.

**Independent Test**: Test prompt generation for `lite`, `full`, and `ultra` levels and verify prompt injection into request bodies across OpenAI, Claude, and Gemini formats.

**Acceptance Scenarios**:
1. **Given** Ponytail prompts for `lite`, `full`, `ultra`, **When** inspected, **Then** each level includes the decision ladder, minimal code rules, and safety boundaries.
2. **Given** `ponytailEnabled: true` and `ponytailLevel: "ultra"`, **When** a request is processed in `handleChatCore`, **Then** the ultra prompt is injected into the system message.
3. **Given** default settings, **When** a request is processed, **Then** `ponytailEnabled` defaults to `false` and existing behavior is preserved.

---

### User Story 5 - Stateless LoopGuard Anti-Loop Detection (Priority: P2)

Autonomous agents frequently get stuck in repetitive tool-calling cycles or repetitive reasoning text loops. LoopGuard inspects recent conversation history in the request body to detect repeated tool calls (single repeat >= 3x, sequence repeat >= 2x) and text repetitions (message repeat >= 3x, sentence repeat >= 3x). When triggered, it appends a stop-and-summarize hint `[ROUTER NOTE: ...]` to break the loop. Crucially, diverse/varied calls must not trigger false positives (negative control).

**Why this priority**: Prevents runaway billing and context exhaustion from infinite agent loops.

**Independent Test**:
1. Positive control: Feed 3 identical tool calls -> verify loop detected.
2. Negative control: Feed 3 diverse tool calls with distinct arguments -> verify loop NOT detected.
3. Text loop: Feed 3 identical assistant planning messages -> verify loop detected.

**Acceptance Scenarios**:
1. **Given** a request with identical tool calls repeated 3 times, **When** `detectLoop()` runs, **Then** it returns `{ detected: true, hint: ... }`.
2. **Given** a request with diverse tool calls (different functions or parameters), **When** `detectLoop()` runs, **Then** it returns `{ detected: false, hint: null }`.
3. **Given** `loopGuardEnabled: false` (default), **When** a request with repetitive history is routed, **Then** no hint is injected and body remains unchanged.
4. **Given** `loopGuardEnabled: true`, **When** a loop is detected, **Then** `applyLoopGuard` appends the hint idempotently to the target message.

# Feature Specification: Wave 6 — Live Model Discovery and Capability Resolution

**Feature Branch**: `feat/wave6-model-discovery`
**Created**: 2026-10-22
**Status**: Draft
**Input**: User description: "WAVE 6: live model discovery and capability resolution. Defensive normalisation of upstream /v1/models payloads (never throws), precedence cascade as a pure function, auto:discovery context reconciler that never clobbers a manual pin, request capability derivation with fail-closed compatibility failures, and combo selection wiring so an image request never routes to a non-vision target."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Defensive Upstream Model Discovery Normalisation (Priority: P1)

Upstream AI gateways and endpoints expose `/v1/models` in wildly diverging shapes: standard OpenAI lists, OpenRouter architecture/modality descriptors (`text+image->text`, nested `top_provider`), Lemonade Server `labels[]` arrays, CLIProxyAPI `supported_reasoning_levels`, and Ollama native `models[].details`. Live discovery must defensively parse all incoming payloads, extract modalities (vision, audio, video, tools, reasoning) and token limits (`contextWindow`, `maxOutputTokens`), and guarantee that malformed or incomplete records never throw or crash the sync loop.

**Why this priority**: Discovered models are untrusted network payloads. A single unexpected field, null entry, or malformed shape must never terminate catalog sync.

**Independent Test**: Pass standard OpenAI, OpenRouter, Lemonade, Ollama, and adversarial malformed payloads (`null`, `{}`, `{ data: [null, "invalid", { id: "" }] }`) to `normalizeDiscoveredModels()` and verify clean, standardized records are returned without throwing.

**Acceptance Scenarios**:

1. **Given** standard OpenAI payload (`{ object: "list", data: [{ id: "gpt-4o", created: 1715368132 }] }`), **When** normalized, **Then** model is recognized with canonical id, name, and default streaming capabilities.
2. **Given** OpenRouter payload with `architecture: { modality: "text+image->text", input_modalities: ["text", "image"] }`, `context_length: 200000`, and `top_provider: { max_completion_tokens: 8192 }`, **When** normalized, **Then** `supportsVision` is `true`, `contextWindow` is `200000`, and `maxOutputTokens` is `8192`.
3. **Given** Lemonade Server payload with `labels: ["chat", "vision", "reasoning", "tool-calling"]` and `context_window: 131072`, **When** normalized, **Then** `supportsVision`, `supportsTools`, and `supportsReasoning` are `true` and `contextWindow` is `131072`.
4. **Given** Ollama payload with `{ models: [{ name: "llama3:latest", details: { family: "llama" }, capabilities: ["tools", "vision"] }] }`, **When** normalized, **Then** model id is "llama3:latest" and `supportsVision` and `supportsTools` are `true`.
5. **Given** malformed or garbage inputs (`null`, `undefined`, numeric primitives, arrays with non-object items), **When** normalized, **Then** an empty array is returned and no exception is thrown.

---

### User Story 2 - Deterministic Capability Precedence Cascade as a Pure Function (Priority: P1)

Model capabilities and context limits must resolve through an explicit, ordered precedence cascade that can run deterministically without implicit ambient dependencies or side effects. The resolution order is:
1. Manual operator overrides (`model_context_overrides` / `model_capability_overrides` with `source: "manual"`)
2. Auto-discovery overrides (`source: "auto:discovery"`)
3. Provider-specific static registry overrides (`PROVIDER_CAPABILITIES[provider][model]`)
4. Synced catalog / models.dev background deltas
5. Exact canonical model definitions (`MODEL_CAPABILITIES[model]`)
6. Glob pattern matches (`PATTERN_CAPABILITIES`)
7. Safe fallback floor (`DEFAULT_CAPABILITIES`)

When computing the baseline catalog view for reconciler comparisons, an option flag (`persistedOverrides: false`) must bypass layers 1 and 2 so an existing override never feeds back into itself.

**Why this priority**: A pure function resolution engine enables fast unit testing, eliminates cache-invalidation bugs, and cleanly separates catalog baseline truth from operator pins.

**Independent Test**: Call `resolveModelCapabilities({ provider, model }, sources, options)` across different combinations of sources and assert that higher layers win over lower layers, and that `persistedOverrides: false` returns the pure catalog view.

**Acceptance Scenarios**:

1. **Given** a model with both a manual override (`contextWindow: 500000`) and an auto-discovery override (`contextWindow: 200000`), **When** resolved, **Then** the manual override wins.
2. **Given** an auto-discovery override (`supportsVision: true`), **When** resolved against a provider table where vision is false, **Then** the auto-discovery override wins.
3. **Given** `persistedOverrides: false`, **When** resolved for a model with an active manual or auto override, **Then** the override is bypassed and the static catalog/registry value is returned.
4. **Given** no matching overrides or catalog entries, **When** resolved, **Then** matching pattern capabilities or `DEFAULT_CAPABILITIES` floor values are returned.

---

### User Story 3 - Self-Correcting Context Reconciler with Manual Pin Protection (Priority: P1)

When upstream `/v1/models` discovery reports a real usable context window that diverges from the static catalog (e.g. vLLM deployment with 256k context where catalog says 128k), the reconciler pins the discovered limit into `model_context_overrides` as an `auto:discovery` source. It must NEVER overwrite or clobber an operator's `manual` pin. When the static catalog subsequently updates to match the discovered value, the redundant `auto:discovery` pin is automatically pruned to prevent database clutter.

**Why this priority**: Reconciles divergence automatically while strictly protecting operator intentionality and preventing DB bloat.

**Independent Test**: Run `reconcileContextWindows()` with discovered models against mock dependencies covering manual pins, catalog divergences, and catalog parity.

**Acceptance Scenarios**:

1. **Given** a discovered model with `contextWindow: 256000` while catalog reports `128000`, **When** reconciled, **Then** `writeAutoOverride` is called with `256000` and `written` count increments.
2. **Given** an existing override with `source: "manual"` and `contextWindow: 1000000`, **When** reconciled with a discovered window of `200000`, **Then** the manual override is untouched and `skippedManual` increments.
3. **Given** an existing override with `source: "auto:discovery"` where discovered window matches the catalog window, **When** reconciled, **Then** `removeOverride` is called and `removed` count increments.
4. **Given** a discovered model with an invalid or non-positive window, **When** reconciled, **Then** any stale `auto:discovery` override is pruned without touching manual pins.

---

### User Story 4 - Request Capability Derivation and Compatibility Evaluation (Priority: P1)

Incoming inference requests must be analyzed to determine their required modalities and resource requirements:
- Vision: image blocks, `image_url`, base64 data URIs, inline data in OpenAI, Anthropic, Gemini, and Antigravity formats.
- Tools: tool/function declarations or tool use history.
- Reasoning: explicit reasoning effort or thinking parameters.
- Tokens: estimated prompt tokens + requested completion tokens (`max_tokens`, `max_completion_tokens`).

Evaluating a target against these requirements must detect compatibility failures (`"vision"`, `"tools"`, `"output_tokens"`, `"context_window"`).

**Why this priority**: Provides the mathematical basis for router pre-dispatch decisions before any upstream network call is made.

**Independent Test**: Pass requests with text-only, multimodal images, and tools to `deriveRequestRequirements(body)` and evaluate candidate models with `evaluateTargetCompatibility()`.

**Acceptance Scenarios**:

1. **Given** an OpenAI request with an `image_url` part, **When** derived, **Then** `requiresVision` is `true`.
2. **Given** a Gemini request with `inlineData: { mimeType: "image/png" }`, **When** derived, **Then** `requiresVision` is `true`.
3. **Given** a request requiring vision evaluated against a text-only model (`supportsVision: false`), **When** evaluated, **Then** `compatible` is `false` and `failures` contains `"vision"`.
4. **Given** a request requesting `max_tokens: 16000` evaluated against a model with `maxOutputTokens: 8192`, **When** evaluated, **Then** `failures` contains `"output_tokens"`.

---

### User Story 5 - Fail-Closed Combo Selection for Image Requests (Priority: P1)

In model combos, requests requiring hard capabilities—specifically image inputs (vision)—must NEVER route to a non-vision model. If a combo contains a mix of vision and non-vision models, non-vision models must be pruned from the candidate and fallback sequence. If NO models in the combo confirm vision support (`supportsVision === true`), the combo execution must fail closed immediately: return an HTTP 400/503 error without attempting dispatches to text-only models that would result in corrupted responses (e.g. "image not provided" or upstream 400 rejections).

**Why this priority**: Prevents silent corruption of user vision requests and stops wasting quota/rate-limits on targets known to be incompatible.

**Independent Test**: Call `handleComboChat` with a combo containing `["deepseek/deepseek-chat", "openai/gpt-3.5-turbo"]` and an image request; assert that it fails closed with an error response and makes zero calls to `handleSingleModel`.

**Acceptance Scenarios**:

1. **Given** a combo with all text-only models and an image request, **When** `handleComboChat` is invoked, **Then** it fails closed with status 400/503 and `handleSingleModel` is never called.
2. **Given** a combo with `[text-only, vision-capable]` and an image request, **When** `handleComboChat` is invoked, **Then** only the vision-capable model is attempted.
3. **Given** a text-only request sent to any combo, **When** `handleComboChat` is invoked, **Then** all models in the combo remain available in normal rotation/fallback order.

---

## Functional Requirements (FRs)

- **FR-001**: System MUST provide `normalizeDiscoveredModels(payload, providerIdOrOptions)` in `src/lib/models/discovery.js` that never throws and normalizes at least standard OpenAI, OpenRouter, Lemonade, and Ollama formats.
- **FR-002**: System MUST implement `resolveModelCapabilities(target, sources, options)` in `src/lib/models/capabilities.js` as a pure function respecting the 7-tier precedence cascade (manual > auto > provider > catalog > model > pattern > floor).
- **FR-003**: System MUST support `persistedOverrides: false` in `resolveModelCapabilities` to produce an override-free catalog baseline view.
- **FR-004**: System MUST implement `reconcileContextWindows(discoveredModels, deps)` in `src/lib/models/contextReconciler.js` that records `auto:discovery` overrides for diverging windows and strictly preserves `manual` pins.
- **FR-005**: System MUST implement `deriveRequestRequirements(body)` in `src/domain/requestCapabilities.js` detecting vision across OpenAI, Claude, Gemini, Antigravity, and data-URI shapes.
- **FR-006**: System MUST implement `filterCompatibleComboTargets(targets, requirements, options)` in `src/domain/requestCapabilities.js` enforcing fail-closed semantics for vision requirements.
- **FR-007**: System MUST wire capability filtering into `handleComboChat` in `open-sse/services/combo.js` so an image request never routes to an incompatible non-vision target.
- **FR-008**: System MUST expand `model_context_overrides` in `src/lib/db/schema.js` and migration `004-wave6-model-capabilities.js` with additive columns `provider`, `model_id`, and `source`.

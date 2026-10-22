# Implementation Plan: Wave 6 — Live Model Discovery and Capability Resolution

**Branch**: `feat/wave6-model-discovery` | **Date**: 2026-10-22 | **Spec**: [Feature Spec](./spec.md)

**Input**: Feature specification from `/specs/006-model-discovery-capabilities/spec.md`

---

## Summary

Wave 6 delivers live model discovery normalisation, capability precedence resolution, context window reconciliation, and fail-closed request routing across four modular components:

1. **`src/lib/models/discovery.js`**: Defensive normalisation of `/v1/models` discovery responses across 4 real payload shapes (Standard OpenAI, OpenRouter architecture modality, Lemonade Server labels, Ollama native capabilities). Guaranteed never to throw under malformed inputs.
2. **`src/lib/models/capabilities.js`**: Pure functional implementation of the 7-tier capability precedence cascade (`manual` operator pin > `auto:discovery` override > `PROVIDER_CAPABILITIES` > synced catalog > `MODEL_CAPABILITIES` > `PATTERN_CAPABILITIES` > `DEFAULT_CAPABILITIES`), featuring a `persistedOverrides: false` option flag for self-healing reconciler baseline comparisons.
3. **`src/lib/models/contextReconciler.js`**: Self-correcting context window reconciler that auto-pins discovered divergence as `auto:discovery` in `model_context_overrides`, automatically unpins when the static catalog catches up, and strictly never overwrites `manual` operator pins.
4. **`src/domain/requestCapabilities.js`**: Request-level modality and resource requirement derivation with fail-closed target compatibility gating (`vision`, `tools`, `output_tokens`, `context_window`).
5. **Combo Routing Wiring**: Wire fail-closed compatibility filtering into `handleComboChat` in `open-sse/services/combo.js` so an image request never routes to an incompatible text-only target.
6. **Additive Schema & Migration 004**: Additive migration (`004-wave6-model-capabilities.js`) expanding `model_context_overrides` with `provider`, `model_id`, and `source` columns.

## Technical Context

**Language/Version**: JavaScript ES2022 (ESM modules). Bun 1.4.3 runtime; Node 22+ fallback.
**Target Subtree**: `src/lib/models/*.js`, `src/domain/requestCapabilities.js`, `open-sse/services/combo.js`, `src/lib/db/migrations/004-wave6-model-capabilities.js`, `tests/unit/wave6-models.test.js`.
**Typecheck**: Checked by `tsconfig.typecheck-core.json`.
**Testing**: Vitest (`tests/unit/wave6-models.test.js`).

## Design Decisions

### D1. Defensive Normalisation Contract (Never Throws)
External catalogs are untrusted. `normalizeDiscoveredModels(payload)` wraps parsing in defensive type checks and guards; invalid arrays, circular references, or missing IDs degrade gracefully by returning empty arrays or omitting invalid records instead of throwing.

### D2. Precedence Cascade as a Pure Function
To guarantee deterministic execution and avoid stateful cache race conditions, `resolveModelCapabilities()` accepts explicit `sources` inputs (`manualOverrides`, `autoOverrides`, `providerOverrides`, `catalogSource`, `modelCapabilities`, `patternCapabilities`, `defaultCapabilities`). In production it defaults to database/static tables, while in tests it can be exercised 100% purely with mock fixtures.

### D3. Manual Pin Inviolability in Reconciler
`reconcileContextWindows(discovered, deps)` inspects `deps.getExistingOverride()`. If `source === "manual"`, the record is skipped unconditionally (`skippedManual++`), preventing auto-discovery runs from overriding deliberate human configuration.

### D4. Fail-Closed Routing on Hard Capability Mismatches
When an inference request carries multimodal image data (`requiresVision`), targets lacking confirmed vision support (`supportsVision !== true`) are filtered out of the combo candidate pool. If no targets survive, the combo router returns an immediate HTTP 400/503 error, ensuring non-vision models never receive image payloads.

### D5. Additive SQLite Schema Evolution
`model_context_overrides` receives additive columns (`provider`, `model_id`, `source`) via versioned migration 004, preserving backward compatibility with existing pattern-based rows while enabling provider-scoped overrides with source tracking.

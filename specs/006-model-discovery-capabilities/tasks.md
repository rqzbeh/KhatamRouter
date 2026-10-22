# Implementation Tasks: Wave 6 — Live Model Discovery and Capability Resolution

**Branch**: `feat/wave6-model-discovery` | **Date**: 2026-10-22 | **Plan**: [Implementation Plan](./plan.md)

---

## Phase 1: Setup & Specifications
- [x] T001 Ground research in current KhatamRouter codebase, OmniRoute references, and Wave 2 tables
- [x] T002 Write `specs/006-model-discovery-capabilities/spec.md` with user scenarios and acceptance criteria
- [x] T003 Write `specs/006-model-discovery-capabilities/plan.md` with architectural design decisions
- [x] T004 Write `specs/006-model-discovery-capabilities/tasks.md` with actionable task breakdown
- [x] T005 Create Unlazy acceptance ledger `.unlazy/wave-006/GATES.md` and verify lint passes

## Phase 2: Additive Database Schema & Migration 004
- [x] T006 Implement migration `src/lib/db/migrations/004-wave6-model-capabilities.js` adding `provider`, `model_id`, `source` to `model_context_overrides` and `source` to `model_capabilities`
- [x] T007 Register migration 004 in `src/lib/db/migrations/index.js` and bump `SCHEMA_VERSION` in `src/lib/db/schema.js`

## Phase 3: Defensive Model Discovery Normalisation
- [x] T008 Implement `src/lib/models/discovery.js` with `normalizeDiscoveredModels(payload, options)` and modality/limit extractors
- [x] T009 Ensure complete non-throwing defensive guarantees for standard OpenAI, OpenRouter, Lemonade, Ollama, and malformed inputs

## Phase 4: Pure Functional Capability Precedence Cascade
- [x] T010 Implement `src/lib/models/capabilities.js` with `resolveModelCapabilities({ provider, model }, sources, options)`
- [x] T011 Implement 7-tier precedence cascade (manual > auto > provider > catalog > model > pattern > floor)
- [x] T012 Implement `persistedOverrides: false` flag to return pure catalog baseline view

## Phase 5: Self-Correcting Context Reconciler
- [x] T013 Implement `src/lib/models/contextReconciler.js` with `reconcileContextWindows(discovered, deps)`
- [x] T014 Enforce manual pin protection (`skippedManual`), divergence write (`auto:discovery`), and parity pruning (`removeOverride`)

## Phase 6: Request Capability Derivation & Fail-Closed Combo Routing
- [x] T015 Implement `src/domain/requestCapabilities.js` with `deriveRequestRequirements(body)` and `evaluateTargetCompatibility(target, requirements)`
- [x] T016 Wire fail-closed filtering into `handleComboChat` in `open-sse/services/combo.js` so an image request never routes to non-vision targets

## Phase 7: Unit Testing, Acceptance Gates & Verification
- [x] T017 Implement comprehensive test suite `tests/unit/wave6-models.test.js` covering 4 real payload shapes and fail-closed combo routing
- [x] T018 Run and pass all acceptance gates in `.unlazy/wave-006/GATES.md`
- [x] T019 Run full regression test suite across Wave 1-5 and baselines
- [x] T020 Run Docker container smoke verification (amd64, Redis, sqlite migrations check)
- [x] T021 Complete security audit and create PR with all CI checks passing

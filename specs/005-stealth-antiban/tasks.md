---
description: "Dependency-ordered checklist tasks for Wave 5 Stealth and Anti-Ban Suite"
---

# Tasks: Wave 5 — Stealth and Anti-Ban Suite

**Input**: Design documents from `/specs/005-stealth-antiban/` (`spec.md`, `plan.md`)

**Prerequisites**: `spec.md`, `plan.md`

**Tests**: `tests/unit/wave5-stealth.test.js` plus Wave 1–4 regression suites and three baseline snapshots.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 fingerprints, US2 header scrub, US3 tool cloak, US4 zero-width, US5 stickiness

---

## Phase 1: Setup & Contracts

- [x] T001 [P] Create `src/lib/stealth/` directory and define feature flag resolution helper (`isStealthEnabled`, `isCliCompatEnabled`).

## Phase 2: CLI Fingerprints (US1)

- [x] T002 [US1] Implement `src/lib/stealth/cliFingerprints.js`: `CLI_FINGERPRINTS` registry (`codex`, `claude`, `github`, `antigravity`, `cursor`); canonical `headerOrder` and `bodyFieldOrder` arrays.
- [x] T003 [P] [US1] Implement `orderHeaders(headers, headerOrder)` preserving original casing and appending unlisted headers in original order.
- [x] T004 [P] [US1] Implement `orderFields(body, fieldOrder)` returning a new object in canonical sequence.
- [x] T005 [US1] Implement `stripInternalBodyFields(body)` to remove `_khatam*` and `_omniroute*` markers.

## Phase 3: Header Scrubbing (US2)

- [x] T006 [US2] Implement `src/lib/stealth/headerScrub.js`: `PROXY_HEADERS`, `BROWSER_HEADERS` lists and `NODE_ACCEPT_ENCODING = "gzip, deflate, br"`.
- [x] T007 [US2] Implement `scrubHeaders(headers, { normalizeEncoding })` case-insensitively removing proxy/browser headers.

## Phase 4: Tool Cloaking & Schema Sanitisation (US3)

- [x] T008 [P] [US3] Implement `canvas`-free `sanitizeToolSchema(schema)`: deep clone, strip `$schema`/`$id`, drop empty `required` arrays, force root `type: "object"`.
- [x] T009 [US3] Implement `cloakToolsInRequest(body)`: map snake_case/lowercase to canonical PascalCase (`TOOL_RENAME_MAP`, `HARNESS_CANONICAL_MAP`), generate alias RESTORE map, rewrite `tool_use` history and `tool_choice`.
- [x] T010 [US3] Implement `decloakToolsInResponse(payload, restoreMap)`: recursively restore tool names in JSON objects and SSE text lines.

## Phase 5: Zero-Width Obfuscation (US4)

- [x] T011 [US4] Implement `src/lib/stealth/zeroWidth.js`: `obfuscateAgentWords(text, words)` inserting `U+200D`.
- [x] T012 [US4] Implement `stripObfuscationZeroWidth(text)` preserving Persian `U+200C` half-spaces and emoji ZWJ groups.

## Phase 6: Session Stickiness (US5)

- [x] T013 [US5] Implement `src/lib/stealth/stickiness.js`: `computeSessionKey(messages, namespace)` SHA-256 first-message hash.
- [x] T014 [US5] Implement bounded Map pin store (`setStickyConnection`, `getStickyConnection`, `clearStickyConnections`) with 15-minute TTL, 500-entry cap, and fail-open error handling.

## Phase 7: Verification

- [x] T015 [P] Write `tests/unit/wave5-stealth.test.js` covering US1–US5 and default-off isolation.
- [x] T016 [P] Run Wave 1–4 regression and provider/alias/OAuth baseline snapshots.
- [x] T017 Build container smoke image (`Dockerfile.bun`) and verify migration rows.

# Requirements Verification Checklist: Spec 013 (v0.5.112 Port)

This checklist tracks and verifies every Functional Requirement (FR), Success Criterion (SC), Implementation Task, and Acceptance Gate.

## 1. Functional Requirements Coverage

| Requirement | Description | Task(s) | Gate | Status |
|---|---|---|---|---|
| **FR-013-01** | Register `gpt-6.1-terra` in `codex.js:57` with `responsesLite: true` | T015, T016 | G4 | Ready |
| **FR-013-02** | Configure `gpt-6.1-terra` capabilities in `capabilities.js:301` | T015, T016 | G4 | Ready |
| **FR-013-03** | Configure `gpt-6.1-terra` pricing in `pricing.js:93` | T015, T016 | G4 | Ready |
| **FR-013-04** | Add `smodel` and `cmodel` to `qoder.js:46` and `qoder-cn.js:46` | T015, T016 | G4 | Ready |
| **FR-013-05** | Apply Claude 5.5 thinking rules to dotted IDs in `capabilities.js:101,270` | T017, T018 | G4 | Ready |
| **FR-013-06** | Preserve thinking `display` in `thinkingUnified.js:293,460` | T017, T018 | G4 | Ready |
| **FR-013-07** | Catalogue `grok-image` / `grok-video` as deferred to Spec 015 | T028 | G8 | Ready |
| **FR-013-08** | Enforce Gemini protobuf schema constraints in `gemini.js:304,374` | T003, T004 | G2 | Ready |
| **FR-013-09** | Flatten Gemini multi-type arrays preferring structural types | T003, T004 | G2 | Ready |
| **FR-013-10** | Reject non-streaming SSE errors with status in `nonStreamingHandler.js:249` | T005, T006 | G2 | Ready |
| **FR-013-11** | Normalize NVIDIA reasoning aliases in `paramSupport.js:36,82` | T007, T008 | G2 | Ready |
| **FR-013-12** | Implement `codebuddyHeaders` hook in `default.js:50` | T009, T010 | G2 | Ready |
| **FR-013-13** | Register `codebuddyHeaders` in `codebuddy-cn` and `codebuddy-intl` | T009, T010 | G2 | Ready |
| **FR-013-14** | Advance combos on CodeBuddy 400 without account cooldown | T009, T010 | G2 | Ready |
| **FR-013-15** | Handle opaque `LLM\|id\|secret` tokens in `bulkAdd.js:28` | T011, T012 | G2 | Ready |
| **FR-013-16** | Register Nace Drex provider in `nace.js` with models `drex-max`/`drex-v2.0` | T021, T022 | G5 | Ready |
| **FR-013-17** | Add `nace.png` and regenerate `index.js` via `migrate-registry.mjs` | T022 | G5 | Ready |
| **FR-013-18** | Implement CommandCode CLI 1.88.0 headers in `commandCodeHeaders.js` | T019, T020 | G5 | Ready |
| **FR-013-19** | Implement `slugifyPath` matching `@sindresorhus/slugify` output | T019, T020 | G5 | Ready |
| **FR-013-20** | Synchronize CommandCode `threadId` and `x-session-id` | T019, T020 | G5 | Ready |
| **FR-013-21** | Update baseline snapshots (`alias-baseline`, `providers-baseline`) | T022 | G5 | Ready |
| **FR-013-22** | Implement 64KB length-prefixed framing in `minimaxCodeLease.js` | T023, T024 | G6 | Ready |
| **FR-013-23** | Connect over named pipe (Windows) or domain socket (POSIX) with capability | T023, T024 | G6 | Ready |
| **FR-013-24** | Validate `dataDir` preventing directory traversal or arbitrary probing | T023, T024 | G6 | Ready |
| **FR-013-25** | Protect lease routes in `dashboardGuard.js:54,92` | T026 | G6 | Ready |
| **FR-013-26** | Reject non-loopback lease requests with HTTP 403 Forbidden | T026 | G6 | Ready |
| **FR-013-27** | Enforce ephemeral in-memory token handling (no DB persistence or logs) | T024, T026 | G6 | Ready |
| **FR-013-28** | Cache leased token in Redis with TTL margin and single-flight lock | T023, T024 | G6 | Ready |
| **FR-013-29** | Fail open to in-process memory cache when Redis is unavailable | T023, T024 | G6 | Ready |
| **FR-013-30** | Wire MiniMax executor and usage to transparently inject leased tokens | T025 | G6 | Ready |
| **FR-013-31** | Implement noble-hashes Keccak-f[1600] in `deepseek-pow-hash.js` | T013, T014 | G3 | Ready |
| **FR-013-32** | Restore hex regex, `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, type checks | T013, T014 | G3 | Ready |
| **FR-013-33** | Throw `TypeError`/`RangeError` on invalid DeepSeek PoW inputs | T013, T014 | G3 | Ready |
| **FR-013-34** | Isolate DeepSeek PoW library boundary for Spec 015 consumption | T014 | G3 | Ready |
| **FR-013-35** | Bump versions to `0.5.112` in `package.json:3` and `cli/package.json:3` | T028 | G8 | Ready |
| **FR-013-36** | Merge release notes into `CHANGELOG.md` preserving Wave 8 notes | T028 | G8 | Ready |
| **FR-013-37** | Document all 14 commits in `docs/UPSTREAM-PORTS.md` | T028 | G8 | Ready |
| **FR-013-38** | Prove OpenCode Free and Docker parity under Bun without runtime npm | T027 | G7 | Ready |

---

## 2. Success Criteria Verification

| Criterion | Target Metric | Verification Method |
|---|---|---|
| **SC-013-01** | 14/14 commits audited and classified | `node .unlazy/013-upstream-0-5-112/scripts/verify-parity-matrix.mjs` |
| **SC-013-02** | `gpt-6.1-terra` discovered with 500k context | `bun x vitest run unit/codex-gpt6-lite.test.js` |
| **SC-013-03** | `smodel` & `cmodel` present in Qoder registries | `bun x vitest run unit/qoder-frontier-models.test.js` |
| **SC-013-04** | Claude 5.5 dotted IDs route thinking correctly | `bun x vitest run unit/github-claude-5-5-thinking.test.js` |
| **SC-013-05** | Gemini protobuf schema predicates strictly enforced | `bun x vitest run unit/gemini-schema-array-items-predicate.test.js` |
| **SC-013-06** | Upstream SSE errors reject with upstream status | `bun x vitest run unit/nonstream-sse-error.test.js` |
| **SC-013-07** | NVIDIA reasoning normalized without duplicates | `bun x vitest run unit/param-support.test.js` |
| **SC-013-08** | CodeBuddy headers attached; combos advance | `bun x vitest run unit/codebuddy-channel-headers.test.js` |
| **SC-013-09** | Bulk add preserves `LLM\|...` without mangling | `bun x vitest run unit/bulk-add-names.test.js` |
| **SC-013-10** | Nace Drex provider serves System One requests | `bun x vitest run unit/nace-systemone-provider.test.js` |
| **SC-013-11** | CommandCode headers align with CLI 1.88.0 | `bun x vitest run unit/commandcode-headers.test.js` |
| **SC-013-12** | MiniMax lease broker enforces 64KB cap & loopback | `bun x vitest run unit/minimax-code-lease.test.js` |
| **SC-013-13** | DeepSeek PoW solves nonces and enforces limits | `bun x vitest run unit/deepseek-pow-hash.test.js` |
| **SC-013-14** | Versions at `0.5.112`, Dockerfiles identical | `cmp Dockerfile Dockerfile.bun` |
| **SC-013-15** | Full test suite passes under Bun | `cd tests && bun x vitest run` |

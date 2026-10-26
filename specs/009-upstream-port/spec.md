# Feature Specification: 009 Upstream Port (VansRouter 0.91.61→0.91.81, 9router 0.5.104→0.5.109)

**Feature Branch**: `spec/009-upstream-port`
**Created**: 2026-10-24
**Status**: Completed / Shipped (all 44 audited upstream candidates merged to master via PR #65)

## Scope

Port all 44 audit-confirmed upstream candidates into KhatamRouter:
- VansRouter `v0.91.61 (f3da996e)` → `v0.91.81 (29dd4b16)`: 94 commits reviewed, 11 candidates (3 cherry-pick, 8 adapt — 4 of the 8 are `adapt` only in placement/testing, semantics identical).
- 9router `v0.5.104 (87a74e1b)` → `v0.5.109 (f39d8f07)`: 39 commits reviewed, 33 candidates (26 cherry-pick, 7 adapt).

**Boundary**: permitted upstream references are `Vanszs/VansRouter` (read-only reference, never `rqzbeh/VansRouter`) and `decolua/9router` (tracking upstream). No commit is applied blind: each port is a reviewed change with a regression gate.

## User Stories & Testing

### US1 — Security and crash fixes first (P1)

Apply these before anything else: dependency bumps closing known CVEs and fixes for request-path crashes/hangs.

**Independent Test**: `bun x vitest run` green vs `known-fails.txt`; targeted spoof/timeout/prototype-pollution tests pass.

**Acceptance**:
1. `undici` is at 7.30.1 (or newer patched) and headroom binds loopback-only.
2. Dashboard Monaco/CDN loader is pinned (no unpinned CDN loads of vulnerable versions).
3. Gemini translator `__proto__` pollution + prototype-method shadowing crash paths are closed (negative tests pass).
4. Models-discovery `fetch` calls have timeout guards (no untimed upstream fetch on the probe path).

### US2 — Correctness and resilience (P1)

Combo failover (credits/4xx/empty-SSE), translator/usage/executor correctness, Pi-settings 500, Kiro/Grok/Antigravity/OpenCode capability fixes, CodeBuddy auth+backoff, commandcode/quota/media fixes.

**Independent Test**: per-port targeted tests + goldens + `verify-*.mjs` green; combo behavior verified by unit tests.

### US3 — Enhancements and providers (P2)

RTK custom system prompt, combo search UI, Copilot catalog refresh, Gemini ref-images + MITM dir, Ollama System One decision models, SenseNova provider, Codex OAuth STT (needs `ffmpeg` in builder), Smart Router/System One with **Redis-backed** stickiness (upstream's in-memory Map is adapted — no per-process stickiness).

**Independent Test**: each feature behind its existing flag/UI surface; provider tests green; Smart Router session pin works across two instances via Redis.

## Requirements

- **FR-001**: All 44 candidates land as reviewed changes on this branch: bug fixes, security, performance, enhancements, new features.
- **FR-002**: Security/crash cluster merges first (US1), then correctness (US2), then enhancements (US3). Nothing waits on the 008 perf work.
- **FR-003**: `adapt` candidates are adapted to Bun-only/Redis-cluster/webpack reality, not pasted: Redis-backed stickiness, `bun:sqlite` compat, no pnpm/Node-isms.
- **FR-004**: Parallel subagent waves execute disjoint-file clusters in parallel; file-sharing clusters run sequentially within their lane (union-find components in the port plan).
- **FR-005**: Every port carries a regression gate (targeted test + guard suites green); goldens byte-identical unless the port intentionally changes behavior (documented).
- **FR-006**: No `docker system prune` / `volume prune`; container verification via dedicated subagent only.
- **FR-007**: Skipped upstream items (release chores, internal ledgers, already-ported Wave 7 items, pnpm/containerd harness) stay skipped with reason recorded.

## Success Criteria

- **SC-001**: Security cluster merged: `undici` patched, headroom loopback, Monaco pinned, prototype-pollution + shadowing closed, discovery fetches timed.
- **SC-002**: Combo resilience complete: credit-exhaustion, request-scoped 4xx, and empty-SSE fallthrough all advance combos in unit tests.
- **SC-003**: Full suite green vs `known-fails.txt` with no new failures after all waves.
- **SC-004**: New providers/features (SenseNova, custom RTK prompt, Codex STT, Smart Router) work behind their surfaces with tests.

## Non-goals

- 008 perf-scale work (separate branch/spec, merged independently).
- Re-litigating Turbopack, port topology, or bundler choices.

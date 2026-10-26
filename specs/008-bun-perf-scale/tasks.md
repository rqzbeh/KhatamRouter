---
description: "Task list for 008-bun-perf-scale"
---

# Tasks: Wave 8 — Bun Hot-Path Profile, Multi-Process Scale, Ladder Re-Run

**Input**: `/specs/008-bun-perf-scale/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested. Tests-first for the perf harness, the model-info cache and the trusted proxy (write, see them fail, then implement).

**Execution rules**
- The main agent orchestrates and reviews. Every task is executed by a **sonnet** subagent via the Workflow tool (user instruction overrides the constitution's haiku tier).
- `[SUBAGENT-DOCKER]` tasks run docker. They are delegated to a dedicated container subagent, never the main agent. No `docker system prune`, no `volume prune`. Pin to `origin/master`, `linux/amd64`, `NEXT_BUILD_CPUS=2`, `--max-old-space-size=3072` (FR-009).
- Every task starts graph-first (`search_graph` → `trace_path` → `get_code_snippet`, then `check_index_coverage` on each relied file). Read `open-sse/AGENTS.md` before touching `open-sse/`.
- Any script or test that opens the DB sets a temp `DATA_DIR` first. Nothing touches `~/.9router`.
- A task that fails its guard is not done. The leaf ledger under `.unlazy/008-bun-perf-scale/` is the proof.
- **Strict Sequential Order**: US1 complete (baseline, slim, guard, after-measure) → US2 complete (CIDR proxy + overlay + two-instance + delegated Docker verification) → US3 (ladder). No US2 authoring or implementation work may overlap or run alongside US1. No slim leaf or task is READY before the baseline is measured and verified (T007).
- **Approved Scoped Code Change**: US2 multi-process scale contains zero engine routing rewrite, but explicitly includes an approved, security-audited code edit to `custom-server.js` (and its `custom-server.ts` twin) for `TRUSTED_PROXY_CIDRS` with strict spoof protection and loopback-only fallback (FR-004).
- **Unique File Ownership**: Every task owns a strictly unique, non-overlapping file path set. T001 owns only `results/.gitkeep`. T002 owns `results/preflight.md`. T022 owns `results/ladder-host.md`. T023 owns `results/ladder-l3.md`. T024 alone owns and integrates into `ladder-results.md`.
- **Threshold & Measurement Discipline**: Evaluations adhere strictly to research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×). Missed thresholds are reported honestly as a miss (never claiming the ceiling moved if unmet). Any unmeasured, invalid, or noisy profile/ladder run cannot certify improvement and must be rejected or re-run (FR-008, SC-002, SC-005). Unmeasurable cells are marked `UNMEASURED` with cause and handoff.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel-safe (disjoint files, within the same phase gate, no dependency on an incomplete task)
- **Owns** lists the only paths a task may write. Parallel tasks never share an owned path.

---

## Phase 1: Setup

- [ ] T001 Create `specs/008-bun-perf-scale/results/` with a `.gitkeep`. Owns: `specs/008-bun-perf-scale/results/.gitkeep`
- [ ] T002 Preflight: confirm `bun -v` is 1.4.3, run `bun install` at the root and `cd tests && bun install`, run the vitest suite once, and write the red set versus `tests/__baseline__/known-fails.txt` into `specs/008-bun-perf-scale/results/preflight.md`. Depends on T001. Owns: `specs/008-bun-perf-scale/results/preflight.md`

## Phase 2: Foundational (blocks all stories)

- [ ] T003 Orchestrator: extend `.unlazy/008-bun-perf-scale/PLAN.md` with the implementation leaves (following the unique ownership and strict sequential phase order table below) and write one `gates/leaf-*.md` per leaf. Run `gate-lint.mjs` and `--approve`. Depends on T002. Owns: `.unlazy/008-bun-perf-scale/PLAN.md`, `.unlazy/008-bun-perf-scale/gates/**`
- [ ] T004 Record the pre-change regression guard to `specs/008-bun-perf-scale/results/guard-before.txt`. Commands: `verify-alias.mjs`, `verify-providers.mjs`, `verify-oauth-urls.mjs`, the four `tests/translator/golden-*.test.js`, and `unit/capabilities`, `unit/key-access`, `unit/translator-request-normalization`, `unit/translator-helpers-edge`. Depends on T002. Owns: `specs/008-bun-perf-scale/results/guard-before.txt`

**Checkpoint**: Ledgers approved, guard baseline captured. Strict prerequisite for Phase 3.

---

## Phase 3: User Story 1 — Profile, slim, re-measure (P1) 🎯 MVP

**Goal**: A measured L1 breakdown based on exclusive phase shares, and a slimmed hot path with identical request/response behavior (FR-001, FR-002, FR-003, SC-001, SC-002).

**Independent Test**: `perf-l1-harness.mjs` before and after on the same workload. The guard output is unchanged (`guard-after.txt`), `db_queries_per_req` is lower, and research D7 targets are evaluated.

### Phase A — harness and baseline

- [ ] T005 [US1] Write `tests/unit/perf-harness.test.js` first. It asserts that the harness uses a `mkdtemp` `DATA_DIR`, refuses a `DATA_DIR` under `~/.9router`, prints `PERF_L1_OK <label>`, and emits JSON matching `data-model.md` (`runs >= 5`, `warmup >= 50`, CV>15% flagged `noisy`; unmeasured/noisy runs flagged so they cannot certify improvement). Depends on T003, T004. Owns: `tests/unit/perf-harness.test.js`
- [ ] T006 [US1] Implement `scripts/perf-l1-harness.mjs` per `contracts/perf-harness.md`: in-process mock executor, seeded key/combo/connections, per-phase timers, a DB query counter, and a 40/40/20 workload mix. Make T005 pass. Depends on T005. Owns: `scripts/perf-l1-harness.mjs`
- [ ] T007 [US1] Run the baseline: `bun scripts/perf-l1-harness.mjs --label baseline --out specs/008-bun-perf-scale/results/l1-baseline.json`. Orchestrator gate: compare the measured `phases_ms` and `db_queries_per_req` with `research-profile.md`. Any unmeasured, invalid, or noisy profile cannot certify improvement and must be rejected or re-run (FR-008, SC-002). If the hotspot ranking differs from static estimates, amend `research.md` D3 and re-rank T009–T012 before any code change. Depends on T006. Owns: `specs/008-bun-perf-scale/results/l1-baseline.json`

### Phase B — slim (starts strictly after T007 baseline gate passes; no slim leaf is READY before baseline)

- [ ] T008 [US1] Write `tests/unit/model-info-cache.test.js` first. It asserts that alias/combo/provider-node reads are cached. Invalidation happens on local write and on a `khatam:events:config_reload` message. A 5 s hard TTL bounds staleness when pub/sub is lost. A revoked, expired or banned API key is rejected on the next request (auth is never cached across requests). Results are identical to the uncached path. Strictly begins only after T007 baseline gate passes. Depends on T007. Owns: `tests/unit/model-info-cache.test.js`
- [ ] T009 [US1] Add TTL caches to `src/lib/db/repos/aliasRepo.js` (`getModelAliases`), `src/lib/db/repos/combosRepo.js` (`getComboByName`) and `src/lib/db/repos/nodesRepo.js` (`getProviderNodes` keyed by type). Follow the `settingsCache` pattern at `src/lib/db/repos/settingsRepo.js:175-213`. Invalidate on create/update/delete and on `config_reload`. Make T008 pass. Depends on T008. Owns: `src/lib/db/repos/aliasRepo.js`, `src/lib/db/repos/combosRepo.js`, `src/lib/db/repos/nodesRepo.js`
- [ ] T010 [P] [US1] Build a module-load `Map<modelId, entry>` in `open-sse/config/providerModels.js` and use it for `findModel`. Replace the repeated linear lookups in `open-sse/handlers/chatCore.js` (`getModelSupportedFormats`, `resolveTransport`, `getModelStrip`, `getModelUpstreamId`, `getModelType`). Behavior is identical, including the `baseModelId` fallback. Strictly begins only after T007 baseline gate passes. Depends on T007. Owns: `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js`
- [ ] T010b [P] [US1] Memoize compiled regex in `matchPattern` (`open-sse/providers/pricing.js`). Write `tests/unit/pattern-match-cache.test.js` first. Must be behaviour-identical including case-insensitivity, wildcard globbing, and regex special-character escaping; bounded cache. Eliminates the ~15.0% (0.37 ms/req) regex recompilation bottleneck across capability detection, thinking normalization, and pricing. Strictly begins only after T007 baseline gate passes. Depends on T007. Owns: `open-sse/providers/pricing.js`, `tests/unit/pattern-match-cache.test.js`
- [ ] T011 [P] [US1] Translation short-circuits. Skipped (measured: translation exclusive of matchPattern is 2.73% / 0.068 ms/req, and targeted functions ensureToolCallIds/fixMissingToolResponses/filterToOpenAIFormat account for only 0.25% / 0.006 ms/req; real translation cost is matchPattern regex compilation, captured in T010b). Strictly begins only after T007 baseline gate passes. Depends on T007. Owns: `open-sse/translator/concerns/toolCall.js`, `open-sse/translator/formats/openai.js`
- [ ] T012 [US1] Request-scoped reuse. Resolve `keyRecord` once in `handleChat` and pass it into `handleSingleModelChat`. Pass the already-resolved combo so `getComboModels` and `getModelInfo` do not re-query. Skip the provider-node lookups when the provider prefix is known. Auth stays fail-closed, and the key is read fresh on every request. Depends on T009. Owns: `src/sse/handlers/chat.js`, `src/sse/services/model.js`

### Phase B exit

- [ ] T013 [US1] Re-run the T004 guard into `specs/008-bun-perf-scale/results/guard-after.txt`. `diff guard-before.txt guard-after.txt` must show no regressions (new test files excluded). Any new red test blocks T014. Depends on T009, T010, T010b, T011, T012. Owns: `specs/008-bun-perf-scale/results/guard-after.txt`
- [ ] T014 [US1] Measure after slimming (`--label after-slim`, same workload and `--runs`). Write `specs/008-bun-perf-scale/results/l1-after.json` and a short `specs/008-bun-perf-scale/results/l1-compare.md` with the before/after per-phase table. State the result against research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%) honestly; any missed threshold is reported as a miss. Any unmeasured, invalid, or noisy profile cannot certify improvement and must be rejected or re-run (FR-008, SC-002). Completes US1. Depends on T013. Owns: `specs/008-bun-perf-scale/results/l1-after.json`, `specs/008-bun-perf-scale/results/l1-compare.md`

**Checkpoint**: Strict US1 complete (baseline, slim, guard, after-measure). All US1 tasks T005–T014 must be complete, verified, and shippable before any US2 task begins.

---

## Phase 4: User Story 2 — Multi-process replicas on shared state (P2)

**Goal**: N replicas behind one LB, sharing Wave 7.5 Redis state without engine routing rewrite, enabled by an approved scoped code change in `custom-server.js` (and twin) for `TRUSTED_PROXY_CIDRS` to trust real client IPs with strict spoof controls, plus compose overlay and nginx LB, ensuring graceful Redis loss (FR-004, FR-005, FR-006, FR-009, SC-003, SC-004).

**Independent Test**: `trusted-proxy.test.js` green with spoof controls. In compose, a trip, a refresh and a rotation on replica A are respected by replica B. With Redis halted, traffic still flows degraded without throwing.

**Strict Order Rule**: US2 work strictly begins ONLY after US1 is 100% complete. No US2 task may overlap US1.

- [ ] T015 [US2] Write `tests/unit/trusted-proxy.test.js` first, per `contracts/scale-compose.md`. Cases: unset var behaves exactly like master (loopback-only trust); a peer outside the CIDRs cannot spoof `X-Forwarded-For`; a peer inside a CIDR is trusted; `::ffff:` mapped peers match their IPv4 CIDR; an invalid CIDR is logged and ignored (stricter, never looser); `x-9r-real-ip`, `x-9r-peer-token` and `x-9r-via-proxy` are stripped from inbound requests. `tests/unit/local-request-peer-trust-3294.test.js` must stay green. Strictly begins only after US1 complete. Depends on T014. Owns: `tests/unit/trusted-proxy.test.js`
- [ ] T016 [US2] Implement approved scoped code change: `TRUSTED_PROXY_CIDRS` in `custom-server.js` around the loopback check at lines ~133-142, and mirror it in `custom-server.ts`. The `.js` file is the runtime-loaded twin. Preserves loopback-only default when unset/empty, treats invalid CIDRs strictly (logged and ignored, never expanding trust), and enforces spoof protection. Make T015 pass. Depends on T015. Owns: `custom-server.js`, `custom-server.ts`
- [ ] T017 [P] [US2] Write `docker-compose.scale.yml` and `deploy/nginx-scale.conf` per `contracts/scale-compose.md`: no `container_name` on the app, no published app port, healthcheck on `/api/health`, an LB that overwrites `X-Forwarded-For` with `$remote_addr`, a shared `9router-data` volume, a shared `REDIS_URL`, and `TRUSTED_PROXY_CIDRS` set to the compose subnet. Document `TRUSTED_PROXY_CIDRS` in `.env.example` and add the single-host-only note to `DOCKER.md`. Do not edit `docker-compose.yml`. Strictly begins only after US1 complete. Depends on T014. Owns: `docker-compose.scale.yml`, `deploy/nginx-scale.conf`, `.env.example`, `DOCKER.md`
- [ ] T018 [US2] Author `scripts/scale-smoke.sh` (author only, do not execute) in the style of `scripts/w75-compose-smoke.sh`. It runs scale N, then checks: a breaker trip on replica A is observed by B; two concurrent refreshes of one token produce one upstream call; the rotation counter continues across replicas; with Redis stopped, requests still return 2xx and logs show at most one warning per outage; it never calls `prune`. Depends on T017. Owns: `scripts/scale-smoke.sh`
- [ ] T019 [P] [US2] Two-instance test without Docker: `tests/unit/cluster-two-instance.test.js`. Reuse the fake-Redis helper the Wave 7.5 cluster tests already use (locate it with `grep -l` over `tests/unit/wave75-*`). It asserts a shared breaker trip, a single refresh, shared rotation, and a Redis-unreachable fallback with no throw. Strictly begins only after US1 complete. Depends on T014. Owns: `tests/unit/cluster-two-instance.test.js`
- [ ] T020 [US2] [SUBAGENT-DOCKER] Container subagent: delegated live Docker verification (never main agent, never `docker system prune` or `volume prune`, per repo convention and FR-009). Run `docker compose -f docker-compose.yml -f docker-compose.scale.yml config`, then `scripts/scale-smoke.sh 2`, then the Redis-halt drill. Write the transcript to `specs/008-bun-perf-scale/results/scale-smoke.md` and clean up only the containers it created. Completes US2. Depends on T016, T017, T018, T019. Owns: `specs/008-bun-perf-scale/results/scale-smoke.md`

**Checkpoint**: Strict US2 complete (CIDR proxy + overlay + two-instance + delegated Docker verification). All US2 tasks T015–T020 must be complete and verified before any US3 work begins.

---

## Phase 5: User Story 3 — Ladder (P3)

**Goal**: One table, one method, and an honest verdict on whether the ceiling moved (FR-007, FR-008, SC-005).

**Independent Test**: `ladder-results.md` has no silent gaps. Every cell is a measured number with its command and environment, or marked `UNMEASURED` with cause and handoff; unmeasured or noisy runs cannot certify improvement.

**Strict Order Rule**: US3 work strictly begins ONLY after US2 is 100% complete.

- [x] T021 [US3] Write `scripts/perf-ladder.sh <1|2|4>`: loopback load driver (Bun-native client loop, `C=10`, 100 warmup, 5×1000 measured, median of 3 after dropping the high and low runs) against an already-running stack. It emits a `LadderRow` and never invokes `docker`. Strictly begins only after US2 complete. Depends on T020. Owns: `scripts/perf-ladder.sh`
- [ ] T022 [US3] Host rows (no docker): run L0 micro rows, L1 from T007 and T014, and an L2 single-replica loopback run against a standalone server with a temp `DATA_DIR`. Record exact commands, environment, latency percentiles, and throughput into `specs/008-bun-perf-scale/results/ladder-host.md`. Depends on T021. Owns: `specs/008-bun-perf-scale/results/ladder-host.md`
- [ ] T023 [US3] [SUBAGENT-DOCKER] Container subagent: delegated live container L3 rows at 2 and 4 replicas plus the Redis-down row, executed via `scripts/perf-ladder.sh` against compose stack (never main agent, no `prune`, per FR-009). Write L3 results table, exact command, environment, and host CPU saturation note to its own output `specs/008-bun-perf-scale/results/ladder-l3.md` (do not write to `ladder-results.md`). Depends on T021. Owns: `specs/008-bun-perf-scale/results/ladder-l3.md`
- [ ] T024 [US3] Orchestrator integration and verdict: integrate host rows from `specs/008-bun-perf-scale/results/ladder-host.md` and container rows from `specs/008-bun-perf-scale/results/ladder-l3.md` into `specs/008-bun-perf-scale/ladder-results.md`. Apply research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×). Provide a plain-language verdict on whether the ceiling moved and by how much, reporting missed thresholds honestly (never claiming ceiling moved if unmet) and naming the next bottleneck (SQLite writer contention, `getSettings`, idempotency body clone, or other). Every cell must be a measured number or marked `UNMEASURED` with cause and handoff; unmeasured or noisy runs cannot certify improvement. T024 alone owns and writes `ladder-results.md`. Completes US3. Depends on T022, T023. Owns: `specs/008-bun-perf-scale/ladder-results.md`

**Checkpoint**: Strict US3 complete. Full before/after comparison table with D7 evaluation documented in `ladder-results.md`.

---

## Phase 6: Polish and closeout

- [ ] T025 [P] Docs, per the repo rule to update docs after every wave: `README.md`, `ROADMAP.md` (mark this perf plan shipped; do not invent a wave number, check the ROADMAP numbering first), `CHANGELOG.md`, and a short `docs/PERFORMANCE.md` that links the results. Depends on T024. Owns: `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/PERFORMANCE.md`
- [ ] T026 Lint and full suite: `bun x eslint` on every touched file, then the full vitest run. The red set must equal `known-fails.txt` exactly (no new failures). Depends on T025. Owns: none (read-only)
- [ ] T027 Orchestrator: `gate-check --reverify` on every leaf ledger, final claim audit against the spec FRs/SCs, and open the PR (Conventional Commits, security notes on the approved `TRUSTED_PROXY_CIDRS` custom-server edit and spoof protection). Depends on T026. Owns: none (read-only audit and PR creation)

---

## Dependencies and order

```text
Setup & Foundational:
T001 → T002 → T003, T004

→ [US1 Complete] (T005..T014)
T005 → T006 → T007 (baseline gate)
               ├─ T008 → T009 ─┬─→ T012 ─→ T013 → T014 (US1 complete gate)
               ├─ T010 ────────┤
               ├─ T010b ───────┤
               └─ T011 ────────┘

→ [US2 Complete] (T015..T020, strictly begins after T014 completes)
               ├─ T015 → T016 ──────────┐
               ├─ T017 → T018 ──────────┼─→ T020 (delegated Docker subagent)
               └─ T019 ─────────────────┘

→ [US3 Complete] (T021..T024, strictly begins after T020 completes)
T021 ─┬─→ T022 (host rows → results/ladder-host.md) ────────┬─→ T024 (alone owns ladder-results.md)
      └─→ T023 (delegated Docker → results/ladder-l3.md) ───┘

→ [Phase 6 Polish & Closeout]
T025 → T026 → T027
```

- **Strict sequential order**: US1 complete (baseline, slim, guard, after-measure) → US2 complete (CIDR proxy + overlay + two-instance + delegated Docker verification) → US3 (ladder).
- **No overlapping execution across stories**: No US2 authoring or implementation work may start before US1 is strictly complete (T014 finished and verified).
- **No slim leaf is ready before baseline**: No Phase B slim task (T008–T012) may be marked ready or begin before the T007 baseline gate produces `l1-baseline.json` and confirms/re-ranks hotspots.
- **US3 strictly waits on US2**: No US3 ladder task (T021–T024) may start before US2 is strictly complete (T020 verified).
- **Disjoint results docs**: T022 writes `results/ladder-host.md`; T023 writes `results/ladder-l3.md`; T024 alone integrates them into `ladder-results.md`. T022 and T024 do not share ownership of `ladder-results.md`.

## Disjoint ownership (for `.unlazy` leaves, T003)

| Leaf | Tasks | Owns | Allowed concurrency |
|---|---|---|---|
| a-harness | T005, T006, T007 | `tests/unit/perf-harness.test.js`, `scripts/perf-l1-harness.mjs`, `specs/008-bun-perf-scale/results/l1-baseline.json` | Sequential within US1 Phase A; blocks all Phase B slim tasks |
| b1-caches | T008, T009 | `tests/unit/model-info-cache.test.js`, `src/lib/db/repos/{aliasRepo,combosRepo,nodesRepo}.js` | Parallel with b2, b2b, b3 once T007 baseline gate passes |
| b2-models | T010 | `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js` | Parallel with b1, b2b, b3 once T007 baseline gate passes |
| b2b-pattern-cache | T010b | `open-sse/providers/pricing.js`, `tests/unit/pattern-match-cache.test.js` | Parallel with b1, b2, b3 once T007 baseline gate passes |
| b3-translator | T011 | `open-sse/translator/concerns/toolCall.js`, `open-sse/translator/formats/openai.js` | Parallel with b1, b2, b2b once T007 baseline gate passes |
| b4-handler | T012 | `src/sse/handlers/chat.js`, `src/sse/services/model.js` | Sequential after b1 (needs cache repo API) |
| b-exit | T013, T014 | `specs/008-bun-perf-scale/results/guard-after.txt`, `specs/008-bun-perf-scale/results/l1-after.json`, `specs/008-bun-perf-scale/results/l1-compare.md` | Sequential after b2, b2b, b3, b4; completes US1 |
| c-proxy | T015, T016 | `tests/unit/trusted-proxy.test.js`, `custom-server.js`, `custom-server.ts` | Strictly after US1 complete (T014); parallel with c-overlay, d-two-instance |
| c-overlay | T017 | `docker-compose.scale.yml`, `deploy/nginx-scale.conf`, `.env.example`, `DOCKER.md` | Strictly after US1 complete (T014); parallel with c-proxy, d-two-instance |
| d-smoke | T018 | `scripts/scale-smoke.sh` | Sequential after c-overlay (T017) |
| d-two-instance | T019 | `tests/unit/cluster-two-instance.test.js` | Strictly after US1 complete (T014); parallel with c-proxy, c-overlay |
| d-docker | T020 | `specs/008-bun-perf-scale/results/scale-smoke.md` | Sequential container subagent after T016, T017, T018, T019; completes US2 |
| e-ladder-script | T021 | `scripts/perf-ladder.sh` | Strictly after US2 complete (T020) |
| e-ladder-host | T022 | `specs/008-bun-perf-scale/results/ladder-host.md` | Sequential after T021 (host micro/L1/L2 rows) |
| e-ladder-docker | T023 | `specs/008-bun-perf-scale/results/ladder-l3.md` | Sequential container subagent after T021 (L3 multi-replica rows) |
| e-ladder-verdict | T024 | `specs/008-bun-perf-scale/ladder-results.md` | Sequential after T022, T023 (alone integrates rows and verdict) |

Docker leaves (T020, T023) run alone and sequentially.

## Implementation strategy

1. **MVP**: T001–T014. Ship US1 alone if US2 or US3 slip.
2. **Increment**: Strict sequence US1 → US2 → US3. Each is independently testable.
3. **Stop rule**: if T007 contradicts the research, stop and re-plan. If T013 shows a regression, revert that change, don't tune around it. If D7 thresholds are unmet in T014 or T024, report honestly as a miss and document the next bottleneck (never claim the ceiling moved if unmet).

## Notes

- Total: 27 tasks. Setup 2, Foundational 2, US1 10, US2 6, US3 4, Polish 3.
- `[P]` marks tasks whose owned paths are disjoint within their active phase gate.
- Commit after each leaf. Conventional Commits.

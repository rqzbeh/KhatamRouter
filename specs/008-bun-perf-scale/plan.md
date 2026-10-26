# Implementation Plan: Bun Hot-Path Profile, Multi-Process Scale, Ladder Re-Run

**Branch**: `spec/008-bun-perf-scale` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-bun-perf-scale/spec.md`

## Summary

Measure first, then slim, then scale, then prove. Strict sequential progression: **US1 complete (baseline, slim, guard, after-measure) → US2 complete (CIDR proxy + overlay + two-instance + delegated Docker verification) → US3 (ladder re-run)**. US1 builds an in-process L1 harness (`scripts/perf-l1-harness.mjs`), records a measured baseline, and removes the redundant per-request SQLite reads, linear model scans and no-op translation passes confirmed by baseline profiling. US2 scales horizontally across replicas sharing Wave 7.5 Redis state with zero engine routing rewrite, requiring a compose overlay (`docker-compose.scale.yml`), nginx LB config (`deploy/nginx-scale.conf`), and one explicitly approved, security-audited code edit: opt-in `TRUSTED_PROXY_CIDRS` parsing in `custom-server.js` (and its `custom-server.ts` twin) so real client IPs survive the LB while strictly preserving the loopback-only default when unset/empty and enforcing spoof protection. US3 re-runs the ladder using identical methods; every cell is a measured number or `UNMEASURED` with cause. Results are evaluated against research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×), reporting missed thresholds honestly and rejecting unmeasured or noisy runs from certifying improvement. Decisions are in [research.md](./research.md).

## Technical Context

**Language/Version**: JavaScript (ESM), Bun 1.4.3 (Bun-only; no TypeScript in the engine)

**Primary Dependencies**: Next.js 16 (webpack retained), `ioredis`, `bun:sqlite`, vitest (tests, Bun host)

**Storage**: SQLite WAL (`$DATA_DIR/db/data.sqlite`, authoritative) + Redis `khatam:` prefix (shared cluster state, fail-open except auth)

**Testing**: `bun x vitest run` from `tests/`; baselines `tests/__baseline__/verify-*.mjs`; translator goldens

**Target Platform**: Linux, single host. Replicas share one SQLite volume (no NFS/EFS)

**Project Type**: web-service (gateway plus dashboard)

**Performance Goals**: L1 p50 ≥35% lower and p95 ≥25% lower; 2 replicas reach ≥1.6× single-replica throughput. Evaluated against research D7 thresholds. Missed thresholds must be reported honestly as a miss (never claiming the ceiling moved if unmet). Any unmeasured, invalid, or noisy profile/ladder run cannot certify improvement and must be rejected or re-run (FR-008, SC-002, SC-005). Cells that cannot be measured must be marked `UNMEASURED` with cause and handoff.

**Constraints**: No behavior change (goldens green). Auth fail-closed, quota/limit fail-open. Loopback-only XFF trust unless `TRUSTED_PROXY_CIDRS` is set (with invalid entries strictly ignored). Harness uses a temp `DATA_DIR` and never touches `~/.9router`. The main agent never runs docker. Strict sequential progression: US1 complete → US2 complete → US3; no US2 work may overlap US1; no slim leaf is ready before baseline.

**Scale/Scope**: ~8 source files touched (US1), 1 compose overlay + LB config + approved scoped code edit in `custom-server.js` (and `custom-server.ts` twin) for `TRUSTED_PROXY_CIDRS` (US2), 2 scripts + scoped results docs with unique owners (`results/ladder-host.md`, `results/ladder-l3.md`, `ladder-results.md`) (US3)

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I Upstream integrity | PASS | Additive caches and overlay only. No upstream capability removed. |
| II Single runtime, port contract | PASS | Bun only. 20128 is published by the LB only in the overlay. Base compose is untouched. Approved code change in `custom-server.js` (+ `.ts` twin) for `TRUSTED_PROXY_CIDRS` preserves port 20128 and single-runtime contract. |
| III SQLite WAL + Redis hybrid | PASS | SQLite stays authoritative. Redis state is reused as-is, nothing new is stored there. |
| IV Graph-first discovery | PASS | The research notes attest `check_index_coverage` on every relied file. |
| V Spec-Kit + Unlazy | PASS | `specs/008-*` plus `.unlazy/008-bun-perf-scale/`. Research gates are 10/10 met. |
| VI Resilience, stealth | PASS | Executors stay stateless. XFF stripping is preserved by default (D2). Opt-in `TRUSTED_PROXY_CIDRS` approved edit strictly preserves loopback-only default when unset, treats invalid CIDRs strictly (logged and ignored), and enforces spoof negative controls. Redis-down behavior is re-verified under N replicas. |

**Post-design re-check**: PASS. Zero engine routing rewrite. The only code edit is the approved, scoped `TRUSTED_PROXY_CIDRS` in `custom-server.js` (and twin). It is opt-in, defaults to today's loopback-only behavior, treats invalid CIDRs strictly (logged and ignored), and has spoof negative controls. A boolean flag was rejected for security reasons (D2).

## Project Structure

### Documentation (this feature)

```text
specs/008-bun-perf-scale/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── research-{profile,scale,ladder,index}.md
├── contracts/{perf-harness,scale-compose}.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source (touch list)

```text
scripts/perf-l1-harness.mjs        # NEW  L1 harness (US1, T006)
scripts/perf-ladder.sh             # NEW  L2/L3 load driver, never calls docker (US3, T021)
src/sse/handlers/chat.js           # request-scoped keyRecord/combo reuse (US1, T012)
src/sse/services/model.js          # fewer provider-node/combo queries (US1, T012)
src/lib/db/repos/{aliasRepo,combosRepo,nodesRepo}.js   # TTL caches + invalidation (US1, T009)
open-sse/config/providerModels.js  # indexed Map for findModel (US1, T010)
open-sse/handlers/chatCore.js      # use indexed lookups (read open-sse/AGENTS.md first) (US1, T010)
open-sse/translator/concerns/toolCall.js, formats/openai.js   # tool-activity bailout, clean-content fast path (US1, T011)
custom-server.js (+ .ts twin)      # APPROVED CODE CHANGE: TRUSTED_PROXY_CIDRS (US2, T016)
docker-compose.scale.yml           # NEW  overlay (US2, T017)
deploy/nginx-scale.conf            # NEW  LB config (US2, T017)
scripts/scale-smoke.sh             # NEW  smoke script (US2, T018)
tests/unit/{perf-harness,trusted-proxy,model-info-cache,cluster-two-instance}.test.js   # NEW (US1, US2)
specs/008-bun-perf-scale/results/ladder-host.md         # NEW  L0-L2 host ladder rows (US3, T022)
specs/008-bun-perf-scale/results/ladder-l3.md           # NEW  L3 multi-replica container rows (US3, T023)
specs/008-bun-perf-scale/ladder-results.md             # NEW  integrated ladder table & verdict (US3, T024 alone)
```

**Structure Decision**: Existing single-repo layout. No new packages. The `.ts` twin of `custom-server` is updated in lockstep, and the plan names `.js` as the runtime-loaded file (Wave 7.5 twin rule).

## Phases

| Phase | Story | Gate to leave the phase |
|---|---|---|
| A. Harness + baseline | US1 | `PERF_L1_OK baseline`, baseline JSON committed under `specs/008-bun-perf-scale/results/l1-baseline.json`, hotspot ranking confirmed or re-ranked against research (D3). Any unmeasured, invalid, or noisy run cannot certify improvement and must be rejected. |
| B. Slim + guard + after-measure | US1 | Goldens + `verify-*.mjs` + unit subset green (`guard-after.txt`), `db_queries_per_req` strictly lower, `l1-after.json` and `l1-compare.md` recorded, research D7 targets evaluated. Strict US1 complete. |
| C. Trusted proxy + overlay + two-instance | US2 | Approved `custom-server.js` (+ twin) code edit lands, `trusted-proxy.test.js` green with spoof controls, `cluster-two-instance.test.js` green, `docker compose config` valid. |
| D. Replica verification | US2 | Container subagent: delegated `scale-smoke.sh 2` cross-replica trip, single refresh, rotation, Redis-halt drill all pass, transcript in `results/scale-smoke.md`. Strict US2 complete. |
| E. Ladder re-run + verdict | US3 | T021 driver ready, T022 host rows in `results/ladder-host.md`, T023 container rows in `results/ladder-l3.md`, T024 integrates into `ladder-results.md` with honest verdict evaluated against D7 thresholds. Strict US3 complete. |

**Strict Sequential Execution**:
Order is strictly sequential: **US1 complete → US2 complete → US3 complete**.
- **No US2 authoring or implementation work may overlap or run alongside US1**. All US1 tasks (baseline, slim, guard, after-measure) must be 100% complete and verified before any US2 task begins.
- **No slim leaf or task may be marked READY or executed before Phase A produces and gates the measured baseline**.
- **No US3 ladder task may begin before US2 is strictly complete and verified** (including delegated Docker verification).
- **Disjoint results docs**: T022 writes `results/ladder-host.md`; T023 writes `results/ladder-l3.md`; T024 alone integrates them into `ladder-results.md`. T022 and T024 do not share ownership of `ladder-results.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Static estimate (8 ms split) is wrong | Phase A measures first. Re-rank before coding (D3). |
| TTL cache serves stale combos/aliases across replicas | 5 s hard TTL, `config_reload` invalidation, auth never cached across requests (D4). |
| Spoofed XFF through the LB | CIDR-scoped trust, LB overwrites XFF, spoof tests (D2). |
| SQLite writer contention at N replicas | Measured in the ladder (`busy_timeout` 5000). If it is the next bottleneck, the report says so. |
| Shared volume on unsupported FS | Documented as single-host only (D6). |
| Noisy host skews numbers | 5 runs, median of means, CV>15% flagged `noisy`. Any unmeasured, invalid, or noisy profile/ladder run cannot certify improvement and must be rejected or re-run (FR-008, SC-002, SC-005). |
| Missed performance thresholds | Evaluated against research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×). Missed thresholds reported honestly as a miss; never claim ceiling moved if targets are unmet. |

## Complexity Tracking

No constitution violations. Nothing to justify.

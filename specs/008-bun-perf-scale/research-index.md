# Research Index: 008-bun-perf-scale (node-1.1 integration)

Scope: Branch integration for research leaves 1.1.1–1.1.3. All three notes exist,
meet the content bar, carry plan handoffs, and agree on shared contracts.

## Note inventory

| Leaf | File | Size | Delivers |
|---|---|---|---|
| 1.1.1 | specs/008-bun-perf-scale/research-profile.md | ~15.6 KB, 7 `##` sections | L1 attribution 40/35/25 (model-info+DB / translation / middleware), slim plan (~2.2ms cache + ~1.5ms short-circuit), re-measure protocol, golden regression guard |
| 1.1.2 | specs/008-bun-perf-scale/research-scale.md | ~24.9 KB, 10 `##` sections | Full 7.5 shared-state inventory (semaphores, CIRCUIT_TRIP, round-robin INCR, OAuth SET NX EX, login limiter, auth-cache-with-SQLite-authority, quota Lua), local-vs-shared-vs-authoritative table, compose changes, risks |
| 1.1.3 | specs/008-bun-perf-scale/research-ladder.md | ~25.0 KB, 11 `##` sections | L0–L3 ladder, baseline inventory with measured L0 cells, UNMEASURED-with-cause L1–L3 cells, ceiling-moved verdict criteria (p50 −35%, 2-replica ≥1.6x), next-bottleneck hypotheses |

Each note attests `check_index_coverage` over every relied file (profile: 18 files,
scale: 20 files, ladder: 22 files; all `no_recorded_issue` / `metadata_match`) and
ends in a `## Handoff` (profile heading is `## ## Handoff` — cosmetic typo, content
intact) mapping findings to FR-001..FR-009 with `speckit-plan` action items.

## Shared-contract agreement

| Contract | Profile | Scale | Ladder | Verdict |
|---|---|---|---|---|
| Dashboard/gateway port 20128, `PORT`/`DASHBOARD_PORT` | assumed | `custom-server.js:10-36` | assumed | AGREE |
| `DATA_DIR` controls `data.sqlite`; temp `DATA_DIR` for bench runs; prod `~/.9router` untouched | temp DATA_DIR + mock executor | `paths.js`/`dataDir.js`, shared volume `9router-data:/app/data` | `mktemp -d`, `PORT=29128` isolation | AGREE |
| Fail-open quota/limit/lease/breaker paths, fail-closed auth (SQLite authority) | assumed via guard | verified per-subsystem with file:line cites | assumed via drill | AGREE |
| Bun-only (`bun:sqlite` sole driver), no Node fallback | stated | stated (`verify-driver-pruning.mjs`) | measured 50ms gate | AGREE |
| Webpack retained, no Turbopack re-litigation | — | — | — | AGREE (no note proposes otherwise) |
| Loopback-only XFF trust preserved | — | flags multi-replica failure mode, proposes `TRUST_PROXY=true` | — | AGREE with action item |
| Docker runs via subagents only; never `prune` | — | stated (FR-009) | stated (FR-009) | AGREE |

## Cross-note consistency

- Hotspot lists agree: profile (uncached `getComboByName`/`getModelAliases`/3×
  `getProviderNodes`, duplicate `getApiKeyByKey` in `chat.js:161+276`, double-hop
  translation) == ladder §7 (same files/lines) — independently derived, same verdict.
- Slim targets agree: in-memory/TTL caches + request-scoped memoization +
  translation short-circuits; regression guard = translator goldens + unit subset +
  `verify-*.mjs` baselines.
- Parent-verified by orchestrator against source 2026-10-24: `register()` direct-route
  mechanism (`open-sse/translator/index.js:21,104`), 3× providerNodes queries
  (`src/sse/services/model.js:45,51,57`), duplicate `getComboByName`+`getApiKeyByKey`
  (`src/sse/handlers/chat.js:161,205,276-277,281`), fixed `container_name: 9router`
  (`docker-compose.yml:6`), loopback-only XFF (`custom-server.js:133-142`).

## Known divergences for plan phase (non-blocking)

1. **Harness filename**: profile proposes `scripts/bench-l1.mjs`, ladder proposes
   `scripts/perf-l1-harness.mjs`. Same protocol intent. Plan phase picks one name.
2. **`TRUST_PROXY` is a small code touch**: scale note's headline fix
   (`custom-server.js:136` honoring `TRUST_PROXY=true`) is a ~3-line env-gated change,
   not zero-diff. It preserves loopback-default security (fail-closed when unset).
   Plan phase scopes it as config-surface work inside US2.

## Handoff readiness

All FR-001..FR-009 have at least one owning note; every UNMEASURED cell carries cause;
no note contradicts another on shared contracts. Ready for `speckit-clarify` (no
[NEEDS CLARIFICATION] markers in spec) → `speckit-plan`.

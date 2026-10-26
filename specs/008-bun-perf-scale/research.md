# Phase 0 Research: 008-bun-perf-scale

Inputs: spec.md, research-profile.md, research-scale.md, research-ladder.md, research-index.md (all gates met).

## D1 — Harness filename

- **Decision**: `scripts/perf-l1-harness.mjs` (L1 in-process), with `scripts/perf-ladder.sh` as the L2/L3 driver.
- **Rationale**: Matches the L0–L3 ladder vocabulary the ladder note defines. `bench-l1.mjs` is dropped.
- **Alternatives**: `bench-l1.mjs` (profile note) — rejected, no ladder-tier naming.

## D2 — `TRUST_PROXY` scope

- **Decision**: Do NOT add a boolean `TRUST_PROXY=true`. Add `TRUSTED_PROXY_CIDRS` (comma-separated CIDRs). Unset or empty means loopback-only, which is today's behavior byte-for-byte.
- **Rationale**: A boolean trusts any TCP peer, so an exposed replica would let a client spoof `X-Forwarded-For` and evade the login limiter. CIDR scoping to the compose network keeps the trust boundary explicit. `CLAUDE.md` makes `custom-server.js` XFF stripping a security invariant.
- **Scope**: ~10 lines in `custom-server.js` (CIDR parse + match), unit-tested with spoof negative controls. Replicas are never published to the host; only the LB is.
- **Alternatives**: boolean flag (rejected, spoofable); do nothing (rejected, all clients collapse to the LB IP and the login limiter locks everyone out at once).

## D3 — Baseline before slimming

- **Decision**: US1 starts with a measured baseline. The 3.2/2.8/2.0 ms split in `research-profile.md` is a static-trace estimate. No saving is claimed until the harness measures it.
- **Rationale**: FR-008 forbids fabricated numbers. `research-ladder.md` marks L1 latency `UNMEASURED`.
- **Consequence**: If the measured baseline is far below ~8 ms, or the hotspots differ, the slim list is re-ranked before any code change.

## D4 — Cache strategy (cluster-safe)

- **Request-scoped memo** (zero cross-process risk): resolve `keyRecord` and the combo once in `handleChat`, then pass them into `handleSingleModelChat` and `getKeyAccessContext`. The record is read once per request, so there is no staleness window and fail-closed auth is unchanged.
- **Process-level TTL caches** for `modelAliases`, `providerNodes` by type, and `getComboByName`.
  - Invalidated on local writes and on `khatam:events:config_reload`.
  - A hard TTL cap of 5 s bounds cross-replica staleness if a pub/sub message is lost or Redis is down.
  - They follow the existing `settingsCache` pattern (`settingsRepo.js:175-213`).
- **Never cached across requests**: API-key validity/lifecycle. SQLite stays authoritative (the Wave 7.5 `apiKeyCache` contract).
- **Indexed `findModel`**: a `Map` built at module load in `providerModels.js` replaces the six linear scans in `chatCore.js`.

## D5 — Direct `openai↔claude` routes: deferred

- **Decision**: Out of scope for this wave. Optional follow-up task, taken only if the measured translation share exceeds 30% of L1 after the cache work.
- **Rationale**: The translator is lossy for thinking blocks, tool ids and images. The profile note's saving is an estimate. This wave only touches the hotspots that are measured and cheap and have golden coverage.
- **In scope**: the tool-activity early bailout in `toolCall.js` and the clean-content fast path in `filterToOpenAIFormat`, both gated by the goldens.

## D6 — Compose scale shape

- **Decision**: New overlay `docker-compose.scale.yml`. The base `docker-compose.yml` is not edited.
- **Contents**: no `container_name` on the app service, `deploy.replicas`, a `/api/health` healthcheck (curl is already in `Dockerfile.bun`), an nginx LB on 20128 that overwrites `X-Forwarded-For` with `$remote_addr`, and `TRUSTED_PROXY_CIDRS` set to the compose network subnet.
- **Single-host only**: replicas share the `9router-data` volume. SQLite WAL needs POSIX locks and shared memory, so NFS/EFS and multi-host are unsupported and documented as such.
- **Redundant per-replica timers** (background refresh, 60 s WAL checkpoint): the refresh lock already prevents duplicate upstream calls. The checkpoint timer is left as-is and watched in the ladder.

## D7 — Verdict thresholds

Adopted from the ladder note as targets, not promises:

| Criterion | Threshold |
|---|---|
| L1 p50 | ≥35% lower |
| L1 p95 | ≥25% lower |
| 2 replicas vs 1 | ≥1.6× throughput |
| Goldens, `verify-*.mjs` | 100% green |
| Redis halted | no request-path throw |

A miss is reported as "ceiling did not move" with the measured next bottleneck, not massaged.

## D8 — L2/L3 measurement

- L1 and L2 run on the host under Bun with a mock upstream and a temp `DATA_DIR`.
- L3 (compose) runs ONLY via subagents using the `w75-compose-smoke.sh` pattern. The main agent never runs docker, and never runs `prune`.
- If a cell cannot be run, it is `UNMEASURED` with a cause (FR-008).

## Unknowns resolved

No `NEEDS CLARIFICATION` remains.

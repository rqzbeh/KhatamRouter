# Feature Specification: Wave 8 — Bun Hot-Path Profile, Multi-Process Scale, Ladder Re-Run

**Feature Branch**: `spec/008-bun-perf-scale`
**Created**: 2026-10-24
**Status**: Draft
**Input**: User description: "Bun improvement plan, using the harness that's already built: 1. Profile the ~8ms hot path — find where the per-request cost lives (translation, getModelInfo, middleware), slim it, re-measure L1. 2. Multi-process Bun behind Redis — compose replicas sharing the 7.5 cluster-safe state (leases, trips, rotation). Config change, not a rewrite. 3. Re-run the ladder — prove the ceiling moved with numbers."

## User Scenarios & Testing

### User Story 1 — Hot-path profile, slim, re-measure (Priority: P1)

An operator serving chat completions through the gateway wants to know exactly where per-request cost lives (request translation, model-info lookup, middleware/edge glue) based on measured exclusive phase shares over the measured L1 total rather than static ~8ms estimates, sees the cost slimmed down, and sees a before/after L1 measurement proving the saving.

**Why this priority**: Everything else (replicas, ladder claims) rests on a measured, attributed breakdown. Without it any "improvement" is a guess.

**Independent Test**: Run the documented L1 profile procedure before and after the slimming change; the after-run shows the same request set served with lower attributed cost and no behavior change (golden translator round-trips + unit subset green). Any unmeasured, invalid, or noisy profile cannot certify improvement.

**Acceptance Scenarios**:

1. **Given** a fixed representative request set, **When** the L1 profile procedure runs, **Then** it attributes per-request cost across translation, model-info lookup, and middleware/edge glue with file-level hotspots based on measured exclusive phase shares over the measured L1 total.
2. **Given** the profiled hotspots, **When** the slimming change lands, **Then** the same request set produces identical responses (translator round-trip goldens pass) with lower measured cost, evaluated against research D7 targets (p50 reduction ≥35%, p95 reduction ≥25%).
3. **Given** a slimming candidate that changes behavior, **When** regression checks run, **Then** the change is rejected (goldens or unit subset red blocks it).
4. **Given** a profile run that is unmeasured, invalid, or noisy, **When** evaluated, **Then** it cannot certify improvement and must be rejected.

---

### User Story 2 — Multi-process Bun replicas sharing cluster-safe state (Priority: P2)

An operator runs two or more gateway processes behind the compose setup sharing one Redis, and every cluster-safety decision made by one replica (leases/concurrency slots, circuit-breaker trips, combo/account rotation) is respected by the others. A Redis outage degrades to previous single-process behavior without dropping requests. To support reverse-proxy load balancing across replicas without trusting untrusted peers, a narrow opt-in `TRUSTED_PROXY_CIDRS` code change in `custom-server.js` (and twin) is authorized to trust forwarding headers from specified proxy CIDRs while strictly preserving the loopback-only default when unset/empty, treating invalid CIDR entries strictly (logged and ignored, never expanding trust), and enforcing spoof protection.

**Why this priority**: Wave 7.5 made shared state cluster-safe; this story turns that into actual horizontal scale. It is a compose/config change with a narrow, security-audited proxy trust addition, not an engine rewrite.

**Independent Test**: Bring up two gateway replicas against one Redis in compose; trip a breaker / grab a lease / rotate a combo on replica A and observe replica B honoring it; halt Redis and confirm traffic still flows degraded; verify spoof negative controls and unset fallback for `TRUSTED_PROXY_CIDRS`.

**Acceptance Scenarios**:

1. **Given** two replicas sharing Redis, **When** one replica trips a circuit breaker, **Then** the other replica gates dispatches to that provider without needing its own failure first.
2. **Given** two replicas sharing Redis, **When** both contend for one single-use credential refresh, **Then** exactly one refresh reaches the provider and the other reuses the result.
3. **Given** two replicas sharing Redis, **When** combo/account rotation advances on one replica, **Then** the other replica continues the rotation instead of restarting it.
4. **Given** Redis is halted, **When** traffic flows, **Then** each replica serves with previous single-process behavior, never throws on the request path, and logs at most one warning per outage.
5. **Given** `TRUSTED_PROXY_CIDRS` is unset or empty, **When** requests arrive from non-loopback peers with `X-Forwarded-For` or `X-Real-IP`, **Then** the server ignores those forwarding headers and derives client IP strictly from the TCP peer socket exactly as master.
6. **Given** `TRUSTED_PROXY_CIDRS` is set to trusted proxy CIDRs, **When** a request arrives from a TCP peer outside those CIDRs attempting to spoof `X-Forwarded-For`, **Then** the spoofed header is ignored and client IP is derived from the TCP peer socket (spoof negative control); if an entry is invalid, it is logged and ignored so the configuration is strictly more restrictive, never less.

---

### User Story 3 — Ladder re-run proves the ceiling moved (Priority: P3)

An operator (or reviewer) sees one ladder table: single-replica baseline vs multi-replica numbers (latency percentiles, throughput, replica count), measured with the same method, evaluating against research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×) to prove whether the ceiling moved after stories 1–2.

**Why this priority**: Numbers are the acceptance proof for the whole plan. It depends on stories 1–2 being real, so it runs last.

**Independent Test**: Run the documented ladder procedure (baseline method + multi-replica method) and produce the results table; every cell is either a measured number with its method or explicitly marked UNMEASURED with the reason; any unmeasured or noisy run cannot certify improvement.

**Acceptance Scenarios**:

1. **Given** the ladder procedure, **When** run against the single-replica baseline, **Then** it records latency/throughput with the exact command and environment noted.
2. **Given** the same procedure, **When** run against the multi-replica compose setup, **Then** it records the same metrics plus replica count.
3. **Given** both runs complete, **When** compared, **Then** the report evaluates results against research D7 thresholds (p50 reduction ≥35%, p95 reduction ≥25%, 2-replica throughput ≥1.6×), states plainly whether the ceiling moved or reports missed thresholds honestly (never claiming the ceiling moved if unmet), and identifies what bottlenecks next — or marks the comparison UNMEASURED with cause.

---

### Edge Cases

- What happens when Redis is reachable at startup but dies mid-ladder? Replicas must degrade per US2-4, and the ladder row must note degraded mode rather than silently mixing numbers.
- How does the system handle a profile run on a machine with noisy neighbors? The L1 procedure must note environment and repeat count; any unmeasured, invalid, or noisy profile cannot certify improvement and must be rejected or re-run.
- What happens when a slimming candidate touches a binary/protobuf path (kiro EventStream, cursor protobuf, commandcode NDJSON) that doesn't round-trip through the translator? It is rejected unless that path's own executor goldens cover it.
- What happens when compose replica count is raised but host CPU is saturated? The ladder must report host saturation instead of claiming "replicas don't help."
- What happens when `TRUSTED_PROXY_CIDRS` contains an invalid or malformed CIDR? Startup logs one error and ignores that entry, ensuring the effective configuration is strictly more restrictive, never less.

## Requirements

### Functional Requirements

- **FR-001**: The plan MUST produce an L1 profile attributing per-request cost across translation, model-info lookup, and middleware/edge glue with file-level hotspots based on measured exclusive phase shares over the measured L1 total (not static ~8ms estimates).
- **FR-002**: The plan MUST slim at least one measured hotspot and re-measure L1 on the same request set and method.
- **FR-003**: Slimming MUST NOT change request/response behavior (translator round-trip goldens and the unit subset stay green).
- **FR-004**: The compose setup MUST support running 2+ gateway replicas against one shared Redis with no engine rewrite; a narrow opt-in `TRUSTED_PROXY_CIDRS` code change in `custom-server.js` (and twin) is authorized to trust proxy CIDRs for `X-Forwarded-For` while preserving the loopback-only default when unset/empty, enforcing spoof negative controls, and treating invalid CIDR entries strictly (logged and ignored, never expanding trust).
- **FR-005**: Leases/concurrency slots, circuit-breaker trips, and combo/account rotation decisions MUST be honored across replicas via the Wave 7.5 cluster-safe state.
- **FR-006**: Redis unavailability MUST degrade to previous single-process behavior without throwing on the request path (fail-open for quota/limit paths, fail-closed for auth per the resilience contract).
- **FR-007**: The ladder MUST report single-replica baseline and multi-replica results with identical metrics, plus replica count, command, and environment for each run.
- **FR-008**: Any unmeasurable cell, invalid/noisy run, or skipped live run MUST be marked UNMEASURED with cause and handoff, and CANNOT certify performance improvement, never silently dropped or fabricated.
- **FR-009**: Live container verification MUST be delegated to subagents (never `docker system prune` / `volume prune`), per repo convention.

### Key Entities

- **L1 profile**: The attributed per-request cost breakdown (translation / model-info / middleware) based on measured exclusive phase shares over the measured L1 total, plus the exact request set, command, and environment that produced it.
- **Cluster-safe state**: The shared decisions replicas must honor — concurrency leases, circuit-breaker trips, combo/account rotation position, single-use refresh outcome.
- **Ladder table**: The before/after comparison (baseline row vs multi-replica row) with latency percentiles, throughput, replica count, and the ceiling-moved verdict evaluated against research D7 thresholds.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Operator can point to the hotspot file(s) responsible for the cost based on measured exclusive phase shares over the measured L1 total (not static ~8ms estimates), identifying a hotspot majority as >50% of attributable overhead or reporting that no single majority hotspot exists.
- **SC-002**: After slimming, the same request set completes measurably faster with zero behavior regressions (goldens + unit subset green), evaluated against research D7 targets (p50 reduction ≥35%, p95 reduction ≥25%); missed thresholds are reported honestly as a miss, and any unmeasured, invalid, or noisy profile cannot certify improvement.
- **SC-003**: Two replicas behind one Redis honor each other's breaker trips, refresh outcomes, and rotation position in a live (or faithfully faked) two-instance test.
- **SC-004**: With Redis halted, the gateway keeps serving with previous single-process behavior and no request-path exceptions.
- **SC-005**: The ladder table shows baseline vs multi-replica numbers measured the same way, evaluating 2-replica throughput against the research D7 target of ≥1.6×; the report provides a plain-language verdict on whether the ceiling moved based on D7 thresholds (reporting missed thresholds honestly, never claiming the ceiling moved if unmet) and documents what bottlenecks next.

## Assumptions

- Bun-only runtime holds (`bun:sqlite` sole driver, WAL `busy_timeout = 5000`); no Node fallback is reintroduced for perf work.
- Redis-default posture holds (Wave 7.5 compose, `khatam:` prefix, fail-open quota/limit paths, fail-closed auth).
- Webpack remains the bundler; no Turbopack re-litigation inside this plan.
- `custom-server.js` loopback-only forwarding trust by default (unless opt-in `TRUSTED_PROXY_CIDRS` is configured) and port contract (dashboard/gateway on 20128, gateway reservation on 20129) are preserved.
- `~/.9router` usage/log split vs `DATA_DIR` db location is preserved; profile/ladder runs use a temp `DATA_DIR` so production data is never touched.

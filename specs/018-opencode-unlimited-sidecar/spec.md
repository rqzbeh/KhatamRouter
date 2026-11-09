# Feature Specification: Bundled OpenCode Unlimited Egress + Working Proxy Rotation

**Feature Branch**: `018-opencode-unlimited-sidecar`
**Created**: 2026-11-08
**Status**: Draft
**Input**: User description: "integrate https://github.com/ebouther/opencode-unlimited-proxy or https://github.com/ElectronBreach/opencode-unlimited-usage as a proxy server or replacement for the opencode free tier so it can bypass daily quota as well. next problem is I added free proxy in one PR, and although it seems like merged, I still do not see it as an option to add in proxy pools!, and even check out currently implemented psiphon solution, like rn when a request goes through psiphon, and quota is exhausted or blocked, it does not automatically rotate on error! I expected it to have 2-3 connection on hold and upon error, it automatically shift to another one so user does not see any timeout or error, and then replaces those ip of connections in the background as well. ... make sure to include them in docker image as well, so the binary must be available on both architectures, without needing user to download or setup anything, production ready out of the box."

> **Lineage**: extends Spec 014 (psiphon rotating proxy pool) and Spec 017 free-proxy ingestion. Additive only: the psiphon fail-closed contract, the `strictProxy` guarantee, and Secret-free egress attribution stay intact.

---

## User Scenarios & Testing

### User Story 1 — OpenCode free tier stops hitting the daily quota (Priority: P1)

As an operator, I want the router to optionally send OpenCode free-tier traffic through a **bundled** local egress daemon that holds a pool of Cloudflare WARP IPv6 `/64` exits and swaps a burned exit instantly, so my daily free quota stops being the ceiling and the client never sees a 429.

OpenCode counts quota per IPv6 `/64` block. The bundled daemon (`opencode2api`, GPL-3.0) registers independent WARP exits, spreads requests across them, evicts any exit answered with 429/403, and re-registers a replacement in the background while a warm spare takes the traffic.

**Why this priority**: this is the actual quota bypass. No other story matters without it.

**Independent Test**: create an `opencode2api` pool, run a streamed completion through `opencode` and confirm (a) the response is 200 and streamed, (b) `/api/proxy-pools/[id]/status` reports more than one active exit, (c) an injected 429 produces a successful response without a client-visible error.

**Acceptance Scenarios**

1. **Given** the daemon is not running, **When** a request selects an `opencode2api` pool, **Then** the daemon is started, becomes ready, and the request is served through it.
2. **Given** an active pool with warm spares, **When** upstream answers 429, **Then** the request succeeds after a retry with no tunnel teardown by the gateway and no error to the client.
3. **Given** the daemon fails to start, **When** a strict pool is selected, **Then** the request fails closed (503) and never leaves over the direct IP.
4. **Given** the daemon crashed, **When** the watchdog observes a degraded `/healthz`, **Then** it restarts the daemon in the background and the pool returns to ready without operator action.

### User Story 2 — Bundle, pin and verify the daemon in the image (Priority: P1)

As an operator pulling the published image, I want the daemon binary already inside the image for `amd64` and `arm64`, version-pinned with a per-arch SHA-256 checked at build time, so nothing has to be downloaded or configured at runtime and an upstream swap cannot silently change what I run.

**Independent Test**: the release manifest is the single source of truth; the pin test fails if the Dockerfiles' `ARG`s drift from it; a build smoke check asserts the binary is executable.

### User Story 3 — Psiphon swaps to a pre-warmed tunnel instead of stalling (Priority: P1)

As an operator, when a psiphon egress is burned (429), blocked (403 `FreeTierError`) or dies in transport, I want an **already established** standby tunnel promoted instantly and the vacated slot refilled in the background, so rotation costs no readiness wait and 2–3 tunnels always sit on hold.

**Independent Test**: with a warm ring of 2, a 429 triggers `rotate()` in under 250 ms of gateway time and the retried request uses a different exit IP and region; ring length returns to its target afterwards.

### User Story 4 — Free proxy sources are actually reachable from the proxy-pools screen (Priority: P2)

As an operator, I want the free-proxy source card visible on the Proxy Pools page where new pools are created, so the merged ingestion feature is discoverable rather than dead code.

**Independent Test**: the proxy-pools page mounts the card; the free-proxy policy API round-trips from it.

### User Story 5 — The new type is a first-class pool everywhere (Priority: P2)

`opencode2api` must be creatable, listable, testable, rotatable, status-visible and considered "usable" by listing completeness, exactly like `psiphon`.

---

## Functional Requirements

### Sidecar daemon (FR-018-01..09)

- **FR-018-01** New proxy pool type `opencode2api` with managed URL `opencode2api://managed`, strict by construction.
- **FR-018-02** Pool config `{ poolSize 1..32 (default 3), warmStandby 0..ring (default 2), retryAttempts 1..6 (default 4) }`, validated and clamped on create/update, defaults required.
- **FR-018-03** A supervisor module spawns the daemon on loopback with a generated per-process API key, a generated config file in the data dir, `stdio` piped, and readiness defined strictly by `GET /healthz` returning `ready: true`.
- **FR-018-04** Readiness is bounded (configurable timeout, default 90 s) and the spawned port is allocated per pool and persisted in memory only.
- **FR-018-05** A watchdog re-checks health on an interval; `degraded`/`unavailable`/dead process triggers a bounded restart with crash-loop protection (no infinite respawn; give up after 3 process exits inside 30 s and report `failed`).
- **FR-018-06** Secrets never leak: the generated key is returned only through the resolver payload and status; logs mask it.
- **FR-018-07** The daemon config is written with the pool's `poolSize`/`warmStandby` mapping and `anonymous: true`, `proxies: ["direct"]`, `free_only: true`.
- **FR-018-08** Stop/delete/deactivate tears down the process and removes its temp files; shutdown hooks clean every pool.
- **FR-018-09** Flow control: every upstream 429/403 on a sidecar request may be retried up to `retryAttempts` without restarting the daemon.

### Egress rewriting

- **FR-018-10** `resolveConnectionProxyConfig` returns `{ source:"opencode2api", opencodeSidecarUrl, opencodeSidecarKey, opencodeSidecarPoolId, opencodeSidecarGeneration, strictProxy:true, connectionProxyUrl:"" }`; unavailable start fails closed.
- **FR-018-11** `proxyAwareFetch` rewrites an `opencode2api` request to the sidecar base URL, strips the `/inference` path segment, and replaces `Authorization` with the local key. No request body re-serialization; a string body is resent byte-identically.
- **FR-018-12** The TLS-fingerprint adapter is bypassed for sidecar requests (the daemon is the impersonator) but the relay path keeps working when the adapter is absent.

### Psiphon warm ring (FR-018-13..19)

- **FR-018-13** Pool option `warmStandby` (default 2, clamp 0..4) counts extra pre-established tunnels held on standby.
- **FR-018-14** Standby tunnels are established with the same candidate/latency/exit-IP verification as the active one, and are excluded from the "same IP after rotation" check until promoted.
- **FR-018-15** `rotate()` promotes an existing standby in the request path (target ≤ 250 ms when a standby exists), bumps the generation, and schedules a background refill; with no standby it keeps today's synchronous behaviour.
- **FR-018-16** Refill is single-flight per pool, picks regions not used by live exits, and stops at the configured target.
- **FR-018-17** Idle standby beyond the target is pruned; promoted/discarded tunnels have their temp config and data dir removed.
- **FR-018-18** Warm tunnels never satisfy `ensureTunnel` when unverified (missing exit IP ⇒ not eligible).
- **FR-018-19** Rotation attempts per request rise from 2 to 4 and a rotation that did not change the generation is not counted against the budget.

### Discoverability (FR-018-20..22)

- **FR-018-20** `FreeProxySourcesCard` is mounted on `/dashboard/proxy-pools`.
- **FR-018-21** `opencode2api` appears in the create/edit type selector, the status/rotate/test endpoints and `VALID_PROXY_TYPES` in both registry copies.
- **FR-018-22** The pool test endpoint for `opencode2api` reports readiness plus active/standby exit counts and never marks the pool active on a failed probe.

### Packaging (FR-018-23..26)

- **FR-018-23** `src/lib/network/opencode2api/opencode2apiRelease.json` pins version, per-arch URL, sha256 and size.
- **FR-018-24** Both `Dockerfile` and `Dockerfile.bun` declare `ARG OPENCODE2API_VERSION` and per-arch sha256, download, verify, extract to `/usr/local/bin/opencode2api`, and copy it into the runner stage.
- **FR-018-25** A build smoke check asserts `/usr/local/bin/opencode2api` is executable.
- **FR-018-26** A unit test fails when the Dockerfile ARGs drift from the manifest (same pattern as the regionhop pin).

---

## Non-Functional Requirements

- **NFR-018-01** Plain JS ESM, Bun-only, no new runtime dependency.
- **NFR-018-02** Strict pools fail closed; a broken daemon must never silently egress direct for a strict pool.
- **NFR-018-03** No outbound calls from the gateway itself for the sidecar path; only loopback.
- **NFR-018-04** Bounded resources: pool size and warm ring are clamped; every spawned process is tracked and terminated.
- **NFR-018-05** State stays in memory; nothing secret is persisted.
- **NFR-018-06** GPL-3.0 attribution for the bundled binary in `docs/`, the README and the module header.

## Key Entities

`opencode2api` pool (type, config, active process, generation), warm-ring entry (child, port, region, exitIp, dataDir, generation, readyAt), release manifest entry.

## Success Criteria

- **SC-018-01** A sidecar-pool request that receives 429 on the first attempt returns a 200 to the client.
- **SC-018-02** With a warm standby present, promotion is ≤ 250 ms of gateway time and the new exit IP differs.
- **SC-018-03** After a rotation, ring length returns to the target within one refill cycle.
- **SC-018-04** Both Dockerfiles pass the pin test and contain the executable smoke check.
- **SC-018-05** `/dashboard/proxy-pools` renders the free-proxy card.
- **SC-018-06** Existing psiphon, strict-proxy and free-tier suites stay green.

## Out of Scope

Host-network mode, `NET_ADMIN`, regional exit pinning for the daemon, persisting generated keys, ARM cross-build on CI runners beyond the existing matrix, and any billing/usage accounting inside the daemon.

## Assumptions

- `opencode2api` needs no root, no TUN device and only outbound UDP/2408 for WARP; on hosts without it, it degrades to `direct`.
- The upstream project keeps publishing signed-by-checksum release tarballs per arch.
- `/healthz` exposes `ready`, `warp.active`, `warp.standby`, `warp.cooling` as observed on v1.4.5.
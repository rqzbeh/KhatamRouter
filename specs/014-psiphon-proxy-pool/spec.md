# Spec 014: Psiphon Rotating Proxy Pool

**Feature Branch**: `spec/014-psiphon-proxy-pool`
**Status**: Planned
**Classification**: Networking / anti-ban / proxy pools (additive, off by default)

## 1. Problem Statement & Scope

OpenCode Free (`oc/*`, `noAuth`) flags egress IPs once total requests/tokens pass an upstream threshold.
Observed signatures (code + live logs from the production VPS, 94 min window, 49 `oc/*` failures, all `429`):

- `429 FreeUsageLimitError` / `free_rate_limited` (quota; growing reset-after delays) — `open-sse/executors/opencode.js:191`
- `403 FreeTierError` (egress IP flagged) — `open-sse/utils/proxyFetch.js:361`
- transport failure (`connect timeout`, `502 BAD_GATEWAY`) — `open-sse/executors/base.js:178`

Existing proxy pools are static URLs. The only IP-burn reaction is `replayFreeTierRejectionDirect`, which replays on the
**real server IP** (leaks it) and never rotates. For OpenCode Free the loop in `src/sse/handlers/chat.js` also exits on first
failure because `markAccountUnavailable` returns `shouldFallback:false` for `connectionId === "noauth"`
(`src/sse/services/auth.js:249`).

**Objective**: a new proxy-pool type `psiphon` that supervises local `psiphon-tunnel-core` `ConsoleClient` sidecars,
connects to the lowest-latency country, **holds** that tunnel while requests succeed, and on burn signals tears it down
and reconnects to a **new IP and new country**.

### In scope
- `psiphon` pool type (create/edit/test/delete via existing `/api/proxy-pools`), status + manual rotate endpoint, dashboard UI.
- Tunnel manager (spawn, readiness, best-latency pick, hold, rotate, verify-new-IP, shutdown).
- Burn classifier and rotate-and-retry hook in the chat loop; works for `noAuth` free providers **and** any provider bound to a psiphon pool.
- Proactive rotation on per-IP request/token thresholds.
- Docs (`docs/PSIPHON.md`), tests, gates.

### Explicit out of scope (tracked debt, not silent skips)
- Bundling or auto-downloading the Psiphon binary (GPL-3.0; user supplies it). Installer script: deferred.
- Sharing one tunnel across cluster workers (`KHATAM_WORKERS>1`): each worker owns its own tunnel(s); cross-worker coordination via Redis deferred.
- Psiphon sponsor credentials: user-supplied (`PropagationChannelId`, `SponsorId`, server-list keys); never committed.

## 2. User Stories

### US1: Stay unflagged on OpenCode Free (P1)
As an operator, I want OpenCode Free traffic to leave through a Psiphon tunnel that rotates when flagged, so that free usage keeps working.

### US2: Best-ping country, sticky while healthy (P1)
As an operator, I want the tunnel to pick the fastest country and stay on it while requests succeed, so that latency is low and the IP stays stable (stable IP = fewer flags).

### US3: Clean rotation on burn (P1)
As an operator, I want a 429, FreeTierError, transport failure or usage threshold to disconnect and reconnect to a different country with a verified different exit IP, so that the next request is not tied to the burned IP.

### US4: Never leak the real IP (P1)
As an operator, I want psiphon pools to fail closed (no direct replay, no direct fallback), so that the server's real IP is never exposed to the provider.

### US5: Control from the dashboard (P2)
As an operator, I want to create a psiphon pool, see region/IP/generation/usage, and press "Rotate now".

## 3. Functional Requirements

### FR-014-01 Pool type
`"psiphon"` MUST be accepted by `POST/PUT /api/proxy-pools` (`VALID_PROXY_TYPES`). `proxyUrl` is optional for it (stored as `psiphon://managed`). Pool `data.psiphon` = `{ regions: string[] (ISO alpha-2, `^[A-Z]{2}$`, default empty = any), probeCandidates: int 1..5 (default 3), maxRequestsPerIp: int>=0 (default 0=off), maxTokensPerIp: int>=0 (default 0=off) }`. Invalid values MUST yield 400.

### FR-014-02 Fail closed
Psiphon pools MUST always resolve with `strictProxy=true` regardless of stored value. `replayFreeTierRejectionDirect` MUST NOT run for them. If the tunnel cannot be established within `PSIPHON_READY_TIMEOUT_MS` (default 45000) the request MUST fail 503 and MUST NOT go direct.

### FR-014-03 Operator-controlled binary and config
Binary path ONLY from env `PSIPHON_BIN` (default `$DATA_DIR/bin/ConsoleClient`); base config ONLY from `PSIPHON_CONFIG_FILE` (default `$DATA_DIR/psiphon/client.config.json`). Neither is settable through any API. Spawn MUST use an argv array, no shell, a scrubbed environment (no gateway secrets), and `ListenInterface=127.0.0.1`. Missing binary/config MUST surface a clear actionable error (503 + dashboard status `failed`), never a crash.

### FR-014-04 Tunnel establishment & best ping
`ensureTunnel` MUST start `probeCandidates` ConsoleClient instances in parallel, each with a distinct `EgressRegion` (random from `regions`, or from `AvailableEgressRegions` when `regions` is empty), own `DataRootDirectory`, `LocalHttpProxyPort=0`, `DisableLocalSocksProxy=true`. Readiness = `ListeningHttpProxyPort` notice AND (`Tunnels.count>=1` or `ActiveTunnel`). It MUST probe each ready instance through its HTTP proxy (`http://cp.cloudflare.com/generate_204`), keep the lowest latency, and terminate the rest. Concurrent callers MUST share one in-flight establishment (single-flight).

### FR-014-05 Sticky hold
While no burn signal occurs and thresholds are not exceeded, the same tunnel (same generation) MUST be reused. A dead child process MUST be detected (exit event) and the tunnel re-established as a rotation with reason `process_exit`.

### FR-014-06 Burn classification
Pure function `shouldRotateOn({status, error})` MUST return true for: `429`; `403` whose error/body contains `FreeTierError` or `FreeUsageLimit`; `502`/`503` produced by transport failure (`connect timeout`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `Proxy`), and MUST return false for 400/401/404/other 403 and success.

### FR-014-07 Rotate-and-retry
In `src/sse/handlers/chat.js`, after `handleChatCore` fails with a burn signal and the request used a psiphon pool, the handler MUST `rotate()` (awaiting a new verified IP) and retry the same request, at most `maxRotationsPerRequest` (2) times, then return the last failure. This MUST also apply to the `noauth` virtual credential (bypassing the `shouldFallback:false` early-out). Non-psiphon behaviour MUST be unchanged.

### FR-014-08 Rotation semantics
`rotate()` MUST: terminate the current child, delete its data dir, pick a region different from the current one and the last 3 used (if alternatives exist), establish per FR-014-04, read exit IP through the new proxy, and if the IP equals the previous IP retry up to 3 times with a fresh data dir + different region. It MUST be single-flight and generation-guarded: callers passing a `seenGeneration` older than the current generation MUST NOT trigger another rotation (N concurrent 429s => one rotation).

### FR-014-09 Proactive rotation
`recordUsage(poolId,{requests,tokens})` MUST accumulate per generation; when `maxRequestsPerIp`/`maxTokensPerIp` (if >0) is reached the NEXT `ensureTunnel` MUST rotate first with reason `threshold`.

### FR-014-10 Lifecycle
Tunnels start lazily on first use. `stopAll()` MUST run on process `exit`/`SIGTERM`/`SIGINT`; no orphan ConsoleClient may survive a graceful shutdown. Deleting/deactivating a pool MUST stop its tunnel.

### FR-014-11 API & UI
`GET /api/proxy-pools/[id]/status` -> manager status; `POST /api/proxy-pools/[id]/rotate` -> manual rotate (psiphon pools only, else 400). `POST .../test` for psiphon establishes the tunnel and reports region, latency and exit IP. Dashboard proxy-pools page MUST offer type psiphon (regions, candidates, thresholds), show state/region/IP/generation/usage, and a "Rotate now" button. All behind existing dashboard auth (`/api/proxy-pools` is already protected).

### FR-014-12 Docs
`docs/PSIPHON.md` MUST document env vars, config file format, building `ConsoleClient` (`CGO_ENABLED=0 go build`), GPL-3.0 boundary (sidecar, not bundled), Docker volume mount, cluster-worker caveat, and Psiphon ToS/legal responsibility of the operator.

## 4. Success Criteria

- SC-014-01 Unit tests with a fake ConsoleClient prove: best-latency pick, sticky hold, rotate to different region + IP, single-flight, generation guard, threshold rotation, process-exit recovery, shutdown kills children.
- SC-014-02 Integration test proves a 429 and a 403 FreeTierError on a psiphon-bound `noauth` request trigger rotate+retry (<=2), and success after rotation returns 200; a non-psiphon pool is untouched.
- SC-014-03 Test proves no direct egress occurs when the tunnel is unavailable (503, `fetch` to origin never called without proxy).
- SC-014-04 No new runtime dependency; no binary committed; no `shell:true`/`exec`.
- SC-014-05 Existing suites `strict-proxy-enforcement`, `opencode-freetier-direct-replay`, `opencode-tls-client`, `wave75-redis-accelerators` stay green; Verify CI jobs green.
- SC-014-06 Real-world check (operator, post-merge, not a CI gate): with a real ConsoleClient + config, `test` endpoint returns a Psiphon exit IP != server IP.

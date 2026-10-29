# Research: Psiphon Rotating Proxy Pool

All findings from primary sources fetched 2026-10-29 plus this repo's code. "Unverified" items are called out.

## Failure signatures (OpenCode Free)
| Signal | Source | Meaning |
|---|---|---|
| 429 `FreeUsageLimitError` | `open-sse/executors/opencode.js:191`, `specs/012` | per-session/IP quota, growing reset-after |
| 429 `free_rate_limited` | prod VPS log (49x `oc/*` 429 in 94 min) | shared free capacity limit |
| 403 `FreeTierError` | `open-sse/utils/proxyFetch.js:361` | egress IP flagged (#4983: proxy 403, direct 200) |
| `[ProxyFetch] Proxy failed ... fetch connect timeout` | prod VPS log (18x) | transport failure |
Local `~/.9router` DB held no OpenCode data; no `FreeTierError` in the VPS window (read-only SSH, logs only).

## Repo seams (graph + reads)
- Pool resolution: `src/lib/network/connectionProxy.js` `resolveConnectionProxyConfig` (type switch: relay types vs http).
- No-auth pool pick: `src/sse/services/auth.js:48-73`; virtual credential `id:"noauth"`.
- Loop: `src/sse/handlers/chat.js` `while(true)` ~419-580; `markAccountUnavailable` early-outs for `noauth` (`auth.js:249`) so the loop returns on first failure -> this is the rotate hook point.
- Transport: `open-sse/utils/proxyFetch.js` — undici `ProxyAgent` = **HTTP(S) proxy only** (no SOCKS). `directFetch` (wreq-js) bypassed when a proxy is set. `replayFreeTierRejectionDirect` must be disabled for psiphon.
- `markPoolUnfit` exists (`proxyPoolFitness.js`) but only freebuff calls it; `proxy_pool_fitness` table has no writers. Not used here (rotation replaces unfit-marking for psiphon).
- Types whitelist duplicated in `src/app/api/proxy-pools/route.js:10` and `[id]/route.js:41`.
- `type` lives in `proxyPools.data` JSON: no migration needed.
- No SSRF guard on pool `proxyUrl` today (pre-existing; psiphon pools take no URL).

## Psiphon facts (psiphon-tunnel-core `psiphon/config.go`, notice.go, controller.go; freeb5d/regionhop; 3x-ui PR 6849)
- Run: `ConsoleClient -config client.config`. Notices are JSON lines on stderr: `{"noticeType":..,"data":..}`.
- Needed config: `PropagationChannelId`, `SponsorId` (mandatory, user-supplied), `DataRootDirectory` (must exist), `LocalHttpProxyPort` (0 = ephemeral), `LocalSocksProxyPort`/`DisableLocalSocksProxy`, `ListenInterface`, `EgressRegion`, `EmitDiagnosticNotices`. Bootstrap server list via `RemoteServerListURLs`+`RemoteServerListSignaturePublicKey` (user config).
- Readiness notices: `ListeningHttpProxyPort{port}`, `Tunnels{count}`, `ActiveTunnel`, `ConnectedServerRegion`, `AvailableEgressRegions{regions}`.
- No built-in ping selection: empty `EgressRegion` races servers, fastest-establishing wins and is stored as **affinity** in the BoltDB under `DataRootDirectory`.
- New IP on reconnect: same dir + same region reuses the affinity server => same IP. Therefore rotate with **fresh DataRootDirectory + different EgressRegion** and verify exit IP changed (regionhop `autorestart_gates` pattern).
- Best ping = our own: N parallel instances with distinct regions, probe `generate_204` through each, keep the fastest (regionhop `probe.go` pattern).
- Binaries: upstream publishes no ConsoleClient executables; regionhop publishes linux archives; self-build `CGO_ENABLED=0 go build`. License GPL-3.0 => do **not** bundle; sidecar over loopback only.
- Unverified: whether Psiphon servers reject arbitrary sponsor IDs (server rules not public); the real region list (read at runtime from `AvailableEgressRegions`).

## Design decisions
1. HTTP proxy port (not SOCKS): works with existing undici `ProxyAgent`; zero new deps.
2. Per-process tunnel owner (cluster workers each own tunnel); cross-worker sharing deferred.
3. Fail closed: psiphon => `strictProxy=true`, no direct replay.
4. Operator-only binary/config paths (env), never API (RCE/SSRF avoidance).
5. Generation counter makes rotation idempotent under concurrent 429s.
6. Test with a fake ConsoleClient (bun script emitting real notice shapes); no network in CI.

# Implementation Plan: Bundled OpenCode Unlimited Egress + Working Proxy Rotation

**Branch**: `018-opencode-unlimited-sidecar`
**Spec**: [spec.md](./spec.md)

## Architecture

Two independent egress mechanisms, one shared contract.

1. **Bundled sidecar (`opencode2api`)** — the daemon owns exit rotation. The gateway only supervises it and rewrites the URL. Because the daemon already does per-`/64` dispatch with warm spares, the gateway must **not** opportunistically retry across a restarted daemon; it only retries the same daemon on 429/403 up to `retryAttempts`.

2. **Psiphon warm ring** — the gateway owns rotation (no upstream daemon feature), so it must pre-establish standby tunnels and promote them synchronously on rotation.

Shared contract: both are strict pools resolved by `resolveConnectionProxyConfig`, both expose `source`, both fail closed when unavailable, both carry a `generation` used by the chat-handler rotation guard.

```
resolver ─┬─ psiphon ──────────► ensureTunnel() ─► ring[active] (http://127.0.0.1:port)
          └─ opencode2api ─────► ensureSidecar() ─► http://127.0.0.1:port  (+ local bearer)

chat.js failure ─┬─ psiphon     ─► rotate() promotes ring standby, refill scheduled
                 └─ opencode2api ─► sidecar retry budget (daemon rotates internally)
```

## Concurrency & failure model

- Standby list is a plain array guarded by the pool's existing `inFlightPromise` single-flight field; promotion splices synchronously, so two concurrent rotations cannot promote the same tunnel.
- Refill runs detached, sets `refillInFlight`, and is re-entered once after completion if the ring is still short.
- Crash-loop guard reuses the existing 3-exits-in-30 s rule.
- Replacement uses the generation counter; a stale caller (`seenGeneration < state.generation`) returns without rotating.

## Files

| File | Change |
|---|---|
| `src/lib/network/opencode2api/opencode2apiRelease.json` | new — pinned version/urls/hashes/sizes (single source of truth mirrored by both Dockerfiles) |
| `src/lib/network/opencode2api/config.js` | new — pool option validate/normalize, ports, temp config writer |
| `src/lib/network/opencode2api/sidecarManager.js` | new — supervisor: ensure/stop/status/rotate-health, watchdog, crash guard |
| `src/lib/network/opencode2api/index.js` | new — public surface + `isOpencodeSidecarPool` |
| `src/lib/network/connectionProxy.js` | sidecar branch before the generic pool branch |
| `open-sse/utils/proxyFetch.js` | `opencode2api` rewrite before the relay branch |
| `open-sse/handlers/chatCore.js` | forward sidecar fields in `proxyOptions` |
| `src/sse/services/auth.js` | forward sidecar fields into `providerSpecificData` (both paths) |
| `src/sse/handlers/chat.js` | sidecar retry budget; psiphon budget 2→4 with generation guard |
| `src/lib/network/psiphon/psiphonManager.js` | warm ring: establish, promote, refill, prune |
| `src/app/api/proxy-pools/types.js` | `opencode2api` type + option normalizer |
| `src/app/api/proxy-pools/route.js`, `[id]/route.js` | accept type/options |
| `src/app/api/proxy-pools/[id]/status/route.js`, `rotate/route.js`, `test/route.js` | sidecar branches |
| `src/lib/models/listingCompleteness.js` | type added |
| `src/app/(dashboard)/dashboard/proxy-pools/page.js` | selector option + config inputs + status badge + card mount |
| `Dockerfile`, `Dockerfile.bun` | pinned download, verify, extract, runner copy, smoke check |
| `docs/OPENCODE2API.md`, `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `specs/README.md` | docs |

## Design decisions

- **Generated key per process**, never persisted: the daemon binds loopback only for the whole container lifetime, so a fresh key per spawn needs no rotation policy.
- **`Authorization` replaced, not appended** — the daemon accepts a local server key and injects the public-tier auth itself; forwarding `Bearer public` would be ignored.
- **Path rewrite strips `/inference`** because the daemon maps `/v1/*` onto the v2 anonymous upstream; `/inference/v1/...` would double the segment.
- **Non-streaming stays aggregated by the existing handler** — the daemon always streams; `chatCore`'s aggregation is unchanged.
- **Standby cap 4** keeps 5 processes per pool worst case (~5 × 40 MB), tolerable and bounded.

## Risks

| Risk | Mitigation |
|---|---|
| Daemon binary GPL-3.0 embedded in an MIT image | Attribution in `docs/OPENCODE2API.md` + README; binary stays a separate executable, not linked |
| Host without outbound UDP/2408 | `/healthz` reports `degraded`; status surfaces it; test endpoint refuses to mark active |
| Sidecar returns 429 forever on a burned prefix | `retryAttempts` bounded; final 429 handed to the existing proxy-health cooldown |
| Psiphon ring memory bloat | clamp 0..4, prune above target |
| Relay/adapter regressions | sidecar branch runs before relay; adapter bypassed only for the loopback URL |

## Verification

Unit: release pin, config validation, supervisor lifecycle (fake binary), path/header rewrite, resolver fail-closed, ring promote/refill/prune, chat retry budgets. Integration: existing psiphon + strict-proxy + free-tier suites, `eslint`, `bun build` syntax check. Live: VPS smoke through a real sidecar pool.
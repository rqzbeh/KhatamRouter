# `opencode2api` — bundled OpenCode free-tier egress pool

The `opencode2api` proxy pool type runs the bundled [`opencode2api`](https://github.com/jasonxu114514/opencode2api) daemon inside the container and sends OpenCode Free traffic through it. The daemon holds a pool of Cloudflare WARP exits, retires an exit the moment the upstream free tier burns it (HTTP 429 / 403), and substitutes a pre-registered exit before the request continues — so the daily free quota stops being a hard ceiling for a single address.

This is the same mechanism `opencode-unlimited-proxy` / `opencode-unlimited-usage` provide, run as a supervised local sidecar instead of an external service.

---

## License (read this before redistributing)

`opencode2api` is **GPL-3.0**. It ships as a **separate executable** inside the image (nothing is statically linked into the MIT-licensed gateway), and the upstream `LICENSE` file is installed at `/usr/local/share/doc/opencode2api/LICENSE`. Any image you publish that contains the binary must keep that license file and the corresponding-source offer intact.

Version pinning, per-arch checksums and the license copy live in `Dockerfile` / `Dockerfile.bun`; the trusted values live in `src/lib/network/opencode2api/opencode2apiRelease.json`, and `tests/unit/opencode2api-release-pin.test.js` fails the build config when the two drift.

---

## Why it is a managed pool type

OpenCode's free tier counts quota per egress IPv6 `/64` block. A static proxy is burned once it is flagged; the exit has to change per request, not per pool. The daemon owns that rotation, so the gateway does **not** restart or rotate it on a 429 — it only retries the same daemon up to the pool's `retryAttempts` while the daemon swaps exits internally.

- **Strict by construction.** An `opencode2api` pool never falls back to some *other* proxy: if the daemon cannot be started or is not ready, the request fails closed with 503. The one exception is deliberate — if WARP itself cannot initialize the daemon is relaunched over the host IP (see below), and `status` then reports `warpEnabled: false`.
- **Nothing to install.** The binary is in the image for both `amd64` and `arm64`, already covered by the release-pin test.
- **Loopback only.** The daemon listens on `127.0.0.1:<port>`; the gateway talks to it over loopback. `/healthz` requires no authentication.

## Requirements

- Outbound **UDP 2408** (Cloudflare WARP endpoint). No root, no TUN device, no `NET_ADMIN`.
- IPv6 egress is derived from the WireGuard source, so the quota is per exit. An `ipv4` stack egresses from a shared NAT address and burns much faster.

### When WARP cannot initialize

The daemon aborts startup when WARP registration fails (`initialize WARP egress` / `create WARP device`), naming the failing network step. That is the one startup failure caused by the environment rather than by config or the binary, so the supervisor relaunches the daemon **once** with `warp.enabled: false` instead of reporting the whole pool unusable.

In that degraded mode the daemon still serves, but every exit is the host's own address, so the per-`/64` quota spread is gone until the process restarts. A log line says so (`WARP init failed; relaunching without WARP`), the pool stays `ready`, and the choice is remembered for that pool so background restarts do not keep retrying a blocked endpoint.

Any other startup failure (bad config, missing/again non-executable binary, exit codes outside the two WARP messages) is rethrown as `OpencodeSidecarUnavailableError` and fails closed with 503. For a strict pool that means no direct egress.

## Creating a pool

Dashboard → **Proxy Pools** → type **opencode2api**, or via the API:

```bash
curl -X POST http://localhost:20128/api/proxy-pools \
  -H 'Content-Type: application/json' \
  -d '{"name":"opencode-unlimited","type":"opencode2api","options":{"poolSize":3,"warmStandby":2,"retryAttempts":4}}'
```

Then bind it to an `opencode` (free-tier) connection via **Connection Proxy Pool**.

### Options

| Option | Range | Default | Meaning |
|---|---|---|---|
| `poolSize` | 1–32 | 3 | Upper bound on WARP exits the daemon keeps registered (`warp.pool_size`). It is a ceiling: the daemon registers a spare ahead of demand rather than all of them at once. |
| `warmStandby` | 0–4 | 2 | Extra exits kept pre-registered so a burned exit is replaced without waiting for registration. Effective daemon ceiling is `poolSize + warmStandby`, clamped to 32. |
| `retryAttempts` | 1–6 | 4 | How many exits one request may burn before the last 429/403 is returned to the caller (`retry.max_attempts`). |

Out-of-range values are clamped, not rejected; missing values take the default.

## How it is supervised

`src/lib/network/opencode2api/sidecarManager.js` owns the lifecycle:

1. First request for the pool spawns the daemon on a free loopback port with a generated per-process `server_keys` entry written into a throwaway config in the data dir.
2. Readiness is **only** `GET /healthz` returning `ready: true` (bounded, 90 s by default). The daemon answers 503 while WARP is enabled without an active exit, so a 503 is not ready.
3. A watchdog re-checks health. A dead process or a degraded report triggers a bounded restart; three exits inside 30 s mean `failed` and no further respawn until something asks again.
4. `status` exposes `ready` plus `warp.{active,standby,cooling}` so the dashboard can show whether exits exist.
5. `rotate` is a supervised restart. The local key is regenerated per spawn and never persisted.
6. Stopping the pool (edit, delete, shutdown) sends `SIGTERM` and escalates to `SIGKILL`.

## Egress rewriting

For a request bound to an `opencode2api` pool, `proxyAwareFetch` rewrites the URL to the sidecar base, strips the `/inference` segment (the daemon maps `/v1/*` onto the anonymous upstream itself), and **replaces** `Authorization` with the local server key — the public `Bearer public` credential would be ignored. The body is resent byte-identically; nothing is re-serialized.

The OpenCode TLS-fingerprint adapter is bypassed for sidecar URLs because the daemon performs its own impersonation. Relay pools are untouched.

## Observability

- Pool `status` route → `ready`, `warpEnabled`, active/standby/cooling exits, last error. The route also returns the current local `apiKey`; that key is only valid against the loopback daemon, so it is not a remote credential.
- Pool `test` route → performs a real readiness probe and will not mark the pool active if it fails.
- Container logs: the supervisor tags its own lines `[opencode2api] Pool <id> ...`; the daemon's JSON logs pass through on the child's stdio.

## Failure modes

| Symptom | Cause | Handling |
|---|---|---|
| Pool stuck `failed` after ~3 quick restarts | UDP/2408 blocked, or WARP staging down | Requests fail closed 503; check egress firewall, then `rotate` |
| Persistent 429 with exits cooling | Prefix exhausted faster than Cloudflare reissues | Raise `poolSize`/`warmStandby`; lower concurrency |
| Pool `ready` but no `active` exit | Daemon started before the first exit registered | Readiness gate holds the request until an exit exists |
| Binary missing in a self-built image | Built from a stale `Dockerfile` | Rebuild; the runner stage copies and smoke-checks `opencode2api -h` |

## Verification

```bash
cd tests && bun x vitest run unit/opencode2api-release-pin.test.js unit/opencode2api-config.test.js unit/opencode2api-supervisor.test.js unit/opencode2api-egress.test.js unit/opencode2api-pool-api.test.js
bun scripts/verify-018.mjs docker
bun scripts/verify-018.mjs vps   # live: healthz ready, warp.active > 0, streamed completion
```
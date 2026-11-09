# Spec 020 — Free-proxy usability: grouping, real connectivity gate, WARP provider

Status: in progress
Branch: `020-freeproxy-usability`

## Problem

Free proxy pools import, but are unusable in practice:

1. Pool selectors (provider card, connections card) fetch `/api/proxy-pools?isActive=true`, so the ~200 inactive free pools are invisible where a user picks a pool. Where they are visible, they are a flat 200-row dump.
2. The import path never proves connectivity. Measured on the VPS: 196 iplocate pools, ~33/120 candidates can open a tunnel and only ~9/120 can reach `opencode.ai` — so ~2 usable pools out of 200.
3. Two feeds are broken/degenerate: `oneproxy` 404s (that host now serves an unrelated app), and `proxifly` returns a single random proxy per call.
4. `PATCH /api/proxy-pools/[id]` returns 405, so activation cannot be a partial update.
5. The bundled WARP egress (`opencode2api`) is reachable only by manually creating a pool and binding a connection, so it is invisible from the Providers page.

## Outcomes

- O1. Selectors list every pool, grouped by parent source (1proxy / Proxifly / IPLocate / psiphon / WARP / manual). Picking an inactive pool activates it in the same action.
- O2. The pool page lists the same groups, collapsed except the two managed groups, with search.
- O3. Sync only imports candidates that actually reach `https://opencode.ai/zen/v1/models` through the proxy (GET, 6 s, 8 in flight, stop at the cap). Dead free pools older than 1 h are pruned.
- O4. `oneproxy` points at the ProxyScrape v4 feed; `proxifly` points at the jsDelivr bulk list. Allowlist updated to the serving hosts only.
- O5. `PATCH` is accepted as a `PUT` alias on a pool.
- O6. A first-class `opencode-warp` provider (`ocw`) whose egress is always the local WARP sidecar. Missing pool row degrades to a 503, never to the server IP.
- O7. Health probes honour the proxy dispatcher under Bun (`undiciRuntime`), so a dead proxy fails a test.

## Non-goals

- Auto-activating imported pools (still opt-in per pool).
- Changing Psiphon rotation.
- Making free pools reliable enough to be a default; they are opportunistic.

## Security notes

- Feed hosts remain allowlisted; every candidate still passes `assertGatewayUrlAllowed` (SSRF/DNS-rebinding guard).
- The connectivity gate runs `probeLatency`, which uses real `undici` with a `ProxyAgent`; a proxy that ignores CONNECT cannot pass.
- `opencode-warp` is strict by construction: loopback-only daemon, per-spawn bearer, `strictProxy: true`, no credential forwarding upstream.
- Pruning only deletes pools whose `provenance.source` starts with `free:` **and** whose id equals the recomputed `fp_` hash, so a user-edited pool is never removed.
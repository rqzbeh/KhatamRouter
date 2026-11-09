# Plan 020 — Free-proxy usability

Outcomes are implemented in disjoint file sets so they can land as separate,
independently reviewable commits.

## Lanes

| Lane | Outcome | Files | Gate |
|---|---|---|---|
| 1 | O7 + O5 | `src/lib/network/undiciRuntime.js`, `src/lib/network/proxyTest.js`, `src/app/api/proxy-pools/[id]/test/route.js`, `src/lib/network/psiphon/probe.js`, `src/app/api/proxy-pools/[id]/route.js` | dead proxy → 500, PATCH activates |
| 2 | O1 | `src/lib/network/proxyPoolGroups.js`, `src/shared/components/NoAuthProxyCard.js`, `.../providers/components/ConnectionsCard.js` | grouping order + one-click WARP create |
| 3 | O2 | `.../dashboard/proxy-pools/page.js` | collapsed by default, search, managed groups expanded |
| 4 | O3 + O4 | `src/lib/freeProxyProviders/index.js` | parser cases, gate/prune/tests |
| 5 | O6 | registry `opencode-warp.js`, `connectionProxy.js`, `auth.js`, executor + index, capabilities, alias tokens | missing row → 503, not direct |

## Sequencing

1. is already merged (commits `c5ad41f6`, `491845a8`).
2. … 5 land in parallel; 5 depends on nothing else and 4 is independent.

## Risks

- Grouping a 200-row list needs the page to stay responsive → collapse by default.
- The gate lengthens a sync: 8 in flight, 6 s timeout, stop at 50 passing.
- `opencode-warp` duplicates an executor instance; the daemon route for
  `systemone` models is unverified, so that model is omitted from the new entry.
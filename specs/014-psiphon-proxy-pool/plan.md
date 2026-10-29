# Plan 014: Psiphon Rotating Proxy Pool

## 1. Architecture

```
dashboard -> /api/proxy-pools (type=psiphon) ---> proxyPools.data.psiphon
request -> chat.js -> getProviderCredentials -> resolveConnectionProxyConfig
                         | type==="psiphon": await psiphonManager.ensureTunnel(pool)
                         v                        -> {proxyUrl: http://127.0.0.1:PORT, generation, region}
       chatCore -> executor -> proxyAwareFetch(proxyOptions{strictProxy:true, psiphon:true})  (no direct replay)
                         |
   result fail && shouldRotateOn(result) -> psiphonManager.rotate(poolId,{seenGeneration,reason}) -> retry (<=2)
```

Manager (`src/lib/network/psiphon/`): `psiphonManager.js` (state machine, single-flight, generation), `notices.js`
(JSON-line parser), `config.js` (client.config builder, region validation), `probe.js` (latency + exit-IP via undici
ProxyAgent), `classify.js` (`shouldRotateOn`).

### Manager contract (consumed by integration + API tasks)
```js
isPsiphonPool(pool) -> boolean
ensureTunnel(pool, opts?) -> Promise<{ proxyUrl, region, generation, exitIp|null }>   // throws PsiphonUnavailableError (status 503)
rotate(poolId, { reason, seenGeneration? }) -> Promise<{ rotated, generation, region, exitIp|null }>
recordUsage(poolId, { requests=1, tokens=0 }) -> void
getStatus(poolId) -> { state:'idle|connecting|ready|rotating|failed', region, generation, exitIp, requests, tokens, lastError, lastRotation:{reason,at}|null }
stopTunnel(poolId) / stopAll() -> Promise<void>
shouldRotateOn({status,error}) -> boolean            // classify.js, re-exported
class PsiphonUnavailableError extends Error { status = 503 }
__setSpawnForTests(fn) / __resetForTests()
```
Env: `PSIPHON_BIN`, `PSIPHON_CONFIG_FILE`, `PSIPHON_READY_TIMEOUT_MS`(45000), `DATA_DIR`.

## 2. Packages & disjoint ownership (sequenced: P1 -> (P2 || P3) -> P4 -> P5)

| Task | Name | Owns | Oracle |
|---|---|---|---|
| T1 | Spec package + gates | specs/014-psiphon-proxy-pool/**, .unlazy/014-psiphon-proxy-pool/**, specs/README.md | gate-lint |
| T2 | Tunnel manager + fake ConsoleClient + tests | src/lib/network/psiphon/**, tests/fixtures/fake-psiphon.mjs, tests/unit/psiphon-manager.test.js | vitest psiphon-manager |
| T3 | Resolution, fail-closed, rotate-and-retry | src/lib/network/connectionProxy.js, src/sse/handlers/chat.js, src/sse/services/auth.js, open-sse/utils/proxyFetch.js, open-sse/handlers/chatCore.js, tests/unit/psiphon-rotation.test.js | vitest psiphon-rotation |
| T4 | API + repo + dashboard UI | src/app/api/proxy-pools/**, src/lib/db/repos/proxyPoolsRepo.js, src/app/(dashboard)/dashboard/proxy-pools/page.js, tests/unit/psiphon-pool-api.test.js | vitest psiphon-pool-api |
| T5 | Docs + status | docs/PSIPHON.md, README.md, ROADMAP.md, CHANGELOG.md | docs-claims verifier |

All ownership sets are disjoint. T3 and T4 run in parallel only after T2 is verified.

## 3. Threat model
| Threat | Vector | Countermeasure |
|---|---|---|
| Real-IP leak | direct replay / fallback on tunnel failure | strictProxy forced; replay disabled; 503 not direct (FR-014-02, SC-014-03) |
| RCE via dashboard | API-settable binary/config path | env-only paths, argv spawn, no shell (FR-014-03) |
| Secret exposure | psiphon config has sponsor ids | file outside repo, never logged, child env scrubbed, status endpoint omits config |
| Open proxy | listener reachable from network | `ListenInterface=127.0.0.1`, ephemeral port, HTTP proxy only |
| Rotation storm / DoS | concurrent 429s, loops | single-flight + generation guard, max 2 rotations/request, min interval between rotations (5s) |
| Orphan processes / disk growth | crash, rotations | exit handlers, kill+rm data dir each rotation, startup sweep of `$DATA_DIR/psiphon/run/*` |
| Region injection | API `regions` | strict `^[A-Z]{2}$`, max 50 |

## 4. Verification matrix
| Area | Test |
|---|---|
| manager | tests/unit/psiphon-manager.test.js |
| classify + loop | tests/unit/psiphon-rotation.test.js |
| API/validation | tests/unit/psiphon-pool-api.test.js |
| regressions | strict-proxy-enforcement, opencode-freetier-direct-replay, opencode-tls-client, wave75-redis-accelerators |
| container smoke | docker subagent after merge (per memory rule) |

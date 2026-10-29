# Tasks: Psiphon Rotating Proxy Pool

## Execution Rules & Discipline
- **Strict ordering**: T1 -> T2 -> (T3 || T4) -> T5.
- **Test-first**: each task writes its tests, sees them fail, then implements.
- **Disjoint ownership**: an agent edits only its `Owns` paths. Work in its own worktree.
- **Stub-proof oracles**: every oracle checks test file exists, has a minimum `expect(` count, has no `skip/todo`, then runs vitest.
- Discovery via codebase-memory-mcp (`search_graph`, `trace_path`, `get_code_snippet`, `check_index_coverage`); grep as fallback.
- Plain JavaScript ESM, Bun-only, no new dependency, match surrounding style.

| Task ID | Phase | User Story | Summary | Gate | Owns |
|---|---|---|---|---|---|
| T1 | Spec | all | spec package + gates | G1-G3 | specs/014-psiphon-proxy-pool/**, .unlazy/014-psiphon-proxy-pool/**, specs/README.md |
| T2 | Core | US2,US3 | tunnel manager + fake ConsoleClient | G4 | src/lib/network/psiphon/**, tests/fixtures/fake-psiphon.mjs, tests/unit/psiphon-manager.test.js |
| T3 | Integration | US1,US3,US4 | resolution, fail-closed, rotate-and-retry | G5 | src/lib/network/connectionProxy.js, src/sse/handlers/chat.js, src/sse/services/auth.js, open-sse/utils/proxyFetch.js, open-sse/handlers/chatCore.js, tests/unit/psiphon-rotation.test.js |
| T4 | API/UI | US5 | pool type validation, status/rotate endpoints, dashboard | G6 | src/app/api/proxy-pools/**, src/lib/db/repos/proxyPoolsRepo.js, src/app/(dashboard)/dashboard/proxy-pools/page.js, tests/unit/psiphon-pool-api.test.js |
| T5 | Docs | all | docs + status | G7 | docs/PSIPHON.md, README.md, ROADMAP.md, CHANGELOG.md |

#### T2: Tunnel manager
- **Depends on**: T1. **Gate**: G4.
- Implement the manager contract in `plan.md` section 1 (FR-014-01..10 manager parts): `notices.js`, `config.js`, `probe.js`, `classify.js`, `psiphonManager.js`.
- `tests/fixtures/fake-psiphon.mjs`: executable bun script honouring `-config <file>`; reads `EgressRegion`/`DataRootDirectory`, emits real notice shapes (`ListeningHttpProxyPort`, `Tunnels`, `ConnectedServerRegion`, `AvailableEgressRegions`) on stderr, serves a tiny local HTTP proxy that answers `generate_204` and the exit-IP URL with a per-(region,datadir) fake IP, with env-driven delay per region (for best-ping) and crash/never-ready modes.
- Tests (>=14 expects): best-latency pick, losers terminated, sticky reuse, rotate => new region + new IP + new data dir, last-3-regions avoidance, same-IP retry, single-flight ensure, generation guard (3 concurrent rotates => 1 rotation), threshold rotation, process-exit recovery, missing binary => PsiphonUnavailableError, ready timeout => error, region validation, stopAll kills children, scrubbed env (no `JWT_SECRET`), no `shell`.
- **Oracle**:
```bash
test -s tests/unit/psiphon-manager.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-manager.test.js) -ge 14 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-manager.test.js && ! grep -rqE "shell: *true|child_process.*exec\(" src/lib/network/psiphon && cd tests && bun x vitest run unit/psiphon-manager.test.js && echo T2_PASS
```

#### T3: Integration
- **Depends on**: T2. **Gate**: G5.
- `resolveConnectionProxyConfig`: for `type==="psiphon"` call `ensureTunnel`, return `connectionProxyUrl`, `connectionProxyEnabled:true`, `strictProxy:true`, plus `psiphonGeneration`, `psiphonPoolId`; on `PsiphonUnavailableError` return strict-proxy-with-empty-url so `proxyAwareFetch` throws (fail closed, 503 upstream).
- `proxyFetch.js`: skip `replayFreeTierRejectionDirect` when `proxyOptions.psiphonPoolId` set.
- `chat.js`: after a failed `handleChatCore`, if `credentials.providerSpecificData.psiphonPoolId` and `shouldRotateOn(result)` and attempts < 2 => `rotate({seenGeneration})`, re-resolve credentials, `continue`; bypass the `noauth` `shouldFallback` early-out only for this path. `recordUsage` on success (requests=1, tokens from usage if available). Other behaviour unchanged.
- Tests (>=10 expects): 429 => rotate+retry => 200; 403 FreeTierError => rotate; transport 502 => rotate; 400/401 => no rotate; max 2 rotations then returns failure; non-psiphon pool untouched; psiphon tunnel unavailable => 503 and global fetch never called directly; no direct replay for psiphon; concurrent failures => single rotation; regression suites listed in SC-014-05.
- **Oracle**:
```bash
test -s tests/unit/psiphon-rotation.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-rotation.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-rotation.test.js && cd tests && bun x vitest run unit/psiphon-rotation.test.js unit/strict-proxy-enforcement.test.js unit/opencode-freetier-direct-replay.test.js unit/opencode-tls-client.test.js && echo T3_PASS
```

#### T4: API + UI
- **Depends on**: T2. **Gate**: G6.
- Add `"psiphon"` to both type whitelists; validate `psiphon` options (FR-014-01) in create+update; `proxyUrl` optional for psiphon (default `psiphon://managed`); `status` and `rotate` routes; `test` route psiphon branch; stop tunnel on delete/deactivate. Dashboard: type picker, psiphon fields, state/region/IP/generation badge, "Rotate now". Lint-clean (react-hooks rules).
- Tests (>=10 expects): create ok/400 matrix (regions, candidates, negatives), proxyUrl optional, status shape omits config/secrets, rotate 400 for non-psiphon, rotate calls manager, delete stops tunnel, auth guard path covered.
- **Oracle**:
```bash
test -s tests/unit/psiphon-pool-api.test.js && [ $(grep -c 'expect(' tests/unit/psiphon-pool-api.test.js) -ge 10 ] && ! grep -qE "it\.skip|it\.todo|xit|describe\.skip" tests/unit/psiphon-pool-api.test.js && cd tests && bun x vitest run unit/psiphon-pool-api.test.js && cd .. && bun x eslint src/app/api/proxy-pools "src/app/(dashboard)/dashboard/proxy-pools" src/lib/network && echo T4_PASS
```

#### T5: Docs
- **Depends on**: T3, T4. **Gate**: G7.
- `docs/PSIPHON.md` per FR-014-12; README feature row + env table; ROADMAP entry; CHANGELOG. No overclaim: real-Psiphon check is operator-side (SC-014-06).
- **Oracle**:
```bash
test -s docs/PSIPHON.md && grep -q "GPL-3.0" docs/PSIPHON.md && grep -q "PSIPHON_BIN" docs/PSIPHON.md && bun scripts/verify-docs-claims.mjs && echo T5_PASS
```

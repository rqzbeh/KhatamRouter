# Research: Model Import, Capability Discovery & Batch Testing

**Feature**: `017-model-import-testing` | **Date**: 2026-11-08

This document records decisions, rationale, and the **source verification** behind every claim the plan relies on. All file paths were read directly (not inferred from a research summary). Where a claim came from an external research report, it was verified against source before being relied upon.

---

## R1. Discovery/capability modules exist but are NOT wired into the runtime

**Decision**: Treat Wave 6 discovery/override modules as "present but disconnected" and add explicit runtime wiring (S1, FR-065).

**Evidence (verified)**:
- `src/lib/models/discovery.js` — defines `normalizeDiscoveredModels`, defensive normalizer.
- `src/lib/models/capabilities.js` — defines `resolveModelCapabilities` (7-tier cascade), `export function resolveModelCapabilities(...)` at `capabilities.js:98`.
- `src/lib/models/contextReconciler.js` — `reconcileContextWindows`; internally imports `resolveModelCapabilities` (`contextReconciler.js:91`).
- Grep for importers: only `tests/unit/wave6-models.test.js` and `tests/unit/us7-scenario08-model-discovery-reconciler.test.js` import `discovery.js` / `contextReconciler.js`. **No `src/` or `open-sse/` production file imports them.**
- The runtime request path uses `getCapabilitiesForModel` from `open-sse/providers/capabilities.js`, called from `src/domain/requestCapabilities.js` (`resolveCaps`, ~line 205), `src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, `src/shared/hooks/useModelCaps.js`, `open-sse/executors/kiro.js`.

**Rationale**: FR-009/FR-010/FR-012 require overrides to affect real routing; today they only affect the reconciler's own baseline comparison. Without wiring, the whole override feature is cosmetic.

**Alternatives considered**: Treat as already-done and only add an API. Rejected — verified there is no runtime caller.

---

## R2. SSRF guard: layered functions exist; several custom-gateway paths bypass or under-use them

**Decision**: Route every operator-supplied gateway URL through the DNS-aware + redirect-re-validating layer; add the guard to create/update; persist a request-independent local declaration (S0).

**Evidence (verified)**:
- `src/shared/utils/ssrfGuard.js` provides three layers, documented in its header:
  - `assertPublicUrl(rawUrl)` — synchronous literal/IP/hostname checks (`ssrfGuard.js:162`).
  - `assertPublicUrlResolved(rawUrl)` — adds DNS resolution (`:172`).
  - `fetchPublic(url, init, {maxRedirects})` — manual redirect handling, re-validates each hop (`:202`, `:212`).
  - Robust IPv6 handling incl. IPv4-mapped (`::ffff:a.b.c.d` and hex form), NAT64, trailing-dot localhost.
- **Gap 1 (verified)**: `src/app/api/providers/suggested-models/route.js` calls raw `fetch(url)` on a query-string `url` (line ~25) — no guard at all.
- **Gap 2 (verified)**: `src/app/api/provider-nodes/route.js` POST persists `baseUrl` with no SSRF check; `src/app/api/provider-nodes/[id]/route.js` PUT likewise.
- **Gap 3 (verified)**: `src/app/api/provider-nodes/validate/route.js` uses only literal `assertPublicUrl` (`:72`) and a request-scoped `isLocalRequest(request)` bypass (`:69-73`) — not DNS-aware, and background work has no request to satisfy `isLocalRequest`.
- Existing users of the strong layer: `src/sse/handlers/fetch.js` (`assertPublicUrlResolved`), `open-sse/handlers/search/index.js` (`fetchPublic`).

**Rationale**: FR-058/FR-059/FR-060/FR-061/FR-062 + SC-019/SC-020.

**Background authorization (verified)**: `isLocalRequest` (`src/dashboardGuard.js:142`) derives trust from the *inbound request* (loopback peer, proxy headers, origin). Scheduled sync and batch tests have no inbound request, so a purely request-scoped check cannot authorize them. Hence FR-062a: persist the self-hosted declaration on the node and honor it for background work — while never letting a proxied/non-local request inherit it.

**Alternatives considered**: Keep only literal checks. Rejected — a nip.io/attacker domain resolving to `127.0.0.1` bypasses literal checks; the module's own header documents this exact bypass class (#3714).

---

## R3. TLS: verification is default-on, but an insecure fallback exists and must not be repurposed

**Decision**: Keep certificate verification on for all gateway TLS; any self-signed relaxation must be explicit and scoped to the declared local gateway only (S0, FR-063a).

**Evidence (verified)**:
- `open-sse/utils/proxyFetch.js:231-248` builds a dispatcher; `insecure` adds `{ rejectUnauthorized: false }` (`:244`).
- The insecure retry only runs when `!isStrictSsl` where `isStrictSsl = options.strictTls === true || STRICT_SSL==="true"||"1"` (`~:302-317`). The OpenCode specialized path explicitly has **no** insecure fallback (`:290` comment).
- Therefore verification is on by default, but a global `STRICT_SSL` gate and an automatic insecure retry on cert errors exist — the local-gateway feature must not widen this to remote or strict-proxy egress.

**Rationale**: FR-063a, SC-024.

**Alternatives considered**: Add a new TLS toggle. Rejected — reuse the existing, narrower `strictTls` semantics and scope by declared-local gateway.

---

## R4. Combo cooldown: shipping implementation is correct; extend, don't regress

**Decision**: Extend `open-sse/services/combo.js` with a per-combo configurable member cooldown and nested-error handling, preserving the commit `20a40ef8` invariants.

**Evidence (verified)**:
- `open-sse/services/combo.js`: `COMBO_STORM_COOLDOWN_MS = 90s`, `TRANSIENT_5XX_COOLDOWN_MS = 45s`, `MAX_COOLDOWN_ENTRIES = 1000`, `comboModelCooldownMap` keyed `` `${scope}::${comboName}::${modelStr}` `` (`:31`), `parseRetryAfter` (`:56`), bounded `setCooldownEntry` with LRU eviction (`:126-137`), scope isolation documented at `:24-27`.
- Commit `20a40ef8` "fix(combo): isolate cooldowns and preserve upstream status and Retry-After (#125)" changed `open-sse/services/combo.js` (+421), added `fixtures/combo-cooldown/responses.json` and `tests/unit/combo-cooldown-correctness.test.js` + `tests/integration/combo-cooldown-reliability.mjs`.
- Existing tests cover: numeric/date retry-after, no truncation above 90s, bounded map/pruning, scope isolation, abort cleanup.
- The combo schema (`src/lib/db/schema.js:117-126`) has `{id,name,kind,models,createdAt,updatedAt}` — no cooldown config yet, so a schema addition is required.

**Real user reproduction (verified fixture shapes)**: `fixtures/combo-cooldown/responses.json` already contains `rateLimitSeconds`, `rateLimitDate`, `rateLimitExtremeSeconds`, `rateLimitUint64`, `rateLimitMalformedResets`, `503-transient-wait`, etc. The new regression (outer 503 wrapping embedded 429 with daily-limit + ~11114s hint + shorter nested hints) extends this set.

**Rationale**: FR-039..FR-046, SC-013..SC-015. Extending avoids re-deriving the correctness the #125 fix established.

---

## R5. Failure classification already separates transport/quota/policy

**Decision**: Reuse `failureClassification.js` + `resilienceConfig.js` for batch and rotation classification; add "access/regional restriction" as an explicit bucket.

**Evidence (verified)**:
- `src/lib/resilience/failureClassification.js` splits 429 into rate-limit vs quota and decides whether a failure may count against provider health; `TERMINAL_QUOTA_PATTERNS`/`QUOTA_PATTERNS` present; pure/synchronous/no-I/O.
- `open-sse/config/resilienceConfig.js` defines `FAILURE_KIND` (`QUOTA_EXHAUSTED`, `TRANSIENT`, ...), `COOLDOWN_BY_KIND`, `POLICY_FAILURE_PATTERN`, `QUOTA_SCALE_RETRY_SECONDS`.
- OmniRoute `/api/models/test-all` (reference only) exposes per-result flags `rateLimited`, `isTransient`, `isQuota`, `isTimeout`, `skipped` and `autoHideFailed` gating (`!rateLimited && !isTimeout && !isTransient && !isQuota && !skipped`), plus consecutive-rate-limit/bot-block early stop. This confirms the classification-gated design the spec requires.

**Rationale**: FR-020..FR-023, FR-030, FR-036, SC-005/SC-010.

---

## R6. Proxy pools and SOCKS support

**Decision**: Free-proxy import is HTTP/HTTPS-only in the first slice; SOCKS entries are filtered/deferred.

**Evidence (verified)**:
- `src/app/api/proxy-pools/types.js:3` — `VALID_PROXY_TYPES = ["http","vercel","cloudflare","deno","netlify","psiphon"]` (no socks type).
- `src/lib/network/proxyTest.js` and `open-sse/utils/proxyFetch.js` use undici `ProxyAgent` (no SOCKS).
- `socks-proxy-agent` is a dependency (`package.json:51`) but used only in `src/lib/mimoLoginSession.js:444-472` (comment: "undici ProxyAgent has no socks support").
- OmniRoute free-proxy sources expose mixed protocols (`http/https/socks4/socks5`); OmniRoute's own schema allows all four.

**Rationale**: FR-047..FR-050, SC-017. Importing SOCKS proxies we cannot dial would create dead pools.

---

## R7. Free-proxy source inventory and license

**Decision**: Implement 1proxy, proxifly, iplocate as opt-in sources; exclude webshare (paid, needs API key — treat as a future/credentialed source); MIT-notice OmniRoute.

**Evidence (verified)**:
- OmniRoute `src/lib/freeProxyProviders/`: `oneproxy.ts` (`1proxy`, `https://1proxy-api.aitradepulse.com/api/v1/proxies/advanced`, quality min default 50, max 500), `proxifly.ts` (`https://api.proxifly.dev/proxy`, anonymity default elite), `iplocate.ts` (GitHub raw `iplocate/free-proxy-list/main/protocols/<proto>.txt`, opt-in via env), `webshare.ts` (paid, gated on `FREE_PROXY_WEBSHARE_API_KEY`).
- `src/shared/validation/freeProxySchemas.ts` enumerates `["1proxy","proxifly","iplocate","webshare"]` and allows `http/https/socks4/socks5` protocols.
- OmniRoute `LICENSE`: MIT, `Copyright (c) 2026 diegosouzapw`. KhatamRouter `LICENSE`: MIT, `Copyright (c) 2024-2026 decolua and contributors`.
- Unsafe-host guard precedent: OmniRoute imports `isPrivateHost` from `@/shared/network/outboundUrlGuard`.

**Rationale**: FR-047..FR-053, SC-016/SC-017. Attribution + re-implementation avoids license ambiguity.

---

## R8. Optional automatic sync surface

**Decision**: Add a sync policy (global default off + per-provider inherit/enabled/disabled) in front of the existing catalog sync, with a bounded interval distinct from the retry interval.

**Evidence (verified)**:
- `src/lib/modelCatalog/sync.js`: `CATALOG_URL = "https://models.dev/api.json"`, `SYNC_INTERVAL_MS = 24h`, `STARTUP_DELAY_MS = 60s`, `RETRY_DELAY_MS = 30m`, `FETCH_TIMEOUT_MS = 60s`, atomic `writeAtomic` (`.tmp` + rename), fail-open by design.
- `src/lib/db/repos/settingsRepo.js` — `getSettings`/`updateSettings`, scope `settings`, invalidation via events.
- Sync is global today (single `CATALOG_URL`); per-provider gating must select which providers a run touches.

**Rationale**: FR-013..FR-018, FR-064, SC-009/SC-022.

---

## R9. Persistence patterns to reuse

**Decision**: Use existing repos + `kv(scope,key,value)` patterns; no new storage engine.

**Evidence (verified)**:
- `src/lib/db/repos/disabledModelsRepo.js` uses `kv` scope `disabledModels` with atomic read-merge-write; `disableModels`/`enableModels`; no reason/time audit today (FR-025 requires adding it).
- `src/lib/db/repos/proxyPoolsRepo.js` stores `data` JSON; `src/lib/db/repos/nodesRepo.js` stores node with `baseUrl` (add `isSelfHosted`).
- `src/lib/db/schema.js` defines tables; migrations under `src/lib/db/migrations/` (e.g. `004-wave6-model-capabilities.js` added `provider`, `model_id`, `source` to `model_context_overrides`).
- Combo cache invalidation already listens to `CONFIG_RELOAD` (`combosRepo.js:23-40`) — new config must publish/invalidate consistently.

**Rationale**: Constitution III (SQLite WAL + Redis hybrid, fail-open).

---

## R10. Testing conventions

**Decision**: Place new tests under `tests/unit` and `tests/integration`; run with `bun x vitest run`.

**Evidence (verified)**:
- `tests/vitest.config.js` aliases `open-sse/` and `@/`, includes `**/*.test.js`, excludes worktrees/`real/`.
- Existing relevant suites: `tests/unit/combo-cooldown-correctness.test.js`, `tests/unit/cowork-mcp-ssrf-guard.test.js`, `tests/integration/combo-cooldown-reliability.mjs`, `tests/unit/wave6-models.test.js`.
- `tests/__baseline__/` holds regression snapshots.

**Rationale**: SC verification methods must be runnable and consistent with the repo.

---

## R11. Psiphon VPS: evidence-gated, currently blocked

**Decision**: Do not plan a fix. Plan diagnostics → (evidence) → reproducible regression → fix, or report blocked.

**Evidence (verified)**:
- Existing surface: `src/lib/network/psiphon/psiphonManager.js` (`rotate`, generation guard, crash-loop guard, `terminateProcess` 1500ms escalation), `src/lib/network/psiphon/probe.js`, `docs/PSIPHON.md`.
- No VPS diagnostic artifacts exist in the repo; the reported behavior is not reproduced here.

**Rationale**: FR-054..FR-057, SC-018.

---

## R12. External research claims — verification verdicts

| Claim from research | Verified? | Evidence |
|---|---|---|
| Custom gateway discovery lacks comprehensive SSRF redirect/DNS guard | **Yes, confirmed** | raw fetch in `suggested-models`, no guard in create/update, literal-only in validate (R2) |
| Automated sync must have safe credential handling | **Yes** — becomes a plan requirement | no host-scoped credential policy in gateway paths (R2/R3) |
| Explicit local/self-hosted support needed | **Yes** — request-scoped only today | `isLocalRequest` needs a request (R2) |
| Bounded scheduling + redirect handling | **Yes** | `fetchPublic` has `maxRedirects`; sync has bounded timings (R2/R8) |
| Discovery/override runtime wiring missing | **Yes, confirmed** | no production importers (R1) |
| Free proxy inventory: 1proxy/proxifly/iplocate | **Yes** | OmniRoute source (R7) |
| SOCKS unsupported by current proxy path | **Yes** | undici ProxyAgent only (R6) |
| OmniRoute MIT | **Yes** | LICENSE (R7) |
| Psiphon VPS root cause | **No evidence** | no diagnostics in repo (R11) → blocked |

## R13. Independent audit — claim-by-claim verification (2026-11-08)

An independent audit reported issues; each was verified against source before correction. All 11 confirmed.

| # | Audit claim | Verified against source | Correction |
|---|---|---|---|
| 1 | `model_capability_overrides` lacks provider/model/source | **Confirmed**: `src/lib/db/schema.js` shows only `id, model_pattern, capabilities_json, created_at, updated_at`. Migration `004` touches `model_context_overrides` and `model_capabilities` — NOT `model_capability_overrides`. | FR-008a; S1 adds a new migration; data-model updated. |
| 2 | Cascade is record-level, not per-field | **Confirmed**: `resolveModelCapabilities` returns `buildResolved({ base: manual })` wholesale on first match (`src/lib/models/capabilities.js`). | FR-009a; per-field merge contract; SC-026. |
| 3 | Disabled-model callers require `string[]` | **Confirmed**: `src/app/api/models/route.js:17` (`disabled[alias]` used as list), `src/app/api/v1/models/route.js:362` (`Array.isArray`+`includes`), `src/app/api/models/disabled/route.js:11`. | FR-025a; parallel audit scope or projection; SC-027. |
| 4 | S0 incorrectly gated by unrelated foundation | **Confirmed**: plan listed S0 under the foundational dependency language while S0 only needs SSRF/guard code. | Plan: S0 depends on Setup only; corrected dependency note. |
| 5 | Sync runner must target actual providers, not models.dev | **Confirmed**: `src/lib/modelCatalog/sync.js` fetches only `CATALOG_URL=https://models.dev/api.json` and diffs against the built-in registry; no per-provider `/models` call. | FR-013a; S7 adds per-provider sync; SC-028. |
| 6 | Synchronous runtime/UI requires cache/invalidation | **Confirmed**: `resolveCaps` in `src/domain/requestCapabilities.js` is synchronous and calls `getCapabilitiesForModel`; `useModelCaps.js` is a client hook. | FR-009b; `OverrideCache` entity; invalidate on write + `CONFIG_RELOAD`. |
| 7 | Handler must thread combo cooldown | **Confirmed**: `handleComboChat({..., cooldownScope=null})` at `open-sse/services/combo.js:606`; `src/sse/handlers/chat.js` call sites (263, 295, 375) do NOT pass `cooldownScope`. | FR-043a; S2 handler threading; SC-029. |
| 8 | Migration register/version | **Confirmed**: `src/lib/db/migrations/index.js` imports `001`–`004` and sorts by version; `src/lib/db/migrate.js` applies via `_khatam_migrations`. New migrations must be registered. | FR-038a; SC-031; foundational tasks T009 + new capability migration. |
| 9 | Context reconciler only handles context | **Confirmed**: `src/lib/models/contextReconciler.js` header + implementation reconcile only context windows. | FR-006a; S1 adds capability reconciliation. |
| 10 | Proxy selection must integrate fitness | **Confirmed**: `pickProxyPoolId` (`src/lib/network/connectionProxy.js:23`) is round-robin/random with no fitness; `proxyPoolFitness.js` is imported by no production module (only `freebuff.js` uses `markPoolUnfit`). | FR-043b; S8 integrates fitness; SC-030. |
| 11 | Overrides API task missing | **Confirmed**: tasks.md referenced an overrides API only in prose; no explicit API task. | Added explicit S4 override route tasks + tests. |

## R14. Independent re-review — six blockers verified (2026-11-08)

| # | Blocker | Verified against source | Correction |
|---|---|---|---|
| 1 | Retry S5 scheduled after dependent S6/S7 | S6/S7 consume the effective-wait policy; tasks.md had S5 in Phase 9 after S6(7)/S7(8) | tasks.md reordered: S5 now Phase 8, before S6 (Phase 9) and S7 (Phase 10); plan notes ordering |
| 2 | S4 overrides API appears in S1 and as a separate PR | tasks.md S1 phase had no API but the narrative "(+S4 pieces)" and plan S4 said "S1 migration"; ambiguous | Overrides API lives **only** in S4; S1 reads persisted rows only; plan S1/S4 and tasks Phase 4/7 clarified |
| 3 | Missing API test task | No explicit `model-overrides-api.test.js` task | Added T055 (overrides API contract test) in S4 |
| 4 | combosRepo explicit SQL must map cooldown | Verified: `rowToCombo` returns `{id,name,kind,models,createdAt,updatedAt}`; `createCombo` INSERT and `updateCombo` UPDATE omit `cooldownMs` | T044 (S2) + data-model + combo-cooldown contract call out all three sites; T042 adds a repo-mapping test |
| 5 | Schema version bump | Verified: `src/lib/db/schema.js` `SCHEMA_VERSION = 5` with an explicit "+1 on every TABLES change" contract; `migrate.js` uses it for pre-change backup | T021 bumps `SCHEMA_VERSION`; T025 asserts the bump; FR-038a/SC-031 |
| 6 | Deterministic id / unique scoped override idempotency + legacy NULL safety | Verified: legacy rows have `model_pattern NOT NULL`, `provider` NULL; reconciler already uses `id = auto:${provider}:${modelId}` + `INSERT OR REPLACE`; no UNIQUE index on capability overrides | T020 (deterministic ids + NULL-safe UNIQUE `COALESCE` index), T032 (null-safe matching), T056 (idempotent POST); data-model + import-discovery contract updated |

## Open Questions (resolved with reasonable defaults)
- **Scope of first free-proxy slice** → HTTP/HTTPS only; exclude webshare (credentialed/paid). (R6/R7)
- **Sync interval vs retry interval** → separate settings; sync bounded by its own interval (FR-018). (R8)
- **Local-gateway background authorization** → persisted declaration (FR-062a). (R2)
- **TLS relaxation scope** → declared-local only; never remote/strict-proxy (FR-063a). (R3)

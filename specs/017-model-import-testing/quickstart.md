# Quickstart: Model Import, Capability Discovery & Batch Testing

**Feature**: `017-model-import-testing`

Runnable validation scenarios that prove the feature works end-to-end. This is a run/validation guide only — implementation details live in `tasks.md`. Contracts: [contracts/](./contracts/); entities: [data-model.md](./data-model.md).

## Prerequisites

- Bun `1.4.4+`; repo deps installed at root and under `tests/`.
- Run tests from `tests/` with `bun x vitest run` (aliases resolve `open-sse/` and `@/`).
- For live checks: dashboard on `http://localhost:20128` with auth; a test connection (built-in or a user-created compatible gateway).

```bash
bun install
cd tests && bun install
```

## 1. SSRF / TLS / local authorization (S0)

Mock a gateway whose hostname resolves to a private address and whose endpoint redirects to an internal target; assert refusal and no internal fetch.

```bash
cd tests && bun x vitest run unit/gateway-ssrf-guard.test.js
cd tests && bun x vitest run unit/gateway-local-auth-background.test.js
```

Expected: private-resolving host refused; redirect-to-internal refused; declared self-hosted gateway authorized for a background sync with no inbound request; proxied/non-local request to the same URL refused; TLS verification on by default (insecure relaxation only for declared-local).

## 2. Discovery + per-field override runtime wiring (S1)

```bash
cd tests && bun x vitest run unit/model-override-runtime-wiring.test.js
cd tests && bun x vitest run unit/model-override-per-field.test.js
cd tests && bun x vitest run unit/model-override-cache.test.js
cd tests && bun x vitest run unit/model-discovery-reconciler-wiring.test.js
```

Expected: overriding only `contextWindow` leaves discovered `vision`/`tools` intact (per-field, not record-level); a `manual` override changes an actual routing/capability decision; a `CONFIG_RELOAD`/write refreshes the synchronous cache; manual overrides survive repeated reconciles; capability (not just context) is reconciled.

## 3. Combo cooldown + real regression (S2)

```bash
cd tests && bun x vitest run unit/combo-cooldown-correctness.test.js
node tests/integration/combo-cooldown-reliability.mjs
cd tests && bun x vitest run unit/combo-cooldown-nested-error.test.js
cd tests && bun x vitest run unit/combo-handler-cooldown-threading.test.js
```

Expected: cooling member skipped in round-robin, silent restore at expiry; nested outer-503/embedded-429 fixture fails over promptly, cools only the correctly-scoped member, honors the longest trustworthy hint without truncation, ignores malformed hints; a request through `src/sse/handlers/chat.js` actually engages scoped cooldown (scope threaded from the handler).

## 4. Import + overrides (S3, S4)

```bash
cd tests && bun x vitest run unit/model-import-api.test.js
cd tests && bun x vitest run unit/model-overrides-api.test.js
```

Expected: import summary sums to input and re-run shows `added:0`; overrides API GET returns per-field provenance; POST writes a deterministic-id `manual` row and a repeat POST updates (no duplicate); legacy NULL-provider rows are handled safely; DELETE reverts to the next layer.
Manual curl (dashboard auth required):
```bash
curl -s -X POST localhost:20128/api/models/import \
  -H 'content-type: application/json' \
  -d '{"providerId":"openai-compatible-chat-abc","connectionId":"conn-1","mode":"merge"}'
```
Expected: `{added,updated,skipped,failed}` sums to input; re-run → `added:0`; malformed records counted, not fatal.

## 5. Retry intervals (S5)

```bash
cd tests && bun x vitest run unit/retry-interval-floor.test.js
```
Expected: effective wait is `max(configured, Retry-After)`; configured interval never shortens upstream; access/regional restriction blocks retry.

## 6. Batch "test all" (S6)

```bash
cd tests && bun x vitest run unit/model-test-batch-classification.test.js
```
Fixture matrix: success, hard failure, quota, access-restriction, rate-limit, transport. Expected: auto-disable (opt-in) disables only the hard failure; quota/access/rate-limit/transport never disabled; storm halt reports `stopReason`; no secret in payloads.

## 7. Optional automatic sync (S7)

```bash
cd tests && bun x vitest run unit/model-sync-policy.test.js
cd tests && bun x vitest run unit/model-sync-provider-targeting.test.js
```
Expected: resolution table deterministic (SC-009); an enabled provider/connection without a models.dev entry still syncs its advertised listing (SC-028); manual metadata preserved; failed sync leaves catalog intact.

## 8. Scoped rotation failures + proxy fitness (S8)

```bash
cd tests && bun x vitest run unit/proxy-rotation-scope.test.js
cd tests && bun x vitest run unit/proxy-pool-fitness-selection.test.js
```
Expected: failure in one scope changes 0 other scopes; non-global scope without id rejected; classified as transport, not quota; an unfit pool is not selected ahead of a fit one.

## 9. Free proxy sources (S9)

```bash
cd tests && bun x vitest run unit/free-proxy-sources.test.js
```
Expected: all sources off by default (0 outbound, 0 pools); enabling one imports with provenance; private/metadata hosts rejected; SOCKS filtered; disclosure present; fail-closed preserved.

## 10. Psiphon VPS (S10 — blocked until evidence)

No automated pass/fail gate is expected until VPS diagnostics exist. The Unlazy gate for S10 must be "blocked with recorded evidence" unless a reproducible cause is found (see `research.md` R11). Do not treat a green unit test as an evidence substitute.

## Full suite

```bash
cd tests && bun x vitest run
```
Baseline expected reds are documented in `tests/__baseline__/known-fails.txt`.

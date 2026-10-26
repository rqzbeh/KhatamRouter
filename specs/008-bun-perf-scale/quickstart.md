# Quickstart: validate 008-bun-perf-scale

Prereqs: Bun 1.4.3, `bun install` at the root, and `cd tests && bun install`. Docker steps are run by a subagent, never the main agent, and never with `prune`.

## 1. Baseline (before any change)

```bash
bun scripts/perf-l1-harness.mjs --label baseline --out /tmp/l1-baseline.json
# expect: PERF_L1_OK baseline
```

Read `db_queries_per_req` and `phases_ms`. If the hotspot ranking differs from `research-profile.md`, re-rank the slim list first (research D3).

## 2. Regression guard (run before AND after every slimming change)

```bash
bun tests/__baseline__/verify-alias.mjs && bun tests/__baseline__/verify-providers.mjs \
  && bun tests/__baseline__/verify-oauth-urls.mjs
cd tests && bun x vitest run translator/golden-request.test.js \
  translator/golden-translator-concerns.test.js translator/golden-url-header.test.js \
  translator/golden-response-stream.test.js \
  unit/capabilities.test.js unit/key-access.test.js
```

## 3. After slimming

```bash
bun scripts/perf-l1-harness.mjs --label after-slim --out /tmp/l1-after.json
# expect: PERF_L1_OK after-slim; db_queries_per_req lower; p50 down by the D7 threshold or an honest miss
```

## 4. Trusted proxy

```bash
cd tests && bun x vitest run unit/trusted-proxy.test.js   # spoof negative controls + unset == master
```

## 5. Multi-replica (container subagent only)

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml config   # valid
# subagent: up --scale 9router=2, then:
#  - trip a breaker on replica A, observe replica B gate that provider
#  - two concurrent refreshes of one token produce exactly one upstream call
#  - stop redis, keep sending traffic: no request-path throw
```

## 6. Ladder

```bash
scripts/perf-ladder.sh 1   # baseline row (stack already running)
scripts/perf-ladder.sh 2   # 2-replica row
# fill specs/008-bun-perf-scale/ladder-results.md; UNMEASURED needs a cause
```

# Local Parity & Architecture Audit: 9router 0.5.112–0.5.116 (Spec 019)

**Working Tree**: `/tmp/khatam-upstream-019` | **Branch**: `019-upstream-05116` | **Audit Date**: 2026-11-08

---

## Prior port

### Upstream v0.5.112 Ingestion Audit (Spec 013, PR #119 commit `9b56a40a`, PR #120 commit `b74ca77a`)

The upstream release window `v0.5.111 (3a978a63)` -> `v0.5.112 (1fe586bb)` consists of 14 commits (`e70ea24d` through `1fe586bb`). All 14 commits are fully accounted for, ported or verified superior on `master` with 251 targeted passing tests (full suite retains documented baseline failures in known-fails.txt):

| Upstream Commit | Upstream Title | Status | Local Implementation Paths & Line Citations | Unit Test Evidence | Hardening & Architectural Adaptations |
|---|---|---|---|---|---|
| `e70ea24d` | `Fix OpenCode` | Already present superior | `open-sse/services/opencodeTlsClient.js:1-120` | `tests/unit/opencode-tls-client.test.js` | **No runtime npm / lazyRuntime**: Upstream used child-process `npm install` via `lazyRuntime.js`. KhatamRouter uses pre-installed native `wreq-js` TLS bindings under Bun (PR #78, #123). |
| `acb3c080` | `feat(codex): add GPT-6.1 Terra` | Ported | `open-sse/providers/registry/codex.js:57`<br>`open-sse/providers/capabilities.js:301`<br>`open-sse/providers/pricing.js:93` | `tests/unit/codex-gpt6-lite.test.js` | Configured `gpt-6.1-terra` with `responsesLite: true`, `GPT_6_LITE_THINKING_LEVELS`, 500k context window, 128k output cap, and accurate pricing ($1.00 input, $5.00 output). |
| `3fd925ab` | `fix(codebuddy): send plugin request/conversation id headers` | Ported | `open-sse/executors/default.js:50`<br>`open-sse/providers/registry/codebuddy-cn.js:40`<br>`open-sse/providers/registry/codebuddy-intl.js:40` | `tests/unit/codebuddy-channel-headers.test.js`<br>`tests/unit/codebuddy-intl-backoff.test.js` | Implemented `codebuddyHeaders` generating UUIDs for `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID` with request-scoped error backoff. |
| `f3e1f716` | `fix(github): apply Claude 5.5 thinking rules to Copilot's dotted model ids` | Ported | `open-sse/providers/capabilities.js:101,270`<br>`open-sse/translator/concerns/thinkingUnified.js:293,460` | `tests/unit/github-claude-5-5-thinking.test.js` | Applied Claude 5.5 thinking rules to dotted Copilot model IDs (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) and preserved requested thinking display format. |
| `b1effa03` | `feat(commandcode): align request headers with official CLI 1.88.0` | Ported | `open-sse/shared/commandCodeHeaders.js:1-68`<br>`open-sse/executors/commandcode.js:29`<br>`open-sse/providers/registry/commandcode.js:25`<br>`open-sse/services/usage/commandcode.js:86`<br>`open-sse/translator/request/openai-to-commandcode.js:204`<br>`src/app/api/providers/validate/route.js:30` | `tests/unit/commandcode-headers.test.js`<br>`tests/unit/commandcode-usage.test.js` | Implemented decamelizing path slugification and threadId/x-session-id UUID synchronization matching official CLI 1.88.0. |
| `a199d777` | `fix(providers): treat LLM\|id\|secret as opaque token in bulk-add, not name\|key` | Ported | `src/shared/utils/bulkAdd.js:28-31` | `tests/unit/bulk-add-names.test.js` | Preserved `LLM\|` tokens as opaque API keys during bulk import without destructive pipe splitting. |
| `ced0cf6e` | `fix(nvidia): normalize reasoning aliases for NIM` | Ported | `open-sse/translator/concerns/paramSupport.js:36,82` | `tests/unit/param-support.test.js` | Normalized assistant turn `reasoning` field aliases to `reasoning_content` for `nvidia` provider to eliminate duplicate-field 400 errors. |
| `f7f6f5ed` | `feat: add Nace Drex provider to the System One lane` | Ported with hardening | `open-sse/providers/registry/nace.js:1-41`<br>`public/providers/nace.png`<br>`open-sse/providers/registry/index.js:125`<br>`tests/__baseline__/alias-baseline.json`<br>`tests/__baseline__/providers-baseline.json` | `tests/unit/nace-systemone-provider.test.js` | Provider registry index regenerated via `scripts/migrate-registry.mjs` instead of hand-edited, preserving automated registry invariants. |
| `8db1f4ae` | `fix(translator): enforce Gemini protobuf type predicates on schema items and properties` | Ported | `open-sse/translator/formats/gemini.js:304,374` | `tests/unit/gemini-schema-array-items-predicate.test.js` | Stripped `items` from non-array schemas and `properties`/`required` from non-object schemas to prevent Gemini 400 validation failures. |
| `56dbf466` | `fix(chat): reject SSE errors in non-streaming responses` | Ported | `open-sse/handlers/chatCore/nonStreamingHandler.js:249-265` | `tests/unit/nonstream-sse-error.test.js` | Extracted and clamped upstream SSE error frames (400-599 or 502) in non-streaming chat, returning `createErrorResult` and logging failure. |
| `3b7acf72` | `fix(docker): bundle lazy runtime deps so OpenCode Free resolves` | Already present superior | `Dockerfile:1-125`<br>`Dockerfile.bun:1-125` | `tests/unit/opencode-tls-client.test.js`<br>`specs/013-upstream-0-5-112/results/dockerfile-identity.txt` | Both Dockerfiles remain 100% byte-identical without bundling npm or dynamic runtime downloaders. |
| `d7bb71ce` | `fix(deepseek): use noble-hashes port for DeepSeek PoW hash` | Ported with hardening | `open-sse/lib/deepseek-pow-hash.js:1-249` | `tests/unit/deepseek-pow-hash.test.js` | Inlined noble-hashes Keccak-f[1600]/SHA3-256 with restored input validation: 64-hex regex `/^[0-9a-fA-F]{64}$/`, `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000`, safe integer bounds, and loop timeout guards. |
| `85d73bd6` | `feat(minimax-code): lease auth mode via desktop app named-pipe broker` | Ported with hardening | `open-sse/services/minimaxCodeLease.js:1-509`<br>`open-sse/executors/minimax-code.js:15-38`<br>`open-sse/services/minimaxCodeUsage.js:208`<br>`src/dashboardGuard.js:55-56,94-95`<br>`src/app/api/oauth/[provider]/[action]/route.js:34-118`<br>`src/sse/handlers/chat.js:192`<br>`src/sse/services/tokenRefresh.js:33`<br>`src/app/(dashboard)/dashboard/providers/components/MinimaxLeaseButton.js:1-60`<br>`src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js:140` | `tests/unit/minimax-code-lease.test.js`<br>`tests/unit/minimax-lease-guard.test.js` | **MiniMax broker hardening + Redis single-flight**:<br>1. Loopback-only enforcement in `dashboardGuard.js` (`ALWAYS_PROTECTED`, `LOCAL_ONLY_PATHS`).<br>2. Strict path traversal & null-byte rejection via canonical `dataDir` validation (`validateAndCanonicalizeDataDir`).<br>3. Bounded 64KB frame decoding (`AUTH_LEASE_MAX_FRAME_BYTES`).<br>4. Multi-worker Redis token cache (`khatam:mcode:lease:<digest>`) with TTL safety margin and distributed single-flight locking (`khatam:lock:mcode:lease:<digest>`).<br>5. Leased tokens are NEVER written to SQLite (`providerConnections`), remaining strictly ephemeral in memory.<br>6. Usage service strictly resolves via `getLeaseToken` on lease connections. |
| `1fe586bb` | `# v0.5.112 (2026-10-28)` | Release chore | `package.json:3`<br>`cli/package.json:3`<br>`CHANGELOG.md:1-18`<br>`docs/UPSTREAM-PORTS.md:268-335` | `tests/unit/display-branding-guard.test.js` | Version aligned to `0.5.112` across root and CLI packages while preserving KhatamRouter fork branding, vertical scale architecture, and security hardening. |

### Post-0.5.112 Enhancements Shipped on Master (Commits between `b74ca77a` and `HEAD`)

Between Spec 013 merge (`b74ca77a`) and current `master` (`e1fb2594`), 30 commits landed covering:
- **Psiphon Proxy Pool (Spec 014)**: PR #117, #118, #121; pinned `regionhop` v1.27.0 with single manifest hash verification (PR #143). Zero-config default in Docker.
- **VansRouter Parity**: Commits `66c956b5` (v0.91.81..v0.91.89 parity, PR #122) and docs `9ee1e792`.
- **Transport Hardening**: Proxy-aware `wreq-js` TLS client, Psiphon lifecycle & Redis publisher readiness (PR #123).
- **OpenCode Interoperability (Spec 016)**: PR #124 (terminal tool aliasing, combo storm cooldowns, keep-alive tuning).
- **Combo Resilience**: PR #125 (isolate cooldowns and preserve upstream status/Retry-After), PR #130 (skip transient delay for wrapped quota failures), PR #131, PR #142 (configure scoped member failure cooldown and recovery).
- **Gateway Security**: PR #133 (SSRF, TLS, and egress hardening for custom gateway discovery).
- **Model Import & Capabilities (Spec 017)**: PR #134 (DB metadata persistence), PR #135 (import engine), PR #138 (schema node distinction), PR #139 (live catalogs in passthrough), PR #140 (prune from proven complete snapshots), PR #141 (capability override merging), PR #145 (bounded test-all batch), PR #146 (auto-sync policy), PR #147 (runtime capability overrides editing API), PR #149 (provider listing completeness), PR #150 (dashboard UI for model import/test/sync).
- **Proxy Resilience**: PR #136 (remove failing proxy pools from rotation), PR #137 (explicit egress attribution for 403 cooldowns), PR #148 (opt-in OmniRoute free proxy sources with strict guards).

---

## Graph coverage

Structural discovery and verification were executed via `mcp__codebase-memory-mcp` against graph project `home-redsnow-KhatamRouter` (indexed at `2026-11-08T19:55:21Z`, index mode: full, generation matches).

### Files Verified via `check_index_coverage`

Every code file relied upon was checked:

| File Path | Coverage Status | Freshness | Action Taken |
|---|---|---|---|
| `open-sse/services/minimaxCodeLease.js` | `no_recorded_issue` | `metadata_match` | Graph traversal + verified `validateAndCanonicalizeDataDir` (lines 75-104) and `getLeaseToken` |
| `open-sse/lib/deepseek-pow-hash.js` | `no_recorded_issue` | `metadata_match` | Graph search + verified `solveDeepSeekPow` (lines 231-249) and `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000` |
| `src/dashboardGuard.js` | `no_recorded_issue` | `metadata_match` | Graph search + verified `ALWAYS_PROTECTED` (lines 47-57) and `LOCAL_ONLY_PATHS` (lines 81-100) |
| `open-sse/executors/commandcode.js` | `no_recorded_issue` | `metadata_match` | Verified CLI 1.88.0 request header wiring and session continuity |
| `open-sse/shared/commandCodeHeaders.js` | `no_recorded_issue` | `metadata_match` | Verified decamelizing slugification and UUID header emission |
| `open-sse/providers/registry/commandcode.js` | `no_recorded_issue` | `metadata_match` | Verified registry metadata |
| `open-sse/providers/capabilities.js` | `no_recorded_issue` | `metadata_match` | Verified `gpt-6.1-terra` capabilities (lines 301-310) and Claude 5.5 thinking rules |
| `open-sse/providers/pricing.js` | `no_recorded_issue` | `metadata_match` | Verified `gpt-6.1-terra` pricing table entry (line 93) |
| `open-sse/providers/registry/codex.js` | `no_recorded_issue` | `metadata_match` | Verified `gpt-6.1-terra` model entry (line 57) |
| `open-sse/providers/registry/nace.js` | `no_recorded_issue` | `metadata_match` | Verified Nace System One provider configuration |
| `open-sse/translator/formats/gemini.js` | `no_recorded_issue` | `metadata_match` | Verified protobuf schema normalization (lines 304, 374) |
| `open-sse/handlers/chatCore/nonStreamingHandler.js` | `no_recorded_issue` | `metadata_match` | Verified non-streaming SSE error rejection (lines 249-265) |
| `src/sse/handlers/chat.js` | `no_recorded_issue` | `metadata_match` | Verified leased token non-persistence in SQLite |
| `src/sse/services/tokenRefresh.js` | `no_recorded_issue` | `metadata_match` | Verified ephemeral token refresh bounds |

**Worktree Invariant Note**: Graph indices point to the primary project checkout. Because this audit runs in isolated worktree `/tmp/khatam-upstream-019` on branch `019-upstream-05116` (clean at `master`), direct file reads (`Read` tool) confirmed that the worktree code matches the graph findings line-by-line.

---

## Verification

### Automated CI & Verification Entrypoints (from `.github/workflows/verify.yml`)

KhatamRouter enforces strict Bun-only verification across four parallel CI jobs plus Docker smoke:

```bash
# 1. Syntax & Import Check (typecheck job, plain JS ESM, resolving @/ and relative imports)
# Root tree:
ROOT=$(git ls-files src open-sse custom-server.js next.config.mjs postcss.config.mjs ':(glob)scripts/*.mjs' | grep -E '\.(js|mjs)$' | grep -vE '^src/lib/oauth/(services/(antigravity|claude|codex|gemini|github|iflow|openai|index)|utils/banner)\.js$')
bun build --target=bun --loader=.css:text --external next/font/google --outdir /tmp/syntax-check-out $ROOT
# CLI package:
CLI=$(git ls-files cli | grep -E '\.js$')
bun build --target=bun --packages=external --outdir /tmp/syntax-check-out-cli $CLI

# 2. Baselines (baselines job)
bun tests/__baseline__/verify-providers.mjs       # Verifies 94 provider configurations
bun tests/__baseline__/verify-alias.mjs           # Verifies 132 model alias tokens
bun tests/__baseline__/verify-oauth-urls.mjs      # Verifies OAuth endpoint configurations
bun scripts/verify-docs-claims.mjs               # Verifies docs claims against code

# 3. Core Unit Tests (unit-core job)
cd tests && bun x --bun vitest run --reporter=verbose \
  unit/capabilities.test.js \
  unit/capabilities-service-kind.test.js \
  unit/db-driver-chain.test.js \
  unit/db-migration-chain.test.js \
  unit/custom-server-peer-headers.test.js \
  unit/custom-server-h2c.test.js \
  unit/bun-only-guard.test.js \
  unit/bun-version-consistency.test.js \
  unit/ci-docs-only.test.js

# 4. Wave & Feature Tests (unit-wave job)
cd tests && bun x --bun vitest run --reporter=verbose \
  unit/wave1-bun-ts-redis-sqlite.test.js \
  unit/wave2-migrations.test.js \
  unit/wave2-quota-store.test.js \
  unit/wave3-acl.test.js \
  unit/wave3-limits.test.js \
  unit/wave4-docs-claims.test.js \
  unit/wave4-resilience.test.js \
  unit/wave5-stealth.test.js \
  unit/wave6-models.test.js \
  unit/wave7-parity.test.js \
  unit/wave75-bun-sqlite.test.js \
  unit/wave75-docker-compose.test.js \
  unit/wave75-idempotency.test.js \
  unit/wave75-redis-accelerators.test.js \
  unit/wave75-redis-shared-state.test.js \
  unit/wave75-twins-alignment.test.js \
  unit/psiphon-manager.test.js \
  unit/psiphon-rotation.test.js \
  unit/psiphon-pool-api.test.js \
  unit/psiphon-downloader.test.js

# 5. Targeted Spec 013 Regression Suite
cd tests && bun x --bun vitest run \
  unit/codex-gpt6-lite.test.js \
  unit/codebuddy-channel-headers.test.js \
  unit/codebuddy-intl-backoff.test.js \
  unit/github-claude-5-5-thinking.test.js \
  unit/commandcode-headers.test.js \
  unit/commandcode-usage.test.js \
  unit/bulk-add-names.test.js \
  unit/param-support.test.js \
  unit/nace-systemone-provider.test.js \
  unit/gemini-schema-array-items-predicate.test.js \
  unit/nonstream-sse-error.test.js \
  unit/deepseek-pow-hash.test.js \
  unit/minimax-code-lease.test.js \
  unit/minimax-lease-guard.test.js \
  unit/opencode-tls-client.test.js
```

### Container Verification Smoke Entrypoints (from `verify.yml:352-475`)

Docker smoke tests must be run via subagent (never in main agent):
1. **Build Smoke Image**:
   ```bash
   docker build -f Dockerfile.bun -t khatamrouter:smoke-test .
   ```
2. **Assert No Baked Database**:
   ```bash
   docker run --rm --entrypoint sh khatamrouter:smoke-test -c "test -z \"\$(find / -name '*.sqlite*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -1)\""
   ```
3. **Leg 1: Standalone SQLite Boot & Readiness**:
   ```bash
   docker run -d --name kh-smoke-test -p 20128:20128 -v /tmp/khdata:/app/data -e DATA_DIR=/app/data -e JWT_SECRET=c0ffee1234567890abcdef1234567890c0ffee1234567890abcdef1234567890 -e API_KEY_SECRET=c0ffee1234567890abcdef1234567890c0ffee1234567890abcdef1234567890 khatamrouter:smoke-test
   # Polling readiness:
   until curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/dashboard | grep -E '^(200|302|307)$'; do sleep 1; done
   ```
4. **Leg 2: Redis-Backed Boot & Health Checks**:
   ```bash
   docker run -d --name kh-smoke-redis -p 20128:20128 -e REDIS_URL=redis://host.docker.internal:6379 ... khatamrouter:smoke-test
   ```

---

## Security

### Architectural & Runtime Security Invariants

1. **Bun-Only Invariant**:
   - Node.js, npm, npx, yarn, pnpm are completely banned across runtime, build, subagent tooling, and testing.
   - All tool invocations must use `bun` or `bun x --bun`.
   - Node fallback drivers (`better-sqlite3`, `node:sqlite`, `sql.js`) were removed. `bun:sqlite` is the sole SQLite driver with WAL mode.
   - Dynamic package downloaders (`lazyRuntime.js`) are forbidden.

2. **Access Control & Network Boundaries**:
   - `src/dashboardGuard.js`:
     - `ALWAYS_PROTECTED`: routes requiring JWT token regardless of `requireLogin` setting (e.g., `/api/shutdown`, `/api/settings/database`, `/api/oauth/cursor/auto-import`, `/api/oauth/minimax-code/lease*`).
     - `LOCAL_ONLY_PATHS`: routes restricted strictly to loopback (`localhost`, `127.0.0.1`, `::1`) preventing remote invocation or DNS rebinding (e.g., `/api/cli-tools/*`, `/api/tunnel/*`, `/api/oauth/minimax-code/lease*`, `/api/headroom/*`).
   - Reverse Proxy & IP Spoofing Defense:
     - `custom-server.js` strips incoming `X-Forwarded-For` from client sockets unless the direct TCP peer is a loopback reverse proxy (`isLoopbackPeer`).

3. **MiniMax Code Lease Broker Security Bounds**:
   - Canonical `dataDir` validation (`validateAndCanonicalizeDataDir`) rejects path traversal (`..`), null bytes (`\0`), and non-absolute paths before socket creation.
   - Strict 64KB frame decoding ceiling (`AUTH_LEASE_MAX_FRAME_BYTES = 64 * 1024`) prevents buffer exhaustion DoS attacks.
   - Ephemeral token non-persistence: leased tokens are stripped in `tokenRefresh.js:33` and `chat.js:192` so credentials never touch the SQLite database (`providerConnections`).
   - Multi-worker Redis caching with distributed locking ensures single-flight lease acquisition without token churning.

4. **DeepSeek PoW Solver Bounds**:
   - `open-sse/lib/deepseek-pow-hash.js` enforces strict input assertions:
     - Challenge format: exactly 64 hexadecimal characters (`/^[0-9a-fA-F]{64}$/`).
     - Difficulty ceiling: capped at `MAX_DEEPSEEK_POW_DIFFICULTY = 250_000` to prevent CPU exhaustion.
     - Salt and expiry validated as bounded string (1-1024 chars) and non-negative safe integer.

5. **SSRF & Gateway Egress Hardening**:
   - Custom gateway and proxy URL parsing allows only `http:` and `https:` schemes.
   - Local and private network addresses (RFC 1918, link-local, loopback) are blocked for outbound gateway discovery unless explicitly opted into loopback testing.
   - Gemini image generation reference images are restricted to in-memory base64 data URIs, rejecting external HTTP fetches.

6. **Frozen Behavior Constraints (User Rule)**:
   - **Psiphon Proxy Pool**: Pool lifecycle, regionhop pinning (v1.27.0), and rotation behavior are frozen.
   - **OpenCode Free Rotation**: Session rotation, TLS fingerprinting, and quota backoff behavior are frozen; do not modify quota bypass behavior.

---

## Spec tooling

### Spec-Kit Template Resolution & Configuration

- **Configuration**:
  - `.specify/init-options.json`: Spec-Kit v1.2.2, AI integration: `claude`, feature numbering: `sequential`.
  - `.specify/integration.json`: Integration `claude`, script `sh`, invoke separator `-`.
  - `.specify/feature.json`: Pinned to `{"feature_directory": "specs/019-upstream-05116"}`.
  - `.specify/extensions.yml`: Absent; `setup-plan.sh` executes cleanly with explicit `SPECIFY_FEATURE_DIRECTORY=specs/019-upstream-05116`.
- **Template Resolution Pipeline** (`.specify/scripts/bash/common.sh:512-646`):
  1. Priority 1 (Project overrides): `.specify/templates/overrides/${template_name}.md`
  2. Priority 2 (Presets): `.specify/presets/<preset-id>/templates/${template_name}.md` (sorted by integer priority from `.registry`)
  3. Priority 3 (Extensions): `.specify/extensions/<ext-id>/templates/${template_name}.md` (sorted by `_sorted_extension_ids` from `.specify/extensions/.registry`)
  4. Priority 4 (Core templates): `.specify/templates/${template_name}-template.md` or `${template_name}.md`
- **Extension Hooks**:
  - Extensions register in `.specify/extensions/.registry` with `priority` (integer, default 10) and `enabled` (boolean).
  - Composition strategies (`replace`, `prepend`, `append`, `wrap`) are evaluated via `resolve_template_content`.
- **Project Constitution** (`.specify/memory/constitution.md`, Version 2.1.0):
  - **Principle I (Upstream Base Integrity)**: Direct fork of `decolua/9router` v0.5.104; all features ported without regressing upstream capabilities.
  - **Principle II (Single-Runtime Stack Bun v1.4.4)**: Gateway and dashboard unified on Bun v1.4.4, port 20128.
  - **Principle III (SQLite3 WAL + Redis Hybrid State)**: `bun:sqlite` sole driver on `$DATA_DIR/db/data.sqlite`; Redis `khatam:` namespace for rate limiting, quotas, and cluster events.
  - **Principle IV (Graph-First Discovery & Coverage Invariant)**: Query `codebase-memory-mcp` before edits; verify index coverage on all touched files.
  - **Principle V (Spec-Kit SDD + Unlazy Gate-Driven Completion)**: Runnable acceptance gates (`gate-lint.mjs`, `gate-check.mjs`) required for all work.
  - **Principle VI (Stateless Executors, Limits, Stealth & Capabilities)**: Executors are stateless; granular limits, 4-state circuit breaker, anti-ban protections, and dynamic capability discovery.

### Recommended Memory Pages for Driver

The orchestrator and driver agents should consult the following persistent memory pages:
1. `psiphon-then-spec013-plan.md`: Git gotchas (`.unlazy` and `docs/*` are gitignored; use `git add -f`), wait loops for CI, `gh --repo rqzbeh/KhatamRouter`.
2. `bun-only-tooling-and-single-branch.md`: User rule banning Node.js everywhere (subagents, tests, tools); requirement to delete remote and local branches post-merge.
3. `never-skip-upstream-commits-wreq-js-under-bun.md`: Strict policy against skipping upstream commits; mathematical parity proof for Bun adaptations.
4. `fork-must-overtake-9router-and-vansrouter.md`: Superset objective; keep audit ledger in `docs/UPSTREAM-PORTS.md` updated.
5. `wave-process-spec-unlazy-codebase-memory.md`: Standard wave delivery workflow (Spec-Kit + Unlazy + Codebase-Memory + PR security audit).

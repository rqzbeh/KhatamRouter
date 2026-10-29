# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, distributed as `9router` via `bunx` / `bun add -g`, which fetch from the npm registry) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root — **server strictly REQUIRES Bun**; Node.js is no longer supported):
```bash
cp .env.example .env
bun install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 bun run dev:bun   # dev (webpack, port 20127 by default via next dev)
bun run build:bun && PORT=20128 HOSTNAME=0.0.0.0 bun run start:bun       # production
```
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `bun x eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).
- Bundler: Webpack is retained (`--webpack`). Turbopack was formally evaluated and rejected (see Bundler note below).

CLI package (`cli/`):
```bash
bun run cli:pack       # build + pack from root
cd cli && bun run dev  # dev mode
```
> The published `9router` CLI requires `bun` on PATH and fails with an actionable install message otherwise. `cli/hooks/sqliteRuntime.js` has been removed (tray helpers live in `trayRuntime.js`).

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `bun test`):
```bash
bun install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && bun install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
bun x vitest run                        # all tests; auto-discovers tests/vitest.config.js (Bun host required: bun:sqlite)
bun x vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `bun x vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **Test suite posture**: **4102 passing** with 0 regressions since Wave 7.5. `tests/__baseline__/known-fails.txt` mirrors the measured pre-Wave-7.5 failure set; run the suite under Bun (`bun x vitest run`), not plain Node. Expected red:
> - Catalogued in `tests/__baseline__/known-fails.txt`.
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It is a SQLite layer under `src/lib/db/` standardizing strictly on native `bun:sqlite` with WAL journal mode (`busy_timeout = 5000`, `temp_store = MEMORY`, preflight integrity check).
- **Bun-only**: All Node-runtime fallback drivers (`better-sqlite3`, `node:sqlite`, `sql.js`) have been permanently removed from source, `package.json`, `bun.lock`, and `serverExternalPackages`. Startup fails closed with an actionable message if Bun is not running.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### Bundler Choice (Webpack vs Turbopack Finding)
Turbopack was rigorously evaluated in Wave 7.5 per Spec 0075 and **REJECTED**: Webpack remains the production and development bundler (`--webpack`). Do not re-litigate Turbopack adoption without reviewing `specs/0075-bun-only-redis-default/turbopack-eval.md`:
- Turbopack standalone build caused a **+52% output size inflation** (137 MB vs Webpack's 90 MB) due to dynamic filesystem access in `open-sse/executors/devin-cli.js` triggering unbounded project-wide tracing.
- Turbopack ignored custom `webpack()` config callbacks in `next.config.mjs` (`fs: false`, `path: false`, inotify optimizations).
- Turbopack emitted 27 compilation tracing warnings during static route generation.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- **Security-first on PRs**: Security is the top priority when reviewing or creating PRs. Audit authentication, credential/token storage & leaks, header manipulation (`X-Forwarded-For`), and SSRF risks before functional logic. Always include explicit security warnings/notes when reporting PR reviews or changes to the user.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).

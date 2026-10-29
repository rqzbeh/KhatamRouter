# KhatamRouter

A local AI routing gateway and web dashboard. KhatamRouter exposes one OpenAI-compatible HTTP endpoint (`/v1/*`) across many model providers, with format translation, combo routing with fallback, multi-account rotation, OAuth and API-key credential management, automatic token refresh, and usage tracking.

For implementation status and milestones, see [ROADMAP.md](./ROADMAP.md). For release notes, see [CHANGELOG.md](./CHANGELOG.md).

## How This Fork Differs

KhatamRouter is initialized from decolua/9router and adapts provider definitions and stateless executors from Vanszs/VansRouter. The differences below are from this repository's code.

- **Bun-only runtime**: Runs strictly on Bun. The Node fallback drivers (`better-sqlite3`, `node:sqlite`, `sql.js`) are removed, and startup throws outside Bun (`src/lib/db/driver.js:24-25`). Upstream 9router keeps a multi-driver fallback chain (`src/lib/db/adapters/betterSqliteAdapter.js` exists upstream). VansRouter declares `engines.node` and uses pnpm.
- **Native SQLite with WAL**: Persistence uses `bun:sqlite` with `journal_mode = WAL` and `busy_timeout = 5000` (`src/lib/db/adapters/bunSqliteAdapter.js:11-12`).
- **Multi-process vertical scaling**: A `node:cluster` supervisor runs one worker per core, sized by `KHATAM_WORKERS` (default `max(1, nproc - 2)`, `src/lib/cluster/supervisor.js:20-33`). Neither 9router nor VansRouter uses `node:cluster`.
- **Optional Redis**: Redis provides pub/sub events (`src/lib/redis/events.js`) and the login limiter's shared state (`src/lib/auth/loginLimiter.js`). Without `REDIS_URL`, the gateway uses SQLite and per-process state. Upstream has no Redis code. VansRouter keeps rotation and failure state in in-process `Map`s (`open-sse/services/combo.js:141`).
- **Hot-path caches**: Alias, combo, and node lookups use 5-second in-memory caches with invalidation on writes (`src/lib/db/repos/aliasRepo.js:14`, `src/lib/db/repos/combosRepo.js:10`, `src/lib/db/repos/nodesRepo.js:10`). Neither upstream project has these constants.
- **Atomic shared secrets**: The session secret and machine ID are published with a temp file and hard link, so only one worker's value wins (`src/shared/utils/secretFile.js:9-26`). Used by `src/lib/auth/dashboardSession.js:22` and `src/shared/utils/machineId.js:31`.
- **Request ingestion hardening**: `custom-server.js` rejects requests that combine `Content-Length` and `Transfer-Encoding` (`custom-server.js:310`) and caps chunked bodies at 64 MiB (`custom-server.js:164`).
- **Opt-in capability guard**: Image requests can be refused when no combo target confirms vision support, enabled with `KHATAM_MODEL_CAPABILITY_GUARD=1` (`src/domain/requestCapabilities.js:16`, `open-sse/services/combo.js:525`).
- **Per-key quotas and cost ledger**: Per-key spend caps and a `request_cost_ledger` table (`src/domain/keyQuota.js`, `src/lib/db/keyQuota.js`). Not present in upstream or VansRouter.
- **Stateless executors and LoopGuard**: Executors for AgentRouter, Qwen, ZCode, Freebuff, and MuseSparkWeb (`open-sse/executors/`), plus opt-in sliding-window loop detection (`open-sse/utils/loopGuard.js`, off by default via `loopGuardEnabled`, `src/lib/db/repos/settingsRepo.js:71`). Adapted from VansRouter.
- **Tests and claim checks**: Vitest suite run under Bun, plus `scripts/verify-docs-claims.mjs`, which checks docs against code.

## Quick Start

### Docker Compose

```bash
docker compose up -d
```

`docker-compose.yml` builds the image locally from `Dockerfile.bun`, starts Redis 8.2 alongside it, and publishes the gateway on port `20128`. The dashboard is at `http://localhost:20128/dashboard`. See [DOCKER.md](./DOCKER.md) for standalone containers and volumes.

### From Source

Bun is required.

```bash
bun install

# Development server (the script hardcodes port 20127)
bun run dev:bun

# Production build and start on port 20128
bun run build:bun
PORT=20128 bun run start:bun
```

### CLI Package

```bash
bun add -g 9router   # or: bunx 9router
```

Bun fetches the `9router` package from the npm registry. That package is maintained upstream, so it is not built from this repository's `cli/` directory.

Release notes and tagged releases are listed on [GitHub Releases](https://github.com/rqzbeh/KhatamRouter/releases) and in [CHANGELOG.md](./CHANGELOG.md).

## Configuration

```bash
cp .env.example .env
```

> **Security warning**: Set strong values before exposing the gateway. Defaults are not safe for shared or networked deployments. `INITIAL_PASSWORD` in `.env.example` is `change-me`, and the login route falls back to `123456` if it is unset (`src/app/api/auth/login/route.js:58`). `API_KEY_SECRET` falls back to a built-in string when empty (`src/shared/utils/apiKey.js:3`).

- `INITIAL_PASSWORD`: Dashboard login password. Must be changed.
- `JWT_SECRET`: Session cookie signing key. If empty, a random value is generated under `DATA_DIR`.
- `API_KEY_SECRET`: HMAC secret for gateway API keys. Set it explicitly.
- `PORT`: Listener port. Defaults to `20128` (`custom-server.js:15`).
- `DATA_DIR`: Storage directory. Defaults to `~/.9router` outside Docker, `/app/data` in the compose file.
- `REDIS_URL`: Optional Redis endpoint, for example `redis://localhost:6379`.
- `KHATAM_WORKERS`: Worker count for vertical scaling, clamped to 1-64.

The full list is in [`.env.example`](./.env.example).

## Connecting Clients

- **Base URL**: `http://localhost:20128/v1`
- **Dashboard**: `http://localhost:20128/dashboard`
- **API keys**: Created on the dashboard's Endpoint page (`src/app/(dashboard)/dashboard/endpoint/`).

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model": "YOUR_MODEL_OR_COMBO", "messages": [{"role": "user", "content": "Hello"}]}'
```

Any OpenAI-compatible client can use the base URL. Provider definitions live in `open-sse/providers/registry/`.

## Documentation

- [ROADMAP.md](./ROADMAP.md): implementation status and planned work.
- [CHANGELOG.md](./CHANGELOG.md): release history.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md): request lifecycle, translation, persistence.
- [docs/PERFORMANCE.md](./docs/PERFORMANCE.md): vertical scaling benchmarks.
- [DOCKER.md](./DOCKER.md): container deployment.
- [CLAUDE.md](./CLAUDE.md): contributor and agent conventions.

## Credits and Lineage

- **[decolua/9router](https://github.com/decolua/9router)**: KhatamRouter is initialized from 9router v0.5.104 and ports later upstream releases. The routing engine, dashboard, provider interfaces, and CLI originate there. MIT License.
- **[Vanszs/VansRouter](https://github.com/Vanszs/VansRouter)**: Provider definitions, stateless executors, LoopGuard, and free-tier discovery were adapted from VansRouter to this Bun-only, Redis-optional architecture. KhatamRouter does not share git history with VansRouter. MIT License.

Both projects are MIT-licensed. The copyright notice is preserved in [LICENSE](./LICENSE): Copyright (c) 2024-2026 decolua and contributors.

# ── Multi-stage Dockerfile for Native Bun Runtime (KhatamRouter) ─────────────
# Wave 7.5 (spec/0075-bun-only-redis-default): this file is the single maintained
# application Dockerfile. `Dockerfile.bun` is kept as a byte-identical alias for
# compatibility with older build scripts and CapRover configs; a unit test
# (tests/unit/wave75-docker-compose.test.js) fails if the two ever diverge.
#
# Pinned to oven/bun:1.4.3-slim per Constitution Principle II & Wave 1 spec.
FROM oven/bun:1.4.3-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
     build-essential \
     python3 \
     python-is-python3 \
     make \
     g++ \
     libsecret-1-0 \
     ca-certificates \
     curl \
     sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# ── Builder stage (100% Bun Native Install & Build) ─────────────────────────
FROM base AS builder
WORKDIR /app

# Cache dependency layer. The lockfile is optional for the first build, so the
# build context provides it only when present (.dockerignore keeps it otherwise).
COPY package.json ./
COPY bun.lock* ./

# Fast Bun native package install
RUN bun install --include=optional --quiet

# Smoke check native database driver used by Bun (bun:sqlite)
RUN bun -e "import { Database } from 'bun:sqlite'; const db = new Database(':memory:'); db.query('SELECT 1 AS ok').get(); db.close(); console.log('bun:sqlite smoke: OK');"

COPY . .

# Build-time resource caps. ARGs must be declared to be consumed at all —
# otherwise `--build-arg NEXT_BUILD_CPUS/NODE_OPTIONS` is silently dropped by
# BuildKit. Exporting them via ENV (not just ARG) puts them in the environment
# of the build command below, so `next build` actually sees them.
ARG NEXT_BUILD_CPUS=2
ARG NODE_OPTIONS
ENV NEXT_BUILD_CPUS=${NEXT_BUILD_CPUS}
ENV NODE_OPTIONS=${NODE_OPTIONS}

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build-local throwaway path so build-time operations never touch /root/.9router or leak into the image
ENV DATA_DIR=/tmp/khatam-build-data
ENV DATA_DIR_ALLOW_TEMP=1

# Next.js build execution under Bun
RUN bun run build

# ── Runner stage (100% Bun Native Production Runtime) ───────────────────────
FROM oven/bun:1.4.3-slim AS runner

LABEL org.opencontainers.image.title="khatamrouter" \
  org.opencontainers.image.description="KhatamRouter — dual-runtime AI gateway & control plane (Bun Native)" \
  org.opencontainers.image.licenses="MIT"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     curl \
     sqlite3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Dual-port architecture:
#   DASHBOARD_PORT (20128) - Bun Next.js control plane
#   ENDPOINT_PORT  (20129) - Go data plane gateway
ENV PORT=20128
ENV DASHBOARD_PORT=20128
ENV ENDPOINT_PORT=20129
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

# Standalone output artifacts from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/runtime-secrets.cjs ./runtime-secrets.cjs

# Wave 7.5 / SC-009: bun:sqlite is built into the Bun binary, so the image must
# ship no Node-only SQLite addon. If output tracing ever drags one in, fail the
# build here instead of shipping it.
RUN test -z "$(find /app -type f -name 'better_sqlite3.node' -print -quit 2>/dev/null || true)"

RUN chown -R bun:bun /app /app/data

USER bun

# Expose both the control plane dashboard and the data plane endpoint gateway
EXPOSE 20128 20129

ENTRYPOINT ["bun", "custom-server.js"]

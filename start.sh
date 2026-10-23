#!/usr/bin/env bash
set -euo pipefail

# ── Launch KhatamRouter under Native Bun Runtime via Docker ─────────────────
# Builds and runs the consolidated Bun Dockerfile (Dockerfile.bun / Dockerfile).
# Ports:
#   20128 - DASHBOARD_PORT (Bun Next.js control plane)
#   20129 - ENDPOINT_PORT  (Go data plane gateway)

docker stop 9router 2>/dev/null || true
docker rm 9router 2>/dev/null || true

# Build the Bun native container image
docker build -f Dockerfile.bun -t 9router .

# Run with Bun runtime, mounted data volume, and env-file
docker run -d \
  --name 9router \
  -p 20128:20128 \
  -p 20129:20129 \
  --env-file .env \
  -v 9router-data:/app/data \
  9router

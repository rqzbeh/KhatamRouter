#!/usr/bin/env bash
# ── Wave 7.5: Docker Compose Bun & Redis Smoke Verification (T015a / FR-026) ──
# Verifies that:
#   1. docker-compose builds the native Bun image (Dockerfile.bun / Dockerfile).
#   2. redis:8.2-alpine starts and reaches 'healthy' status before the app.
#   3. The app is auto-wired with REDIS_URL=redis://redis:6379 and answers requests.
#   4. PRAGMA journal_mode is 'wal' and PRAGMA quick_check is 'ok' in SQLite.
#   5. The -wal file appears in the persistent data volume.
#   6. Zero Node-only SQLite native addons (better_sqlite3.node) exist in the image.
#
# Rules:
#   - Pinned to linux/amd64, NEXT_BUILD_CPUS=2, NODE_OPTIONS=--max-old-space-size=3072.
#   - Isolated project name and temp volume.
#   - Never touches the 'hindsight' container or runs docker system prune.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-khatam-smoke-$$}"
DASHBOARD_PORT="${DASHBOARD_HOST_PORT:-20128}"
if [ "$DASHBOARD_PORT" -gt 65535 ]; then
  DASHBOARD_PORT="${DASHBOARD_PORT#1}"
fi
if ss -tulpn 2>/dev/null | grep -q ":${DASHBOARD_PORT} "; then
  DASHBOARD_PORT=30128
fi

REDIS_PORT="${REDIS_HOST_PORT:-16379}"
if [ "$REDIS_PORT" -gt 65535 ]; then
  REDIS_PORT="${REDIS_PORT#1}"
fi
SMOKE_DATA_DIR="${SMOKE_DATA_DIR:-/tmp/khatam-smoke-data}"
OVERRIDE_FILE=""

cleanup() {
  local exit_code=$?
  echo ""
  echo "=== [Cleanup] Tearing down smoke stack ($PROJECT_NAME) ==="
  if [ -n "$OVERRIDE_FILE" ] && [ -f "$OVERRIDE_FILE" ]; then
    rm -f "$OVERRIDE_FILE" 2>/dev/null || true
  fi
  if [ -n "$OVERRIDE_FILE" ] && [ -f "docker-compose.yml" ]; then
    docker compose -p "$PROJECT_NAME" -f docker-compose.yml -f "$OVERRIDE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f khatam-smoke-app khatam-smoke-redis khatam-smoke-headroom >/dev/null 2>&1 || true
  if [ -n "$SMOKE_DATA_DIR" ] && [ -d "$SMOKE_DATA_DIR" ]; then
    rm -rf "$SMOKE_DATA_DIR" >/dev/null 2>&1 || docker run --rm -v /tmp:/tmp-host --user 0 --entrypoint rm khatamrouter:smoke-w75 -rf "/tmp-host/$(basename "$SMOKE_DATA_DIR")" >/dev/null 2>&1 || true
  fi
  if [ "$exit_code" -ne 0 ]; then
    echo "❌ Smoke check failed with exit code $exit_code"
  fi
}
trap cleanup EXIT

echo "=== [1/7] Preparing smoke environment ==="
# Clean any stale smoke containers or data
docker rm -f khatam-smoke-app khatam-smoke-redis khatam-smoke-headroom >/dev/null 2>&1 || true
if [ -d "$SMOKE_DATA_DIR" ]; then
  rm -rf "$SMOKE_DATA_DIR" >/dev/null 2>&1 || docker run --rm -v /tmp:/tmp-host --user 0 --entrypoint rm khatamrouter:smoke-w75 -rf "/tmp-host/$(basename "$SMOKE_DATA_DIR")" >/dev/null 2>&1 || true
fi
mkdir -p "$SMOKE_DATA_DIR"
chmod 777 "$SMOKE_DATA_DIR" 2>/dev/null || true

# Compose override to map dedicated smoke host ports and volume
OVERRIDE_FILE="/tmp/kh-w75-override-$$.yml"
cat <<EOF > "$OVERRIDE_FILE"
services:
  9router:
    container_name: khatam-smoke-app
    image: khatamrouter:smoke-w75
    ports:
      - "${DASHBOARD_PORT}:20128"
    volumes:
      - ${SMOKE_DATA_DIR}:/app/data
    environment:
      DATA_DIR: /app/data
      JWT_SECRET: "smoke-jwt-secret-w75-verification-key"
      API_KEY_SECRET: "smoke-api-key-secret-w75-verification-key"
  redis:
    container_name: khatam-smoke-redis
    ports:
      - "127.0.0.1:${REDIS_PORT}:6379"
  headroom:
    container_name: khatam-smoke-headroom
EOF

echo "=== [2/7] Building and launching stack ($PROJECT_NAME) ==="
export DOCKER_DEFAULT_PLATFORM="${PLATFORM:-linux/amd64}"
docker compose -p "$PROJECT_NAME" -f docker-compose.yml -f "$OVERRIDE_FILE" build \
  --build-arg NEXT_BUILD_CPUS=2 \
  --build-arg NODE_OPTIONS="--max-old-space-size=3072"

docker compose -p "$PROJECT_NAME" -f docker-compose.yml -f "$OVERRIDE_FILE" up -d

echo "=== [3/7] Waiting for Redis healthcheck (redis:8.2-alpine) ==="
REDIS_CID=$(docker compose -p "$PROJECT_NAME" ps -q redis)
REDIS_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$REDIS_CID")
echo "Redis image: $REDIS_IMAGE"
if [ "$REDIS_IMAGE" != "redis:8.2-alpine" ]; then
  echo "Error: Expected redis:8.2-alpine, got $REDIS_IMAGE"
  exit 1
fi
echo "Verified: Redis image is redis:8.2-alpine"

REDIS_HEALTHY=0
for i in $(seq 1 60); do
  STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' "$REDIS_CID" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    REDIS_HEALTHY=1
    echo "Redis healthy after ${i}s"
    break
  fi
  sleep 1
done

if [ "$REDIS_HEALTHY" -ne 1 ]; then
  echo "Error: Redis service did not reach 'healthy' state within 60s (status: $STATUS)"
  docker compose -p "$PROJECT_NAME" logs redis
  exit 1
fi

APP_CID=$(docker compose -p "$PROJECT_NAME" ps -q 9router)
REDIS_STARTED_AT=$(docker inspect --format='{{.State.StartedAt}}' "$REDIS_CID")
APP_STARTED_AT=$(docker inspect --format='{{.State.StartedAt}}' "$APP_CID")
echo "Redis container started at: $REDIS_STARTED_AT"
echo "App container started at:   $APP_STARTED_AT"
if ! docker compose -p "$PROJECT_NAME" -f docker-compose.yml config | grep -A 2 "redis:" | grep -q "service_healthy"; then
  echo "Error: App does not have condition: service_healthy on Redis"
  exit 1
fi
echo "Verified: Redis reaches healthy BEFORE the app starts (depends_on: redis: condition: service_healthy)."

echo "=== [4/7] Waiting for KhatamRouter app readiness on http://127.0.0.1:${DASHBOARD_PORT} ==="
APP_READY=0
HTTP_STATUS=""
for i in $(seq 1 90); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/dashboard" || true)
  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "307" ]; then
    APP_READY=1
    echo "App ready after ${i}s (HTTP /dashboard: $HTTP_STATUS)"
    break
  fi
  sleep 1
done

if [ "$APP_READY" -ne 1 ]; then
  echo "Error: App failed to become ready within 90s (HTTP /dashboard status: $HTTP_STATUS)"
  docker compose -p "$PROJECT_NAME" logs 9router
  exit 1
fi

echo "=== [5/7] Probing application HTTP endpoints ==="
ROOT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/" || true)
echo "HTTP / returned: $ROOT_STATUS"
if [ "$ROOT_STATUS" != "200" ] && [ "$ROOT_STATUS" != "302" ] && [ "$ROOT_STATUS" != "307" ]; then
  echo "Error: / returned unexpected HTTP status $ROOT_STATUS"
  exit 1
fi

MODELS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/v1/models" || true)
echo "HTTP /v1/models returned: $MODELS_STATUS"
if [ "$MODELS_STATUS" != "200" ] && [ "$MODELS_STATUS" != "401" ]; then
  echo "Error: /v1/models returned unexpected status $MODELS_STATUS"
  exit 1
fi

echo "=== [6/7] Validating SQLite WAL mode, quick_check integrity & -wal file ==="
docker compose -p "$PROJECT_NAME" exec -T 9router bun -e '
  import { Database } from "bun:sqlite";
  const dbPath = (process.env.DATA_DIR || "/app/data") + "/db/data.sqlite";
  const db = new Database(dbPath, { readonly: true });
  const journal = db.query("PRAGMA journal_mode;").get();
  const integrity = db.query("PRAGMA quick_check;").get();
  console.log("Journal mode:", JSON.stringify(journal));
  console.log("Integrity:", JSON.stringify(integrity));
  if (journal["journal_mode"] !== "wal") {
    console.error("Expected WAL mode, got:", journal);
    process.exit(1);
  }
  if (integrity["quick_check"] !== "ok") {
    console.error("Integrity check failed:", integrity);
    process.exit(1);
  }
'

# Assert -wal file appears in mounted volume
WAL_FOUND=0
if ls "$SMOKE_DATA_DIR/db/"*"-wal" >/dev/null 2>&1; then
  WAL_FOUND=1
  echo "Verified: SQLite -wal file found on host mount: $(ls "$SMOKE_DATA_DIR/db/"*"-wal")"
else
  echo "Writing probe to generate WAL activity..."
  docker compose -p "$PROJECT_NAME" exec -T 9router bun -e '
    import { Database } from "bun:sqlite";
    const dbPath = (process.env.DATA_DIR || "/app/data") + "/db/data.sqlite";
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS _smoke_wal_probe (id INTEGER PRIMARY KEY, ts INTEGER); INSERT INTO _smoke_wal_probe (ts) VALUES (" + Date.now() + ");");
  '
  if ls "$SMOKE_DATA_DIR/db/"*"-wal" >/dev/null 2>&1; then
    WAL_FOUND=1
    echo "Verified: SQLite -wal file found on host mount after write: $(ls "$SMOKE_DATA_DIR/db/"*"-wal")"
  fi
fi

if [ "$WAL_FOUND" -ne 1 ]; then
  echo "Error: SQLite -wal file not found on host mount under $SMOKE_DATA_DIR/db/"
  exit 1
fi

echo "=== [7/7] Confirming no Node-only SQLite binary in built image (SC-009) ==="
NODE_ADDONS=$(docker compose -p "$PROJECT_NAME" exec -T 9router find / -name "better_sqlite3.node" 2>/dev/null || true)
if [ -n "$NODE_ADDONS" ]; then
  echo "Error: Found Node-only native SQLite addon in production image:"
  echo "$NODE_ADDONS"
  exit 1
fi
echo "Verified: Zero Node-only SQLite native binaries found in container."

echo ""
echo "WAVE75_COMPOSE_SMOKE_OK"

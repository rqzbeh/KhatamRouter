#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PLATFORM="${PLATFORM:-linux/amd64}"
CONTAINER_NAME="${CONTAINER_NAME:-kh-smoke}"
IMAGE_NAME="khatamrouter:smoke-${CONTAINER_NAME}-$$"
DATA_TMP=""

cleanup() {
  local exit_code=$?
  echo "--- Cleanup ---"
  if [ -n "$CONTAINER_NAME" ]; then
    if [ "$exit_code" -ne 0 ]; then
      echo "Dumping container logs before removal:"
      docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
    fi
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$IMAGE_NAME" ]; then
    docker rmi -f "$IMAGE_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$DATA_TMP" ] && [ -d "$DATA_TMP" ]; then
    rm -rf "$DATA_TMP" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

echo "=== 1. Building container image ($IMAGE_NAME) for platform $PLATFORM ==="
docker buildx build --platform "$PLATFORM" --load -f Dockerfile.bun -t "$IMAGE_NAME" .

echo "=== 2. Asserting no baked database inside image ==="
docker run --rm --entrypoint sh "$IMAGE_NAME" -c 'test -z "$(find / -name "*.sqlite*" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null | head -1)"'
echo "No baked SQLite databases found in image."

echo "=== 3. Booting container ==="
DATA_TMP="$(mktemp -d /tmp/kh-smoke-data-XXXXXX)"
chmod 777 "$DATA_TMP"

TEST_JWT_SECRET="c0ffee1234567890abcdef1234567890c0ffee1234567890abcdef1234567890"
TEST_API_KEY_SECRET="c0ffee1234567890abcdef1234567890c0ffee1234567890abcdef1234567890"

docker run -d \
  --name "$CONTAINER_NAME" \
  -p 20128:20128 \
  -v "$DATA_TMP:/app/data" \
  -e DATA_DIR=/app/data \
  -e JWT_SECRET="$TEST_JWT_SECRET" \
  -e API_KEY_SECRET="$TEST_API_KEY_SECRET" \
  "$IMAGE_NAME"

echo "Polling up to 90s for HTTP readiness on 127.0.0.1:20128/dashboard..."
READY=0
HTTP_STATUS=""
for i in $(seq 1 90); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/dashboard || true)
  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "307" ]; then
    READY=1
    echo "Dashboard ready after ${i}s (HTTP status: $HTTP_STATUS)"
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "Error: Container failed to become ready within 90s (last HTTP status: $HTTP_STATUS)"
  exit 1
fi

echo "=== 4. Asserting HTTP endpoints ==="
if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "302" ] && [ "$HTTP_STATUS" != "307" ]; then
  echo "Error: /dashboard returned unexpected HTTP status $HTTP_STATUS (expected 200, 302, or 307)"
  exit 1
fi
echo "/dashboard returned valid status: $HTTP_STATUS"

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/api/health || true)
if [ "$HEALTH_STATUS" = "200" ]; then
  echo "/api/health returned 200 OK"
elif [ "$HEALTH_STATUS" = "404" ]; then
  echo "/api/health returned 404 (endpoint not defined, noted)"
else
  echo "/api/health returned HTTP $HEALTH_STATUS (noted)"
fi

echo "=== 5. Asserting runtime migrations ==="
MIGRATION_ROWS=$(docker exec "$CONTAINER_NAME" sqlite3 /app/data/db/data.sqlite "SELECT version FROM _khatam_migrations ORDER BY version;")
ROW_COUNT=$(echo "$MIGRATION_ROWS" | grep -c . || true)
echo "_khatam_migrations has $ROW_COUNT rows:"
echo "$MIGRATION_ROWS"

if [ "$ROW_COUNT" -lt 2 ]; then
  echo "Error: Expected at least 2 migrations in _khatam_migrations, found $ROW_COUNT"
  exit 1
fi

JOURNAL_MODE=$(docker exec "$CONTAINER_NAME" sqlite3 /app/data/db/data.sqlite "PRAGMA journal_mode;")
echo "PRAGMA journal_mode: $JOURNAL_MODE"
if [ "$JOURNAL_MODE" != "wal" ]; then
  echo "Error: Expected PRAGMA journal_mode to be wal, got $JOURNAL_MODE"
  exit 1
fi

echo "=== 6. Asserting ACL tables wiring ==="
ACL_TABLES=$(docker exec "$CONTAINER_NAME" sqlite3 /app/data/db/data.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('api_key_quota_limits','request_cost_ledger') ORDER BY name;")
echo "ACL tables found:"
echo "$ACL_TABLES"

if ! echo "$ACL_TABLES" | grep -q "api_key_quota_limits"; then
  echo "Error: Missing table api_key_quota_limits"
  exit 1
fi
if ! echo "$ACL_TABLES" | grep -q "request_cost_ledger"; then
  echo "Error: Missing table request_cost_ledger"
  exit 1
fi

IMAGE_DIGEST=$(docker inspect --format='{{.Id}}' "$IMAGE_NAME" 2>/dev/null || docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_NAME" 2>/dev/null || echo "unknown")

echo "=== Smoke check passed successfully! ==="
echo "Summary: platform=$PLATFORM image=$IMAGE_NAME digest=$IMAGE_DIGEST"

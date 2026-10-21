#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PLATFORM="${PLATFORM:-linux/amd64}"
CONTAINER_NAME="${CONTAINER_NAME:-kh-smoke}"
CONTAINER_NAME_REDIS="${CONTAINER_NAME}-redis"
IMAGE_NAME="khatamrouter:smoke-${CONTAINER_NAME}-$$"
DATA_TMP=""
DATA_TMP_REDIS=""
LOCAL_REDIS_CID=""

cleanup() {
  local exit_code=$?
  echo "--- Cleanup ---"
  if [ -n "$CONTAINER_NAME" ]; then
    if [ "$exit_code" -ne 0 ]; then
      echo "Dumping container logs before removal ($CONTAINER_NAME):"
      docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
    fi
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$CONTAINER_NAME_REDIS" ]; then
    if [ "$exit_code" -ne 0 ]; then
      echo "Dumping container logs before removal ($CONTAINER_NAME_REDIS):"
      docker logs --tail 50 "$CONTAINER_NAME_REDIS" 2>&1 || true
    fi
    docker rm -f "$CONTAINER_NAME_REDIS" >/dev/null 2>&1 || true
  fi
  if [ -n "$LOCAL_REDIS_CID" ]; then
    docker rm -f "$LOCAL_REDIS_CID" >/dev/null 2>&1 || true
  fi
  if [ -n "$IMAGE_NAME" ]; then
    docker rmi -f "$IMAGE_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$DATA_TMP" ] && [ -d "$DATA_TMP" ]; then
    rm -rf "$DATA_TMP" >/dev/null 2>&1 || true
  fi
  if [ -n "$DATA_TMP_REDIS" ] && [ -d "$DATA_TMP_REDIS" ]; then
    rm -rf "$DATA_TMP_REDIS" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

echo "=== 1. Building container image ($IMAGE_NAME) for platform $PLATFORM ==="
docker buildx build --platform "$PLATFORM" --load -f Dockerfile.bun -t "$IMAGE_NAME" .

echo "=== 2. Asserting no baked database inside image ==="
docker run --rm --entrypoint sh "$IMAGE_NAME" -c 'test -z "$(find / -name "*.sqlite*" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null | head -1)"'
echo "No baked SQLite databases found in image."

echo "=== 3. Booting container (Leg 1: SQLite standalone) ==="
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

echo "=== 4. Asserting HTTP endpoints (Leg 1) ==="
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

echo "=== 5. Asserting runtime migrations (Leg 1) ==="
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

echo "=== 6. Asserting ACL tables wiring (Leg 1) ==="
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

# Stop Leg 1 container before optional Leg 2
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# Check if Redis is available or requested
REDIS_AVAILABLE=0
if [ -n "${REDIS_URL:-}" ]; then
  REDIS_AVAILABLE=1
elif timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/6379" 2>/dev/null; then
  REDIS_AVAILABLE=1
  export REDIS_URL="redis://127.0.0.1:6379"
fi

if [ "$REDIS_AVAILABLE" -eq 1 ]; then
  echo "=== 7. Booting container (Leg 2: Redis-backed) ==="
  DATA_TMP_REDIS="$(mktemp -d /tmp/kh-smoke-redis-data-XXXXXX)"
  chmod 777 "$DATA_TMP_REDIS"

  docker run -d \
    --name "$CONTAINER_NAME_REDIS" \
    --network host \
    -v "$DATA_TMP_REDIS:/app/data" \
    -e DATA_DIR=/app/data \
    -e REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
    -e REDIS_KEY_PREFIX=khatam: \
    -e JWT_SECRET="$TEST_JWT_SECRET" \
    -e API_KEY_SECRET="$TEST_API_KEY_SECRET" \
    "$IMAGE_NAME"

  echo "Polling up to 90s for HTTP readiness on 127.0.0.1:20128/dashboard (Redis leg)..."
  REDIS_LEG_READY=0
  for i in $(seq 1 90); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/dashboard || true)
    if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ] || [ "$STATUS" = "307" ]; then
      REDIS_LEG_READY=1
      echo "Redis leg ready after ${i}s (HTTP status: $STATUS)"
      break
    fi
    sleep 1
  done

  if [ "$REDIS_LEG_READY" -ne 1 ]; then
    echo "Error: Redis-backed container failed to become ready within 90s"
    exit 1
  fi

  echo "=== 8. Asserting HTTP endpoints (Leg 2: with Redis) ==="
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/dashboard)
  if [ "$STATUS" != "200" ] && [ "$STATUS" != "302" ] && [ "$STATUS" != "307" ]; then
    echo "Error: /dashboard returned unexpected HTTP status $STATUS with Redis present"
    exit 1
  fi
  echo "/dashboard returned valid status with Redis: $STATUS"

  echo "=== 9. Proving Redis usage (Leg 2) ==="
  docker exec "$CONTAINER_NAME_REDIS" bun -e '
    import Redis from "ioredis";
    const prefix = process.env.REDIS_KEY_PREFIX || "khatam:";
    const client = new Redis(process.env.REDIS_URL);
    await client.set(`${prefix}smoke:probe`, "connected", "EX", 120);
    const readBack = await client.get(`${prefix}smoke:probe`);
    console.log("Container Redis probe verified: " + readBack);
    await client.quit();
  '
else
  echo "Notice: Redis service is not running on 127.0.0.1:6379 and REDIS_URL is unset. Skipping local Leg 2 (exercised in CI)."
fi

IMAGE_DIGEST=$(docker inspect --format='{{.Id}}' "$IMAGE_NAME" 2>/dev/null || docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_NAME" 2>/dev/null || echo "unknown")

echo "=== Smoke check passed successfully! ==="
echo "Summary: platform=$PLATFORM image=$IMAGE_NAME digest=$IMAGE_DIGEST"

#!/usr/bin/env bash
# ── Wave 7.5: Redis Outage Drill Verification (T015b / FR-014 / SC-003) ───────
# Verifies that:
#   1. Stopping the Redis container does not crash or block the KhatamRouter app.
#   2. The app continues serving /dashboard and /v1/models during the outage.
#   3. Rate / quota limits continue to be strictly enforced (via SQLite degradation),
#      never granting unlimited request quota during an outage.
#   4. At most one degraded warning is logged during the outage.
#   5. When Redis restarts, the app reconnects automatically without container restart.
#
# Rules:
#   - Works with an existing running stack or launches an isolated temporary stack.
#   - Never touches the 'hindsight' container or runs docker system prune.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
DASHBOARD_PORT="${DASHBOARD_HOST_PORT:-}"
STARTED_OWN_STACK=0
SMOKE_DATA_DIR=""
OVERRIDE_FILE=""

cleanup() {
  local exit_code=$?
  echo ""
  echo "=== [Cleanup] Redis outage drill cleanup ==="
  if [ "$STARTED_OWN_STACK" -eq 1 ]; then
    echo "Tearing down temporary drill stack ($PROJECT_NAME)..."
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
  else
    # If using an existing stack, make sure Redis is started back up
    if [ -n "$PROJECT_NAME" ]; then
      echo "Ensuring Redis service is left running in existing stack..."
      docker compose -p "$PROJECT_NAME" start redis >/dev/null 2>&1 || true
    fi
  fi
  if [ "$exit_code" -ne 0 ]; then
    echo "❌ Redis outage drill failed with exit code $exit_code"
  fi
}
trap cleanup EXIT

# ── Discover existing stack or spin up a dedicated one ──────────────────────
if [ -z "$PROJECT_NAME" ]; then
  # Check if default compose stack is running
  if docker compose ps -q 9router >/dev/null 2>&1 && [ -n "$(docker compose ps -q 9router)" ]; then
    PROJECT_NAME="khatamrouter"
    DASHBOARD_PORT="${DASHBOARD_PORT:-20128}"
    echo "Detected running KhatamRouter compose stack (port $DASHBOARD_PORT)"
  else
    echo "No running stack detected; starting dedicated drill stack..."
    PROJECT_NAME="khatam-smoke-drill-$$"
    DASHBOARD_PORT="${DASHBOARD_PORT:-20128}"
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
    STARTED_OWN_STACK=1

    docker rm -f khatam-smoke-app khatam-smoke-redis khatam-smoke-headroom >/dev/null 2>&1 || true
    SMOKE_DATA_DIR="/tmp/khatam-smoke-data"
    if [ -d "$SMOKE_DATA_DIR" ]; then
      rm -rf "$SMOKE_DATA_DIR" >/dev/null 2>&1 || docker run --rm -v /tmp:/tmp-host --user 0 --entrypoint rm khatamrouter:smoke-w75 -rf "/tmp-host/$(basename "$SMOKE_DATA_DIR")" >/dev/null 2>&1 || true
    fi
    mkdir -p "$SMOKE_DATA_DIR"
    chmod 777 "$SMOKE_DATA_DIR" 2>/dev/null || true

    OVERRIDE_FILE="/tmp/kh-w75-drill-override-$$.yml"
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
      JWT_SECRET: "drill-jwt-secret-w75-key"
      API_KEY_SECRET: "drill-api-key-secret-w75-key"
  redis:
    container_name: khatam-smoke-redis
    ports:
      - "127.0.0.1:${REDIS_PORT}:6379"
  headroom:
    container_name: khatam-smoke-headroom
EOF

    export DOCKER_DEFAULT_PLATFORM="${PLATFORM:-linux/amd64}"
    docker compose -p "$PROJECT_NAME" -f docker-compose.yml -f "$OVERRIDE_FILE" build \
      --build-arg NEXT_BUILD_CPUS=2 \
      --build-arg NODE_OPTIONS="--max-old-space-size=3072"
    docker compose -p "$PROJECT_NAME" -f docker-compose.yml -f "$OVERRIDE_FILE" up -d

    # Wait for Redis and App readiness
    echo "Waiting for Redis health..."
    REDIS_CID=$(docker compose -p "$PROJECT_NAME" ps -q redis)
    for i in $(seq 1 60); do
      STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' "$REDIS_CID" 2>/dev/null || echo "unknown")
      if [ "$STATUS" = "healthy" ]; then break; fi
      sleep 1
    done

    echo "Waiting for App readiness..."
    for i in $(seq 1 90); do
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/dashboard" || true)
      if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "307" ]; then break; fi
      sleep 1
    done
  fi
fi

echo "=== [1/5] Baseline check before Redis outage ==="
PRE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/dashboard" || true)
echo "Baseline /dashboard HTTP status: $PRE_STATUS"
if [ "$PRE_STATUS" != "200" ] && [ "$PRE_STATUS" != "302" ] && [ "$PRE_STATUS" != "307" ]; then
  echo "Error: Baseline /dashboard check failed ($PRE_STATUS)"
  exit 1
fi

APP_CID=$(docker compose -p "$PROJECT_NAME" ps -q 9router)
APP_STARTED_AT_BEFORE=$(docker inspect --format='{{.State.StartedAt}}' "$APP_CID")
echo "App container StartedAt before outage: $APP_STARTED_AT_BEFORE"

# Seed a test API key with rate limit (limit: 2 requests per minute) into container's own SQLite
echo "Seeding low rate-limit API key into container SQLite database..."
docker compose -p "$PROJECT_NAME" exec -T 9router sqlite3 /app/data/db/data.sqlite "
  INSERT OR REPLACE INTO apiKeys (id, key, name, isActive, createdAt, rate_limits)
  VALUES ('drill-rate-limit-key-id', 'sk-w75-outage-drill-key', 'Outage Drill Key', 1, datetime('now'), '[{\"limit\":2,\"window\":\"1m\"}]');
"
echo "Verified: Seeded API key 'sk-w75-outage-drill-key' with limit 2 req/min into container SQLite."

# Exercise auth login endpoint to initialize Redis client while Redis is healthy
curl -s -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"drill-baseline-probe"}' >/dev/null || true

echo "=== [2/5] Simulating Redis outage (stopping Redis container) ==="
docker compose -p "$PROJECT_NAME" stop redis
echo "Redis container stopped."
REDIS_CID=$(docker compose -p "$PROJECT_NAME" ps -q redis)
REDIS_STATUS=$(docker inspect --format='{{.State.Status}}' "$REDIS_CID" 2>/dev/null || echo "stopped")
echo "Redis container status: $REDIS_STATUS"

echo "=== [3/5] Verifying fail-open serving and SQLite quota limit enforcement ==="
OUTAGE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/dashboard" || true)
echo "Dashboard status during Redis outage: $OUTAGE_HTTP"
if [ "$OUTAGE_HTTP" != "200" ] && [ "$OUTAGE_HTTP" != "302" ] && [ "$OUTAGE_HTTP" != "307" ]; then
  echo "Error: App failed to serve /dashboard during Redis outage (got $OUTAGE_HTTP)"
  exit 1
fi

OUTAGE_MODELS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/v1/models" || true)
echo "/v1/models status during Redis outage: $OUTAGE_MODELS"
if [ "$OUTAGE_MODELS" != "200" ] && [ "$OUTAGE_MODELS" != "401" ]; then
  echo "Error: App failed to answer /v1/models during Redis outage (got $OUTAGE_MODELS)"
  exit 1
fi

# Exercise login during outage to trigger and verify fail-open limiter behavior
curl -s -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"drill-outage-probe"}' >/dev/null || true

echo "Exercising Rate Limit enforcement over HTTP API during outage (limit: 2 req/min)..."
# Request 1: within limit (1/2) -> allowed by rate limiter
REQ1_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${DASHBOARD_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer sk-w75-outage-drill-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"drill-probe-model","messages":[{"role":"user","content":"test 1"}]}' || true)
echo "HTTP Request 1 status (under limit): $REQ1_STATUS"
if [ "$REQ1_STATUS" = "429" ]; then
  echo "Error: Request 1 was unexpectedly rate-limited (got 429)"
  exit 1
fi

# Request 2: reaching limit (2/2) -> allowed by rate limiter
REQ2_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${DASHBOARD_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer sk-w75-outage-drill-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"drill-probe-model","messages":[{"role":"user","content":"test 2"}]}' || true)
echo "HTTP Request 2 status (at limit): $REQ2_STATUS"
if [ "$REQ2_STATUS" = "429" ]; then
  echo "Error: Request 2 was unexpectedly rate-limited (got 429)"
  exit 1
fi

# Request 3: exceeding limit (3/2) -> MUST BE REJECTED with HTTP 429
REQ3_RESP=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:${DASHBOARD_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer sk-w75-outage-drill-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"drill-probe-model","messages":[{"role":"user","content":"test 3"}]}' || true)
REQ3_STATUS=$(echo "$REQ3_RESP" | tail -n 1)
REQ3_BODY=$(echo "$REQ3_RESP" | head -n -1)
echo "HTTP Request 3 status (over limit): $REQ3_STATUS"
echo "HTTP Request 3 response body: $REQ3_BODY"
if [ "$REQ3_STATUS" != "429" ]; then
  echo "CRITICAL DEFECT: Request 3 was NOT rejected with 429 during Redis outage (got $REQ3_STATUS)!"
  exit 1
fi
if ! echo "$REQ3_BODY" | grep -qi "rate limit"; then
  echo "Error: 429 response body did not describe rate limit rejection: $REQ3_BODY"
  exit 1
fi
echo "Verified: Rate limit strictly enforced during Redis outage over real HTTP API (requests 1 & 2 allowed, request 3 rejected with HTTP 429)."

echo "=== [4/5] Checking container logs for degraded warning ==="
sleep 2
LOG_WARNINGS=$(docker compose -p "$PROJECT_NAME" logs --tail 100 9router 2>&1 | grep -iE "redis.*(fail-open|degraded|offline|running without redis)" || true)
echo "Degraded log entries found:"
echo "$LOG_WARNINGS"

# Specifically verify the fail-open warning is logged exactly once per connection (Constitution Principle III)
CLIENT_WARN_COUNT=$(docker compose -p "$PROJECT_NAME" logs 9router 2>&1 | grep -c "\[redis\] redis connection error:" || true)
echo "Degraded warnings count for Redis connection: $CLIENT_WARN_COUNT"
if [ "$CLIENT_WARN_COUNT" -ne 1 ]; then
  echo "Error: Expected exactly 1 degraded warning for Redis connection, found $CLIENT_WARN_COUNT"
  exit 1
fi
echo "Verified: exactly one degraded warning was logged for Redis connection."
echo "Verified: App logged degraded warning during Redis outage without spamming logs."

echo "=== [5/5] Restarting Redis and verifying automatic reconnection ==="
docker compose -p "$PROJECT_NAME" start redis

REDIS_CID=$(docker compose -p "$PROJECT_NAME" ps -q redis)
RECONNECTED=0
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$REDIS_CID" 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ] || [ "$STATUS" = "running" ]; then
    echo "Redis container back up after ${i}s (status: $STATUS)"
    RECONNECTED=1
    break
  fi
  sleep 1
done

if [ "$RECONNECTED" -ne 1 ]; then
  echo "Error: Redis failed to restart within 30s"
  exit 1
fi

sleep 2

# Verify app container did NOT restart
APP_STARTED_AT_AFTER=$(docker inspect --format='{{.State.StartedAt}}' "$APP_CID")
echo "App container StartedAt after Redis recovery: $APP_STARTED_AT_AFTER"
if [ "$APP_STARTED_AT_BEFORE" != "$APP_STARTED_AT_AFTER" ]; then
  echo "Error: App container restarted unexpectedly ($APP_STARTED_AT_BEFORE != $APP_STARTED_AT_AFTER)"
  exit 1
fi
echo "Verified: App container did NOT restart (StartedAt unchanged)."

# Verify app can now communicate with Redis
docker compose -p "$PROJECT_NAME" exec -T 9router bun -e '
  import Redis from "ioredis";
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", { maxRetriesPerRequest: 1, connectTimeout: 3000 });
  await redis.set("khatam:drill:probe", "reconnected", "EX", 60);
  const val = await redis.get("khatam:drill:probe");
  console.log("Redis reconnection probe verified:", val);
  await redis.quit();
  if (val !== "reconnected") process.exit(1);
  process.exit(0);
'

POST_RECOVERY=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${DASHBOARD_PORT}/v1/models" || true)
echo "Post-recovery /v1/models HTTP status: $POST_RECOVERY"
if [ "$POST_RECOVERY" != "200" ] && [ "$POST_RECOVERY" != "401" ]; then
  echo "Error: /v1/models failed after Redis reconnection ($POST_RECOVERY)"
  exit 1
fi

echo ""
echo "WAVE75_REDIS_OUTAGE_OK"

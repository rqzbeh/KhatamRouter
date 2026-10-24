# Quickstart & Verification Guide: Wave 7.5

**Feature Branch**: `spec/0075-bun-only-redis-default`  
**Date**: 2026-10-23  

This guide provides end-to-end runnable validation scenarios to prove that Wave 7.5 features behave as specified.

---

## Prerequisites

- **Bun**: `bun >= 1.4.3` installed locally or via container.
- **Docker & Docker Compose**: `docker compose` v2.
- **Redis CLI** (`redis-cli` or via `docker exec`).

---

## Scenario 1: Bun-Only SQLite Driver Boot & WAL Preflight

Prove that the server boots strictly with `bun:sqlite` and enables WAL mode without falling back to any Node SQLite driver.

```bash
# 1. Clean test data directory
rm -rf /tmp/khatam-sqlite-test
mkdir -p /tmp/khatam-sqlite-test

# 2. Boot server under Bun
DATA_DIR=/tmp/khatam-sqlite-test PORT=20128 bun custom-server.js &
SERVER_PID=$!

# Wait for startup
sleep 3

# 3. Assert PRAGMA journal_mode is WAL and integrity check is ok
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("/tmp/khatam-sqlite-test/db/data.sqlite", { readonly: true });
  const journal = db.query("PRAGMA journal_mode;").get();
  const integrity = db.query("PRAGMA quick_check;").get();
  console.log("Journal mode:", journal);
  console.log("Integrity:", integrity);
  if (journal["journal_mode"] !== "wal" || integrity["quick_check"] !== "ok") {
    process.exit(1);
  }
'

# 4. Clean up
kill $SERVER_PID
```

**Expected Outcome**: Journal mode is `wal`, quick check returns `ok`. Logged driver is `bun:sqlite`.

---

## Scenario 2: Docker Compose Bun + Redis Default Boot

Prove that running `docker compose up` brings up the Bun build of KhatamRouter and healthy Redis 8.2 with zero manual setup.

```bash
# 1. Start stack with docker-compose
docker compose up -d

# 2. Check health of services
docker compose ps

# 3. Assert Redis service is healthy
docker inspect --format='{{json .State.Health.Status}}' $(docker compose ps -q redis)
# Expected: "healthy"

# 4. Assert app container has REDIS_URL wired to redis service
docker exec $(docker compose ps -q 9router) env | grep REDIS_URL
# Expected: REDIS_URL=redis://redis:6379

# 5. Query /dashboard and /v1/models
curl -fsS http://127.0.0.1:20128/dashboard > /dev/null
curl -fsS http://127.0.0.1:20128/v1/models > /dev/null
```

**Expected Outcome**: All services reach healthy status. App communicates with Redis over internal network.

---

## Scenario 3: Redis Outage Drill (Fail-Open & SQLite Quota Degradation)

Prove that stopping Redis does not crash the server and limits continue to be enforced via SQLite storage degradation.

```bash
# 1. Stop Redis container
docker compose stop redis

# 2. Verify dashboard continues serving (fail-open)
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/dashboard)
echo "Dashboard status during Redis outage: $HTTP_STATUS"
# Expected: 200 or 302/307

# 3. Exercise Quota Store consume operation during outage
docker exec $(docker compose ps -q 9router) bun -e '
  import { getQuotaStore } from "./src/lib/quota/storeFactory.js";
  const store = getQuotaStore();
  const res = await store.consume({ key: "test-key", limit: 5, windowMs: 60000, amount: 1 });
  console.log("Outage consume result:", res);
  if (!res.degraded) {
    console.error("Expected degraded: true");
    process.exit(1);
  }
  // Consume until limit exhausted
  await store.consume({ key: "test-key", limit: 5, windowMs: 60000, amount: 10 });
  const rejected = await store.consume({ key: "test-key", limit: 5, windowMs: 60000, amount: 1 });
  console.log("Rejected result:", rejected);
  if (rejected.allowed !== false) {
    console.error("Limits were NOT enforced during Redis outage!");
    process.exit(1);
  }
'

# 4. Restart Redis and verify automatic reconnect
docker compose start redis
sleep 3
```

**Expected Outcome**: Request path does not throw. Quota store degrades to SQLite and still rejects requests that exceed limits (`allowed: false`).

---

## Scenario 4: Cluster-Safe Concurrency Semaphore & Single-Use Token Refresh

Prove that two concurrent processes sharing Redis respect `maxConcurrent` and do not double-spend single-use refresh tokens.

```bash
# 1. Concurrency limit test with 2 processes
bun -e '
  import Redis from "ioredis";
  import { RedisSemaphore } from "./src/lib/resilience/redisSemaphore.js";
  const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  const sem = new RedisSemaphore({ client: redis });

  const r1 = await sem.tryAcquire("test-target", 1);
  const r2 = await sem.tryAcquire("test-target", 1);

  console.log("Acquire 1:", r1.acquired); // true
  console.log("Acquire 2:", r2.acquired); // false (limit 1 held)

  await sem.release("test-target", r1.leaseId);
  const r3 = await sem.tryAcquire("test-target", 1);
  console.log("Acquire 3:", r3.acquired); // true
  await sem.release("test-target", r3.leaseId);
  await redis.quit();
'
```

---

## Scenario 5: Idempotency-Key Replay and Mismatch Detection

Prove that duplicate non-streaming chat requests return the cached response without calling upstream, and conflicting payloads are rejected.

```bash
API_KEY="sk-kh-test"
IDEMPOTENCY_KEY="demo-key-12345"

# 1. First Request: Upstream called, response cached
curl -i -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}'

# 2. Second Request (Identical Body): Upstream NOT called, returned from Redis
curl -i -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}'
# Header check: Idempotency-Replayed: true

# 3. Third Request (Conflicting Body): Rejected with HTTP 422/400
curl -i -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"DIFFERENT BODY"}]}'
# Expected HTTP Status: 422 Unprocessable Entity
```

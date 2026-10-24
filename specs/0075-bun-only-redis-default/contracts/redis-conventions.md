# Contract: Redis Key Conventions, Leases, and Cluster Events

**Version**: 1.0.0  
**Scope**: Cluster-wide Redis Coordination across Bun control-plane instances.  

---

## 1. Key Naming & Namespacing

Every Redis key MUST start with the prefix configured in `process.env.REDIS_KEY_PREFIX` (defaulting to `khatam:`).

```text
<prefix>:<domain>:<entity>:<id>...
```

| Domain | Key Pattern | Type | TTL Policy |
| :--- | :--- | :--- | :--- |
| **Semaphore** | `khatam:semaphore:conn:<provider>:<connId>` | `ZSET` | Max lease TTL * 2 |
| **Semaphore** | `khatam:semaphore:model:<provider>:<connId>:<model>` | `ZSET` | Max lease TTL * 2 |
| **OAuth Lock** | `khatam:lock:refresh:<provider>:<tokenHash>` | `STRING` | 30 seconds (`EX 30`) |
| **Idempotency** | `khatam:idempotency:<apiKeyHash>:<idempotencyKey>` | `STRING` | 300 seconds (5 mins) |
| **Auth Cache** | `khatam:cache:auth:key:<apiKeyHash>` | `STRING` | 60 seconds |
| **Counters** | `khatam:counter:combo:<comboName>:index` | `STRING` | No TTL (Persistent) |
| **Counters** | `khatam:counter:proxy:pool:index` | `STRING` | No TTL (Persistent) |
| **Login Limiter**| `khatam:ratelimit:login:<ipHash>` | `STRING` | 900 seconds (15 mins) |
| **Session Pin** | `khatam:session:stealth:<promptHash>` | `STRING` | 900 seconds (15 mins) |
| **Quota Window**| `khatam:quota:<normKey>:<counterType>:<bucket>` | `STRING` | `winMs * 2 / 1000 + 10` |

### Security Invariant: Zero Raw Secrets in Redis Keys
Under no circumstances may raw API keys, bearer tokens, passwords, or client IPs be written into Redis keys.
- API Key -> `crypto.createHash("sha256").update(rawKey).digest("hex")`
- Refresh Token -> `crypto.createHash("sha256").update(token).digest("hex")`
- Client IP -> `crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16)`

---

## 2. Distributed Semaphore Contract (Sorted Set Leases)

Concurrency limits are coordinated across replicas using Redis Sorted Sets (`ZSET`).

### 2.1 Lua Script: `SEMAPHORE_TRY_ACQUIRE`
```lua
-- KEYS[1]: Semaphore key
-- ARGV[1]: Current timestamp (epoch ms)
-- ARGV[2]: Lease expiration timestamp (now + leaseTtlMs)
-- ARGV[3]: Max allowed concurrency
-- ARGV[4]: Unique lease ID (<instanceId>:<requestId>:<timestamp>)
-- ARGV[5]: Key TTL in seconds

-- 1. Remove expired leases whose holders have died or completed without release
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])

-- 2. Count active leases
local count = redis.call("ZCARD", KEYS[1])

-- 3. Check limit
if count < tonumber(ARGV[3]) then
  redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
  return { 1, count + 1 }
else
  return { 0, count }
end
```

### 2.2 Lua Script: `SEMAPHORE_RELEASE`
```lua
-- KEYS[1]: Semaphore key
-- ARGV[1]: Unique lease ID

redis.call("ZREM", KEYS[1], ARGV[1])
return 1
```

---

## 3. Client Separation Invariant (Command vs Subscriber)

In Redis, a client that has executed `SUBSCRIBE` enters subscriber mode and **cannot** execute `PUBLISH` or general key commands.

- **Command Client**: Obtained via `getRedisClient()`. Used for:
  - `GET`, `SET`, `INCRBYFLOAT`, `EVAL`
  - `publishKhatamEvent(channel, payload)` (`client.publish(...)`)
- **Subscriber Client**: Obtained via `getRedisSubscriber()`. Used strictly for:
  - `SUBSCRIBE`, `UNSUBSCRIBE`, `MESSAGE` event handling.

Violating this separation breaks event publishing with command rejection errors.

---

## 4. Pub/Sub Channels and Payload Schema

All messages sent over Redis Pub/Sub wrap payloads in a standard envelope.

### Envelope Schema:
```json
{
  "source": "<instanceId>",
  "channel": "<channelName>",
  "timestamp": 1729670400000,
  "payload": { ... }
}
```

### Standard Channels:
1. `khatam:events:config_reload`
   - Triggered when settings, models, or API keys are updated in SQLite.
   - Action: Evicts in-memory caches, pricing cache, and auth caches.
2. `khatam:events:circuit_trip`
   - Triggered when a breaker trips to `OPEN` or `DEGRADED`.
   - Payload: `{ domain, state, reason, cooldownMs, lastFailureKind }`.
   - Action: Applies state change to local breaker registry without echoing back.
3. `khatam:events:usage`
   - Triggered on post-flight request completion.
   - Payload: Usage event record fanned out to all connected dashboard SSE streams.
4. `khatam:events:console_log`
   - Triggered on stdout/stderr log events.
   - Payload: `{ timestamp, level, message, metadata }` streamed to all dashboard log viewers.

---

## 5. Redis Disabling & Graceful Degradation Contract

To satisfy FR-010, FR-014, and SC-003, operators may run KhatamRouter with Redis disabled without breaking core routing functionality.

### 5.1 Disabling Redis
- **Environment**: Set `REDIS_URL=""` or leave `REDIS_URL` unset in `.env`.
- **Docker Compose**: Place `docker-compose.override.yml` in the project root to set `REDIS_URL: ""` on the app service and remove the `depends_on: redis` dependency:
  ```yaml
  services:
    redis:
      profiles: ["disabled"]
    9router:
      environment:
        - REDIS_URL=
      depends_on: !reset []
  ```

### 5.2 Graceful Degradation Behavior
When Redis is disabled or unreachable, every subsystem degrades gracefully to single-instance operation without throwing errors on the request path:
1. **Quota Store**: `RedisQuotaStore` degrades to internal `SqliteQuotaStore` fallback instance. Returns `{ allowed, remaining, resetAtMs, resetMs, current, limit, degraded: true }` and strictly enforces limits (never grants unlimited bypass).
2. **Concurrency Semaphores**: `RedisSemaphore` degrades to local `InProcessSemaphore`.
3. **OAuth Refresh Locks**: Distributed refresh mutex degrades to in-process `withRefreshDedup` Map.
4. **Circuit Breakers**: Multi-instance trip sync degrades to local in-memory registry; breaker trips operate per-instance.
5. **Dashboard Login Limiter**: Falls back to in-memory IP failure Map.
6. **Session Stickiness**: Falls back to in-memory first-message pins Map.
7. **Idempotency**: Fails open; requests proceed upstream without caching; warning logged once.
8. **Auth & Pricing Caches**: Caching bypassed or uses local in-memory TTL cache; SQLite remains authoritative.

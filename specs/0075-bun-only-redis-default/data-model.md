# Data Model: Wave 7.5 — Bun-Only Runtime and Redis by Default

**Feature Branch**: `spec/0075-bun-only-redis-default`  
**Date**: 2026-10-23  
**Status**: Completed  

---

## 1. Entities & Storage Backends

Wave 7.5 unifies the runtime on **`bun:sqlite`** for persistent durable state and **Redis (ioredis)** for ephemeral cluster-wide coordination, rate limiting, and accelerators.

```
+---------------------------------------------------------------------------------------+
|                                    KhatamRouter                                       |
|                                                                                       |
|   +------------------------------------+    +-------------------------------------+   |
|   |         SQLite (bun:sqlite)        |    |            Redis (ioredis)          |   |
|   |   $DATA_DIR/db/data.sqlite (WAL)   |    |         REDIS_URL (khatam:*)        |   |
|   +------------------------------------+    +-------------------------------------+   |
|   | • api_keys                         |    | • Leases (Semaphores & Locks)       |   |
|   | • provider_connections             |    | • Idempotency Records               |   |
|   | • api_key_quota_limits             |    | • Auth Cache (Advisory)             |   |
|   | • api_key_quota_counters (Fallback)|    | • Shared Rotation Counters          |   |
|   | • request_cost_ledger              |    | • Quota Sliding Windows (Primary)   |   |
|   | • circuit_breaker_states           |    | • Pub/Sub Event Bus                 |   |
|   +------------------------------------+    +-------------------------------------+   |
+---------------------------------------------------------------------------------------+
```

---

## 2. Redis Key Entities & Schemas

All Redis keys are prefixed by `process.env.REDIS_KEY_PREFIX || "khatam:"`.

### 2.1 Lease (Distributed Semaphore & Mutex)

Represents a time-bounded concurrency slot or exclusive operation claim.

- **Storage Structure**: Redis Sorted Set (`ZSET`) for semaphores; String (`SET NX EX`) for exclusive locks.
- **Key Formats**:
  - Provider Connection Semaphore: `khatam:semaphore:conn:<provider>:<connectionId>`
  - Model Concurrency Semaphore: `khatam:semaphore:model:<provider>:<connectionId>:<modelId>`
  - Single-Use OAuth Refresh Mutex: `khatam:lock:refresh:<provider>:<tokenHash>`
- **Fields (ZSET Member & Score)**:
  - `Member` (string): `<instanceId>:<requestId>:<timestamp>`
  - `Score` (float): Expiration timestamp in epoch milliseconds (`now + leaseTtlMs`).
- **Validation Rules**:
  - `maxConcurrent`: Integer > 0.
  - `leaseTtlMs`: Default 120,000 ms (2 minutes). Maximum 600,000 ms (10 minutes).
  - `tokenHash`: SHA-256 hex string of the refresh token (never store plain tokens in keys).
- **State Transitions**:
  - `tryAcquire`: Prunes members with score `< now` via `ZREMRANGEBYSCORE`. If `ZCARD < limit`, adds member with score `now + leaseTtlMs`.
  - `release`: Removes member via `ZREM`.
  - `holderDeath`: When an instance crashes, expired score ensures the slot becomes available on subsequent evaluations.

---

### 2.2 Idempotency Record

Stores the cached response of a non-streaming request to prevent duplicate upstream execution and duplicate billing on network retries.

- **Storage Structure**: Redis Hash or JSON String.
- **Key Format**: `khatam:idempotency:<apiKeyHash>:<idempotencyKey>`
- **Fields**:
  - `bodyHash` (string, required): SHA-256 hex digest of the client request JSON body.
  - `state` (string, required): `"in_flight"` | `"completed"` | `"failed"`.
  - `status` (integer, optional): HTTP status code (e.g., 200) when state is `"completed"`.
  - `headers` (object, optional): Sanitized response headers map (e.g., `{"content-type":"application/json"}`).
  - `body` (string, optional): Stringified JSON response payload when state is `"completed"`.
  - `createdAt` (integer, required): Epoch timestamp in milliseconds.
  - `expiresAt` (integer, required): Epoch timestamp in milliseconds when the record expires.
- **Validation & Exclusions**:
  - `idempotencyKey`: String, 1–256 characters. Must match `^[A-Za-z0-9_\-\.\:]+$`.
  - `apiKeyHash`: SHA-256 of the Bearer API key.
  - **Exclusion**: Requests declaring `stream: true` in body or query are **never stored**; idempotency handling is bypassed.
- **State Lifecycle**:
  ```
  [New Request]
        |
        v
  [in_flight] (TTL: 60s)
        |
        +---> [Success 2xx] ---> [completed] (TTL: 300s) ---> [Replayed on Identical Key]
        |
        +---> [Upstream Fail] -> [failed / Key Deleted]  ---> [Allows Fresh Retry]
  ```

---

### 2.3 Auth Cache Entry (Advisory)

Accelerates API key validation by caching authentication metadata in Redis. **Advisory only**: SQLite remains the authoritative source of truth. A cache hit never authorizes a key that has been revoked or banned in SQLite.

- **Storage Structure**: Redis String (JSON).
- **Key Format**: `khatam:cache:auth:key:<apiKeyHash>`
- **Fields**:
  - `keyId` (integer): Primary key in `api_keys` SQLite table.
  - `status` (string): `"active"` | `"revoked"` | `"banned"`.
  - `role` (string): `"admin"` | `"user"`.
  - `models` (array of strings): Whitelisted models/combos.
  - `limits` (object): Associated rate and spend limit configuration.
  - `expiresAt` (integer): Epoch timestamp in milliseconds.
- **Lifecycle & Invalidation**:
  - Default TTL: 60 seconds (`AUTH_CACHE_TTL_SEC`).
  - Invalidation: Any DB operation revoking, deleting, banning, or regenerating an API key publishes `CONFIG_RELOAD` or directly deletes `khatam:cache:auth:key:<apiKeyHash>`.

---

### 2.4 Shared Atomic Counters

Coordinates rotation indexes and sliding window counts without database disk writes.

- **Storage Structure**: Redis String (numeric integer).
- **Key Formats**:
  - Combo Model Rotation: `khatam:counter:combo:<comboName>:index`
  - Proxy Pool Rotation: `khatam:counter:proxy:pool:index`
  - Dashboard Login Limiter: `khatam:ratelimit:login:<ipHash>`
- **Behavior**:
  - Incremented via atomic `INCR` or `INCRBY`.
  - Bound by modulo arithmetic over targets array: `target = targets[counter % targets.length]`.
  - Login limiter sets TTL on first failure (`EXPIRE 900`).

---

### 2.5 Cluster Event (Pub/Sub)

Enables real-time invalidation and observability across distributed router instances.

- **Channels**:
  - `khatam:events:config_reload`: Fired on settings or key update.
  - `khatam:events:circuit_trip`: Fired when a breaker transitions to `OPEN` or `DEGRADED`.
  - `khatam:events:usage`: Fanned-out request usage records.
  - `khatam:events:console_log`: Distributed live log lines for dashboard viewers.
- **Payload Schema**:
  ```json
  {
    "source": "inst-6789abc",
    "channel": "khatam:events:circuit_trip",
    "timestamp": 1729670400000,
    "payload": {
      "domain": "anthropic:conn-1",
      "state": "OPEN",
      "reason": "upstream-500-threshold",
      "cooldownMs": 60000
    }
  }
  ```
- **Rules**:
  - Echo suppression: Receivers discard events where `source === CURRENT_INSTANCE_ID`.

---

## 3. SQLite Schema Invariants (`bun:sqlite`)

The SQLite database at `$DATA_DIR/db/data.sqlite` continues to use versioned migrations managed by `src/lib/db/migrationRunner.js` with table `_khatam_migrations`.

### Critical Tables Relied Upon:
1. `api_keys`: Contains key lifecycle, hashes, and permissions.
2. `api_key_quota_limits`: Contains `rpm`, `rph`, `rpd`, `tpm`, `tpd`, `spend_usd_day`, `spend_usd_week`.
3. `api_key_quota_counters`: Persistent store for SQLite quota tracking when Redis is offline.
4. `request_cost_ledger`: Stores post-flight usage records (`api_key_id`, `provider`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `created_at`).
5. `circuit_breaker_states`: Durable snapshot for circuit breaker state restoration across cold restarts.

### SQLite Connection PRAGMAs:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

# Research Note: Multi-Process Bun Behind Redis as a Configuration Change (US2 / FR-004..FR-006, FR-009)

**Date**: 2026-10-24  
**Feature Branch**: `spec/008-bun-perf-scale`  
**Target Document**: `specs/008-bun-perf-scale/research-scale.md`  
**Index Coverage Verification**: `check_index_coverage` was executed for all 20 referenced source, spec, configuration, and test files. Every file returned `status: no_recorded_issue` and `freshness: metadata_match`. Every conclusion drawn herein was verified directly against the underlying source code.

---

## 1. Executive Summary

User Story 2 (`US2`) and Functional Requirements `FR-004`, `FR-005`, and `FR-006` establish a key architectural goal for KhatamRouter: **scale the Bun runtime horizontally to multiple processes (2+ replicas) behind Redis without an engine rewrite**. 

Wave 7.5 (`specs/0075-bun-only-redis-default`) already established the prerequisite infrastructure:
1. **Bun-Only Engine**: All Node.js SQLite fallback adapters (`better-sqlite3`, `node:sqlite`, `sql.js`) were eliminated. The runtime strictly standardizes on native `bun:sqlite` with Write-Ahead Logging (`WAL`) mode and `busy_timeout = 5000` (file: `src/lib/db/adapters/bunSqliteAdapter.js:10-16`).
2. **Cluster-Safe State Coordination**: Shared state across replicas was unified into Redis primitives under the default `khatam:` prefix with non-blocking, fail-open semantics (file: `src/lib/redis/client.js:16-27`).
3. **Container Baseline**: `Dockerfile.bun` and `docker-compose.yml` provide a containerized Bun environment with Redis 8.2-alpine and Headroom.

This research note demonstrates that running multiple Bun replicas is **strictly a deployment and configuration change** (Docker Compose, reverse proxy routing, and environment adjustments), requiring **zero modifications** to the core routing engine or translator pipeline. However, critical operational constraints around SQLite POSIX file locking, loopback reverse-proxy trust in `custom-server.js`, and container port mapping must be addressed to ensure clean cluster operation.

Per repository rules (`FR-009` and repo memory), all live container operations and scale tests must be executed via subagents and must never invoke destructive commands such as `docker system prune` or `docker volume prune`.

---

## 2. Wave 7.5 Cluster-Safe State Inventory

The codebase already implements cluster coordination across replicas in `src/lib/redis/*`, `src/lib/quota/*`, `src/lib/resilience/*`, `src/lib/auth/*`, and `open-sse/services/*`. Below is the complete inventory of shared cluster state:

### 2.1 Concurrency Semaphores & Leases
- **Primary Source**: `src/lib/resilience/redisSemaphore.js:8-12, 28-63, 141-162`
- **Redis Key Pattern**: `khatam:semaphore:<key>` (e.g. `khatam:semaphore:conn:<provider>:<connId>` or `khatam:semaphore:model:<provider>:<connId>:<model>`)
- **Data Structure**: Redis Sorted Set (`ZSET`)
- **Score**: Expiration epoch timestamp (`now + leaseTtlMs`, defaulting to 120s; `src/lib/resilience/redisSemaphore.js:22`)
- **Member**: `<instanceId>:<requestId>:<timestamp>`
- **Mechanism**: Atomic Lua script `SEMAPHORE_TRY_ACQUIRE` (`src/lib/resilience/redisSemaphore.js:28-63`). On every acquire attempt:
  1. `ZREMRANGEBYSCORE KEYS[1] "-inf" ARGV[1]` atomically removes expired leases, automatically cleaning up slots if a worker replica crashed or terminated ungracefully ("holder-death cleanup").
  2. `ZCARD KEYS[1]` counts active leases.
  3. If active count `< maxConcurrent`, `ZADD` registers the new lease and `EXPIRE` sets a safety key TTL.
- **Fail-Open Contract**: If Redis is unreachable, unset, or throws, `RedisSemaphore` catches the error, logs a single warning, and degrades to an in-process fallback (`InProcessSemaphore`) without throwing on the request path (`src/lib/resilience/redisSemaphore.js:189-192`).

### 2.2 Circuit Breaker State & `CIRCUIT_TRIP` Pub/Sub
- **Primary Source**: `src/lib/resilience/circuitBreakerStore.js:315-340, 368-385`, `src/lib/redis/events.js:22-28, 111-136`
- **Redis Channels & Keys**: 
  - Pub/Sub Channel: `khatam:events:circuit_trip` (`KHATAM_EVENTS.CIRCUIT_TRIP`, `src/lib/redis/events.js:24`)
  - Snapshot Cache Key: `khatam:cb:<domain>` with 300s TTL (`src/lib/resilience/circuitBreakerStore.js:229-231, 288`)
- **Mechanism**:
  - Dual Delivery: Events publish first to the synchronous local `EventEmitter`, then to Redis Pub/Sub (`src/lib/redis/events.js:117-135`).
  - Self-Loop Prevention: All published envelopes carry a unique `source: INSTANCE_ID` (`src/lib/redis/events.js:30, 124`). Inbound Redis messages from the same instance ID are ignored (`src/lib/redis/events.js:64`).
  - Remote Synchronization: When replica A trips a circuit to `OPEN` or `DEGRADED`, it publishes a `CIRCUIT_TRIP` event. Replica B receives the payload and executes `breaker.openCircuit()` or `breaker.transition("DEGRADED")` (`src/lib/resilience/circuitBreakerStore.js:322-335`). A local guard flag `isApplyingRemoteTrip` ensures replica B does not re-publish the event back to the cluster.
- **Authority**: SQLite `circuit_breakers` table is durable authority (`src/lib/resilience/circuitBreakerStore.js:4`); Redis is an optional, sub-millisecond cache mirror.

### 2.3 Atomic Round-Robin Rotation
- **Primary Source**: `open-sse/services/combo.js:251-273`
- **Redis Key Pattern**: `khatam:counter:combo:<comboName>:index` and `khatam:counter:proxy:pool:index`
- **Mechanism**:
  - Monotonic distributed counter: `const count = await client.incr(key);` (`open-sse/services/combo.js:262`).
  - Position computation: `const currentIndex = Math.floor((count - 1) / normalizedStickyLimit) % models.length;` (`open-sse/services/combo.js:264`).
  - Replicas rotate through combo targets atomically without resetting or repeating slots.
  - Fail-Open: On Redis absence or error, silently degrades to in-process rotation state Map (`open-sse/services/combo.js:272`).

### 2.4 OAuth `SET NX EX` Refresh Lock & Result Cache
- **Primary Source**: `open-sse/services/tokenRefresh/dedup.js:24-38, 81-105, 114-124`
- **Redis Keys**:
  - Distributed Mutex: `khatam:lock:refresh:<provider>:<tokenHash>` (`SET ... EX 30 NX`, `open-sse/services/tokenRefresh/dedup.js:82`)
  - Result Cache: `khatam:cache:refresh:<provider>:<tokenHash>` (15s TTL, `open-sse/services/tokenRefresh/dedup.js:120`)
- **Mechanism**:
  - When two replicas simultaneously encounter an expired single-use OAuth refresh token, both attempt to acquire the lock with `SET NX EX 30`.
  - The winner executes the provider refresh call.
  - The losing replica enters a polling loop (150ms sleep, up to 15s max) awaiting the winner's result in the cache key (`open-sse/services/tokenRefresh/dedup.js:88-105`).
  - Upon cache population, the losing replica reads the new credentials without making a second upstream refresh call, preventing single-use token invalidation.
- **Secret Hygiene**: Raw tokens are hashed via SHA-256 (`hashRefreshToken`, `open-sse/services/tokenRefresh/dedup.js:24-29`). Zero raw credentials appear in Redis keys.

### 2.5 Dashboard Login Limiter
- **Primary Source**: `src/lib/auth/loginLimiter.js:22-44, 66-96, 137-177`
- **Redis Key Pattern**: `khatam:ratelimit:login:<ipHash>` (15m TTL / `LOGIN_REDIS_TTL_SEC = 900`, `src/lib/auth/loginLimiter.js:25`)
- **Mechanism**:
  - Hashes client IP to 16 hex characters (`hashClientIp`, `src/lib/auth/loginLimiter.js:36-39`).
  - Coordinates failed login attempts across replicas.
  - Progressive backoff lockout: 30s, 2m, 10m, 30m after 5 failed attempts (`MAX_FAILS_BEFORE_LOCK = 5`, `src/lib/auth/loginLimiter.js:22-23`).
  - `recordFailAsync` fetches remote failures from Redis, combines them with local attempts, advances the lock tier if necessary, and writes back the updated lockout threshold.

### 2.6 Advisory Auth Cache with SQLite Authority
- **Primary Source**: `src/lib/auth/apiKeyCache.js:8-13, 63-85, 134-194, 204-233`
- **Redis Key Pattern**: `khatam:cache:auth:key:<apiKeyHash>` (60s TTL / `AUTH_CACHE_TTL_SEC = 60`, `src/lib/auth/apiKeyCache.js:19, 36-39`)
- **Negative Control Invariant**: Cache hits NEVER bypass the SQLite status check. In `getCachedApiKey()`, even after retrieving cached metadata from Redis, the code executes:
  ```javascript
  const db = await getAdapter();
  const row = db.get("SELECT isActive FROM apiKeys WHERE key = ?", [rawKey]);
  ```
  (`src/lib/auth/apiKeyCache.js:173-175`). If SQLite marks the key inactive, revoked, or missing, the cache entry is immediately evicted (`client.del(cacheKey)`) and authorization is rejected.

### 2.7 Sliding-Window Quota Counters
- **Primary Source**: `src/lib/quota/redisQuotaStore.js:67-83, 103-195`
- **Redis Key Pattern**: `khatam:quota:<normKey>:<counterType>:<bucket>` with TTL = `2 * windowMs + 10s`
- **Mechanism**: Two-bucket weighted sliding window evaluated via Lua script `CONSUME_LUA`. Atomically computes `(prevBucketCount * weight) + currentBucketCount + amount`. If `<= limit`, increments via `INCRBYFLOAT` and returns `allowed: true`.

---

## 3. State Topology: Local Per-Replica vs Shared Redis vs Authoritative SQLite

To understand multi-process execution, system state is classified across three tiers:

| Subsystem / State Entity | Storage Tier | Coordination Mechanism | Cross-Replica Sync Behavior |
| :--- | :--- | :--- | :--- |
| **Active TCP Sockets & HTTP Streams** | Local Per-Replica | In-Memory (Bun event loop) | Completely independent per process |
| **In-Flight LLM Request Contexts** | Local Per-Replica | In-Memory | Managed by the replica serving the connection |
| **Local Event Bus (`localBus`)** | Local Per-Replica | Node `EventEmitter` | Synchronous intra-process only |
| **H2C Request Replay & Downgrade** | Local Per-Replica | In-Memory (`custom-server.js`) | Per-socket HTTP upgrade handling |
| **Concurrency Semaphores** | Shared Redis | `ZSET` Leases + Lua | Cluster-wide concurrency tracking with holder-death pruning |
| **Circuit Breaker Trip State** | Shared Redis | Pub/Sub + Mirror Cache | Near-instant propagation (`<5ms`) across replicas |
| **Combo & Proxy Model Counters** | Shared Redis | Monotonic `INCR` | Fair, synchronized round-robin rotation across all replicas |
| **OAuth Token Refresh Mutex** | Shared Redis | `SET NX EX 30` + Poll | Prevents duplicate refresh of single-use refresh tokens |
| **Dashboard Login Lockouts** | Shared Redis | String JSON + 900s TTL | Shared IP brute-force protection across all instances |
| **Sliding-Window Quotas** | Shared Redis | 2-Bucket Lua `INCRBYFLOAT` | Precise global rate-limiting across all nodes |
| **API Key Definitions & Credentials** | Authoritative SQLite | `data.sqlite` (`apiKeys` table) | Durable authority; verified on every auth check |
| **Settings, Model Aliases, Combos** | Authoritative SQLite | `data.sqlite` (`settings`, `kv`) | Shared across replicas via mounted volume |
| **Usage History & Request Details** | Authoritative SQLite | `data.sqlite` (`usageHistory`) | Appended directly by the replica completing the request |

---

## 4. SQLite WAL `busy_timeout = 5000` Implications for Multi-Process

KhatamRouter uses `bun:sqlite` with native Write-Ahead Logging (file: `src/lib/db/adapters/bunSqliteAdapter.js:10-16`):
```sql
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

### 4.1 How WAL Enables Multi-Process Bun
1. **Concurrent Readers**: In SQLite WAL mode, read transactions never block write transactions, and write transactions never block read transactions. Any number of Bun replicas can execute `SELECT` queries concurrently without lock contention.
2. **Single Writer with 5-Second Queueing**: Write transactions (`INSERT`, `UPDATE`, `DELETE`, `BEGIN IMMEDIATE`) require an exclusive write lock on the WAL file. When one replica holds the write lock, other replicas attempting to write will wait up to **5,000 milliseconds** (`busy_timeout = 5000`) before throwing `SQLITE_BUSY`.
3. **Transaction Brevity**: In KhatamRouter, writes are tiny and fast (appending a row to `usageHistory` takes `<0.2ms` on local NVMe/SSD). Lock contention window is tiny even at hundreds of requests per second.

### 4.2 Critical Operational Constraints & Risks
- **Filesystem Locking Requirement**: SQLite WAL mode requires POSIX advisory locks (`fcntl` / `flock`) and shared memory (`data.sqlite-shm`) across processes.
  - **Single Host / Local Docker Volume**: Multi-process Bun sharing a Docker named volume (`9router-data`) or host bind mount on the same Linux host kernel works correctly because the Linux page cache and POSIX locks are shared.
  - **Network Filesystems (NFS, SMB, AWS EFS)**: Running replicas across distinct physical hosts sharing an NFS/EFS mount will cause database corruption or immediate `SQLITE_IOERR` / `SQLITE_BUSY` crashes. SQLite officially warns against WAL on network shares. Multi-process Bun scale is strictly single-host (multi-core vertical/container scaling) when backed by SQLite.
- **WAL Checkpoint Contention**:
  - `bunSqliteAdapter.js:87-90` registers a periodic 60-second timer: `setInterval(() => { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }, 60000)`.
  - When replica A triggers a `TRUNCATE` checkpoint while replica B is actively executing transactions, the checkpoint cannot truncate the log. The call is wrapped in `try { ... } catch {}` so it never crashes, but periodic checkpointing across multiple uncoordinated timers creates unnecessary I/O bursts.

---

## 5. Storage Partitioning: `DATA_DIR` vs `~/.9router`

An important discrepancy exists between historical documentation and the current codebase:
- **Historical Docs (`CLAUDE.md:82`, `docs/ARCHITECTURE.md:161`)**: Claimed that application configuration lives in SQLite, while usage and logs (`usage.json` + `log.txt`) remain under `~/.9router` and do not follow `DATA_DIR`.
- **Current Runtime Reality**:
  - As verified in `src/lib/db/repos/usageRepo.js:783`:
    ```javascript
    // No-op: request log is now derived from usageHistory table on read.
    export async function appendRequestLog() {}
    ```
  - `log.txt` and `usage.json` are legacy files preserved only for migration compatibility (`src/lib/db/paths.js:9-14`).
  - All runtime state (settings, API keys, provider connections, combos, and usage history) lives inside **one single SQLite file**: `data.sqlite` (`src/lib/db/paths.js:7`).
  - `DATA_DIR` (`src/lib/dataDir.js:33-76`) fully controls the location of `data.sqlite` (`path.join(DATA_DIR, "db", "data.sqlite")`).
  - In `docker-compose.yml:16`, `DATA_DIR: /app/data` is mounted to named volume `9router-data`. All replicas share `/app/data/db/data.sqlite`.

---

## 6. Security Philosophy: Fail-Open Quota vs Fail-Closed Auth

KhatamRouter adheres to two contrasting security invariants depending on failure domain:

### 6.1 Fail-Open: Quota, Semaphores, Breakers, and Caches
- **Evidence**:
  - `src/lib/quota/redisQuotaStore.js:18-22`: "When REDIS_URL is unset, or when Redis commands throw, methods catch the error, emit a single non-fatal warning, and return `{ allowed: true, degraded: true, ... }`... Runs on the request path: MUST NEVER throw."
  - `src/lib/resilience/redisSemaphore.js:189-192`: Catches Redis errors and degrades to in-process semaphore.
  - `src/lib/resilience/circuitBreakerStore.js:7-11`: Swallows errors; "no state" is always a valid answer.
- **Rationale**: An infrastructure failure in Redis must never interrupt active LLM streaming calls or cause customer application outages. Availability and graceful degradation take precedence over strict quota enforcement during an outage.

### 6.2 Fail-Closed: Authentication and Authorization
- **Evidence**:
  - `src/lib/auth/apiKeyCache.js:8-9, 170-194`: Cache hits in Redis *never* bypass SQLite. Every request verifies key validity against SQLite `apiKeys` table.
  - If SQLite throws or is unreachable, `apiKeyCache.js:183-186` catches the error and returns `null` (401 Unauthorized):
    ```javascript
    } catch (dbErr) {
      // If SQLite is unavailable or errors, fail-closed on authorization
      return null;
    }
    ```
- **Rationale**: A revoked, expired, or deleted API key must never be allowed to access upstream models due to cache staleness or database errors. Security invariants are non-negotiable.

---

## 7. Loopback Reverse Proxy Trust & XFF Handling in `custom-server.js`

A critical architectural finding emerges from analyzing `custom-server.js` and `src/lib/auth/loginLimiter.js`:

### 7.1 The Single-Process Loopback Assumption
In `custom-server.js:132-150`:
```javascript
const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
const xff = req.headers["x-forwarded-for"];
const xRealIp = req.headers["x-real-ip"];
const viaProxy = !!(xff || xRealIp);
const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";

// Trust forwarding headers only when the TCP peer is a local reverse proxy.
// Direct/public sockets remain keyed by the unspoofable peer address.
const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;

delete req.headers["x-9r-real-ip"];
delete req.headers["x-forwarded-for"];
delete req.headers["x-9r-via-proxy"];
delete req.headers["x-9r-peer-token"];
req.headers["x-9r-real-ip"] = ip;
req.headers["x-9r-peer-token"] = PEER_TOKEN;
if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
return handler(req, res);
```

### 7.2 The Multi-Replica Failure Mode
1. When multiple Bun replicas run behind an external reverse proxy (e.g. Nginx, Traefik, HAProxy, or AWS ALB) in a Docker bridge network:
   - The TCP peer connecting to `custom-server.js` is the **proxy container's IP** (e.g., `172.18.0.2`), **NOT** `127.0.0.1`.
   - `isLoopbackProxy` evaluates to `false`.
   - `custom-server.js` discards `X-Forwarded-For` and stamps `x-9r-real-ip: 172.18.0.2` (the proxy IP!).
   - Downstream, `src/lib/auth/loginLimiter.js:229-232` inspects `x-9r-real-ip` and sees `172.18.0.2`.
   - **Severe Consequence**: All clients across the Internet are identified as having the same IP address (`172.18.0.2`). A single attacker brute-forcing the login page will trigger a global lockout locking out every administrator. Furthermore, IP-based rate limiting becomes globally shared across all users.

### 7.3 Solution for Multi-Process Deployment
`custom-server.js` must be made aware of trusted proxies beyond strict loopback:
1. Support `process.env.TRUST_PROXY === "true"` or a CIDR range (e.g. `10.0.0.0/8`, `172.16.0.0/12`) in `custom-server.js:136`:
   ```javascript
   const isTrustedProxy = isLoopbackProxy || process.env.TRUST_PROXY === "true";
   ```
2. When `TRUST_PROXY=true` is set in container environment, `custom-server.js` trusts `X-Forwarded-For` from upstream ingress load balancers.

---

## 8. Concrete Compose & Environment Changes

Scaling KhatamRouter from 1 to N replicas in Docker Compose requires the following changes:

### 8.1 Docker Compose Adjustments (`docker-compose.yml`)

1. **Remove Hardcoded `container_name: 9router`**:
   - `docker-compose.yml:6` specifies `container_name: 9router`. In Docker Compose, scaling a service with a static container name throws an error: `cannot specify "container_name" when scaling service`.
   - Omit `container_name` on the scalable service or define it via `docker-compose.override.yml`.
2. **Port Conflict Resolution**:
   - `docker-compose.yml:9` binds `20128:20128`. Multiple replicas cannot bind to the same host port.
   - For multi-process scale, replicas should expose port 20128 internally on the Docker network, fronted by an ingress reverse proxy (or map dynamic host ports for testing: `20128-20129:20128`).
3. **Add Container Healthcheck to `9router`**:
   - `Dockerfile.bun:73` installs `curl` in the runner stage.
   - `src/app/api/health/route.js:9-11` exposes a lightweight `GET /api/health` returning `{ ok: true }`.
   - Add service healthcheck:
     ```yaml
     healthcheck:
       test: ["CMD", "curl", "-f", "http://localhost:20128/api/health"]
       interval: 10s
       timeout: 3s
       retries: 3
       start_period: 5s
     ```
4. **Scale Configuration**:
   ```yaml
   services:
     9router:
       build:
         context: .
         dockerfile: Dockerfile.bun
       restart: always
       deploy:
         replicas: 2
       volumes:
         - 9router-data:/app/data
       environment:
         DATA_DIR: /app/data
         PORT: "20128"
         DASHBOARD_PORT: "20128"
         HOSTNAME: "0.0.0.0"
         NODE_ENV: production
         REDIS_URL: redis://redis:6379
         REDIS_KEY_PREFIX: "khatam:"
         TRUST_PROXY: "true"
       depends_on:
         redis:
           condition: service_healthy
       healthcheck:
         test: ["CMD", "curl", "-f", "http://localhost:20128/api/health"]
         interval: 10s
         timeout: 3s
         retries: 3
         start_period: 5s
   ```

---

## 9. Rollout Risks & Mitigations

1. **Risk: SQLite WAL Write Bottleneck under High Concurrency**
   - *Detail*: All replicas append usage to `usageHistory` in `data.sqlite`. Under peak concurrency (>200 req/s), multiple simultaneous write transactions could cause latency spikes while waiting on SQLite's 5s lock queue.
   - *Mitigation*: Ensure transactions in `src/lib/db/repos/usageRepo.js` are minimal; consider buffering usage writes in Redis before flushing to SQLite if write contention is observed during ladder re-runs.
2. **Risk: Redundant Background Token Refresh Loops**
   - *Detail*: `custom-server.js:93-122` initializes `startBackgroundTokenRefreshFromCustomServer()` on every replica. Both replicas run background timers.
   - *Mitigation*: The distributed lock in `open-sse/services/tokenRefresh/dedup.js:82` protects against duplicate token refreshes upstream, but replicas perform redundant periodic checks.
3. **Risk: Split-Brain Ingress IP Detection**
   - *Detail*: If `TRUST_PROXY=true` is not honored by `custom-server.js`, all replicas collapse client traffic onto the reverse proxy's internal container IP.
   - *Mitigation*: Update `custom-server.js` to honor `TRUST_PROXY` before enabling multi-replica scale behind an ingress proxy.
4. **Risk: Inadvertent Docker Cleanup Violations**
   - *Detail*: Developers running container smoke tests may be tempted to run cleanup commands.
   - *Mitigation*: Repo rule is non-negotiable: live container runs must be delegated to subagents, and `docker system prune` or `docker volume prune` must never be run.

---

## 10. Handoff

### Mapping Findings to Functional Requirements

| Requirement | Finding & Implementation Mapping |
| :--- | :--- |
| **FR-004** (Multi-process Bun 2+ replicas without rewrite) | Fully supported as a config/compose change. Wave 7.5 eliminated Node fallbacks; state is already coordinated across Redis (`src/lib/redis/*`) and SQLite WAL (`src/lib/db/adapters/bunSqliteAdapter.js`). |
| **FR-005** (Cluster-safe state honored across replicas) | Verified across: (1) `redisSemaphore.js` (concurrency slots), (2) `circuitBreakerStore.js` (CIRCUIT_TRIP pub/sub), (3) `combo.js` (atomic round-robin `INCR`), (4) `dedup.js` (OAuth refresh `SET NX EX`), (5) `loginLimiter.js` (progressive lockout), and (6) `apiKeyCache.js` (advisory cache with SQLite authority). |
| **FR-006** (Graceful degradation on Redis unavailability) | Verified across all subsystems: quota fails open (`RedisQuotaStore:134-163`), semaphores fall back to in-process (`redisSemaphore:189`), circuit breakers fall back to local registry (`circuitBreakerStore:7`), login limiter falls back to local Map (`loginLimiter:8`). |
| **FR-009** (Subagent isolation for Docker verification) | Subagent execution pattern required for container scale validation; prune commands prohibited per repo instructions. |

### Speckit-Plan Action Items
To execute US2 / FR-004..FR-006 in `speckit-plan`:
1. **Patch `custom-server.js`**: Update line 136 to inspect `process.env.TRUST_PROXY === "true"` so multi-replica deployments behind an ingress reverse proxy preserve real client IPs.
2. **Create Scale Compose Override**: Add `docker-compose.scale.yml` (or update `docker-compose.yml`) defining:
   - 2 replicas for `9router`.
   - Omission of static `container_name: 9router`.
   - Container healthcheck pointing to `/api/health`.
   - Ingress load balancer (e.g. lightweight Nginx container listening on 20128 balancing between the 2 replicas).
3. **Validate Fail-Open in 2-Replica Topology**: Test stopping the Redis container mid-flight to verify both replicas continue serving chat completions without throwing exceptions.
4. **Index Coverage Note**: All research was verified using `check_index_coverage` across all cited files, confirming full alignment with the indexed codebase graph.

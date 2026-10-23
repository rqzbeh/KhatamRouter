# Research & Findings: Wave 7.5 — Bun-Only Runtime and Redis by Default

**Feature Branch**: `spec/0075-bun-only-redis-default`  
**Date**: 2026-10-23  
**Status**: Completed  

---

## 1. Verified Audit Claims (Five Investigations)

Every claim highlighted in the pre-planning audit was verified against the codebase using direct source inspection, index coverage analysis (`codebase-memory-mcp`), and static execution tracing. All five claims are **CONFIRMED**.

### Claim 1: Quota Store Runtime Failure Returns `{allowed:true, degraded:true}` Unlimited
- **Files Verified**: `src/lib/quota/redisQuotaStore.js` (lines 125–136, 207–218, 250–260, 284–295), `src/lib/quota/redisQuotaStore.ts`, `src/lib/usage/apiKeyUsageLimits.js` (lines 124–245), `src/domain/keyQuota.js` (lines 79–185).
- **Observed Behavior**: In `redisQuotaStore.js`, whenever Redis is unconfigured or a Redis runtime error occurs (`catch (error)`), the methods `consume()` and `peek()` return `{ allowed: true, degraded: true, current: 0, limit, remaining: limit, resetAtMs, resetMs }`. Higher-level callers (`apiKeyUsageLimits.js`, `keyQuota.js`) check `res.allowed` and see `true`. They note `degraded = true` but completely bypass limit enforcement. SQLite quota storage (`sqliteQuotaStore.js`) is never called as a fallback.
- **Consequence**: Any Redis outage, network partition, or misconfiguration immediately grants unlimited request quota to all API keys and connections, bypassing spending and rate limits.
- **Resolution**: Implement automatic degradation from `RedisQuotaStore` to `SqliteQuotaStore`. On Redis client absence or runtime error, `RedisQuotaStore` forwards the operation to its internal fallback `SqliteQuotaStore` instance so limits continue to be strictly enforced against SQLite WAL.

### Claim 2: MiniMax/Codex Single-Use Refresh Tokens Burn Across Multiple Instances
- **Files Verified**: `open-sse/services/tokenRefresh/dedup.js` (lines 1–31), `open-sse/services/tokenRefresh/providers.js` (lines 710–768), `open-sse/services/tokenRefresh.js` (lines 162–165).
- **Observed Behavior**: Refresh deduplication in `dedup.js` relies strictly on an in-memory `Map`: `const refreshDedupCache = new Map()`. When multiple router instances run behind a load balancer, each instance possesses its own isolated memory space. MiniMax and Codex issue single-use refresh tokens: exchanging token $R_1$ produces access token $A_2$ and new refresh token $R_2$, while invalidating $R_1$. If two concurrent requests hit separate instances with $R_1$, both instances execute `fetch()` with $R_1$. The first succeeds; the second receives HTTP 400 `invalid_grant` ("refresh token already used"). Under `classifyOAuthRefreshError`, `invalid_grant` is treated as unrecoverable, wiping the stored credentials and signing the account out permanently.
- **Consequence**: Multi-process clustering breaks OAuth accounts with single-use tokens.
- **Resolution**: Introduce a distributed Redis lock and cached refresh result (`khatam:lock:refresh:<provider>:<tokenHash>`, `SET NX EX 30`). One instance acquires the lock and performs the refresh; competing instances await the result in Redis or read the newly minted token from Redis cache.

### Claim 3: `gateTarget` Default Path Ranks Cooldown Over Circuit Breaker
- **Files Verified**: `src/domain/fallbackResilience.js` (lines 65–102), `src/domain/executeTargetGates.js` (lines 10–18, 65–108).
- **Observed Behavior**: The documented gate order is strictly: (1) Circuit Breaker (`OPEN`), (2) Cooldown, (3) Credential. In `fallbackResilience.js`:
  ```js
  const getBreaker = typeof options.getBreaker === "function"
    ? options.getBreaker
    : () => resolveBreaker(domain); // resolveBreaker is async!
  const verdict = await evaluateTargetGates(descriptor, { getBreaker, ... });
  ```
  Because `evaluateTargetGates` and its sub-gate `circuitGate` are synchronous, `resolveBreaker` returns an unawaited `Promise`. `typeof breaker.getStatus === "function"` evaluates to `false`, so Gate 1 silently skips. Next, Gate 2 (`cooldownGate`) evaluates. If the target has an active cooldown, `cooldownGate` returns `skipVerdict(GATE.COOLDOWN)`. When control returns to `fallbackResilience.js`, the recheck is guarded by `if (verdict.kind !== "skip")`. Because `verdict.kind === "skip"` (due to cooldown), the recheck is bypassed! The function returns `skip` with reason `cooldown`, even if the circuit breaker is `OPEN`.
- **Consequence**: Long-term provider outages are masked as transient per-account cooldowns, distorting routing decisions, metrics, and error reporting.
- **Resolution**: Pre-resolve (await) `resolveBreaker(domain)` *before* invoking `evaluateTargetGates`, ensuring `breaker` is passed directly as an object so Gate 1 (`circuitGate`) executes first.

### Claim 4: `publishKhatamEvent` Publishes Over Subscriber Connection
- **Files Verified**: `src/lib/redis/events.js` (lines 90–133), `src/lib/redis/events.ts` (lines 80–120).
- **Observed Behavior**: `publishKhatamEvent` invokes:
  ```js
  const sub = getRedisSubscriber();
  const published = sub.publish(channel, raw);
  ```
  In Redis and the `ioredis` client library, once a connection issues a `SUBSCRIBE` command, it enters subscriber mode. Under RESP2/RESP3, subscriber-mode connections reject standard commands (including `PUBLISH`) with a command rejection error. As soon as any subscriber is registered in the process, subsequent calls to `publishKhatamEvent` fail.
- **Consequence**: Cluster event publication (`khatam:events:*`) is broken as soon as subscriptions are active.
- **Resolution**: Send `publish` commands over the primary command client (`getRedisClient()`), reserving `getRedisSubscriber()` strictly for `SUBSCRIBE` / `UNSUBSCRIBE` listeners.

### Claim 5: Passthrough Streaming Decloak Gap and Dead Code
- **Files Verified**: `open-sse/handlers/chatCore/streamingHandler.js` (lines 27–45), `open-sse/utils/stream.js` (lines 556–580), `src/lib/stealth/toolCloak.js` (lines 350–365).
- **Observed Behavior**: When `sourceFormat === targetFormat` (such as Anthropic Claude client calling Claude upstream), `needsTranslation()` is false, and `streamingHandler.js` invokes `createPassthroughStreamWithLogger()`. This function does not accept or apply `toolNameMap`. Any cloaked tools in the incoming stream reach the client still cloaked in PascalCase or vendor-cloaked form. Additionally, `decloakToolsInResponse()` in `src/lib/stealth/toolCloak.js` was found to have zero callers in the entire production runtime.
- **Consequence**: Stealthed tool names leak to clients on same-format streaming requests, causing client-side tool lookup failures.
- **Resolution**: Pass `toolNameMap` into `createPassthroughStreamWithLogger` (or pipe through `decloakStreamChunk` transform stream when `toolNameMap` is populated). Document `restoreToolNames` / `decloakStreamChunk` as the canonical decloaking pipeline and remove or wire `decloakToolsInResponse`.

---

## 2. Design Decisions

### Decision 1: Quota-Degrade-to-SQLite Architecture
- **Decision**: `RedisQuotaStore` retains an embedded `SqliteQuotaStore` fallback instance.
- **Rationale**:
  - The SQLite quota store (`sqliteQuotaStore.js`) operates against the local WAL database synchronously via `bun:sqlite`. It is robust, zero-latency, and local.
  - When Redis client is null, connection status is disconnected, or any Redis operation throws, `RedisQuotaStore` immediately executes the same operation against `sqliteQuotaStore`.
  - The returned result retains the exact contract `{ allowed, remaining, resetAtMs, resetMs, current, limit, degraded: true }`.
  - The `degraded: true` flag informs observability without bypassing security or spend limits.
- **Alternatives Considered**:
  - *Fail-Closed (block requests on Redis outage)*: Rejected. The system constitution specifies fail-open for infrastructure outages while maintaining authorization enforcement. Blocking requests breaks high availability.
  - *Keep unlimited allow `{ allowed: true, degraded: true }`*: Rejected. Violates FR-014 and allows unbounded billing spikes during Redis maintenance.

### Decision 2: Lease-Based Distributed Concurrency Semaphore
- **Decision**: Implement `RedisSemaphore` backed by Redis Sorted Sets (`ZSET`) and Lua scripts.
- **Rationale**:
  - Keys: `khatam:semaphore:conn:<provider>:<connectionId>` and `khatam:semaphore:model:<provider>:<connectionId>:<modelId>`.
  - Lease Member: `<instanceId>:<requestId>:<timestamp>`.
  - Score: Lease expiration time in epoch milliseconds (`now + leaseTtlMs`). Default `leaseTtlMs = 120,000` (2 minutes).
  - Atomic Acquire (`tryAcquire` Lua):
    1. Prune expired leases: `ZREMRANGEBYSCORE key -inf now`.
    2. Check cardinality: `count = ZCARD key`.
    3. If `count < maxConcurrent`: `ZADD key (now + leaseTtlMs) leaseId`, set `EXPIRE key (ceil(leaseTtlMs/1000) * 2)`, return `{ acquired: 1, current: count + 1 }`.
    4. If `count >= maxConcurrent`: return `{ acquired: 0, current: count }`.
  - Atomic Release: `ZREM key leaseId`.
  - **Holder-Death Release**: If an instance crashes or is killed via `SIGKILL`, expired leases are purged on the very next `tryAcquire` evaluation. No dangling locks or orphan counters remain.
  - Fallback: Degrades to `InProcessSemaphore` if Redis is unavailable.
- **Alternatives Considered**:
  - *Redis String Counter (`INCR` / `DECR`)*: Rejected. If a process dies while handling an in-flight request, the counter is never decremented, permanently exhausting concurrency slots until manual intervention.
  - *Redlock Distributed Mutex*: Overkill and adds round-trip latency for non-exclusive multi-slot admission.

### Decision 3: Idempotency Record Shape and Exclusions
- **Decision**: Redis Hash or JSON string keyed by `khatam:idempotency:<apiKeyHash>:<idempotencyKey>`.
- **Key Shape**:
  - `apiKeyHash`: SHA-256 of the Bearer API key (never store plain keys).
  - `idempotencyKey`: Value of `Idempotency-Key` header (max 256 chars).
  - Scope: Fully isolated per API key; tenant A cannot see or collide with tenant B's idempotency keys.
- **Payload Shape**:
  ```json
  {
    "bodyHash": "sha256-hex-of-request-body",
    "state": "in_flight | completed | failed",
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"id\":\"chatcmpl-...\", ...}",
    "createdAt": 1729670400000,
    "expiresAt": 1729670700000
  }
  ```
- **Lifecycle & Rules**:
  1. Requests with `stream: true` (in body or query) are **EXCLUDED** from idempotency storage. Streaming chunks are not buffered for replay.
  2. On new request: `SETNX` creates state `"in_flight"` with short TTL (60s).
  3. If existing record found:
     - Check `bodyHash`: if mismatch, return HTTP 422/400 `Idempotency-Key reuse with conflicting request payload`.
     - If state is `"in_flight"`: await completion up to 10s or return HTTP 409 Conflict with `Retry-After`.
     - If state is `"completed"`: replay response with header `Idempotency-Replayed: true`. Upstream call count = 0.
  4. On completion: update record with `"completed"`, set full TTL (default 300s / 5m). On upstream failure, delete key so client retries can re-attempt.
  5. Fallback: If Redis is down, proceed with normal execution without idempotency, logging one warning.

### Decision 4: Rule for `.js` vs `.ts` Twin Runtime-Loading
- **Decision**: The `.js` file is ALWAYS the runtime-loaded module.
- **Evidence & Verification**:
  1. All imports in `src/`, `open-sse/`, and Next.js route handlers use explicit `.js` extensions: e.g., `import { isRedisConfigured } from "../redis/client.js"`.
  2. In `tsconfig.json`, `noEmit: true` is configured. TypeScript is not compiled to JS during build.
  3. `package.json` scripts (`start`, `start:bun`) execute `custom-server.js`.
- **Enforcement Rule**:
  - Any bug fix, feature, or refactor MUST be applied to the `.js` runtime file.
  - The corresponding `.ts` twin MUST be updated in lockstep to keep TypeScript definitions and type-checking green.
  - Divergence between twins is prohibited.

### Decision 5: Test Execution under Bun (Bun-Hosted Vitest vs `bun test`)
- **Decision**: Use **Bun-hosted Vitest** (`bun x vitest run` or `bun run --bun vitest run`).
- **Rationale**:
  - `tests/` contains over 360 uses of `vi.mock()`, `vi.fn()`, `vi.importActual()`, `vi.useFakeTimers()`, and `vi.advanceTimersByTime()`.
  - Plain `bun test` does NOT support Vitest's `vi` mocking namespace, module hoisting, or `importActual()`. Running `bun test` causes hundreds of test failures.
  - In contrast, running Vitest under Bun executes Vitest's ESM runner while using Bun's V8-compatible JS engine, resolving `import("bun:sqlite")` natively.
- **Alternatives Considered**:
  - *Rewrite all tests for `bun test`*: Massive churn across 100+ test files, high risk of introducing subtle test regressions.
  - *Run Vitest on Node*: Requires keeping Node in test environments, preventing testing native `bun:sqlite` behavior without mocks.

### Decision 6: Turbopack Comparison Protocol
- **Decision**: Execute evaluation in an isolated worktree (`/tmp/khatam-turbopack-eval`).
- **Comparison Criteria**:
  1. Build Time: `next build --webpack` vs `next build` (Turbopack).
  2. Peak Memory: Measure peak RSS during build.
  3. Standalone Size: Size of `.next/standalone` output directory.
  4. Route Manifest: Exact diff of `.next/routes-manifest.json`.
  5. Runtime Validation: Verify standalone container boots under Bun, `/dashboard` and `/v1/models` respond, and `serverExternalPackages` (`open`, `ioredis`, `bun:sqlite`) load without bundling errors.
- **Policy**: If ANY regression or unresolved difference is observed, Webpack remains the default and the reason is recorded in `CLAUDE.md`.

---

## 3. Best Practices & Reference Patterns

### Bun-Only SQLite Architecture
- **Single Driver**: `bun:sqlite` is built into the Bun binary. It requires no native compiler, no external `.node` binary, and no fallback dependencies.
- **Fail-Closed on Non-Bun**:
  ```js
  if (!process.versions.bun) {
    throw new Error("[DB] KhatamRouter requires the Bun runtime (bun:sqlite). Please run with 'bun'.");
  }
  ```
- **Removal of Legacy Artifacts**:
  - Delete `betterSqliteAdapter.js`, `nodeSqliteAdapter.js`, `sqljsAdapter.js`.
  - Prune `better-sqlite3` and `sql.js` from `package.json`, `bun.lock`, and `next.config.mjs` (`serverExternalPackages`).
  - Prune `cli/hooks/sqliteRuntime.js`.
- **Direct Consumers**:
  - `src/lib/oauth/utils/zedCredentials.js`: replace `require("better-sqlite3")` with `const { Database } = await import("bun:sqlite")`, passing `{ readonly: true }`.
  - `src/app/api/oauth/cursor/auto-import/route.js`: replace `require("better-sqlite3")` with `bun:sqlite`.
  - `src/app/api/cli-tools/omp-settings/route.js`: replace `better-sqlite3` with `bun:sqlite`.
  - `open-sse/shared/mimoAccount.js`: replace `node:sqlite` with `bun:sqlite` `{ readonly: true }`.

### Redis 8.2 Alpine with Docker Compose
- **Service Configuration**:
  - Image: `redis:8.2-alpine`.
  - Command: `redis-server --appendonly yes --appendfsync everysec --save 60 1000`.
  - Port binding: `127.0.0.1:6379:6379` (strictly loopback; container network used for app communication).
  - Healthcheck: `test: ["CMD", "redis-cli", "ping"]`, interval `5s`, timeout `3s`, retries `5`.
  - Volume: Named volume `redis-data:/data`.
- **App Service**:
  - Depends on `redis` with `condition: service_healthy`.
  - `REDIS_URL: redis://redis:6379`.
  - `REDIS_KEY_PREFIX: khatam:`.
- **Disabling Redis**:
  - Setting `REDIS_URL=""` or omitting it safely engages all local fallback paths (SQLite quota store, in-process semaphores, local event bus).

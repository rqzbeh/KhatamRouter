# Feature Specification: Wave 7.5 — Bun-Only Runtime and Redis by Default

**Feature Branch**: `spec/0075-bun-only-redis-default`
**Created**: 2026-10-22
**Amended**: 2026-10-22 (US7 finalized with verified audit findings)
**Status**: Draft
**Input**: User description: "Wave 7.5: Remove better-sqlite3 (not Bun-compatible) and every Node-runtime SQLite fallback (node:sqlite, sql.js); bun:sqlite is the only driver, no Node fallback. docker-compose.yml builds from the Bun Dockerfile and runs Redis (redis:8.2-alpine) enabled by default. Use Redis to its full capacity, adapting the Redis use cases OmniRoute has that apply to us, plus lease-based distributed concurrency semaphores, round-robin counters and opt-in Idempotency-Key. Evaluate Turbopack in place of webpack. Fix confirmed Wave 1-7 defects. Semantic cache is out of scope."

> **Numbering note**: ROADMAP.md already reserves **Wave 8** for "Dashboard and Tooling" (TSX limits modals, key-quota tabs, capability badges, consolidated TypeScript CLI). This wave is therefore **7.5** and lives in `specs/0075-...`, which sorts between `007-` and `008-`. Wave 8 scope is untouched; the only CLI change here is that the existing launcher requires `bun`.  
> [Correction: Dashboard tooling shipped in PRs #71/#72 as plain JavaScript without TypeScript; the real Wave 8 is Bun performance and scale (specs/008-bun-perf-scale, planned).]

---

## User Scenarios & Testing

### User Story 1 - One SQLite Driver, Bun Only (Priority: P1)

An operator runs KhatamRouter and it always uses Bun's built-in SQLite engine. There is no probing chain, no native add-on that can fail to compile, and no pure-JavaScript fallback that cannot read WAL files. If Bun is missing, startup stops with one clear message instead of silently degrading.

**Why this priority**: `better-sqlite3` is a Node native add-on that does not run under Bun; the code already skips it there, and `Dockerfile.bun` already deletes it. Carrying it, `node:sqlite` and `sql.js` is dead weight, hides the real runtime, and `sql.js` cannot open a WAL database.

**Independent Test**: Boot the server under Bun on a fresh and on an existing database and confirm the reported driver is `bun:sqlite`, WAL is on and integrity check passes. Grep the shipped tree for the removed packages.

**Acceptance Scenarios**:
1. **Given** a fresh data directory, **When** the server starts under Bun, **Then** the logged driver is `bun:sqlite`, `PRAGMA journal_mode` is `wal` and `PRAGMA quick_check` is `ok`.
2. **Given** an existing WAL database, **When** the server starts, **Then** it opens without data loss and no fallback driver is attempted.
3. **Given** `bun:sqlite` cannot initialize, **When** the server starts, **Then** startup fails closed with an actionable error and no other driver is tried and no database file is replaced.
4. **Given** the repository after this wave, **When** searching source, manifests and lockfiles, **Then** `better-sqlite3`, `sql.js` and `node:sqlite` appear nowhere except historical docs (CHANGELOG) and removal notes.
5. **Given** the four direct SQLite consumers (Zed credentials, Cursor auto-import, OMP settings, Mimo account), **When** they read an IDE database, **Then** they use `bun:sqlite` read-only and behave as before, including the `get()`-returns-null-versus-undefined difference.

---

### User Story 2 - Docker Compose Runs Bun with Redis On (Priority: P1)

An operator runs `docker compose up` and gets the Bun build of KhatamRouter plus a Redis service, already wired together. Redis being enabled is the default, not an opt-in.

**Why this priority**: Today compose pulls an upstream Node image with no Redis, so the Redis features shipped in Waves 1-4 are off for every compose user.

**Independent Test**: `docker compose config` is valid; `docker compose up` brings Redis healthy first, then the app; the app reports Redis available; stopping Redis does not crash the app.

**Acceptance Scenarios**:
1. **Given** the compose file, **When** rendered, **Then** the app service builds from the Bun Dockerfile, depends on Redis with `condition: service_healthy`, and has `REDIS_URL` pointing at the Redis service by default.
2. **Given** the Redis service, **When** inspected, **Then** it uses `redis:8.2-alpine`, persists to a named volume with append-only mode, has a `redis-cli ping` healthcheck, and publishes no port beyond loopback.
3. **Given** the stack is running, **When** Redis is stopped, **Then** the app keeps serving requests, logs one degraded warning, and quota and rate limits continue to be enforced (see FR-014).
4. **Given** the stack is running, **When** Redis returns, **Then** the app reconnects without a restart.
5. **Given** the production image, **When** scanned, **Then** no `better_sqlite3.node` binary and no Node-only SQLite package is present.
6. **Given** the legacy Node `Dockerfile`, `start.sh` and `captain-definition`, **When** built or run, **Then** they produce the same Bun image, not a Node one.

---

### User Story 3 - Cluster-Safe Shared State in Redis (Priority: P1)

An operator runs more than one KhatamRouter process behind a load balancer. State that must agree across processes is shared through Redis, so one process's decision is respected by the others. When Redis is unavailable, each feature degrades to its previous single-process behaviour without blocking requests.

**Why this priority**: The Redis audit found state that is per-process today and unsafe with two processes: OAuth refresh locks (a single-use refresh token can be burned twice), concurrency limits (limit doubles with two processes), the dashboard login limiter (lockout never reaches its threshold), circuit-breaker trips (`CIRCUIT_TRIP` is defined but never published or subscribed) and session stickiness.

**Independent Test**: Run two server instances against one Redis in tests (or two module instances with a shared fake) and assert each shared behaviour; then run again with Redis unreachable and assert the previous behaviour.

**Acceptance Scenarios**:
1. **Given** two instances, **When** one breaker transitions to `OPEN`, **Then** the other observes the trip and gates dispatch to that provider without having to fail first.
2. **Given** two instances and a single-use refresh token, **When** both try to refresh at once, **Then** exactly one calls the provider and the other reuses its result.
3. **Given** two instances, **When** failed dashboard logins hit different instances, **Then** the lockout threshold is counted across both.
4. **Given** a conversation pinned to account A on instance 1, **When** the next request lands on instance 2, **Then** it routes to account A while the pin is fresh.
5. **Given** `maxConcurrent: 2` and two instances, **When** four requests arrive together, **Then** at most two are in flight upstream in total.
6. **Given** an instance that crashes holding a concurrency slot, **When** its lease expires, **Then** the slot is released with no manual action.
7. **Given** Redis unreachable, **When** any of the above runs, **Then** it behaves as it did before this wave, never throws on the request path, and logs at most one warning per outage.
8. **Given** the pricing and request-details caches, **When** a settings change is published, **Then** they invalidate like the settings cache already does.

---

### User Story 4 - Redis Accelerators (Priority: P2)

An operator gets faster and more observable request handling from Redis: API-key authentication metadata cached, usage and log events fanned out to every dashboard, and round-robin selection that no longer writes SQLite on each request.

**Why this priority**: These are performance and observability gains, not correctness fixes, so they follow the cluster-safety stories.

**Independent Test**: Unit tests against a fake Redis plus an SQLite-authoritative negative control for the auth cache.

**Acceptance Scenarios**:
1. **Given** a valid API key, **When** it is used repeatedly, **Then** authentication metadata is served from cache after the first lookup.
2. **Given** a cached API key that is then revoked, banned or expired, **When** it is used next, **Then** it is rejected. A cache hit alone never authorizes a request; the database remains the source of truth for identity and lifecycle.
3. **Given** a revoke, delete or regenerate, **When** it completes, **Then** the cached entry is removed.
4. **Given** two dashboard users on different instances, **When** a request completes, **Then** both see the usage event; and console-log lines from any instance reach every log viewer.
5. **Given** a combo or proxy pool, **When** requests rotate across targets, **Then** the rotation index is shared across instances and does not write the database per request.
6. **Given** Redis unreachable, **When** any accelerator runs, **Then** the request path is unchanged from today.

---

### User Story 5 - Opt-In Idempotency Keys (Priority: P2)

A client that retries a chat request with the same `Idempotency-Key` header does not trigger a second upstream call; it receives the original outcome. Clients that do not send the header see no change.

**Why this priority**: Retrying clients and flaky networks double-bill upstream accounts. It is new behaviour, so it is strictly opt-in by header.

**Independent Test**: Send two identical requests with one key and count upstream calls; send without a key and confirm no caching; send the same key with a different body and confirm it is rejected.

**Acceptance Scenarios**:
1. **Given** a non-streaming chat request with a new key, **When** it completes, **Then** the response is stored for a bounded time.
2. **Given** the same key and an identical body, **When** replayed within that time, **Then** the stored response is returned with no upstream call and a marker header.
3. **Given** the same key while the first request is still in flight, **When** replayed, **Then** the replay waits for the first outcome, or is told the request is in progress, and never starts a second upstream call.
4. **Given** the same key with a different body, **When** sent, **Then** it is rejected with a clear client error.
5. **Given** no `Idempotency-Key`, **When** any request is sent, **Then** behaviour and latency are unchanged.
6. **Given** two different API keys using the same `Idempotency-Key` value, **When** sent, **Then** their entries never collide or leak (the key is scoped per API key).
7. **Given** a streaming request or an error response, **When** a key is supplied, **Then** the result is not stored as a successful replay (see Assumptions).
8. **Given** Redis unreachable, **When** a key is supplied, **Then** the request proceeds without idempotency protection and a warning is logged once.

---

### User Story 6 - Build Pipeline: Turbopack Evaluation (Priority: P3)

A maintainer finds out whether the dashboard can build with Next's default bundler under Bun instead of `--webpack`, and adopts it only if nothing regresses.

**Why this priority**: The `--webpack` flag is inherited from upstream with no recorded reason, but Turbopack ignores the `webpack()` config callback and changes how `open` and standalone tracing resolve.

**Independent Test**: Build both ways in an isolated worktree and diff route manifests, standalone output and runtime behaviour.

**Acceptance Scenarios**:
1. **Given** an isolated worktree, **When** built with and without `--webpack`, **Then** a comparison of build time, peak memory, standalone size and route manifest is recorded in the plan.
2. **Given** a Turbopack standalone build, **When** the container runs, **Then** the dashboard and `/v1/models` respond and `open`, `ioredis` and `bun:sqlite` resolve correctly at runtime.
3. **Given** any regression or unresolved difference, **When** the evaluation ends, **Then** webpack is kept and the reason is documented in CLAUDE.md. Adoption is conditional, not assumed.

---

### User Story 7 - Wave 1-7 Defect Fixes (Priority: P2)

An operator relies on Waves 1-7 behaving as their docs claim. Defects confirmed by the cross-wave audit and by pre-planning verification (five targeted verifiers, all `confirmed`) are fixed here rather than carried forward.

**Why this priority**: Shipping on top of known defects compounds them. Three waves are in real trouble: Wave 3's ACL blocks every key that uses it, its limiter and spend caps never fire on real traffic, and the Wave 5 zero-width feature and the Wave 6 discovery half are dead code.

**Independent Test**: Each confirmed defect gets a failing test first, then a fix.

**Acceptance Scenarios**:
1. **Given** a key using Wave 3 tri-state ACL, **When** it makes a request, **Then** it is evaluated once by the unified gate and the legacy `enforceKeyAccess` gate MUST NOT also reject it (`src/sse/handlers/chat.js` double-gate fix).
2. **Given** connection-level rate, spacing or concurrency limits configured, **When** requests dispatch through `chatCore.js`/`auth.js`, **Then** `connectionLimiter.js` is invoked (Wave 3 T017 is genuinely wired, not just re-exported).
3. **Given** USD spend caps configured on an API key, **When** live requests complete, **Then** `request_cost_ledger` is populated and caps trigger (live caller of the ledger recorder verified, not just the writer).
4. **Given** an OPEN circuit plus an active cooldown on the production path, **When** `gateTarget` runs without `options.getBreaker`, **Then** the verdict is `circuit_open`, not `cooldown` (breaker pre-resolved before the gate chain; the guarded recheck MUST NOT be skippable — verified claim w4-order).
5. **Given** circuit-breaker HALF_OPEN admission, **When** probes are allowed, **Then** the probe budget is consumed via `canExecute()` so concurrent probes are bounded.
6. **Given** Redis configured, **When** any `publishKhatamEvent` fires after a subscription is active, **Then** the publish goes over the command client, not the subscriber connection (verified claim w1-pubsub; fake-Redis unit test updated to emulate subscriber-mode rejection, plus tests in `.js` and `.ts` twins).
7. **Given** stealth tool cloaking enabled, **When** a same-format stream passes through, **Then** tool names are decloaked for the client (passthrough stream receives the tool-name map), or the wave documents `restoreToolNames` as the single response path and removes the dead `decloakToolsInResponse` (verified claim w5-decloak — either fix or documented decision, not silent dead code).
8. **Given** model discovery configured, **When** discovery runs, **Then** `normalizeDiscoveredModels` output feeds the reconciler and the capability cascade is reachable at request time, or the wave documents discovery as intentionally manual/CLI-only with the dead modules removed (verified claim: zero production callers; either wire or remove).
9. **Given** revoked/banned/expired API keys and non-chat endpoints, **When** requests arrive, **Then** embeddings and other endpoints enforce the same unified ACL and spend checks as chat (no bypass via endpoint choice).
10. **Given** CI, **When** it runs, **Then** all Wave 1-7 unit suites are listed in `verify.yml` (Wave 5-7 suites are missing today).
11. **Given** production startup without `JWT_SECRET`/`API_KEY_SECRET` set, **When** the server boots, **Then** secret enforcement fails closed (verify that the `runtime-secrets.cjs` guard is actually invoked at startup; it exists but may be uncalled), and Windsurf's registry/test inconsistency (script excludes `windsurf.js` while `windsurf-executor.test.js` imports it) is resolved in one direction.
12. **Given** duplicate `.js`/`.ts` twins and committed build artifacts, **When** audited, **Then** the runtime-loaded file is identified and divergence between twins is resolved or documented.
13. **Given** README, ROADMAP, CLAUDE.md and i18n docs, **When** this wave ships, **Then** statements about SQLite drivers, Node fallback, compose, ports and Redis match the code.
14. **Explicitly out of US7**: the legacy `MIGRATED_MARKER` reference (inside the unreachable legacy-JSON branch — leave it, do not touch).

---

### Edge Cases

- Existing databases written by an earlier driver: the file format is identical, so they open unchanged; the preflight integrity check must still run read-only and fail closed on corruption.
- `bun:sqlite` returns `null` for a missing row where the old driver returned `undefined`; all callers must use falsy checks.
- `bun:sqlite` transactions are synchronous; no caller may `await` inside a transaction.
- Redis restarts mid-request: in-flight lease and lock holders must not deadlock; every Redis-held key has a TTL.
- Redis eviction under memory pressure: no correctness property may depend on a key surviving (the auth cache and idempotency store are advisory; SQLite stays authoritative where identity is concerned).
- Clock skew between instances: leases and windows use Redis server time (or are TTL-based), not each instance's wall clock.
- A client sends `Idempotency-Key` with a streaming request: stored response replay is not attempted.
- Port 6379 already in use on the host: the Redis service must not publish beyond loopback, and a changed host port must be configurable.
- `.env` contains an empty `REDIS_URL=`: this is treated as "unset", not as the compose default; a documented way to disable Redis is provided.
- Running from source with Node (no Bun): fails immediately with a message naming Bun as required, not with a cryptic `ERR_UNKNOWN_BUILTIN_MODULE`.
- The published `9router` CLI is launched by a Node shebang: it must locate `bun` and fail with a clear install message otherwise.

## Requirements

### Functional Requirements

**Runtime (US1)**
- **FR-001**: The system MUST use `bun:sqlite` as its only SQLite driver. The `better-sqlite3`, `node:sqlite` and `sql.js` adapters, probe functions and the sql.js WAL-refusal branch MUST be removed.
- **FR-002**: The system MUST fail closed with an actionable message when `bun:sqlite` cannot initialize or when run without Bun, and MUST NOT replace or create a database file as a side effect of that failure.
- **FR-003**: `better-sqlite3` and `sql.js` MUST be removed from `package.json`, `package-lock.json`, `bun.lock`, `serverExternalPackages`, the image prune step and the CLI bundler.
- **FR-004**: The Zed credential reader, Cursor auto-import, OMP settings route and Mimo account reader MUST use `bun:sqlite` with read-only open where they only read.
- **FR-005**: The adapter contract (`run`, `get`, `all`, `exec`, `pragma`, `transaction`, `checkpoint`, `close`) MUST be unchanged, and the `.js` and `.ts` adapter twins MUST NOT diverge in behaviour (`get()` miss returns the same value in both).
- **FR-006**: The test suite MUST run under Bun-hosted Vitest, MUST keep coverage of the driver, WAL, integrity preflight and migration backup paths, and the regression baseline MUST be regenerated with removed tests accounted for.
- **FR-007**: The `cli/` launcher MUST start the server with `bun`, MUST fail with an install message if `bun` is absent, MUST NOT inject `NODE_PATH` or install SQLite runtimes, and MUST keep its tray helpers working after `sqliteRuntime.js` is removed. This is a documented breaking change for CLI users without Bun.

**Compose and Docker (US2)**
- **FR-008**: There MUST be exactly one maintained application Dockerfile (Bun). `Dockerfile`, `start.sh` and `captain-definition` MUST build or reference that image.
- **FR-009**: `docker-compose.yml` MUST build from the Bun Dockerfile, publish the dashboard port, and add a `redis` service using `redis:8.2-alpine` with append-only persistence on a named volume, a `redis-cli ping` healthcheck, and loopback-only host binding.
- **FR-010**: The app service MUST set `REDIS_URL` to the Redis service by default and depend on it with `condition: service_healthy`. Disabling Redis MUST be possible and documented.
- **FR-011**: `.env.example`, `DOCKER.md`, README, CLAUDE.md, `docs/ARCHITECTURE.md`, gitbook deployment docs and every i18n README MUST match the new defaults.

**Shared state (US3, US4)**
- **FR-012**: Circuit-breaker transitions to `OPEN` and `DEGRADED` MUST be published on `CIRCUIT_TRIP`, and every instance MUST apply received trips to its in-memory registry without echoing its own events.
- **FR-013**: The OAuth refresh path MUST use a Redis lock with a TTL (`SET NX EX`) so one instance refreshes and others reuse the result; the in-process dedup stays as the first layer.
- **FR-014**: When Redis is unavailable the quota store MUST degrade to the SQLite store and keep enforcing limits. It MUST NOT return an unlimited allow for a Redis outage. Request-path errors MUST still never be thrown.
- **FR-015**: The dashboard login limiter MUST count failures and lockouts in Redis when available, falling back to the in-process map.
- **FR-016**: Stealth session pins MUST be stored in Redis with the existing 15-minute lifetime when available, falling back to the in-process map.
- **FR-017**: Concurrency limits (`maxConcurrent`, `modelConcurrency`) MUST be enforceable across instances using time-limited leases that expire if the holder dies, and MUST fall back to the in-process semaphore.
- **FR-018**: Combo rotation and proxy-pool rotation MUST use a shared atomic counter when Redis is available and MUST NOT write the database per request for rotation.
- **FR-019**: The pricing and request-details caches MUST invalidate on the existing config-reload event.
- **FR-020**: API-key authentication metadata MUST be cacheable in Redis with a bounded lifetime; a cache hit MUST NOT authorize a key on its own, the database MUST remain authoritative, and revoke, ban, delete and regenerate MUST evict the entry. A flag MUST disable the cache.
- **FR-021**: Usage events and console-log lines MUST be fanned out over Redis pub/sub so every instance's dashboard stream sees them, without echoing an instance's own events twice.
- **FR-022**: Every Redis-backed behaviour MUST be individually switchable, MUST namespace keys under `REDIS_KEY_PREFIX`, MUST hash any secret used in a key, MUST give every key a TTL (except documented persistent markers), and MUST NOT throw out of the request path.

**Idempotency (US5)**
- **FR-023**: When an `Idempotency-Key` header is present on a non-streaming chat request, the system MUST store the successful response for a bounded time keyed by (API key, idempotency key), replay it on an identical request, return a client error for a body mismatch, and handle a concurrent duplicate without a second upstream call. Without the header nothing changes.

**Build and quality (US6, US7)**
- **FR-024**: The Turbopack evaluation MUST be performed in an isolated worktree and recorded; webpack stays unless every comparison in US6 passes.
- **FR-025**: Every US7 acceptance scenario (1-11 MUST be fixed with a regression test; 12-13 MUST be resolved; the `MIGRATED_MARKER` legacy-branch reference MUST be left untouched) MUST hold. Remaining medium/low audit findings are fixed where cheap or carry a recorded reason.
- **FR-026**: The wave MUST pass local container verification: a clean image build, a running stack with Redis, dashboard and `/v1/models` probes, WAL and integrity checks, a Redis-outage drill, and an assertion that no Node-only SQLite binary ships.
- **FR-027**: README.md and ROADMAP.md MUST be updated after merge to show Wave 7.5 as shipped, with no overclaiming.

### Key Entities

- **Lease**: A time-limited claim on a concurrency slot or refresh operation, owned by one instance, expiring automatically.
- **Shared counter**: An atomic integer in Redis used for rotation indexes and window counts.
- **Idempotency record**: A stored outcome keyed by (API key hash, client idempotency key) with a request-body fingerprint, a state (in flight or complete) and an expiry.
- **Auth cache entry**: Advisory metadata for one hashed API key with an expiry; never authoritative.
- **Cluster event**: A pub/sub message carrying a source instance id and a payload (config reload, circuit trip, usage, log).

## Success Criteria

### Measurable Outcomes

- **SC-001**: A search for `better-sqlite3`, `sql.js` and `node:sqlite` across source, manifests and lockfiles returns zero hits outside CHANGELOG and this spec.
- **SC-002**: A fresh `docker compose up` reaches a healthy app and a healthy Redis with no manual configuration, and the app reports Redis available.
- **SC-003**: With Redis stopped, the app continues to answer requests and quota/rate limits continue to be enforced, verified by a test and by the container drill.
- **SC-004**: With two instances sharing one Redis, a concurrency limit of N admits at most N concurrent upstream calls in total across both.
- **SC-005**: Two simultaneous refreshes of one single-use token result in exactly one upstream refresh call.
- **SC-006**: A revoked API key is rejected on its next use regardless of cache state (zero cache-authorized revoked keys in the negative-control test).
- **SC-007**: A replayed `Idempotency-Key` request makes zero additional upstream calls; a request without the header is byte-for-byte unchanged in behaviour.
- **SC-008**: The Vitest suite under Bun has no new failures relative to the committed baseline, other than tests removed or replaced for deleted drivers, which are listed.
- **SC-009**: No Node-only SQLite binary exists in the built image.
- **SC-010**: Every confirmed critical or high audit finding is fixed or carries a recorded reason, and docs claims match code for the statements listed in US7.

## Assumptions

- Per the standing overnight-autonomy policy, open questions are decided by the safer, easier-to-revert option and recorded in PR notes.
- Bun is the single supported runtime; Node-only deployment is intentionally unsupported after this wave. The `cli/` npm package keeps its Node shebang only to locate and launch `bun`.
- Redis 8.2 is used via the floating `8.2-alpine` tag chosen by the maintainer; patch updates arrive on image pull. Whether 8.2 is an LTS line is not asserted.
- Idempotency covers non-streaming chat requests only; streaming and error responses are not replayed. Replay lifetime defaults to a short bounded window (to be fixed in the plan).
- The semantic or response-similarity cache is out of scope for this wave by explicit decision. Exact-match replay exists only through Idempotency-Key.
- Wave 8 (TSX dashboard modals, key-quota tabs, capability badges, consolidated TypeScript CLI) and Phase 2 (Go gateway) are unchanged. [Correction: Dashboard tooling shipped as plain JavaScript in PRs #71/#72 without TypeScript; Wave 8 was reassigned to Bun performance and scale (specs/008-bun-perf-scale).]
- User Story 7's contents were finalized by amendment 2026-10-22 after the audit completed plus five targeted verifiers (w4-order, w1-pubsub, w5-decloak, quota-failopen, refresh-singleuse — all `confirmed`).
- The existing Redis event bus, quota store, key prefix and fail-open conventions are reused; this wave adds users of them rather than a second Redis layer.
- Redis is bound to loopback on the host; inter-container traffic uses the compose network. Redis authentication is not added in this wave (deferred; recorded in the plan as a hardening item).

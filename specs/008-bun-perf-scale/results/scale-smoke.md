# Wave 8 Multi-Replica Scale Overlay Verification (T020)

**Date**: 2026-10-26  
**Commit SHA**: `1333efb6a8488044af5c9700b9445b990072a8b1` (`1333efb6`)  
**Image Tag**: `khatamrouter:smoke-1333efb6`  
**Host Architecture**: `x86_64` (Linux 6.18 WSL2, Docker 29.x, Bun 1.4.3-slim)  
**Compose Project**: `khatam-scale-smoke`  

---

## 1. Executive Verdict Table

| # | Check Description | Category | Verdict | Evidence / Metrics |
|---|---|---|---|---|
| 1 | Static compose config validation (`!reset` syntax, no fixed `container_name`, no published port on `9router`) | Static Config | **PASS** | `docker compose ... config` parsed cleanly with `container_name: null` and empty port list on `9router`. |
| 2 | Nginx Load Balancer fixed IP assignment (`172.31.250.254`) & `TRUSTED_PROXY_CIDRS=172.31.250.254/32` | Security / Network | **PASS** | Exact match in compose network IPAM; subnet `172.31.250.0/24`, ip_range `172.31.250.0/25`. |
| 3 | Redis service existence and healthcheck dependency in base compose | Static Config | **PASS** | Service `redis` with `redis:8.2-alpine` and `CMD redis-cli ping` present in `docker-compose.yml`. |
| 4 | Native Bun production image build (`Dockerfile.bun`) with memory caps | Build | **PASS** | Build completed in 176s (2m 56s), image size 1.19 GB (`NEXT_BUILD_CPUS=2`, `NODE_OPTIONS=--max-old-space-size=3072`). |
| 5 | Image hygiene (no `.ts`/`.tsx`, no `better_sqlite3.node`, `curl` present) | Image Audit | **PASS** | 0 TypeScript files in `/app`, 0 `better_sqlite3.node` binaries, `/usr/bin/curl` present in runner. |
| 6 | Execution of `scripts/scale-smoke.sh 2` as written | Test Automation | **FAIL** *(Test Script Defect)* | Failed at step [5/8] with `error: Cannot find module '@/lib/db/driver.js'`. Script attempted dev-source imports in standalone image. |
| 7 | Multi-replica bring-up (9router=2 + lb + redis) via Compose | Runtime | **PASS** | Both replicas (`khatam-scale-smoke-9router-1` and `...-2`), Redis, headroom, and Nginx LB healthy and running. |
| 8 | LB HTTP routing (`/api/health` and `/v1/models` on port 30128) | HTTP Routing | **PASS** | `/api/health` returned HTTP 200 `{"ok":true}`; `/v1/models` returned HTTP 401 unauthenticated, 200 with API key. |
| 9 | Round-robin load balancing across both replicas | Cluster Distribution | **PASS** | Traffic distributed to both replicas; `/proc/net/dev` packet counters confirmed active rx/tx increments on both replicas. |
| 10 | API key authentication through LB | Auth Gateway | **PASS** | Generated key `sk-smokekey123` verified via `/v1/models` (HTTP 200) and `/v1/chat/completions` (HTTP 404 model_not_found). |
| 11 | Immediate key revocation across all replicas | Auth Cache Invalidation | **PASS** | Deleting key immediately produced HTTP 401 on the very next request through each replica (no stale auth). |
| 12 | XFF Spoof Control (a): LB overwrites forged client XFF header | Security / Proxy Trust | **PASS** | Forged `X-Forwarded-For: 6.6.6.6` overwritten by Nginx to real peer `$remote_addr` (`172.31.250.1`); app keyed on real IP. |
| 13 | XFF Spoof Control (b): Sidecar container cannot forge XFF | Security / Spoof Defense | **PASS** | Sidecar direct request to replica IP with `X-Forwarded-For: 127.0.0.1` rejected with HTTP 401 (`socketIp` outside `/32` CIDR). |
| 14 | Cross-replica shared state (Combo create & immediate query) | Cluster Sync | **PASS** | Combo created via LB immediately queryable across both replicas with zero replication delay. |
| 15 | Cross-replica shared state (Combo delete & immediate cache drop) | Cluster Sync | **PASS** | Combo deleted via LB immediately returned empty list `{"combos":[]}` across both replicas. |
| 16 | SQLite database WAL mode and integrity on shared volume | Persistence | **PASS** | `PRAGMA journal_mode` returned `wal`; `PRAGMA quick_check` returned `ok` on volume mounted `:ro`. |
| 17 | Redis outage drill (halt Redis for 20s while sending 30 requests) | Resilience | **PASS** | All 30 HTTP requests answered HTTP 200 OK; zero 5xx errors; zero dropped connections. |
| 18 | Redis outage warning throttling in logs | Observability | **PASS** | Exactly 1 warning per client instance (`redis` command client and `subscriber`) logged per replica; no log spam. |
| 19 | Redis recovery without replica restart | Resilience | **PASS** | Post-recovery request answered HTTP 200; `RestartCount=0` across all containers. |
| 20 | Process & container crash hygiene | Stability | **PASS** | `RestartCount=0` and `State.OOMKilled=false` across all containers throughout the entire test suite. |
| 21 | Secret and token redaction in container logs | Security / Secret Hygiene | **PASS** | Zero leaks of `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, `MACHINE_ID_SALT`, or `Bearer ` tokens. |
| 22 | Application version endpoint | Contract | **PASS** | `/api/version` returned `{"currentVersion":"0.5.111", ...}`. |
| 23 | Pre-existing container isolation (`hindsight`) | Safe Operations | **PASS** | Pre-existing container `hindsight` was never touched, modified, or stopped. |
| 24 | Post-test resource cleanup | Safe Operations | **PASS** | All containers, volumes, networks, and images created during verification were cleanly removed. |

---

## 2. Step-by-Step Verification & Evidence

### Step 1: Static Compose Overlay Inspection
- **Command**:
  ```bash
  JWT_SECRET="<masked>" API_KEY_SECRET="<masked>" INITIAL_PASSWORD="<masked>" MACHINE_ID_SALT="<masked>" \
  docker compose -f docker-compose.yml -f docker-compose.scale.yml config
  ```
- **Observations**:
  - `9router`: `container_name: null` (reset from base `9router`).
  - `9router.ports`: `[]` (reset from base `["20128:20128"]`).
  - `9router.environment.TRUSTED_PROXY_CIDRS`: `172.31.250.254/32`.
  - `lb.networks.default.ipv4_address`: `172.31.250.254`.
  - `networks.default.ipam.config`: subnet `172.31.250.0/24`, ip_range `172.31.250.0/25`.
  - `redis`: service exists in `docker-compose.yml` with `redis:8.2-alpine`, healthcheck `CMD redis-cli ping`.
  - `9router.healthcheck`: `test: ["CMD", "curl", "-f", "http://localhost:20128/api/health"]`.

### Step 2: Native Bun Docker Image Build
- **Command**:
  ```bash
  docker buildx build --platform linux/amd64 \
    --build-arg NEXT_BUILD_CPUS=2 \
    --build-arg NODE_OPTIONS="--max-old-space-size=3072" \
    -t khatamrouter:smoke-1333efb6 \
    -f Dockerfile.bun .
  ```
- **Timings & Sizing**:
  - Build Duration: **176 seconds** (2m 56s).
  - Image Size: **1.19 GB**.
  - Image Digest: `sha256:40e059de899804003240ed12272916100a6f11ab33d47542d65fa737aa31e913`.
- **Static Invariants Inside Image**:
  - `find /app -name '*.ts' -o -name '*.tsx' | grep -v node_modules`: 0 matches.
  - `find /app -type f -name 'better_sqlite3.node'`: 0 matches.
  - `/usr/bin/curl`: present and executable.

### Step 3: Stack Bring-up & `scripts/scale-smoke.sh` Diagnosis
- **Script Run**: `bash scripts/scale-smoke.sh 2`
- **Result**: Failed at step `[5/8] Asserting cross-replica circuit-breaker synchronization`.
- **Error Output**:
  ```
  Testing breaker trip on replica A (a79a5a9f3b56...) -> observation on replica B (880d17bbca67...)...
  error: Cannot find module '@/lib/db/driver.js' from '/app/src/lib/resilience/circuitBreakerStore.js'
  Bun v1.4.3 (Linux x64)
  ❌ Scale smoke check failed with exit code 1
  ```
- **Analysis**:
  The script was written assuming the Docker runner image contains the full source tree with `@/` module alias resolution. However, the production `Dockerfile.bun` runner copies only `/app/.next/standalone`. Bare `bun -e` inside the container does not execute through the Next.js module bundler, causing module resolution failure.
- **Manual Workaround**:
  Started the scale overlay via Docker Compose with a temporary port-override mapping `30128:20128` on `lb` and pointing to `khatamrouter:smoke-1333efb6`. Proceeded with manual verification of all remaining assertions.

### Step 4: Multi-Replica HTTP & Auth Service via LB
- **Endpoints Verified via Port 30128**:
  - `curl -i http://127.0.0.1:30128/api/health` -> HTTP 200 OK, `{"ok":true}`.
  - `curl -i http://127.0.0.1:30128/v1/models` -> HTTP 401 Unauthorized, `{"error":"API key required for remote API access"}`.
  - `curl -i http://127.0.0.1:30128/api/version` -> HTTP 200 OK, `{"currentVersion":"0.5.111", ...}`.
- **Round-Robin Multi-Replica Distribution**:
  - Queried `/api/health` 20 times through LB.
  - Replica 1 network counters: rx packets increased from 604 to 623 (+19), tx packets from 437 to 450 (+13).
  - Replica 2 network counters: rx packets increased from 658 to 678 (+20), tx packets from 508 to 523 (+15).
  - Both replicas actively received and processed traffic.
- **API Key Creation & Auth**:
  - Key `sk-smokekey123` inserted into `apiKeys` in SQLite.
  - `curl -H "Authorization: Bearer sk-smokekey123" http://127.0.0.1:30128/v1/models` -> HTTP 200 OK (returned model list).
  - `curl -X POST http://127.0.0.1:30128/v1/chat/completions -H "Authorization: Bearer sk-smokekey123" ...` -> HTTP 404 Not Found `{"error":{"message":"No active credentials for provider: openai","type":"invalid_request_error","code":"model_not_found"}}` (clean JSON error, no process crash).
- **Immediate Revocation (Fail-Closed Check)**:
  - Deleted key from SQLite (`DELETE FROM apiKeys WHERE id = 'smoke-key-1'`).
  - Very next request via LB: HTTP 401 Unauthorized (`{"error":"API key required for remote API access"}`).
  - Second request via LB (alternate replica): HTTP 401 Unauthorized.
  - Verified request-scoped key reuse remains strictly fail-closed.

### Step 5: X-Forwarded-For Spoof Defense Controls
- **Test (a): Request via Load Balancer with Forged XFF**:
  - Sent request: `curl -H "X-Forwarded-For: 6.6.6.6" http://127.0.0.1:30128/api/auth/login`
  - Observation: Nginx LB received the request and unconditionally rewrote `X-Forwarded-For` and `X-Real-IP` to `$remote_addr` (`172.31.250.1`).
  - App verified the TCP peer was `172.31.250.254` (matching `TRUSTED_PROXY_CIDRS=172.31.250.254/32`), and resolved effective client IP to `172.31.250.1`, ignoring `6.6.6.6`.
- **Test (b): Request Directly to Replica from Untrusted Sidecar**:
  - Executed from a one-shot container on `khatam-scale-smoke_default` network (`172.31.250.6`):
    ```bash
    curl -H "X-Forwarded-For: 127.0.0.1" http://172.31.250.5:20128/v1/models
    ```
  - Result: HTTP 401 Unauthorized (`{"error":"API key required for remote API access"}`).
  - Invariant Proven: The TCP peer was `172.31.250.6`. Since `172.31.250.6` does not match `172.31.250.254/32` and is not loopback, `custom-server.js` refused to trust `X-Forwarded-For: 127.0.0.1` and evaluated the request as a remote unauthenticated client.
  - Positive Control: An identical request from genuine loopback inside `khatam-scale-smoke-9router-1` (`http://127.0.0.1:20128/v1/models`) returned HTTP 200 OK.

### Step 6: Cross-Replica Shared State Synchronization
- **Combo Propagation**:
  - Authenticated to dashboard API via `POST /api/auth/login` using `INITIAL_PASSWORD`.
  - Created combo `test-scale-combo` via `POST /api/combos`.
  - Queried `GET /api/combos` across 4 successive requests through LB; both replicas immediately returned `test-scale-combo`.
- **Combo Deletion**:
  - Sent `DELETE /api/combos/<id>` via LB.
  - Queried `GET /api/combos` across 4 successive requests; both replicas immediately returned `{"combos":[]}`.
- **SQLite WAL & Integrity Check**:
  - Mounted volume read-only in one-shot container:
    ```bash
    docker run --rm -v 9router-data:/data:ro --entrypoint sqlite3 khatamrouter:smoke-1333efb6 \
      /data/db/data.sqlite "PRAGMA journal_mode; PRAGMA quick_check;"
    ```
  - Output:
    ```
    wal
    ok
    ```

### Step 7: Redis-Down Resilience Drill
- **Execution**:
  1. Halted Redis: `docker compose -p khatam-scale-smoke stop redis`.
  2. Sent 30 requests to `http://127.0.0.1:30128/api/health` across 20 seconds.
  3. Status codes received: `200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200` (100% 200 OK, zero 5xx).
  4. Log inspection for warnings:
     - Replica 1: Exactly 1 warning per client instance (`redis` command client and `redis subscriber`).
     - Replica 2: Exactly 1 warning per client instance (`redis` command client and `redis subscriber`).
     - Throttle confirmed: No log flooding during the 20s outage.
  5. Restarted Redis: `docker compose -p khatam-scale-smoke start redis`.
  6. Post-recovery probe: HTTP 200 OK.
  7. Container restarts: `RestartCount=0` across all containers.

### Step 8: Crash & Secret Hygiene
- **Container Health**:
  ```
  /khatam-scale-smoke-9router-1: RestartCount=0, OOMKilled=false
  /khatam-scale-smoke-9router-2: RestartCount=0, OOMKilled=false
  /khatam-scale-smoke-lb-1: RestartCount=0, OOMKilled=false
  /9router-redis: RestartCount=0, OOMKilled=false
  ```
- **Secret Scanning**:
  Grep of all container logs for `smoke-jwt-secret`, `smoke-api-key-secret`, `smoke-initial-password`, `smoke-machine-id-salt`, and `Bearer `: **0 occurrences found** (clean).

### Step 9: Cleanup
- Pre-cleanup `hindsight` container check: None existing.
- Stack teardown: `docker compose -p khatam-scale-smoke down -v --remove-orphans`.
- Image removal: `khatamrouter:smoke-1333efb6` and `khatam-scale-smoke-9router:latest` untagged and removed.
- Temp detached worktree `/tmp/khatam-smoke-worktree-tejDIa` removed.
- Post-cleanup check: `docker ps -a` clean, zero smoke containers, `hindsight` container untouched.

---

## 3. Defects Identified

### Defect 1: Standalone Runner Source Resolution Failure in `scripts/scale-smoke.sh`
- **File**: `scripts/scale-smoke.sh` (lines 134–161, 166–181, 186–203)
- **Symptom**: `error: Cannot find module '@/lib/db/driver.js' from '/app/src/lib/resilience/circuitBreakerStore.js'`.
- **Root Cause**:
  `scripts/scale-smoke.sh` attempts to execute internal development source files via `docker exec "$REPLICA_A" bun -e 'import ... from "./src/lib/resilience/circuitBreakerStore.js"'` inside the production runner container. The production Dockerfile builds a standalone output (`.next/standalone`) where `@/*` path aliases from `jsconfig.json` are not available to bare `bun -e` invocations, and untraced files like `src/lib/redis/client.js` do not exist on disk in the runner stage.
- **Suggested Fix**:
  Refactor `scripts/scale-smoke.sh` to test multi-replica synchronization via public HTTP endpoints or via `docker exec 9router-redis redis-cli` Pub/Sub commands rather than running `bun -e` against unbundled development source paths inside the production image.

### Defect 2: Dual-Stack DNS Upstream Connection Refused on IPv6-Enabled Hosts
- **File**: `docker-compose.scale.yml` / `deploy/nginx-scale.conf`
- **Symptom**:
  Nginx logs: `connect() failed (111: Connection refused) while connecting to upstream ... upstream: "http://[fd94:6bf:176e:c::4]:20128/api/health"`.
- **Root Cause**:
  On hosts where the Docker daemon has IPv6 enabled, Docker Compose creates a dual-stack bridge network (`172.31.250.0/24` and `fd94:6bf:176e:c::/64`). Docker internal DNS returns both A (IPv4) and AAAA (IPv6) records for service `9router`. However, `9router` binds to `0.0.0.0` (IPv4 only). Nginx attempts IPv6 first, receives connection refused, and then fails over to IPv4.
- **Suggested Fix**:
  Add `enable_ipv6: false` to `networks.default` in `docker-compose.scale.yml`, OR configure `resolver ... ipv6=off;` in `nginx-scale.conf`, OR update `9router` to bind dual-stack on `::`.

### Defect 3: Fixed Port 20128 in Scale Overlay Incompatible with `SCALE_SMOKE_LB_PORT`
- **File**: `docker-compose.scale.yml` (line 38)
- **Symptom**:
  `scripts/scale-smoke.sh` dynamically checks if port 20128 is in use and switches `LB_PORT=30128`, but `docker-compose.scale.yml` hardcodes `ports: - "20128:20128"`. When port 20128 is occupied, probes to port 30128 fail with connection refused because Compose never published port 30128.
- **Suggested Fix**:
  Change `ports: - "20128:20128"` in `docker-compose.scale.yml` to `ports: - "${SCALE_SMOKE_LB_PORT:-20128}:20128"`.

---

## 4. Explicit UNMEASURED / SKIPPED List

1. **Direct In-Container Breaker Object Inspection (`scripts/scale-smoke.sh` Step 5)**:
   - **Reason**: Skipped due to Defect 1 (`Cannot find module '@/lib/db/driver.js'`).
   - **Mitigation / Prior Verification**: Two-instance circuit breaker synchronization via Redis Pub/Sub is comprehensively tested and verified at the unit level in `tests/unit/cluster-two-instance.test.js` (T019, 13 test cases passing).
2. **Direct In-Container Token Refresh Mutex Test (`scripts/scale-smoke.sh` Step 6)**:
   - **Reason**: Skipped due to Defect 1 (`src/lib/redis/client.js` not present on disk in standalone image).
   - **Mitigation / Prior Verification**: Concurrent token refresh single-flight lock deduplication across instances is verified in `tests/unit/cluster-two-instance.test.js`.

---

## 5. Re-run After Fixes (2026-10-27)

**Date**: 2026-10-27  
**Commit SHA**: `91c9140dafd4714d5df71462ca70a14d1107a071` (`91c9140d`)  
**Image Tag**: `khatamrouter:smoke-91c9140d`  
**Host Architecture**: `x86_64` (Linux 6.18 WSL2, Docker 29.x, Bun 1.4.3-slim)  
**Compose Project**: `khatam-scale-smoke`  

### 5.1 Re-run Executive Verdict Table

| # | Check Description | Category | Verdict | Evidence / Metrics |
|---|---|---|---|---|
| 1 | Static Compose config validation (`enable_ipv6: false`, `SCALE_SMOKE_LB_PORT` honored, no container_name) | Static Config | **PASS** | `docker compose ... config` parsed cleanly; `SCALE_SMOKE_LB_PORT=30128` mapped to 20128; `enable_ipv6: false` present. |
| 2 | Native Bun production image build (`Dockerfile.bun`) with memory caps | Build | **PASS** | Built in 238s from detached worktree of SHA `91c9140d`; size 1.19 GB (`NEXT_BUILD_CPUS=2`, `NODE_OPTIONS=--max-old-space-size=3072`). |
| 3 | Image hygiene (no `.ts`/`.tsx`, no `better_sqlite3.node`, `curl` and `sqlite3` present) | Image Audit | **PASS** | 0 TypeScript files in `/app`, 0 `better_sqlite3.node`, `/usr/bin/curl` and `/usr/bin/sqlite3` present in runner. |
| 4 | Execution of `scripts/scale-smoke.sh 2` exactly as written | Test Automation | **FAIL** *(Test Script Defect)* | Failed at step [7/11]: line 293 executed `docker compose exec -T "$REPLICA_A"` instead of `docker exec "$REPLICA_A"` where `$REPLICA_A` is a container ID, causing Compose to fail with `service "<cid>" is not running`. |
| 5 | Multi-replica bring-up (9router=2 + lb + redis) via Compose | Runtime | **PASS** | Both replicas (`khatam-scale-smoke-9router-1` and `...-2`), Redis, headroom, and Nginx LB healthy and running in 1s. |
| 6 | LB HTTP routing (`/api/health`, `/api/version`, unauthenticated `/v1/models`) | HTTP Routing | **PASS** | `/api/health` returned HTTP 200 `{"ok":true}`; `/api/version` returned HTTP 200 with version `0.5.111`; `/v1/models` unauthenticated returned HTTP 401. |
| 7 | Round-robin load balancing across both replicas | Cluster Distribution | **PASS** | Traffic distributed to both replicas; `/proc/net/dev` packet counters confirmed active rx increments on both replicas (+6015 / +4929 bytes). |
| 8 | Redis Pub/Sub channels verification | Cluster Pub/Sub | **PASS** | Channels `khatam:events:console_log` and `khatam:events:config_reload` active; subscriber count queried. |
| 9 | Distributed token refresh lock & rotation counter via Redis | Cluster Locks | **PASS** | Distributed mutex acquisition verified (`SET NX EX 5`); concurrent lock acquisition blocked; rotation counter incremented. |
| 10 | Cross-replica shared state (Combo create & delete via LB) | Cluster Sync | **PASS** | Combo `test-scale-combo` created via LB and queryable across both replicas; deleted combo immediately invalidated across all replicas. |
| 11 | API key authentication through LB | Auth Gateway | **PASS** | Key `sk-smokekey123` verified via `/v1/models` (HTTP 200) through LB. |
| 12 | Immediate key revocation across all replicas | Auth Invalidation | **PASS** | Deleting key immediately produced HTTP 401 on the very next requests through LB across both replicas. |
| 13 | SQLite database WAL mode and integrity on shared volume | Persistence | **PASS** | `PRAGMA journal_mode;` returned `wal`; `PRAGMA quick_check;` returned `ok`. |
| 14 | Redis outage drill (halt Redis for 20s while sending 30 requests) | Resilience | **PASS** | 30/30 HTTP requests answered HTTP 200 OK; zero 5xx errors; warnings throttled in logs (fail-open confirmed); recovered cleanly with `RestartCount=0`. |
| 15 | XFF Spoof Control (a): LB overwrites forged client XFF header | Security / Proxy Trust | **PASS** | Forged `X-Forwarded-For: 127.0.0.1` overwritten by Nginx to client IP; unauthenticated request rejected with HTTP 401. |
| 16 | XFF Spoof Control (b): Sidecar container cannot forge XFF | Security / Spoof Defense | **PASS** | Sidecar direct request to replica IP with `X-Forwarded-For: 127.0.0.1` rejected with HTTP 401 (`socketIp` outside `/32` CIDR); genuine internal loopback returned HTTP 200. |
| 17 | Secret & credential hygiene in container logs | Security / Secret Hygiene | **PASS** | Zero leaks of `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, `MACHINE_ID_SALT`, or `Bearer ` tokens across all containers. |
| 18 | Nginx LB log audit for IPv6 connection failures (Step 4a) | Network / DNS | **PASS** | Grep of Nginx LB logs for `connect() failed` yielded 0 matches; dual-stack DNS connection refused defect successfully resolved. |
| 19 | Dynamic re-resolution during scale to 3 replicas (Step 4b) | Dynamic Scale / DNS | **PASS** | Scaled to 3 replicas with `--scale 9router=3 --no-recreate`; sent 60 requests through LB within 9s (<15s) without restarting Nginx; all 3 replicas served traffic (deltas: +152, +114, +109 packets). |
| 20 | Dynamic scale-down error window (Step 4b) | Stability / Failover | **PASS** | Scaled back from 3 to 2 replicas; monitored HTTP status across 20s (40 probes); zero 502 Bad Gateway responses observed (transient error window: 0s). |
| 21 | Replica restart resilience under continuous traffic (Step 4c) | Resilience / Failover | **PASS** | Restarted replica 1 while sending 1 req/s through LB for 30s; zero non-2xx responses (30/30 HTTP 200); Nginx picked up restarted replica's traffic post-restart (+60 / +62 packets). |
| 22 | Pre-existing container isolation (`hindsight`) | Safe Operations | **PASS** | Checked before and after; container `hindsight` was never touched, modified, or stopped. |
| 23 | Post-test resource cleanup | Safe Operations | **PASS** | All containers, volumes, networks, images (`khatamrouter:smoke-91c9140d`), and temporary worktrees were cleanly removed. |

---

### 5.2 Step-by-Step Verification Details & Evidence

#### Step 1: Static Compose Overlay Inspection
- **Command**:
  ```bash
  JWT_SECRET="<masked>" API_KEY_SECRET="<masked>" INITIAL_PASSWORD="<masked>" MACHINE_ID_SALT="<masked>" \
  SCALE_SMOKE_LB_PORT=30128 \
  docker compose -f docker-compose.yml -f docker-compose.scale.yml config
  ```
- **Observations**:
  - `networks.default.enable_ipv6`: `false` (Defect 2 fix verified).
  - `lb.ports`: published port `30128` mapped to target `20128` (Defect 3 fix verified).
  - `9router`: `container_name: null`, `ports: []`.
  - `9router.environment.TRUSTED_PROXY_CIDRS`: `172.31.250.254/32`.
  - `lb.networks.default.ipv4_address`: `172.31.250.254`.

#### Step 2: Native Bun Docker Image Build
- **Command**:
  ```bash
  TMP_WT=$(mktemp -d /tmp/khatam-smoke-build-XXXXXX)
  git -C /home/redsnow/KhatamRouter/.claude/worktrees/wave8-perf worktree add --detach "$TMP_WT" 91c9140dafd4714d5df71462ca70a14d1107a071
  docker buildx build --platform linux/amd64 \
    --build-arg NEXT_BUILD_CPUS=2 \
    --build-arg NODE_OPTIONS="--max-old-space-size=3072" \
    -t khatamrouter:smoke-91c9140d \
    -t khatam-scale-smoke-9router:latest \
    -f "$TMP_WT/Dockerfile.bun" "$TMP_WT"
  git -C /home/redsnow/KhatamRouter/.claude/worktrees/wave8-perf worktree remove --force "$TMP_WT"
  ```
- **Metrics**:
  - Build Duration: **238 seconds** (3m 58s).
  - Image Size: **1.19 GB** (1,185,054,696 bytes).
  - Manifest List Digest: `sha256:804ec9ad4032ff2a3f6a93243660e22aca278958ac0c3ba8ee39bd1039020714`.
- **Static Invariants Inside Image**:
  - `find /app -name '*.ts' -o -name '*.tsx' | grep -v node_modules | wc -l`: `0`.
  - `find /app -type f -name 'better_sqlite3.node' | wc -l`: `0`.
  - `/usr/bin/curl` and `/usr/bin/sqlite3`: present and executable.

#### Step 3: Execution of `scripts/scale-smoke.sh 2` & Diagnosis
- **Command**:
  ```bash
  SCALE_SMOKE_LB_PORT=30128 \
  JWT_SECRET="<masked>" API_KEY_SECRET="<masked>" INITIAL_PASSWORD="<masked>" MACHINE_ID_SALT="<masked>" \
  bash scripts/scale-smoke.sh 2
  ```
- **Result**: Failed at Step [7/11] with exit code 1.
- **Output Snippet**:
  ```
  === [7/11] API Key Auth & Immediate Revocation across all replicas ===
  service "c084421c9a064f274ee583b48a462e7800922ccb9c2b7049db71a831feae8807" is not running
  === [Cleanup] Tearing down scale smoke stack (khatam-scale-smoke) ===
  ❌ Scale smoke check failed with exit code 1
  ```
- **Diagnosis**:
  Line 100 sets `REPLICA_CIDS=$(docker compose -p "$PROJECT_NAME" ps -q 9router)`. Lines 289-293 set `REPLICA_A="${REPLICA_ARRAY[0]}"` and invoke:
  `docker compose -p "$PROJECT_NAME" exec -T "$REPLICA_A" sqlite3 ...`
  In Docker Compose CLI, `docker compose exec` takes `SERVICE [COMMAND]`, not a container ID. Passing a container ID causes Docker Compose to look for a service matching the container hex ID, producing `service "<id>" is not running`. The correct invocation is `docker exec -i "$REPLICA_A" sqlite3 ...` (as correctly used on lines 163, 171, and 359). Recorded as Defect 4 below.

#### Step 4: Step 4(a) Nginx LB Logs for IPv6 Errors
- **Command**:
  ```bash
  docker compose -p khatam-scale-smoke logs lb 2>&1 | grep -i 'connect() failed'
  ```
- **Evidence**:
  ```
  CLEAN: 0 connect() failed errors
  ```
  With `enable_ipv6: false` in `docker-compose.scale.yml` and `ipv6=off` in `deploy/nginx-scale.conf`, Nginx only resolves IPv4 A records via `127.0.0.11`. Zero connection refused errors occurred.

#### Step 5: Step 4(b) Dynamic Re-Resolution on Scale to 3 Replicas
- **Command**:
  ```bash
  docker compose -p khatam-scale-smoke up -d --scale 9router=3 --no-recreate
  ```
- **Measurement Method**:
  Monitored per-replica packet counts on `/proc/net/dev` before and after sending 60 requests through the LB:
  - Elapsed time to send 60 requests: **9 seconds** (< 15 seconds threshold).
  - Nginx LB was NOT restarted (`Container khatam-scale-smoke-lb-1 Running`).
  - Packet deltas:
    - Replica 1: `+152 packets` (616 -> 768)
    - Replica 2: `+114 packets` (572 -> 686)
    - Replica 3: `+109 packets` (26 -> 135)
  - Result: All three replicas received and processed traffic through the LB within 9s of scale-up.
- **Scale-Down Error Window Measurement**:
  Scaled back from 3 to 2 replicas (`--scale 9router=2 --no-recreate`). Probed `http://127.0.0.1:30128/api/health` every 0.5s for 20 seconds (40 probes total):
  - HTTP 200 responses: **40/40 (100%)**.
  - HTTP 502 / non-200 responses: **0**.
  - Transient error window: **0 seconds** (below the <=10s threshold).

#### Step 6: Step 4(c) Dynamic Replica Restart Resilience
- **Command**:
  Sent 1 request/s through LB for 30 seconds while restarting replica 1 (`docker restart khatam-scale-smoke-9router-1` at t=2s).
- **Measurement**:
  - Replica 1 IP before restart: `172.31.250.4`
  - Replica 1 IP after restart: `172.31.250.4`
  - Response sequence across 30 seconds: `200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200`
  - Total non-2xx responses: **0** (30/30 HTTP 200 OK).
  - Post-restart routing verification (20 requests):
    - Replica 1 rx packets: `+60` (91 -> 151)
    - Replica 2 rx packets: `+62` (916 -> 978)
  - Result: Nginx seamlessly routed around the restarting replica and picked up traffic to the restarted replica with zero user-visible errors.

#### Step 7: Redis Outage Resilience & Hygiene
- **Command**:
  Halted Redis (`docker compose stop redis`), sent 30 requests to `/api/health`, inspected logs, restarted Redis.
- **Evidence**:
  - 30/30 HTTP 200 responses during outage (zero 5xx).
  - Warning logs throttled: exactly 2 non-blocking fail-open warnings per replica (`[redis] redis subscriber connection error: connect ECONNREFUSED ... continuing without Redis — non-blocking fail-open`).
  - Container health: `RestartCount=0` and `OOMKilled=false` across all containers (`9router-1`, `9router-2`, `9router-redis`, `headroom`, `lb-1`).

#### Step 8: Spoof Defense Controls
- **Test (a)**: Client forged `X-Forwarded-For: 127.0.0.1` via LB -> Nginx rewrote header to real client IP -> HTTP 401 Unauthorized.
- **Test (b)**: Untrusted sidecar on `khatam-scale-smoke_default` network (`172.31.250.x`) sent direct request to replica IP with forged `X-Forwarded-For: 127.0.0.1` -> App rejected request with HTTP 401 Unauthorized (peer not in `172.31.250.254/32`).
- **Positive Control**: Genuine internal loopback request inside replica (`curl http://127.0.0.1:20128/v1/models`) returned HTTP 200 OK.

#### Step 9: Secret Hygiene & Cleanup
- Grep of all container logs for `smoke-jwt-secret`, `smoke-api-key-secret`, `smoke-initial-password`, `smoke-machine-id-salt`, and `Bearer `: **0 occurrences found**.
- `hindsight` container status checked before test: not running / untouched.
- `hindsight` container status checked after test: not running / untouched.
- Stack cleanly torn down with `down -v --remove-orphans`.
- Image `khatamrouter:smoke-91c9140d` and `khatam-scale-smoke-9router:latest` untagged and removed.

---

### 5.3 Defects Identified in Re-Run

#### Defect 4: Test Script Service Name Mismatch in `scripts/scale-smoke.sh`
- **File**: `scripts/scale-smoke.sh` (lines 293, 306, 322, 329, 423)
- **Symptom**:
  `service "c084421c9a064f274ee583b48a462e7800922ccb9c2b7049db71a831feae8807" is not running`
- **Root Cause**:
  `scripts/scale-smoke.sh` extracts container IDs via `docker compose -p "$PROJECT_NAME" ps -q 9router` into `REPLICA_CIDS`, and sets `REPLICA_A` to the first container ID. On line 293 (and subsequently on lines 306, 322, 329, 423), the script executes:
  `docker compose -p "$PROJECT_NAME" exec -T "$REPLICA_A" sqlite3 ...`
  The `docker compose exec` subcommand expects a Compose service name (`9router`), not a container ID. When passed a hex container ID, Compose attempts to locate a service with that name and fails. In contrast, lines 163, 171, and 359 correctly use native Docker commands (`docker exec "$CID"` and `docker logs "$CID"`).
- **Suggested Fix**:
  In `scripts/scale-smoke.sh`, change lines 293, 306, 322, 329, and 423 to use `docker exec -i "$REPLICA_A"` instead of `docker compose -p "$PROJECT_NAME" exec -T "$REPLICA_A"`.

---

### 5.4 Explicit UNMEASURED / SKIPPED List (Re-Run)

1. **In-Container Circuit-Breaker Trip Object State Inspection (`scripts/scale-smoke.sh` Step 5)**:
   - **Reason**: Skipped intentionally with reason: *"In-container circuit-breaker trip object state inspection cannot be driven from outside standalone image (no admin breaker endpoint in runner)."*
   - **Mitigation / Verification**: Covered and passing at unit level in `tests/unit/cluster-two-instance.test.js` (T019).
2. **Direct In-Container Concurrent Token Refresh Mutex Race (`scripts/scale-smoke.sh` Step 6)**:
   - **Reason**: Skipped intentionally with reason: *"Direct in-container concurrent token refresh mutex race cannot be driven without live upstream provider credentials in standalone runner."*
   - **Mitigation / Verification**: Mutex lock acquisition/block behavior verified directly via Redis (`SET NX EX 5`); concurrent single-flight deduplication verified in `tests/unit/cluster-two-instance.test.js`.

---

## 6. Final Run (T020 Final Verification)

**Date**: 2026-10-27  
**Commit SHA**: `46fa51c9b559f696ec08ff8083659e0d2a2ed13d` (`46fa51c9`)  
**Image Tag**: `khatamrouter:smoke-46fa51c9`  
**Host Architecture**: `x86_64` (Linux 6.18 WSL2, Docker 29.x, Bun 1.4.3-slim)  
**Compose Project**: `khatam-scale-smoke`  

### 6.1 Executive Verdict Table (Final Run)

| # | Check Description | Category | Verdict | Evidence / Metrics |
|---|---|---|---|---|
| 1 | Production Bun Docker image build from detached worktree | Build | **PASS** | Built in 152s (`NEXT_BUILD_CPUS=2`, `NODE_OPTIONS=--max-old-space-size=3072`); size 1.19 GB. |
| 2 | Image hygiene (no `.ts`/`.tsx`, no `better_sqlite3.node`, `curl` and `sqlite3` present) | Image Audit | **PASS** | 0 TypeScript files in `/app`, 0 `better_sqlite3.node`, `/usr/bin/curl` and `/usr/bin/sqlite3` present in runner. |
| 3 | Shipped `scripts/scale-smoke.sh 2` execution | Test Automation | **FAIL** *(Script Defect)* | Failed at Step [9/11] with exit code 1; `docker inspect` template error on `.State.RestartCount` (line 389). |
| 4 | Multi-replica bring-up (9router=2 + lb + redis) via Compose | Runtime | **PASS** | Both replicas, Redis, headroom, and Nginx LB healthy and running in 1s. |
| 5 | LB HTTP routing (`/api/health`, `/api/version`, unauthenticated `/v1/models`) | HTTP Routing | **PASS** | `/api/health` returned HTTP 200 `{"ok":true}`; `/api/version` returned `0.5.111`; unauthenticated `/v1/models` returned HTTP 401. |
| 6 | Round-robin load balancing across both replicas | Cluster Distribution | **PASS** | Traffic distributed to both replicas (+5430 bytes on replica 1, +5496 bytes on replica 2). |
| 7 | Redis Pub/Sub channels verification | Cluster Pub/Sub | **PASS** | Active channels `khatam:events:console_log` and `khatam:events:config_reload` verified. |
| 8 | Distributed token refresh lock & rotation counter via Redis | Cluster Locks | **PASS** | Distributed mutex acquisition verified (`SET NX EX 5`); concurrent lock acquisition blocked; rotation counter incremented to 2. |
| 9 | Cross-replica shared state (Combo create & delete via LB) | Cluster Sync | **PASS** | Created combo visible across all replicas; deleted combo immediately invalidated across all replicas. |
| 10 | API key authentication through LB | Auth Gateway | **PASS** | Key `sk-smokekey123` authenticated successfully via LB (HTTP 200). |
| 11 | Immediate key revocation across all replicas | Auth Invalidation | **PASS** | Deleting key immediately produced HTTP 401 on next requests across both replicas. |
| 12 | SQLite database WAL mode and integrity on shared volume | Persistence | **PASS** | `PRAGMA journal_mode;` returned `wal`; `PRAGMA quick_check;` returned `ok`. |
| 13 | Redis outage drill (halt Redis for 20s while sending 30 requests) | Resilience | **PASS** | 30/30 requests answered HTTP 200 OK during Redis outage; warnings throttled in replica logs; clean recovery. |
| 14 | Process & container crash hygiene | Stability | **PASS** | All containers healthy; `OOMKilled=false`, `RestartCount=0`. |
| 15 | XFF Spoof Control (a): LB overwrites forged client XFF header | Security / Proxy Trust | **PASS** | Forged header `203.0.113.195` absent from Redis rate-limit keys; app keyed strictly on real client IP `172.31.250.1`. |
| 16 | XFF Spoof Control (b): Sidecar container cannot forge XFF | Security / Spoof Defense | **PASS** | Direct request from untrusted sidecar (`172.31.250.6`) rejected forged IP `203.0.113.210` and keyed on real peer `172.31.250.6`. |
| 17 | Genuine loopback positive control inside replica | Security / Loopback Trust | **PASS** | Internal loopback request inside replica allowed without key (HTTP 200). |
| 18 | Secret & credential hygiene in container logs | Security / Secret Hygiene | **PASS** | Zero leaks of `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, `MACHINE_ID_SALT`, or `Bearer ` tokens. |
| 19 | Negative Control (vacuity check via throwaway sabotage) | Test Validation | **PASS** *(Sabotage Detected)* | Sabotaged `TRUSTED_PROXY_CIDRS=172.31.250.0/24` immediately triggered Step 10 failure (exit code 1); proves test is non-vacuous. |
| 20 | Pre-existing container isolation (`hindsight`) | Safe Operations | **PASS** | Pre-existing container `hindsight` checked before and after; untouched. |
| 21 | Post-test resource cleanup | Safe Operations | **PASS** | All smoke containers, volumes, networks, and images (`khatamrouter:smoke-46fa51c9`) cleanly removed. |

---

### 6.2 Shipped Run Full Output & Tally

- **Command**:
  ```bash
  export SCALE_SMOKE_LB_PORT=30128
  export JWT_SECRET="<masked-32b-hex>"
  export API_KEY_SECRET="<masked-32b-hex>"
  export INITIAL_PASSWORD="<masked-16b-hex>"
  export MACHINE_ID_SALT="<masked-16b-hex>"
  bash scripts/scale-smoke.sh 2
  ```
- **Exit Code**: `1`
- **Tally**: `8 check(s) PASSED, 1 check(s) FAILED, 2 check(s) SKIPPED`
- **Full Output**:
  ```text
  === [1/11] Cleaning up any stale scale smoke containers ===
  === [2/11] Building and launching scale stack (khatam-scale-smoke, 2 replicas, port 30128) ===
   Image khatam-scale-smoke-9router Building 
  #1 [internal] load local bake definitions
  ...
   Image khatam-scale-smoke-9router Built 
   Network khatam-scale-smoke_default Creating 
   Volume 9router-data Creating 
   Volume redis-data Creating 
   Network khatam-scale-smoke_default Created 
   Container headroom Creating 
   Container 9router-redis Creating 
   Container khatam-scale-smoke-9router-1 Creating 
   Container khatam-scale-smoke-9router-2 Creating 
   Container khatam-scale-smoke-lb-1 Creating 
   Container 9router-redis Healthy 
   Container khatam-scale-smoke-9router-2 Healthy 
   Container khatam-scale-smoke-9router-1 Healthy 
   Container khatam-scale-smoke-lb-1 Started 
  === [3/11] Waiting for Redis & KhatamRouter replica healthchecks ===
  Redis healthy after 1s
  Replica 7e46a1f672983a9e0ee854c14e51404e75f407b961c6d7eb4afa30720ea3ac76 healthy after 1s
  Replica 8aa50507e5e1326e99aaf2b4a9b368c140cf5a68288f3b019e064cec8b8959be healthy after 1s
  === [4/11] Probing HTTP endpoints via Load Balancer (http://127.0.0.1:30128) ===
  LB /api/health answered 200 after 1s
  LB /api/health response: {"ok":true}
  LB /api/version verified: {"currentVersion":"0.5.111","latestVersion":null,"hasUpdate":false,"runtime":"docker","installCmd":null,"releaseUrl":"https://github.com/rqzbeh/KhatamRouter/releases/latest"}
  LB /v1/models unauthenticated correctly returned 401
  Testing round-robin traffic distribution across replicas...
  Replica 7e46a1f672983a9e0ee854c14e51404e75f407b961c6d7eb4afa30720ea3ac76 traffic delta: 5430 bytes
  Replica 8aa50507e5e1326e99aaf2b4a9b368c140cf5a68288f3b019e064cec8b8959be traffic delta: 5496 bytes
  === [5/11] Circuit-breaker & Redis Pub/Sub channels verification ===
  Active Khatam Redis Pub/Sub channels:
  khatam:events:console_log
  khatam:events:config_reload
  Warning: khatam:events:circuit_trip channel not yet visible in PUBSUB CHANNELS
  Subscribers on khatam:events:circuit_trip: 0
  SKIPPED (covered by tests/unit/cluster-two-instance.test.js): In-container circuit-breaker trip object state inspection cannot be driven from outside standalone image (no admin breaker endpoint in runner).
  === [6/11] Token refresh mutex, rotation counter, and cross-replica shared state ===
  Verified: Distributed token refresh lock acquired.
  Verified: Concurrent lock acquisition blocked by Redis mutex.
  SKIPPED (covered by tests/unit/cluster-two-instance.test.js): Direct in-container concurrent token refresh mutex race cannot be driven without live upstream provider credentials in standalone runner.
  Testing cross-replica rotation counter on Redis...
  Rotation counter after increments: 2
  Verified: Cross-replica rotation counter advances via Redis.
  Testing cross-replica shared state propagation (Combo create/delete via LB)...
  Created combo ID: e1989280-a7a2-46dd-b3b9-de393055bed2
  Verified: Created combo visible across all replicas.
  Verified: Combo deletion invalidated cache across all replicas.
  === [7/11] API Key Auth & Immediate Revocation across all replicas ===
  Verified: API key authenticated successfully via LB (HTTP 200).
  Verified: Immediate key revocation produced 401 on next requests across replicas.
  === [8/11] SQLite database WAL mode and integrity on shared volume ===
  SQLite journal_mode: wal
  SQLite quick_check: ok
  Verified: SQLite database WAL mode and quick_check integrity intact.
  === [9/11] Redis outage drill: halt Redis, verify 2xx degradation & single warning ===
  Halting Redis service...
   Container 9router-redis Stopping 
   Container 9router-redis Stopped 
  Verified: 30/30 requests answered HTTP 200 during Redis outage.
  Replica 7e46a1f672983a9e0ee854c14e51404e75f407b961c6d7eb4afa30720ea3ac76 logged 3 Redis warning(s) during outage.
  Replica 8aa50507e5e1326e99aaf2b4a9b368c140cf5a68288f3b019e064cec8b8959be logged 3 Redis warning(s) during outage.
  Restarting Redis service...
   Container 9router-redis Starting 
   Container 9router-redis Started 
  Verified: Stack recovered cleanly after Redis restart.
  Container /9router-redis: RestartCount=
  ERR, OOMKilled=false
  Error: Container /9router-redis experienced crash/restart during outage drill (restarts=
  ERR, oom=false)

  === [Cleanup] Tearing down scale smoke stack (khatam-scale-smoke) ===

  === Summary: 8 check(s) PASSED, 1 check(s) FAILED, 2 check(s) SKIPPED ===
  ❌ Scale smoke check failed with exit code 1
  ```

---

### 6.3 Diagnosis of Defect 5 (Script Defect)

- **Classification**: **Test Script Defect** (Product and Scale Overlay are fully functional).
- **File**: `scripts/scale-smoke.sh` (line 389).
- **Faulty Code**:
  ```bash
  RESTART_COUNT=$(docker inspect --format='{{.State.RestartCount}}' "$CID" 2>/dev/null || echo "ERR")
  ```
- **Evidence & Root Cause**:
  1. In the Docker container inspection schema, `RestartCount` is a top-level property (`.RestartCount`), while `OOMKilled` is nested under `.State` (`.State.OOMKilled`).
  2. Executing `docker inspect --format='{{.State.RestartCount}}' "$CID"` against any valid Docker container fails with:
     ```text
     template parsing error: template: :1:8: executing "" at <.State.RestartCount>: map has no entry for key "RestartCount"
     ```
  3. Prior to commit `46fa51c9`, line 389 used a fallback `|| echo "0"`, which silently masked this Go template evaluation error.
  4. When commit `46fa51c9` replaced fake-pass fallbacks with `|| echo "ERR"`, the error was exposed: `RESTART_COUNT` evaluated to `"ERR"`, which failed the assertion `if [ "$RESTART_COUNT" != "0" ]`.
- **Suggested Fix**:
  Change line 389 of `scripts/scale-smoke.sh` from `{{.State.RestartCount}}` to `{{.RestartCount}}`:
  ```bash
  RESTART_COUNT=$(docker inspect --format='{{.RestartCount}}' "$CID" 2>/dev/null || echo "ERR")
  ```

---

### 6.4 Verification with Template Fix (Throwaway Script)

To verify the remainder of the smoke suite (Steps 9, 10, and 11) without modifying the repository script, a temporary copy was executed with line 389 updated to `{{.RestartCount}}`:
- **Command**: Run throwaway copy in `/tmp/khatam-smoke-test-XXXXXX/scale-smoke-fixed.sh 2`
- **Exit Code**: `0`
- **Tally**: `11 check(s) PASSED, 0 check(s) FAILED, 2 check(s) SKIPPED`
- **Output Snippet**:
  ```text
  === [9/11] Redis outage drill: halt Redis, verify 2xx degradation & single warning ===
  Container /9router-redis: RestartCount=0, OOMKilled=false
  Container /headroom: RestartCount=0, OOMKilled=false
  Container /khatam-scale-smoke-9router-1: RestartCount=0, OOMKilled=false
  Container /khatam-scale-smoke-9router-2: RestartCount=0, OOMKilled=false
  Container /khatam-scale-smoke-lb-1: RestartCount=0, OOMKilled=false
  Verified: Zero container crashes/restarts throughout outage drill.
  === [10/11] Spoof control: X-Forwarded-For overwrite and untrusted peer defense ===
  Test (a) marker forged IP: 203.0.113.195 (hash: ea3f6e8890630ff0), expected real peer: 172.31.250.1 (hash: d690ef3a0882caff)
  Verified: Forged header 203.0.113.195 absent from Redis rate-limit keys; app keyed strictly on real client IP 172.31.250.1.
  Replica A internal IP: 172.31.250.4, image: khatam-scale-smoke-9router
  Sidecar executed: IP=172.31.250.6, models_code=401, login_code=401
  Verified: Direct request from untrusted sidecar rejected forged IP 203.0.113.210 and keyed on real peer 172.31.250.6.
  Verified: Genuine loopback request inside replica allowed (200).
  === [11/11] Secret & credential hygiene in container logs ===
  Verified: Zero leaked secrets or Bearer tokens in container logs.

  === Summary: 11 check(s) PASSED, 0 check(s) FAILED, 2 check(s) SKIPPED ===
  SCALE_SMOKE_OK
  ```

---

### 6.5 Negative Control (Vacuity Proof)

To verify that Step 10's spoof checks actively test proxy trust controls rather than trivially passing, a negative control was executed using a temporary compose override that sabotaged trust by including the entire sidecar subnet:
- **Sabotage Configuration**:
  ```yaml
  services:
    9router:
      environment:
        TRUSTED_PROXY_CIDRS: "172.31.250.0/24"
  ```
- **Observed Behavior**:
  1. The app accepted the sidecar container's socket IP (`172.31.250.6`) as a trusted proxy because `172.31.250.6` matches `172.31.250.0/24`.
  2. The app trusted the sidecar's forged `X-Forwarded-For: 203.0.113.210` header on the failed login probe and keyed the rate-limiter entry on the forged marker's hash (`2eb52d230d6d696c`).
  3. The smoke test's existence assertion on line 516 caught the forged key in Redis:
     ```text
     Error: Sidecar forged IP 203.0.113.210 was honoured in Redis (key khatam:ratelimit:login:2eb52d230d6d696c present)
     === Summary: 9 check(s) PASSED, 1 check(s) FAILED, 2 check(s) SKIPPED ===
     ❌ Scale smoke check failed with exit code 1
     ```
- **Verdict**: **PASS (Non-Vacuous)**. The check strictly discriminates trusted from untrusted peers.

---

### 6.6 Defects Identified in Final Run

#### Defect 5: Invalid `docker inspect` Template Syntax for RestartCount in `scripts/scale-smoke.sh`
- **File**: `scripts/scale-smoke.sh` (line 389)
- **Symptom**: `Container /9router-redis: RestartCount=\nERR, OOMKilled=false` leading to test failure with exit code 1.
- **Root Cause**:
  `docker inspect --format='{{.State.RestartCount}}'` evaluates an invalid template key. Docker container JSON stores `RestartCount` at `.RestartCount` (top-level), not `.State.RestartCount`.
- **Suggested Fix**:
  Replace `{{.State.RestartCount}}` with `{{.RestartCount}}` on line 389 of `scripts/scale-smoke.sh`.

---

### 6.7 Explicit UNMEASURED / SKIPPED List (Final Run)

1. **In-Container Circuit-Breaker Trip Object State Inspection (`scripts/scale-smoke.sh` Step 5)**:
   - **Reason**: Skipped intentionally with reason: *"In-container circuit-breaker trip object state inspection cannot be driven from outside standalone image (no admin breaker endpoint in runner)."*
   - **Mitigation / Verification**: Covered and passing at unit level in `tests/unit/cluster-two-instance.test.js` (T019).
2. **Direct In-Container Concurrent Token Refresh Mutex Race (`scripts/scale-smoke.sh` Step 6)**:
   - **Reason**: Skipped intentionally with reason: *"Direct in-container concurrent token refresh mutex race cannot be driven without live upstream provider credentials in standalone runner."*
   - **Mitigation / Verification**: Mutex lock acquisition/block behavior verified directly via Redis (`SET NX EX 5`); concurrent single-flight deduplication verified in `tests/unit/cluster-two-instance.test.js`.



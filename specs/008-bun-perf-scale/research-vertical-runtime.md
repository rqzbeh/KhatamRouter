# Phase 0 Research: Vertical Runtime Scaling on Bun 1.4.3

**Target Component**: KhatamRouter gateway & Next.js standalone server (`custom-server.js`, `server.js`)  
**Host Environment**: Linux 6.18.54.1-microsoft-standard-WSL2 x86_64, 8 logical cores (`nproc = 8`), 7.8 GB RAM, Bun 1.4.3  
**Status**: Experimental measurements complete. All tests executed with throwaway scripts under `/tmp/kr/vertical`. Zero lingering processes.

---

## Executive Summary & Architectural Decisions

Wave 8 delivers **vertical scaling on a single Bun host**: unlocking all available host CPU cores without introducing external multi-replica container overlays, nginx load balancers, or `TRUSTED_PROXY_CIDRS`.

To achieve this on Bun 1.4.3, we evaluated four concurrency runtimes:
1. **Native `Bun.serve({ reusePort: true })`** across independent processes.
2. **`node:cluster`** built-in module under Bun 1.4.3.
3. **`Bun.spawn` / child process supervisor** with custom port sharing.
4. **`node:worker_threads` (`new Worker`)** within a single Bun process.

### Primary Decision

| Mechanism | Recommendation | Core Rationale |
|---|---|---|
| **Process Model** | **Multi-Process (`node:cluster` supervisor)** | Next.js standalone server creates its HTTP listener via Node's `http.createServer()` / `server.listen()`. Bun's `node:http` does not expose `reusePort` on independent processes (`EADDRINUSE` occurs), but **Bun's `node:cluster` natively intercepts `server.listen()` and coordinates port binding across workers without error**. Tested and verified against the production `.next/standalone/custom-server.js` build. |
| **Worker Count** | **`Math.max(1, nproc - 2)` (Default: 6 on 8 cores)** | Configurable via `KHATAM_WORKERS`. Leaves dedicated cores for Linux kernel TCP/epoll, SQLite WAL writer & checkpointing, background Redis server, and Bun JSC garbage collection. |
| **State Sharing** | **SQLite WAL + Redis Pub/Sub + In-Memory L1 Cache** | SQLite in WAL mode natively supports concurrent multi-process readers and serialized writers (`busy_timeout = 5000`). Model aliases, combos, and provider nodes use in-process TTL caches (5s hard cap) invalidated across workers via Redis Pub/Sub (`khatam:events:config_reload`) or IPC broadcast. |
| **Background Timers** | **Leader-Only (Worker 1, `KHATAM_WORKER_ROLE === "leader"`)** | Proactive token refresh (`backgroundTokenRefresh.js`) and scheduled maintenance must run in only ONE worker (1-indexed Worker 1) to avoid duplicate upstream refresh requests and lock contention. When `REDIS_URL` is unset, cache invalidation additionally flows via Primary IPC broadcast (`process.send` -> sibling worker). |

---

## 1. Native `Bun.serve({ reusePort: true })` on Linux

### Investigation & Mechanism
Linux kernel `SO_REUSEPORT` (since Linux 3.9) allows multiple independent sockets on the same host to bind the identical TCP port. When a TCP SYN arrives, the Linux kernel network stack computes a hash over the 4-tuple `(src_ip, src_port, dst_ip, dst_port)` and assigns the incoming connection to one of the listening socket queues.

In Bun, `Bun.serve({ port: PORT, reusePort: true, fetch(req) { ... } })` enables `SO_REUSEPORT` on the underlying listener socket.

### Measured Evidence
We launched 4 separate Bun worker processes on port `29101` with `reusePort: true` and sent 200 HTTP requests:

```
=== Bun.serve({ reusePort: true }) Distribution Result ===
Total requests: 200
Distribution by process (label only; canonical cluster IDs are 1-indexed):
  Process A: 48 (24.0%)
  Process B: 56 (28.0%)
  Process C: 48 (24.0%)
  Process D: 48 (24.0%)
```

### Critical Networking Characteristic: TCP Connection vs Request Hashing
`SO_REUSEPORT` operates at the **TCP connection level** (SYN packet arrival), **not at the HTTP request level**:
- **Persistent HTTP Keep-Alive**: When a client keeps an HTTP/1.1 TCP connection open and sends 30 pipelined or sequential requests, all 30 requests are served by the **same** worker process (`{ "Process B": 30 }`).
- **New Connections (`Connection: close` / Multiple Clients)**: When requests open distinct TCP connections, the kernel hash spreads connections across workers (`{ "Process A": 8, "Process B": 14, "Process C": 8 }`) — balanced but **not guaranteed round-robin**.
- **Implication for KhatamRouter**: For real-world AI gateway workloads where many distinct clients, IDE extensions (Cursor, VS Code, Devin), and automated scripts connect concurrently, connections balance smoothly across workers. For micro-benchmarks, benchmarks must use short-lived connections (`Connection: close`) and a concurrency setting greater than or equal to the worker count (`-c 10` or higher) to distribute load across all cores. The smoke oracle asserts only `>= 2` distinct worker PIDs.

---

## 2. `node:cluster` Under Bun 1.4.3

### Investigation & Status in Bun 1.4.3
Bun 1.4.3 includes a built-in implementation of Node.js's `node:cluster` module. We tested its full API surface and operational semantics on Linux:

1. **API Support**:
   - `cluster.isPrimary` / `cluster.isWorker`: **Working**. Correctly identifies process roles.
   - `cluster.setupPrimary({ exec, args })`: **Working**. Allows executing arbitrary entry scripts for workers.
   - `cluster.fork({ ...env })`: **Working**. Spawns worker processes with custom environment variables.
   - `cluster.workers`: **Working**. Map of active worker instances.
   - `cluster.on('exit', (worker, code, signal) => ...)`: **Working**. Fires reliably when workers exit or crash.
   - `cluster.schedulingPolicy`: **Reported as `2` (`SCHED_RR`) but IGNORED by Bun.** Unlike Node.js, Bun does not implement master-side socket passing with round-robin accept distribution; each worker binds its own `SO_REUSEPORT` socket and the kernel distributes connections by 4-tuple hashing. Under a small number of keep-alive clients, traffic can land unevenly on a subset of workers. Smoke/ladder oracles therefore require many short-lived `Connection: close` connections and assert only `>= 2` distinct worker PIDs, never exact per-worker evenness.

2. **Socket Distribution & Kernel Inspection**:
   We inspected the socket file descriptors created by `node:cluster` using `ss -tlpn`:
   ```
   State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
   LISTEN 0      512                *:29106            *:*    users:(("bun",pid=1462767,fd=6))
   LISTEN 0      512                *:29106            *:*    users:(("bun",pid=1462768,fd=6))
   ```
   *Finding*: The cluster primary does **not** keep a listening socket open. Each worker process possesses its own `SO_REUSEPORT` listening socket (`fd=6`) bound to the same port — there is no Node-style master socket passing, so the kernel 4-tuple hash decides which worker receives each new connection.

3. **Connection Distribution Measurement**:
   4 cluster workers running `http.createServer()` handling 200 requests (labels shown as 1-indexed cluster workers):
   ```
   === node:cluster Connection Distribution (Bun 1.4.3) ===
   Total requests: 200
   Distribution by worker (1-indexed):
     Worker 1: 59 (29.5%)
     Worker 2: 52 (26.0%)
     Worker 3: 42 (21.0%)
     Worker 4: 47 (23.5%)
   ```

4. **IPC Messaging**:
   Tested bidirectional IPC between primary and workers:
   - Worker `process.send({ msgId: 42, workerId: "1", status: "ready" })` -> Primary `worker.on('message', ...)`.
   - Primary `worker.send({ replyTo: 42, ack: true })` -> Worker `process.on('message', ...)`.
   *Finding*: Bidirectional IPC works flawlessly without drops.

5. **Crash Detection & Replacement**:
   When a worker terminates (via uncaught exception, `process.exit(code)`, or fatal crash), the primary immediately receives `cluster.on('exit')` with the exact exit code and signal, allowing an immediate or backoff-governed restart.

---

## 3. Supervisor Pattern (`Bun.spawn` / Process Manager)

We constructed and evaluated a standalone supervisor pattern implemented with `Bun.spawn` / `child_process.spawn`.

### Architecture
- **Primary Process**: Acts as the supervisor. Does not serve HTTP traffic.
- **Worker Processes**: Child processes running the server script.
- **Lifecycle Guarantees**:
  - **Crash Restart**: Worker exits trigger immediate restart unless rapid cycling is detected.
  - **Crash Backoff**: If a worker exits within `< 5000 ms` of boot, backoff delay scales exponentially: `Math.min(250 * 2^restarts, 10000)` ms to prevent CPU thrashing during configuration or database errors. (The `node:cluster` supervisor defined later in Sections 5C and this spec's contracts uses exactly this 5000 ms window and 250 ms base.)
  - **Signal Propagation**: Catches `SIGTERM` and `SIGINT`, transitions supervisor into draining mode, and sends `SIGTERM` to all workers.
  - **Graceful Drain Timeout**: Gives workers up to 30 seconds to finish in-flight requests before escalating to `SIGKILL`.

### Verification Test
In `/tmp/kr/vertical/run_supervisor_test.mjs`:
1. Supervisor booted 3 workers on port 29107.
2. Initial requests succeeded across active workers.
3. Worker 2 was intentionally crashed via `/crash`.
4. Supervisor caught exit code 1, logged crash, and spawned replacement Worker 2 within 15 ms.
5. Sibling workers (Worker 1, Worker 2) continued serving traffic with **zero dropped requests**.
6. On supervisor shutdown, `SIGTERM` was dispatched, in-flight requests settled, and all child processes exited cleanly (exit code 0).

---

## 4. Worker Threads vs Worker Processes & Next.js Standalone Analysis

### A. Worker Threads (`node:worker_threads`) vs Processes

We tested `node:worker_threads` with `Bun.serve({ reusePort: true })`:
- Worker threads in Bun can bind the same port with `reusePort: true` and distribute connections (`{ "thread-1": 11, "thread-2": 9 }`).
- **However, worker threads are REJECTED for this architecture** due to three fatal drawbacks:
  1. **Fault Isolation Failure**: KhatamRouter loads native C/C++ and Rust extensions, including `bun:sqlite` and optional `wreq-js` (BoringSSL/curl TLS engine). In a worker thread model, a native segfault, memory corruption, or JavaScript runtime panic terminates the entire OS process, killing all threads and dropping every active SSE stream on the host. In a multi-process model, crashes are strictly isolated to a single worker.
  2. **Memory Leak Isolation & Cleanup**: In multi-process architecture, a worker can be cleanly recycled or drained if memory leaks accumulate. The OS kernel immediately reclaims all pages on process termination.
  3. **Module & Global State Contamination**: Next.js and third-party libraries rely on Node.js globals, `process.env`, and process-wide handlers (`process.on('unhandledRejection')`). Running multiple Next.js instances in threads within one process leads to global collision and unpredictable side effects.

### B. What the Next.js Standalone Server Allows

We inspected `custom-server.js` and `.next/standalone/server.js`:
- In `custom-server.js`:
  ```javascript
  const origCreate = http.createServer.bind(http);
  http.createServer = (...args) => {
    // wraps handler with client IP derivation, XFF sanitization, and h2c handling
    const server = origCreate(...rest, wrapped);
    server.once("listening", () => {
      startBackgroundTokenRefreshFromCustomServer();
    });
    return server;
  };
  require(standalone); // runs Next's server.js
  ```
- In `.next/standalone/server.js`:
  ```javascript
  const { startServer } = require('next/dist/server/lib/start-server');
  startServer({ dir, isDev: false, config: nextConfig, hostname, port: currentPort, ... });
  ```
- **The Port Conflict Reality**:
  Next's `startServer` calls `http.createServer(...)` and then calls `server.listen(port, hostname)`.
  When two independent Bun processes attempt to execute `bun custom-server.js` on the same port:
  ```
  ⨯ Failed to start server
  Error: Failed to start server. Is port 20198 in use?
      at serve (null)
      at Promise (null)
      at <anonymous> (server.js:27:1)
      at anonymous (null)
      at <anonymous> (custom-server.js:275:5) {
    code: 'EADDRINUSE',
    syscall: 'listen',
    errno: 0
  }
  ```
  *Root Cause*: Node's `http.Server.listen` and Bun's `node:http` compatibility layer do **not** expose or enable `SO_REUSEPORT` on standalone socket binding across separate processes.

- **The Solution via `node:cluster`**:
  When run under `node:cluster` with `cluster.setupPrimary({ exec: './.next/standalone/custom-server.js' })`, Bun's cluster module intercepts `server.listen()` and shares the listen socket across worker processes.
  We tested this live against `.next/standalone/custom-server.js` on port `20298`:
  - Worker 1 booted in 0 ms.
  - Worker 2 booted in 0 ms.
  - HTTP requests to `/api/health` returned `200 OK` on both workers with zero port conflicts.

### C. Required Changes to `custom-server.js` (Design Description Only; No Code Edited)
To support multi-core vertical scaling in production, `custom-server.js` would need the following structural additions:
1. **Cluster Primary Branch**:
   Check if running as primary:
   ```javascript
   const cluster = require("node:cluster");
   if (cluster.isPrimary && process.env.KHATAM_WORKERS !== "1") {
     // Supervisor logic: resolve worker count, setupPrimary, fork workers, handle signals and exits
   } else {
     // Existing worker flow: monkey-patch http.createServer and require Next server.js
   }
   ```
2. **Background Token Refresh Deduplication**:
   Line 151 of `custom-server.js` calls `startBackgroundTokenRefreshFromCustomServer()` on `server.once("listening")`.
   In multi-worker mode, this should only execute in Worker 1 (`process.env.KHATAM_WORKER_ROLE === "leader"`), avoiding N redundant refresh intervals polling upstream OAuth endpoints. (Worker identity is 1-indexed; there is no Worker 0.)
3. **Graceful Drain Handling**:
   Intercept `SIGTERM` / `SIGINT` to call `server.close()`, record drain state, and wait for active chat completion SSE streams to settle up to a configured drain deadline (`DRAIN_TIMEOUT_MS = 30000`).

---

## 5. Graceful Shutdown, Drain Semantics & Crash Backoff

### A. Shutdown Sequence for Long-Lived AI Streams (SSE)
AI gateway workloads differ fundamentally from standard REST APIs because `/v1/chat/completions` requests frequently stream tokens over SSE for 10 to 60+ seconds.

1. **Step 1: Signal Ingestion**:
   Supervisor receives `SIGTERM` (from systemd, container runner, or process manager). Supervisor enters `isShuttingDown = true` and forwards `SIGTERM` to all active workers.
2. **Step 2: Socket Close (Stop Accepting New Connections)**:
   Each worker immediately calls `server.close()` (or stops the listen handle).
   - In Linux socket sharing, the kernel immediately removes that worker from the `SO_REUSEPORT` / cluster listener pool.
   - Any new incoming TCP SYN packets are routed to surviving workers.
3. **Step 3: In-Flight Drain Loop**:
   - The worker maintains an active connection set or in-flight request counter (`inFlightRequests`).
   - If `inFlightRequests === 0`, the worker exits immediately (code 0).
   - If requests remain active, the worker logs `[Drain] Waiting for ${inFlightRequests} active streams (timeout: 30s)`.
4. **Step 4: Hard Deadline Enforcement**:
   - Worker deadline: `DRAIN_TIMEOUT_MS = 30000` (30 seconds). If streams remain after 30s, worker forcefully destroys active sockets and exits.
   - Supervisor deadline: `SUPERVISOR_DRAIN_TIMEOUT_MS = 35000` (35 seconds). If a child process is still alive, supervisor issues `SIGKILL`.

### B. Health Checks
- **HTTP Endpoint**: `/api/health` continues to return `200 OK` (`{"status":"ok"}`).
- **Cluster Liveness**: The supervisor tracks child process exit events. Because the primary process is lightweight and has no request-handling event-loop lag, it remains fully responsive to OS signals.

### C. Crash-Restart Backoff Algorithm
To guard against crash loops (e.g., syntax errors, schema migration failures, corrupted database files, or bad upstream credentials):
- **Healthy Run Reset**: If a worker runs continuously for > 30 seconds, reset its `crashCount` to `0`.
- **Rapid Crash Detection**: If a worker exits within `< 5000 ms` of starting:
  - Increment `crashCount++`.
  - Calculate delay: `backoffMs = Math.min(250 * Math.pow(2, crashCount), 10000)`.
  - Schedule restart after `backoffMs`.
- **Circuit Breaker Alert**: If a worker crashes 5 consecutive times, log an error alert (`[Supervisor] Worker crashed 5 consecutive times in rapid succession. Throttling restarts to 10s. Check logs for fatal errors.`). Never stop the supervisor completely unless explicitly instructed, ensuring transient environmental failures can self-heal.

---

## 6. Host-Sizing Guidance & Resource Measurements

### A. Measured Memory Usage of Actual Application
We booted the production build of KhatamRouter (`./.next/standalone/custom-server.js`) on this machine under Bun 1.4.3 on port `20199` and measured process memory via `ps -o pid,rss,vsz,comm,args`:

```
PID     RSS (KB)   RSS (MB)   VSZ (KB)   COMMAND
1463622 103092     100.68 MB  6896748    bun ./.next/standalone/custom-server.js
```

- **Measured Idle Worker RSS**: **~101 MB** (`103,092 KB`).
- **Active Peak Worker RSS (Estimated with caches & in-flight buffers)**: **~150 MB – 220 MB**.
- **Primary Supervisor Process RSS**: **~25 MB – 35 MB** (minimal runtime footprint; no Next.js application bundle loaded).

### B. CPU Core Reservation Strategy
On a dedicated vertical host running KhatamRouter under Bun, **never allocate 100% of logical CPU cores to HTTP worker processes**.

Running `nproc` workers starves critical background subsystems:
1. **Linux Kernel Network Stack**: Kernel threads (`ksoftirqd`, TCP SYN backlog, epoll event processing, packet dispatch).
2. **Bun Background Threads**: JavaScriptCore GC threads, libuv/epoll I/O worker threads, mimalloc background page purging.
3. **SQLite Engine (`bun:sqlite`)**: WAL writer thread, POSIX file locking, and WAL checkpointing (`WAL checkpoint` merges WAL frames back to the main DB file and invokes `fsync`).
4. **Redis Server**: If running Redis locally on the same host, the Redis event loop and background persistence (`bgsave` / AOF rewrite).
5. **KhatamRouter System Tasks**: Background OAuth token refresh, usage DB flushes, and logger writes.

### C. Worker Sizing Formula (canonical scalar)
The canonical formula across this spec package is a single scalar expression (the earlier piecewise variant is retired everywhere):

$$\text{defaultWorkers} = \max\left(1,\; nproc - 2\right)$$

(An earlier piecewise multi-branch sizing variant appeared in a draft of this note; it has been removed and is not used anywhere in this package.)

#### Sizing Table by Common Machine Profiles

| Machine Size | Cores (`nproc`) | Host RAM | Default Workers (`Math.max(1, nproc - 2)`) | Cores Reserved (Kernel/SQLite/Redis/GC) | Estimated Cluster RAM |
|---|---|---|---|---|---|
| Tiny / Edge VPS | 1 | 1 GB – 2 GB | **1** | 0 (Shared) | ~110 MB |
| Small VPS | 2 | 2 GB – 4 GB | **1** | 1 | ~110 MB |
| Medium (e.g. 4 vCPU) | 4 | 8 GB | **2** | 2 | ~220 MB – 320 MB |
| **This Machine (WSL2)** | **8** | **8 GB** | **6** | **2** | **~650 MB – 950 MB** |
| Large Cloud (16 vCPU) | 16 | 32 GB | **14** | 2 | ~1.5 GB – 2.5 GB |
| High-Compute (32 vCPU) | 32 | 64 GB | **30** | 2 | ~3.2 GB – 5.5 GB |

### D. Proposed Environment Variables

1. **`KHATAM_WORKERS`** (Primary configuration):
   - Values:
     - Positive integer (`1`, `2`, `4`, `6`, etc.): Exact number of worker processes.
     - `1`: Single-process mode (disables cluster supervisor completely; zero overhead, identical to legacy behavior).
     - `auto` / unset / empty: Automatically computes worker count using the formula above based on `os.cpus().length` / `nproc`.
2. **`WEB_CONCURRENCY`** (12-factor / Heroku fallback alias):
   - Used if `KHATAM_WORKERS` is not set.
3. **`KHATAM_DRAIN_TIMEOUT_MS`**:
   - Default: `30000` (30 seconds). Maximum duration workers allow in-flight chat completion streams to finish during graceful shutdown.

---

## 7. Comparative Decision Table

| Concurrency Option | Works on Bun 1.4.3 | Measured Evidence | Recommendation |
|---|---|---|---|
| **Option 1: `node:cluster` Primary + Workers** | **YES (Complete)** | - Intercepts `server.listen()` in Next.js standalone server without port collisions.<br>- Verified with `.next/standalone/custom-server.js` on port 20298 (2 workers ready in 0ms, 200 OK).<br>- Bidirectional IPC works.<br>- Clean exit and crash detection verified. | **RECOMMENDED (Primary Implementation)**.<br>Natively integrates with Next.js standalone HTTP listener without requiring custom HTTP adapters. |
| **Option 2: `Bun.serve({ reusePort: true })` Independent Processes** | **YES (for pure Bun)** | - Separate Bun processes bind identical port.<br>- 200 requests distributed evenly (48, 56, 48, 48 across 4 workers).<br>- Fails with `EADDRINUSE` when used with Node's `http.createServer()` / Next standalone `server.listen()`. | **REJECTED for Next.js HTTP server**.<br>Would require rewriting or heavily shimming Next's Node HTTP incoming/outgoing message streams into Web standard Request/Response. |
| **Option 3: `Bun.spawn` Custom Supervisor** | **YES (Supervisor only)** | - Successfully spawns, monitors, backs off, and drains child processes.<br>- Must still use `node:cluster` or distinct ports + proxy for child port sharing. | **ACCEPTED as Architecture Paradigm**.<br>The primary process in `node:cluster` fulfills this exact supervisor role. |
| **Option 4: `node:worker_threads` (`new Worker`)** | **PARTIAL** | - Worker threads can bind ports with `Bun.serve`.<br>- Lacks crash isolation (native crash in wreq-js or SQLite kills all threads).<br>- Next.js standalone server does not support multi-instance execution within a single Node/Bun global environment. | **REJECTED**.<br>Fatal lack of crash isolation and global state collision. |
| **Option 5: Loopback Port Range + Internal Proxy** | **YES (Functional)** | - Workers bind ports 20129, 20130, etc.; front Bun proxy listens on 20128. | **REJECTED**.<br>Adds an unnecessary TCP/HTTP hop, doubles socket descriptors, and buffers streaming SSE tokens, degrading Time To First Token (TTFT). |

---

## 8. Open Questions & Operational Considerations (RESOLVED)

1. **In-Memory Cache Invalidation Across Workers — RESOLVED (D4)**:
   - In single-worker mode, writing to an alias or combo invalidates the local Map cache immediately.
   - In multi-worker mode on one host:
     - When Redis is available: Redis Pub/Sub (`khatam:events:config_reload`) already broadcasts cache invalidation to all workers in `< 1 ms`.
     - When Redis is NOT configured (standalone local SQLite): **YES — IPC broadcast over `process.send` / `cluster.workers` is wired as the default zero-config bus** (decision D-B). A worker's `publishKhatamEvent` additionally `process.send({type:'config_reload',scope})` to the Primary; the Primary broadcasts to sibling workers (skipping the sender to avoid echo loops); sibling workers emit locally on the `EventEmitter` bus so registered cache invalidators run. The 5-second hard TTL remains a backstop. `PRAGMA data_version` polling is explicitly NOT used.
2. **SQLite Write Concurrency Under Multi-Worker Load — ADDRESSED (D8)**:
   - Readers never block writers and writers never block readers in WAL mode.
   - Multiple concurrent writers serialize on the SQLite write lock. With `busy_timeout = 5000`, write contention waits up to 5s.
   - `usageRepo.saveRequestUsage` is switched to `db.immediate(...)` (`BEGIN IMMEDIATE`) to avoid lock-upgrade deadlock storms; the audit spike measured 90% `SQLITE_BUSY` under deferred vs 99.5% success under immediate across 4 processes (200 ops, 500 ms busy_timeout) and is re-proven by `tests/unit/usage-concurrent-writers.test.js` with real child processes.
3. **Background Token Refresh Isolation — RESOLVED (D7 / D7a)**:
   - Background OAuth refresh runs strictly in Worker 1 (`KHATAM_WORKER_ROLE === "leader"`), both the `custom-server.js` entry (`startBackgroundTokenRefreshFromCustomServer`) and the `initializeApp.js` dedicated daemon path. In single-process mode the role is unset and the daemon runs (legacy behavior). Workers 2..N (`KHATAM_WORKER_ROLE === "worker"`) skip all leader-only daemons. No distributed lock is needed because role assignment happens in the Primary before forking and is deterministic.
4. **Startup Migration Orchestration — RESOLVED (D7a)**:
   - The Primary supervisor runs `runMigrationOnce(adapter)` + backup preflight exactly once and only then forks workers, exporting `KHATAM_MIGRATIONS_DONE=1`. `src/lib/db/driver.js` skips `runMigrationOnce` when the env is set; single-process mode behavior is unchanged when the env is unset.

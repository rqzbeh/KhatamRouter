# Psiphon Rotating Proxy Pool

The `psiphon` proxy pool type manages local `psiphon-tunnel-core` (`ConsoleClient`) subprocesses to provide rotating egress tunnels. It selects lowest-latency countries, holds active tunnels while upstream traffic succeeds, and automatically rotates to a new IP address and egress country upon encountering rate limits or IP bans.

---

## What and Why

Free-tier providers such as OpenCode Free (`oc/*`, unauthenticated `noAuth`) track and flag egress IP addresses once cumulative requests or tokens exceed quota boundaries. This produces several failure modes:

- `429 FreeUsageLimitError` / `free_rate_limited`: Upstream quota exhausted with increasing cooldown delays.
- `403 FreeTierError`: Upstream has flagged the specific egress IP.
- Transport failures (`connect timeout`, `502 Bad Gateway`, `503 Service Unavailable`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `Proxy` errors).

Traditional static proxy pools cannot recover when an egress IP is burned. A `psiphon` proxy pool solves this by:

1. Starting local `ConsoleClient` instances lazily on first request.
2. Launching multiple candidate instances across candidate regions to find the lowest-latency route.
3. Holding the established tunnel stickily across requests to maintain stable connections.
4. Automatically rotating to a fresh country and verified new exit IP upon receiving burn signals or reaching usage thresholds.

---

## How It Works

### 1. Lazy Startup and Parallel Candidate Probing
When a request targets a provider connection bound to a `psiphon` pool, `psiphonManager.ensureTunnel()` activates the tunnel:
- Spawns `probeCandidates` (default 3, range 1 to 5) `ConsoleClient` child processes in parallel.
- Each candidate is assigned a distinct `EgressRegion` (selected from configured pool regions or auto-discovered available regions), an isolated ephemeral directory (`DataRootDirectory`), an ephemeral port (`LocalHttpProxyPort=0`), and disabled SOCKS (`DisableLocalSocksProxy=true`).
- Monitors each process's `stderr` stream for JSON notices until both `ListeningHttpProxyPort` and tunnel readiness (`ActiveTunnel` or `Tunnels.count >= 1`) are received.
- Probes latency for all ready candidates concurrently via `http://cp.cloudflare.com/generate_204` through their respective local HTTP proxies.
- Keeps the candidate with the lowest round-trip latency as the active tunnel.
- Immediately terminates all losing candidates (`SIGTERM`, escalating to `SIGKILL` after 1500ms) and deletes their temporary data directories.
- Queries `http://cp.cloudflare.com/cdn-cgi/trace` through the winning proxy to determine and cache the external exit IP.

### 2. Sticky Hold
While requests succeed and configured thresholds are not met, the active tunnel remains open and is reused for subsequent requests without introducing connection setup latency.

### 3. Transport Failure Classification and Automatic Recovery
The router inspects upstream responses with `shouldRotateOn()`. Rotation is triggered exclusively on authentic network and transport failures:
- HTTP `502` or `503` caused by transport/proxy connectivity failures (`connect timeout`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `Proxy`, `fetch connect timeout`).
- Unhandled network transport exceptions without an HTTP status.

**Truthful Quota Handling**:
- HTTP `429` (rate limits, `FreeUsageLimitError`) and HTTP `403` (`FreeTierError`, flagged IP) **do NOT** trigger automatic tunnel rotation or session churn. The router preserves the upstream response and its `Retry-After` header faithfully, preventing IP churn and retry storms.
- Client aborts (`AbortError`, disconnected requests) never trigger rotation or retries.

When a transport failure is detected during a request in `src/sse/handlers/chat.js`:
- The tunnel manager executes `rotate()`:
  - Awaits actual process exit (with `SIGTERM` escalating to `SIGKILL` after 1500ms) before deleting temporary working directories across all candidate failure and teardown paths.
  - Excludes the current region and the last 3 recently used regions (maintaining a 4-region history buffer) to ensure geographic rotation.
  - Launches fresh candidates with new isolated directories to clear BoltDB affinity cache.
  - Verifies that the new exit IP differs from the previous exit IP. If the provider assigns the identical exit IP, it retries up to 3 times with different candidate regions and directories. If identical exit IP persists after the final (3rd) attempt, the rotation fails closed and does not report false success.
  - Egress is only marked verified (`egressVerified: true`) when an external exit IP lookup successfully returns a valid IP.
- The request handler retries the original request against the rotated tunnel (up to a maximum of 2 rotations per request).

### 4. Proactive Threshold Rotation
Pools can optionally configure `maxRequestsPerIp` and `maxTokensPerIp`. Usage is recorded on each successful response via `recordUsage()`. When either threshold is exceeded, the next call to `ensureTunnel()` proactively triggers a rotation with reason `threshold`.

### 5. Concurrency Control and Crash-Loop Protection
- **Single-Flight Deduplication**: Concurrent callers awaiting tunnel establishment or rotation share a single in-flight Promise.
- **Generation Guard**: Each rotation increments a numeric `generation` counter. Concurrent requests failing simultaneously pass their `seenGeneration`; if the tunnel has already rotated to a higher generation, duplicate rotations are skipped.
- **Minimum Interval**: Non-crash rotations enforce a cooldown of `PSIPHON_MIN_ROTATE_INTERVAL_MS` (default 5000ms) to prevent rotation storms.
- **Unexpected Process Exit**: An exit listener on the active child detects crashes and triggers re-establishment with reason `process_exit`.
- **Crash-Loop Guard**: If 3 or more `process_exit` events occur within 30 seconds, auto-rotation halts, placing the pool into a `failed` state with a 503 error. Operators can reset the state via a manual rotate request. Non-fatal crashes back off exponentially (`min(500 * 2^n, 5000)` ms).
- **Graceful Shutdown**: Process termination listeners (`SIGTERM`, `SIGINT`, `exit`) invoke `stopAll()`, ensuring child processes and temporary files are terminated. Stale run directories from previous PID sessions are swept at startup.

---

## Fail-Closed Guarantees

Psiphon proxy pools enforce strict operational isolation to prevent accidental leakage of the server's direct IP address:

1. **Forced `strictProxy`**: All psiphon pool resolutions set `strictProxy: true` regardless of database configuration.
2. **Disabled Direct Replay**: The `replayFreeTierRejectionDirect` mechanism in `open-sse/utils/proxyFetch.js` is explicitly bypassed when a request uses a psiphon pool.
3. **No Direct Egress Fallback**: If the Psiphon tunnel cannot be established, times out, or crashes, the request fails with HTTP 503 `PsiphonUnavailableError`. The router will never attempt a direct egress connection to the upstream provider.

---

## Legal and Sidecar Architecture Boundary (GPL-3.0)

`psiphon-tunnel-core` is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

To maintain clean architectural boundaries:
- **Sidecar Execution**: `ConsoleClient` runs as an isolated external sidecar process. KhatamRouter communicates with it strictly over standard operating system IPC: reading JSON notices from `stderr` pipes and routing HTTP requests through an ephemeral loopback HTTP proxy listener (`lo` / `127.0.0.1`).
- **Binary Provisioning**: The official container builds download and place prebuilt `ConsoleClient` binaries from `freeb5d/regionhop` releases during Docker build (`/usr/local/bin/ConsoleClient`). For non-container environments, KhatamRouter automatically downloads the appropriate architecture binary (`amd64` / `arm64`) to `$DATA_DIR/bin/ConsoleClient` on first use if not present, or operators can supply their own via `PSIPHON_BIN`.
- **Zero-Config Default**: A standard public Psiphon deployment configuration is built-in. Operators can override it anytime by placing `client.config.json` in `$DATA_DIR/psiphon/` or pointing `PSIPHON_CONFIG_FILE` to a custom file.
- **Operator Responsibility**: Operators are responsible for their network traffic and compliance with Psiphon terms of service and relevant regulatory requirements.

---

## Building ConsoleClient

The operator can build the official `ConsoleClient` binary from source using Go:

```console
git clone https://github.com/Psiphon-Labs/psiphon-tunnel-core.git
cd psiphon-tunnel-core/ConsoleClient
CGO_ENABLED=0 go build -o ConsoleClient .
```

Move the compiled `ConsoleClient` binary to the KhatamRouter data directory:

```bash
mkdir -p ~/.9router/bin
mv ConsoleClient ~/.9router/bin/ConsoleClient
chmod 755 ~/.9router/bin/ConsoleClient
```

---

## Configuration File Format

Create a base client configuration file at `~/.9router/psiphon/client.config.json` (or point `PSIPHON_CONFIG_FILE` to its location).

> **Important**: Use placeholder values as shown below. Never commit real sponsor credentials or private keys.

```json
{
  "PropagationChannelId": "EXAMPLE_PROPAGATION_CHANNEL_ID",
  "SponsorId": "EXAMPLE_SPONSOR_ID",
  "RemoteServerListURLs": [
    "https://example.com/psiphon/server_list_compressed"
  ],
  "RemoteServerListSignaturePublicKey": "EXAMPLE_PUBLIC_KEY"
}
```

When spawning candidates, KhatamRouter reads this base configuration and writes an ephemeral, mode `0600` configuration file for each child process, injecting dynamic runtime parameters:
- `DataRootDirectory`: Isolated working directory under `$DATA_DIR/psiphon/run/`.
- `ListenInterface`: Bound strictly to `127.0.0.1`.
- `LocalHttpProxyPort`: Set to `0` (system assigns an ephemeral port).
- `DisableLocalSocksProxy`: Set to `true` (KhatamRouter uses HTTP proxying).
- `EmitDiagnosticNotices`: Set to `true` (enables structured JSON notices on `stderr`).
- `EgressRegion`: The assigned 2-letter ISO alpha-2 country code.

---

## Environment Variables

The psiphon subsystem reads the following environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PSIPHON_BIN` | `$DATA_DIR/bin/ConsoleClient` | Path to the executable `ConsoleClient` binary. |
| `PSIPHON_CONFIG_FILE` | `$DATA_DIR/psiphon/client.config.json` | Path to the base Psiphon configuration JSON file. |
| `PSIPHON_READY_TIMEOUT_MS` | `45000` | Maximum milliseconds to wait for a candidate process to establish and report ready. |
| `PSIPHON_PROBE_URL` | `http://cp.cloudflare.com/generate_204` | Endpoint used to test HTTP proxy connectivity and measure latency. |
| `PSIPHON_IP_URL` | `http://cp.cloudflare.com/cdn-cgi/trace` | Endpoint used to verify the external exit IP address. |
| `PSIPHON_MIN_ROTATE_INTERVAL_MS` | `5000` | Minimum milliseconds between non-crash rotations to prevent rotation storms. |
| `PSIPHON_CRASH_BACKOFF_MS` | *(exponential backoff)* | Overrides the default exponential backoff (`min(500 * 2^n, 5000)` ms) on process exit crash recovery. |
| `DATA_DIR` | `~/.9router` | Base data directory path used to resolve default binary, config, and runtime paths. |

### Test-Only Environment Variables
The following environment variables exist solely for the test harness and mock fixtures (`tests/fixtures/fake-psiphon.mjs`):
- `NODE_ENV`: When set to `test`, bypasses unreachable latency errors in unit suites.
- `FAKE_PSIPHON_CRASH`: Simulates an immediate process crash during startup.
- `FAKE_PSIPHON_NEVER_READY`: Prevents emission of readiness notices to test timeouts.
- `FAKE_PSIPHON_LATENCY_MAP`: Maps regions to artificial latency values for candidate ranking tests.
- `FAKE_PSIPHON_AVAILABLE_REGIONS`: Supplies custom region arrays in notice payloads.
- `FAKE_PSIPHON_STATIC_IP`: Returns a static IP to test retry loops when an exit IP fails to change.
- `FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE`: State file tracking consecutive identical-IP attempts across test processes.
- `FAKE_PSIPHON_READY_DELAY`: Introduces a delay before readiness notices are emitted.
- `FAKE_PSIPHON_IGNORE_SIGTERM`: Simulates stubborn processes to test `SIGKILL` escalation.
- `FAKE_PSIPHON_FLOOD_STDOUT`: Tests notice parser robustness against non-JSON stream pollution.
- `FAKE_PSIPHON_CRASH_AFTER_READY`: Simulates post-readiness unexpected exits.

---

## Docker Deployment

Because `ConsoleClient` is licensed under GPL-3.0, it is not bundled inside the prebuilt KhatamRouter container image (`ghcr.io/rqzbeh/khatamrouter:edge`). Mount the binary and configuration file from the host filesystem into the container:

```yaml
version: "3.8"

services:
  khatamrouter:
    image: ghcr.io/rqzbeh/khatamrouter:edge
    restart: unless-stopped
    ports:
      - "20128:20128"
    volumes:
      - ./data:/app/data
      - ./bin/ConsoleClient:/app/data/bin/ConsoleClient:ro
      - ./config/client.config.json:/app/data/psiphon/client.config.json:ro
    environment:
      - DATA_DIR=/app/data
      - PSIPHON_BIN=/app/data/bin/ConsoleClient
      - PSIPHON_CONFIG_FILE=/app/data/psiphon/client.config.json
```

Ensure the binary mounted into the container matches the container's architecture (Linux x86_64 or arm64).

---

## Using with OpenCode Free

1. **Create the Pool**: In the KhatamRouter dashboard, navigate to **Proxy Pools** (`/dashboard/proxy-pools`) and click **Add Pool**.
2. **Select Type**: Choose `psiphon` from the Type dropdown.
3. **Configure Options**:
   - **Regions**: Specify preferred 2-letter country codes (e.g., `["US", "CA", "NL", "DE"]`), or leave empty to allow any discovered country.
   - **Probe Candidates**: Number of parallel candidates to evaluate for best latency (default `3`, range `1` to `5`).
   - **Max Requests per IP**: Optional proactive rotation limit (set to `0` to disable).
   - **Max Tokens per IP**: Optional proactive token limit (set to `0` to disable).
4. **Bind Provider**: Navigate to **Providers** (`/dashboard/providers`), locate the OpenCode (`opencode`) connection, and select the newly created Psiphon pool in the **Proxy Pool** selector.
5. Requests through `oc/*` models now route through the tunnel and automatically rotate upon encountering rate limits.

---

## API Reference

All proxy pool endpoints require dashboard authentication.

### `POST /api/proxy-pools`
Creates a new proxy pool.
```json
{
  "name": "opencode-psiphon",
  "type": "psiphon",
  "proxyUrl": "psiphon://managed",
  "isActive": true,
  "psiphon": {
    "regions": ["US", "NL", "DE"],
    "probeCandidates": 3,
    "maxRequestsPerIp": 500,
    "maxTokensPerIp": 2000000
  }
}
```

### `PUT /api/proxy-pools/[id]`
Updates an existing pool's configuration. Deactivating a pool (`isActive: false`) automatically terminates any running tunnel.

### `GET /api/proxy-pools/[id]/status`
Returns runtime status for the active tunnel without exposing binary paths, internal tokens, or configuration secrets:
```json
{
  "status": {
    "state": "ready",
    "region": "NL",
    "generation": 4,
    "exitIp": "198.51.100.24",
    "requests": 142,
    "tokens": 420800,
    "lastError": null,
    "lastRotation": {
      "reason": "burn_429",
      "at": 1730235600000
    }
  }
}
```

### `POST /api/proxy-pools/[id]/rotate`
Manually triggers tunnel rotation to a new country and IP address. Resets crash-loop guards. Returns HTTP 400 if the target pool is not of type `psiphon`.

### `POST /api/proxy-pools/[id]/test`
Verifies tunnel operation. Ensures candidate startup, probes latency, checks exit IP, and updates the pool's health status in the database:
```json
{
  "ok": true,
  "status": 200,
  "elapsedMs": 145,
  "region": "NL",
  "latency": 145,
  "exitIp": "198.51.100.24",
  "testedAt": "2026-10-29T21:40:00.000Z"
}
```

---

## Cluster Worker Caveat

When running in multi-worker configurations (`KHATAM_WORKERS > 1`):
- Each cluster worker process supervises its own independent `ConsoleClient` subprocesses and local tunnel ports.
- Tunnel status, generation counts, and rotation state are held per worker in memory.
- Cross-worker coordination and tunnel sharing via Redis are deferred to future revisions.

---

## Limitations

- **CI Verification**: Continuous Integration tests run exclusively against a mock `ConsoleClient` implementation (`tests/fixtures/fake-psiphon.mjs`). Operation has not been tested against the live public Psiphon network in CI workflows.
- **Protocol Support**: SOCKS proxying is disabled (`DisableLocalSocksProxy=true`). Traffic is routed exclusively through local HTTP proxies using Undici `ProxyAgent`.
- **Sponsor Credentials**: Upstream acceptance of arbitrary or unauthenticated sponsor credentials cannot be verified or guaranteed by KhatamRouter. Operators must verify their configuration against live Psiphon infrastructure.

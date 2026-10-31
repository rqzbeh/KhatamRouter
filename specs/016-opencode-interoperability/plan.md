# Plan 016: OpenCode Interoperability & Transport Lifecycle

## 1. System Architecture & Boundaries

```
Client (/v1/chat/completions or /v1/messages)
  │
  ▼
src/sse/handlers/chat.js (Request parsing, credential resolution, quota pass-through)
  │
  ▼
open-sse/executors/opencode.js
  ├── open-sse/utils/opencodeFingerprint.js
  │     └─ Neutral constants (/home/user/project, /var/cache/opencode, "linux")
  │     └─ Bounded memoization (MAX_TRANSLATED_IDS = 5000, MEMORY_CONFIG.sessionTtlMs)
  │
  ├── Deadline & Abort Controller (FR-016-03)
  │     └─ Linked AbortSignal + FETCH_CONNECT_TIMEOUT_MS (60s header deadline)
  │     └─ Preserved streaming timeouts (STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS)
  │
  ▼
open-sse/services/opencodeTlsClient.js / proxyFetch.js
  │
  ├── In-process native transport (wreq-js C-ABI/Node-API binding or fetch fallback)
  ├── Strict Proxy Check: if strictProxy && proxy down => Fail 503 (No direct fallback)
  └── Custom TLS Trust: bounded local CA cert (Never NODE_TLS_REJECT_UNAUTHORIZED=0)
  │
  ▼
Proxy Egress (HTTP CONNECT tunnel) -> Upstream OpenCode Server
```

---

## 2. Upstream PR Scope Analysis & Architectural Decisions

### 2.1 Coordinated Dependency: Upstream #5310
- **Scope**: Native HTTP transport with proxy preservation, signal abort propagation, and fallback correctness.
- **Decision**: Developed on current branch `fix/proxy-redis-reliability`. Spec 016 establishes the interoperability and contract boundaries for OpenCode transport.
- **Coordination Seam**: `opencodeTlsFetch(url, init, { signal, timeoutMs, proxy, insecure })` and `opencodeAdapterFetch(url, options, config)`.

### 2.2 Privacy Hardening: Upstream #5222
- **Scope**: OpenCode session timestamps, CLI fingerprint, and conversation IDs.
- **Decision**: Accept core session format and stable timestamps; maintain strict divergence from upstream on host environment metadata.
- **Hardening Invariants**:
  - Replace upstream dynamic `process.cwd()` and `os.tmpdir()` inspection with static neutral constants (`/home/user/project`, `/var/cache/opencode`, `linux`).
  - Preserve existing memory bounds: `MAX_TRANSLATED_IDS = 5000` in `open-sse/executors/opencode.js` and `open-sse/executors/opencode-zen.js`, `MAX_SESSIONS = 1000` and `MAX_ASSISTANT_SESSIONS = 5000` in `open-sse/utils/sessionManager.js`, governed by `MEMORY_CONFIG.sessionTtlMs` (2h) and `MEMORY_CONFIG.sessionCleanupIntervalMs` (30m).

### 2.3 Constrained Resource Controls: Upstream #5297
- **Scope**: Generic request deadlines, timeout aborts, and worker resource cleanup.
- **Decision**: Adopt generic response-header deadlines (`FETCH_CONNECT_TIMEOUT_MS = 60000`) and caller cancellation (`signal`), while preserving streaming contracts (`STREAM_FIRST_CHUNK_TIMEOUT_MS = 200000`, `STREAM_STALL_TIMEOUT_MS = 360000`).
- **Rejection of Quota Evasion**: Strictly reject upstream logic that generates new session identifiers on HTTP 429 quota exhaustion. Preserve provider `Retry-After` headers; do not shorten or bypass upstream backoff requests.

### 2.4 Excluded / Deferred: Upstream #5298 (Daemon / MCP Host Bridge)
- **Scope**: Direct host command execution and local MCP tool bridging.
- **Decision**: **EXCLUDED FROM SPEC 016**.
- **Reasoning**: Unproven host execution isolation and permission approval are risks blocking adoption as-is. Deferred until safe future isolation and explicit operator authorization controls are established.

### 2.5 Excluded from Scope: Upstream #5328 (Tool Aliasing for Gate Evasion)
- **Scope**: Renaming client tools specifically to bypass upstream filters.
- **Decision**: **EXCLUDED FROM SCOPE**.
- **Reasoning**: Tool aliasing for client-gate evasion is outside the scope boundaries of this task. Standard tool parameter mapping and upstream schema compliance are maintained without introducing artificial client-spoofing evasion mechanisms.

---

## 3. Disjoint Task Sequence & Planned Ownership

Implementation is staged sequentially. Runtime files remain owned by active transport reliability workflows.

| Task ID | Phase | Summary | Gate | Planned File Ownership |
|---|---|---|---|---|
| **T1** | Spec & Gates | Author Spec-Kit package and Unlazy gates ledger | G1 | `specs/016-opencode-interoperability/**`, `.unlazy/016-opencode-interoperability/**` |
| **T2** | Parity & Privacy Audit | Verify bounded conversation IDs and neutral host path privacy | G2 | `tests/unit/opencode-fingerprint.test.js`, `tests/unit/opencode-session.test.js` |
| **T3** | Transport & Abort Integration | In-process wreq-js, loopback CONNECT proxy, local test CA, header deadline aborts | G3 | `tests/integration/opencode-transport-abort.mjs` |
| **T4** | Subprocess & Quota Lifecycle | Process cleanup under 1500ms escalation, strict 429 Retry-After preservation | G4 | `tests/unit/opencode-subprocess-cleanup.test.js`, `tests/unit/opencode-quota-compliance.test.js` |
| **T5** | Documentation & Parity Ledger | Parity documentation, security notes, CHANGELOG and ROADMAP | G5 | `docs/UPSTREAM-PORTS.md`, `ROADMAP.md`, `CHANGELOG.md` |

---

## 4. Threat Model & Security Invariants

| Threat | Vulnerability Vector | Defense / Security Invariant |
|---|---|---|
| **Host Reconnaissance** | Upstream #5222 reads `process.cwd()` and `os.tmpdir()` into `<env>` markers. | **Neutral Constants**: Use static paths (`/home/user/project`, `/var/cache/opencode`, `linux`). Forbid `process.cwd()`, `os.userInfo()`, and `os.tmpdir()` in request construction (FR-016-02). |
| **Uncontrolled Host Execution** | Upstream #5298 provides model-directed host command execution. | **Scope Exclusion**: Unproven host execution isolation and permission approval are risks blocking adoption as-is. Excluded from this task (FR-016-08). |
| **Direct Egress Leak** | Proxy tunnel fails; request silently falls back to direct origin IP. | **Strict Proxy Enforcement**: When `strictProxy` is set, proxy failure yields HTTP 503; direct fallback is disabled (FR-016-04). |
| **Insecure TLS Bypasses** | Tests or runtime disable TLS validation to bypass self-signed proxy certificates. | **Bounded Local Test CA**: All test certificates are signed by a temporary in-memory test CA passed to `ca` options. `NODE_TLS_REJECT_UNAUTHORIZED=0` is forbidden (FR-016-05). |
| **Memory Exhaustion DoS** | High volume of distinct session IDs causes unbounded Map growth. | **Bounded Session Stores**: Enforce `MAX_TRANSLATED_IDS = 5000` and `MEMORY_CONFIG.sessionTtlMs = 7200000` with periodic cleanup (FR-016-01). |
| **Sidecar Process Leaks** | Child sidecars fail to terminate on parent exit or request abort. | **Bounded Process Lifecycle**: Explicit PID tracking with 1500ms fallback escalation before SIGKILL (FR-016-07). |

---

## 5. Real Testing Contracts

To eliminate mock-acceptance anti-patterns, tests must conform to real runtime contracts:
1. **Zero Global TLS Bypasses**: Integration tests must never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. Local test servers use ephemeral test CAs.
2. **In-Process Native Execution**: `wreq-js` operates as an in-process native binding under Bun (matching repo `.bun-version` 1.4.4); child process tests apply strictly to external sidecars.
3. **Tested Sidecar Escalation**: External subprocess tests verify termination within the bounded 1500ms escalation window (`terminateProcess`).
4. **Streaming Integrity**: Response-header timeouts (`FETCH_CONNECT_TIMEOUT_MS`) must not abort active SSE streaming bodies once tokens are flowing.

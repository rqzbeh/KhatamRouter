# Spec 016: OpenCode Interoperability & Transport Lifecycle

**Feature Branch**: `fix/proxy-redis-reliability` (proposed future dedicated branch: `spec/016-opencode-interoperability`)  
**Status**: Specification & Upstream Audit (Coordinated with active transport reliability stabilization)  
**Classification**: Provider interoperability, transport lifecycle, host privacy, and resource bounds (additive, Bun-native)  

---

## 1. Problem Statement & Upstream Scope Audit

KhatamRouter integrates OpenCode Free and Zen provider lanes (`open-sse/executors/opencode.js`, `open-sse/services/opencodeTlsClient.js`) to support standard OpenAI-compatible and Claude-compatible routing. Upstream (`decolua/9router`) proposed five PRs touching OpenCode, proxy networking, and runtime controls: `#5297`, `#5310`, `#5222`, `#5298`, and `#5328`.

Rather than uncritical adoption, KhatamRouter evaluates each proposal against Bun runtime contracts, host privacy, resource bounds, and routing reliability.

### 1.1 Upstream PR Evaluation & Parity Ledger

| Upstream PR | Title / Area | Status in KhatamRouter | Selection / Scope Boundary |
|---|---|---|---|
| **#5310** | Proxy-preserving native HTTP transport / abort / fallback | **Coordinated Prerequisite** | Handled on current branch (`fix/proxy-redis-reliability`). Coordinates native transport contracts, proxy preservation, and in-process abort signal propagation; **no duplicate implementation**. |
| **#5222** | OpenCode session timestamps, CLI fingerprint & conversation IDs | **Scoped Audit & Privacy Hardening** | Core CLI fingerprint and session timestamps ported in commit `8aae44bc`. Preserves existing memory bounds (`MAX_TRANSLATED_IDS = 5000`, `MEMORY_CONFIG.sessionTtlMs = 7200000`) and neutral host-path privacy (`/home/user/project`, `/var/cache/opencode`, `linux`). Rejects upstream `process.cwd()` / `os.tmpdir()` leaks. |
| **#5297** | Generic per-request deadline, abort & worker-resource controls | **Selectively Scoped (Generic only)** | Adopts standard response-header arrival deadline (`FETCH_CONNECT_TIMEOUT_MS = 60000`), fail-safe `AbortSignal` propagation, and preserves streaming/stall contracts (`STREAM_FIRST_CHUNK_TIMEOUT_MS = 200000`, `STREAM_STALL_TIMEOUT_MS = 360000`). **Strictly rejects**: generating fresh identities on quota (429) refusals, and clamping or ignoring upstream `Retry-After`. |
| **#5298** | Daemon / MCP bridge host tool execution | **Excluded / Deferred** | Unproven host execution isolation and permission approval are risks blocking adoption as-is. Deferred until safe future isolation and an explicit operator authorization boundary are established. |
| **#5328** | Tool aliasing for terminal substring gate | **Adapted with Hardening** | Ported `GATED_TOOL_NAME_RE = /terminal/i` and bidirectional aliasing to `run_command` in `open-sse/utils/opencodeFingerprint.js`, hardened to support Claude `/messages` tool_use history blocks. |

> **Scope Declaration**: KhatamRouter does NOT claim blanket 5-of-5 upstream parity. Upstream PR #5328 is excluded from the scope of this task, PR #5298 is deferred due to unproven host execution isolation and permission approval risks, PR #5310 is coordinated with transport reliability on `fix/proxy-redis-reliability`, PR #5222 is audited for privacy and existing memory bounds, and PR #5297 is constrained to standard generic resource controls.

---

## 2. User Stories

### US1: Standard API Translation & Upstream Schema Compliance (P1)
As an API client using `/v1/chat/completions` or `/v1/messages`, I want my tool calls and message parameters accurately translated to OpenCode backend formats while honoring upstream schema requirements without broken structures.

### US2: Host Privacy & Bounded Conversation Identifiers (P1)
As an operator running KhatamRouter, I want OpenCode session identifiers to remain stable and bounded within existing runtime memory limits (`MAX_TRANSLATED_IDS = 5000`, `MEMORY_CONFIG.sessionTtlMs`), while outgoing metadata never discloses local host paths, OS usernames, or temporary directory structures.

### US3: Proxy-Preserving Transport with Validated TLS (P1)
As an operator routing OpenCode traffic through managed HTTP proxies (including Psiphon pools), I want `wreq-js` native in-process transport to fail closed when a proxy is down, cancel cleanly when the client aborts, and validate TLS certificates without global TLS verification bypass (`NODE_TLS_REJECT_UNAUTHORIZED=0`).

### US4: Bounded Response Deadlines & Lifecycle Teardown (P1)
As an operator under high traffic, I want hanging upstream requests to terminate cleanly if response headers stall past `FETCH_CONNECT_TIMEOUT_MS`, in-flight requests to cancel on client abort without cutting valid long SSE streams, and external sidecar processes to terminate cleanly under tested bounded escalation timeouts.

### US5: Truthful Quota Accounting & Backoff Compliance (P1)
As an operator, I want upstream 429 quota rejections and `Retry-After` headers to be preserved and surfaced truthfully to clients, preventing wasteful request cycling or aggressive retry storms.

---

## 3. Functional Requirements

### FR-016-01: Bounded Conversation State & Runtime TTL
Conversation identifier tracking (`open-sse/utils/sessionManager.js`, `open-sse/executors/opencode.js`, `open-sse/executors/opencode-zen.js`) MUST preserve existing runtime contracts:
- `MAX_TRANSLATED_IDS = 5000` per ID store (`session` and `request`) in `open-sse/executors/opencode.js` and `open-sse/executors/opencode-zen.js`.
- `MAX_SESSIONS = 1000` for connection derivation in `open-sse/utils/sessionManager.js`.
- `MAX_ASSISTANT_SESSIONS = 5000` and `MAX_CONTINUATION_SESSIONS = 5000` in `open-sse/utils/sessionManager.js`.
- Stale entries MUST expire using `MEMORY_CONFIG.sessionTtlMs` (7,200,000ms / 2h) evaluated at `MEMORY_CONFIG.sessionCleanupIntervalMs` (1,800,000ms / 30m) from `open-sse/config/runtimeConfig.js`.

### FR-016-02: Strict Host Metadata Neutralization
Outgoing OpenCode fingerprint payloads (`<env>` markers and metadata blocks in `open-sse/utils/opencodeFingerprint.js`) MUST use static, neutral constants (`path: "/home/user/project"`, `tmp: "/var/cache/opencode"`, `platform: "linux"`). Dynamic host introspection (`process.cwd()`, `os.homedir()`, `os.tmpdir()`, `os.userInfo()`) MUST NOT be called in request translation paths.

### FR-016-03: Proxy Transport Abort Signal & Bounded Header Deadlines
Native HTTP requests dispatched through `opencodeTlsClient.js` / `wreq-js` MUST link caller `AbortSignal` to cancel underlying in-process requests and active streams immediately. Transport MUST enforce response-header arrival deadlines using existing runtime configuration (`FETCH_CONNECT_TIMEOUT_MS = 60000`). It MUST NOT impose arbitrary total timeouts that terminate valid long-running SSE response streams. Inter-chunk and prompt-prefill timeouts MUST preserve existing streaming contracts (`STREAM_FIRST_CHUNK_TIMEOUT_MS = 200000`, `STREAM_STALL_TIMEOUT_MS = 360000`). Native `wreq-js` calls execute in-process; no subprocess is spawned for native HTTP fetching.

### FR-016-04: Fail-Closed Transport Enforcement
When `strictProxy: true` is configured for an OpenCode connection, requests MUST NOT fall back to direct host egress on proxy failure. If proxy CONNECT negotiation fails, the executor MUST return HTTP 503 `PROXY_UNAVAILABLE` without invoking direct `fetch()`.

### FR-016-05: Local Test CA Root for Integration Verification
Integration tests for TLS and proxy CONNECT MUST establish bounded trust using ephemeral, dedicated test CA certificates passed directly to the client runtime. Setting `NODE_TLS_REJECT_UNAUTHORIZED=0` or disabling SSL certificate verification globally is strictly prohibited.

### FR-016-06: Respect for Quota & Retry-After Semantics
Upstream HTTP 429 responses MUST NOT trigger automatic session identifier rotation or credential cycling. Provider `Retry-After` header values MUST be preserved and forwarded in downstream error responses without clamping or artificial shortening.

### FR-016-07: Subprocess Resource Teardown for External Sidecars
Any external background child process spawned for sidecar operations (e.g. Psiphon tunnels in `src/lib/network/psiphon/psiphonManager.js`) MUST register termination handlers (`exit`, `SIGINT`, `SIGTERM`) and terminate cleanly using tested bounded timeouts aligned with the existing 1500ms escalation policy (`terminateProcess` with 1500ms fallback before SIGKILL).

### FR-016-08: Exclusion of Unisolated Host Bridge (#5298)
The daemon/MCP host bridge proposed in upstream #5298 is excluded from this task. Unproven host execution isolation and permission approval are risks blocking adoption as-is. No model-originated host commands may execute on the gateway host without safe future isolation (such as OS sandboxing or containerization) and an explicit operator authorization boundary.

### FR-016-09: Bidirectional Gated Tool Aliasing (#5328)
Tools declaring names matching `/terminal/i` (such as `terminal` in Claude Code, Cursor, or Cline) are aliased to `run_command` in `open-sse/utils/opencodeFingerprint.js` to satisfy upstream textual gate constraints. The transformation MUST be bidirectional: `tool_choice`, history turns (including Claude `/messages` tool_use blocks), and streaming responses MUST restore the caller's original tool name. Caller tool definitions and arguments MUST be preserved untouched.

### FR-016-10: Native Bun Compatibility
All transport, session management, and executor routines MUST run directly on Bun per the repo's authoritative `.bun-version` (`1.4.4+`) without requiring Node.js compatibility polyfills, `better-sqlite3`, or obsolete external native extensions.

---

## 4. Success Criteria & Real Testing Contracts

- **SC-016-01**: Spec package (`spec.md`, `plan.md`, `tasks.md`) and Unlazy gate ledger (`GATES.md`) are complete, internally consistent, and pass `gate-lint.mjs --strict` with zero findings.
- **SC-016-02**: Privacy audit confirms zero host information leakage in OpenCode fingerprint payloads (`process.cwd` and `os.tmpdir` never appear in emitted envelopes).
- **SC-016-03**: Session cache respects existing runtime bounds (`MAX_TRANSLATED_IDS = 5000`, `MEMORY_CONFIG.sessionTtlMs = 7200000`) under session churn.
- **SC-016-04**: In-process `wreq-js` native fetch cancels in-flight operations upon `AbortSignal` and enforces response-header deadlines without terminating active SSE streaming bodies.
- **SC-016-05**: HTTP 429 quota errors return proper `Retry-After` backoffs and do not cycle active OpenCode session records.
- **SC-016-06**: External sidecar processes (e.g. Psiphon) cleanly terminate within tested bounded timeouts aligned to the 1500ms escalation contract.

---

## 5. Dependencies & Coordination

1. **Current Branch Context**: Documents reside on `fix/proxy-redis-reliability` where native proxy transport and abort mechanisms are being stabilized.
2. **Implementation Staging**: Implementation tasks are planned for execution once transport reliability coordination is complete.
3. **Host Bridge Deferral**: Any future proposal for model-directed host tool execution requires independent review, containerized isolation design, and explicit operator authorization controls.

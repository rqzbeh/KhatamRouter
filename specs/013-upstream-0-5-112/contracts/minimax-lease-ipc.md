# Contract: MiniMax Code Desktop App Broker Lease IPC Protocol

## 1. Scope & Objective
This contract defines the local Inter-Process Communication (IPC) protocol between KhatamRouter and the official MiniMax Code desktop application on the same machine.

MiniMax user refresh tokens are strictly single-use. When multiple client processes (e.g. CLI and local gateway) independently refresh an account, concurrent refresh calls revoke each other. To eliminate race conditions, the MiniMax desktop application functions as an IPC authentication broker. KhatamRouter connects over a local socket to lease short-lived JWT access tokens without holding or refreshing the long-lived refresh token.

---

## 2. IPC Wire Protocol Specification

### 2.1 Transport Endpoints
- **POSIX (Linux, macOS)**:
  - Socket path: `<canonicalDataDir>/run/mcode-auth-lease-v1.sock`
  - Capability file: `<canonicalDataDir>/run/mcode-auth-lease-v1.cap`
  - Default data directory: `~/.minimax`
- **Windows (win32)**:
  - Named pipe path: `\\.\pipe\mcode-auth-lease-<16-hex-digest>`
  - Digest derivation: `crypto.createHash("sha256").update(canonicalDataDir.toLowerCase()).digest("hex").slice(0, 16)` where `canonicalDataDir` uses normalized backslashes without trailing separators.
  - Capability file: `<canonicalDataDir>\run\mcode-auth-lease-v1.cap`
  - Default data directory: `%USERPROFILE%\.minimax`

### 2.2 Wire Framing
- Format: 4-byte big-endian `uint32` length prefix + JSON string payload.
- Maximum payload size: `65,536` bytes (64 KB, `AUTH_LEASE_MAX_FRAME_BYTES`).
- Socket behavior: Any frame declaring $> 65,536$ bytes or failing JSON parsing causes the connection to abort immediately with `PROTOCOL_MISMATCH`.

### 2.3 Handshake & Authentication
Every request payload MUST include the capability token:
- Read from `<dataDir>/run/mcode-auth-lease-v1.cap`.
- Must match `/^[A-Za-z0-9_-]{43}$/` (43-character base64url string).
- If the file is unreadable or empty, the client throws `AuthLeaseError("BROKER_UNAVAILABLE")`.

---

## 3. Protocol Methods

### 3.1 `status`
Probes whether the desktop app is running, reachable, and authenticated. Does NOT issue or renew a lease.
- **Request**:
  ```json
  {
    "version": 1,
    "requestId": "status-<timestamp>",
    "capability": "<43-char-token>",
    "method": "status"
  }
  ```
- **Timeout**: 5000 ms.
- **Success Response**:
  ```json
  {
    "ok": true,
    "requestId": "status-<timestamp>",
    "result": {
      "status": "active",
      "generation": 12,
      "expiresAtMs": 1730129000000
    }
  }
  ```

### 3.2 `lease`
Requests an active JWT access token valid for at least `minValidityMs` (default 300,000 ms, capped at 300,000 ms).
- **Request**:
  ```json
  {
    "version": 1,
    "requestId": "lease-<timestamp>",
    "capability": "<43-char-token>",
    "method": "lease",
    "minValidityMs": 300000
  }
  ```
- **Timeout**: 10000 ms.
- **Success Response**:
  ```json
  {
    "ok": true,
    "requestId": "lease-<timestamp>",
    "result": {
      "accessToken": "eyJhbGciOi...",
      "generation": 12,
      "expiresAtMs": 1730129000000
    }
  }
  ```

---

## 4. Error Codes & Mapping

| Error Code | Meaning | HTTP Status in Route |
|---|---|---|
| `AUTH_REQUIRED` | Desktop app is running but user is not logged in | 409 Conflict |
| `BROKER_UNAVAILABLE` | Socket missing, permission denied, or app not running | 409 Conflict |
| `CAPABILITY_REJECTED` | Capability file content rejected by broker | 409 Conflict |
| `PROTOCOL_MISMATCH` | Incompatible framing or version mismatch | 409 Conflict |
| `INVALID_REQUEST` | Out-of-bounds parameter or bad path | 400 Bad Request |
| `INTERNAL_ERROR` | Internal broker error | 500 Internal Error |

---

## 5. Security & Network Constraints
1. **Loopback Gate**: Endpoints `/api/oauth/minimax-code/lease` and `/api/oauth/minimax-code-global/lease` MUST be listed in `ALWAYS_PROTECTED` and `LOCAL_ONLY_PATHS` in `src/dashboardGuard.js`. Non-loopback callers receive HTTP 403 Forbidden.
2. **Path Sanitization**: `dataDir` overrides passed via query or body MUST be validated as absolute canonical paths. Relative paths and directory traversals (`..`) are rejected with `INVALID_REQUEST`.
3. **No Persistent Token Storage**: Access tokens are held in volatile memory or Redis only; they must never be committed to SQLite or printed in server logs.

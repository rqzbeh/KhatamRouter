# Data Model 013: Upstream v0.5.112 Port Entity Schemas

## 1. Provider Connection Schema Extensions

### 1.1 MiniMax Code Lease Connection (`authType === "mcode-lease"`)
Connections created via the MiniMax Desktop App broker borrow credentials dynamically over local IPC. They store no refresh token in SQLite.

```typescript
interface MiniMaxLeaseConnection {
  id: string;                               // Unique connection ID (e.g., "conn_mcode_lease_xxx")
  provider: "minimax-code" | "minimax-code-global";
  authType: "mcode-lease";                   // Distinguishes from "oauth" and "apikey"
  name: string;                             // e.g., "MiniMax Desktop (Lease)"
  accessToken: null;                        // Never persisted to SQLite (ephemeral in memory/Redis)
  refreshToken: null;                       // Desktop app owns refresh; router holds no refresh token
  expiresAt: null;                          // Expiry tracked dynamically by lease manager
  providerSpecificData: {
    mcodeDataDir: string;                   // Canonical absolute path to MiniMax desktop data dir
  };
  testStatus: "active" | "error";
  createdAt: string;
  updatedAt: string;
}
```

---

## 2. MiniMax IPC Wire Protocol Framing & Payloads

### 2.1 Binary Frame Format
Every frame transmitted across the local named pipe or Unix domain socket conforms to:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Payload Length (Big-Endian uint32)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                   JSON Payload (UTF-8 Bytes)                  |
|                 (1 <= length <= 65536 bytes)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 2.2 Client Request Payload (`status` / `lease`)
```typescript
interface McodeLeaseRequest {
  version: 1;                               // AUTH_LEASE_PROTOCOL_VERSION
  requestId: string;                        // e.g. "status-xyz" or "lease-xyz" (no '9r' branding)
  capability: string;                       // 43-character base64url string read from .cap file
  method: "status" | "lease";
  minValidityMs?: number;                   // Optional for "lease" (default 300,000 ms, max 300,000 ms)
}
```

### 2.3 Broker Response Payload
```typescript
interface McodeLeaseResponseSuccess {
  ok: true;
  requestId: string;
  result: {
    status?: "active" | "expired";
    generation: number;                     // Monotonically increasing credential generation
    expiresAtMs: number;                    // Epoch timestamp in milliseconds
    accessToken?: string;                   // JWT access token (only returned for method: "lease")
  };
}

interface McodeLeaseResponseError {
  ok: false;
  requestId: string;
  error: {
    code: "AUTH_REQUIRED" | "BROKER_UNAVAILABLE" | "CAPABILITY_REJECTED" | 
          "PROTOCOL_MISMATCH" | "INVALID_REQUEST" | "INTERNAL_ERROR";
    message?: string;
  };
}
```

---

## 3. Redis Cluster Cache Schemas

### 3.1 Leased Token Cache (`khatam:mcode:lease:<digest>`)
Stores the shared leased token across clustered worker processes.
- **Key**: `khatam:mcode:lease:<digest>` (where `<digest>` is the 16-hex SHA-256 of canonical `dataDir`).
- **Type**: String (JSON-serialized).
- **TTL**: $\max\left(1, \lfloor(\text{expiresAtMs} - \text{now} - 60000) / 1000\rfloor\right)$ seconds.

```json
{
  "accessToken": "eyJhbGciOi...",
  "expiresAtMs": 1730123456789,
  "generation": 42
}
```

### 3.2 Single-Flight Distributed Lock (`khatam:lock:mcode:lease:<digest>`)
Coordinates single-flight lease acquisition across workers.
- **Key**: `khatam:lock:mcode:lease:<digest>`
- **Type**: String (Worker PID or UUID identifier)
- **TTL**: 5000 ms (auto-expires if worker crashes)

---

## 4. CommandCode Request & Session Models

### 4.1 Request Headers
```typescript
interface CommandCodeHeaders {
  "Content-Type": "application/json";
  "User-Agent": "cli";
  "x-command-code-version": "1.88.0";
  "x-cli-environment": "production";
  "x-cli-surface": "cli";
  "x-taste-learning": "false";
  "x-project-slug": string;                 // slugifyPath(process.cwd())
  "x-session-id": string;                   // UUID v4 format, synchronized with threadId
  "Authorization"?: string;                 // "Bearer <user_token>"
  "Accept"?: string;                        // "text/event-stream" or "application/json"
}
```

### 4.2 Translator Request Envelope
```typescript
interface CommandCodeRequestEnvelope {
  threadId: string;                         // UUID v4 format derived from credentials._clientSessionId
  memory: "";
  config: {
    workingDir: string;                     // process.cwd()
    date: string;                           // YYYY-MM-DD
    environment: string;                    // process.platform (e.g. "linux")
    structure: any[];
  };
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}
```

---

## 5. DeepSeek PoW Interface Specification

```typescript
/**
 * Searches for a valid nonce satisfying DeepSeekHashV1(prefix + nonce) == challenge.
 *
 * @param prefix - Challenge prefix string
 * @param challenge - 64-character lowercase or uppercase hex digest
 * @param difficulty - Difficulty ceiling integer in range [1, 250000]
 * @returns Nonce integer satisfying the challenge, or -1 if no solution exists in [0, difficulty)
 * @throws TypeError if prefix is not a string or challenge is not 64 hex characters
 * @throws RangeError if difficulty is not a safe integer in [1, 250000]
 */
function findDeepSeekPowNonce(
  prefix: string,
  challenge: string,
  difficulty: number
): number;
```

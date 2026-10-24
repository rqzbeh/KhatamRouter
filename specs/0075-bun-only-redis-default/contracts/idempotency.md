# Contract: HTTP Idempotency-Key Specification

**Header Name**: `Idempotency-Key`  
**Endpoint**: `/v1/chat/completions` (and OpenAI-compatible `/v1/*` inference routes)  
**Applicability**: Non-streaming requests (`stream: false` or omitted)  

---

## 1. Request Contract

Clients optionally supply an idempotency key to guarantee at-most-once execution on upstream providers across network retries.

### Header Format:
```http
POST /v1/chat/completions HTTP/1.1
Host: api.khatamrouter.local
Authorization: Bearer sk-kh-abcdef...
Idempotency-Key: 7b819f3e-8e4a-4d22-9fa4-706d3e8a4d10
Content-Type: application/json

{
  "model": "claude-sonnet-4.5",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

### Constraints:
- `Idempotency-Key` length: 1 to 256 characters.
- Valid characters: `^[A-Za-z0-9_\-\.\:]+$`.
- **Streaming Exclusion**: If `stream: true` is set in the request JSON body or query parameter, the `Idempotency-Key` header is ignored. Responses for streaming requests are not stored or replayed.

---

## 2. Response Behaviors

### 2.1 First Successful Request (Cache Miss)
- Upstream request executes normally.
- Response is stored in Redis under `khatam:idempotency:<apiKeyHash>:<idempotencyKey>` with TTL = 300s.
- Response returned to client with normal HTTP 200 and standard headers.

### 2.2 Replayed Identical Request (Cache Hit)
- If a request arrives with the same `Idempotency-Key` and the request body SHA-256 matches `bodyHash`:
  - Upstream request is **not executed** (0 upstream calls, 0 additional tokens billed).
  - Stored response status, headers, and body are returned immediately.
  - Header added:
    ```http
    Idempotency-Replayed: true
    ```

### 2.3 Payload Mismatch (Conflict)
- If a request arrives with an identical `Idempotency-Key` but a different request body (`bodyHash` mismatch):
  - Upstream request is **not executed**.
  - Server returns HTTP 422 (Unprocessable Entity) or HTTP 400:
    ```json
    {
      "error": {
        "message": "Idempotency-Key reuse with conflicting request payload",
        "type": "invalid_request_error",
        "code": "idempotency_conflict"
      }
    }
    ```

### 2.4 In-Flight Duplicate
- If a duplicate request arrives while the original request is still executing upstream (state is `"in_flight"`):
  - The second request either polls for up to 10 seconds awaiting the result, or returns HTTP 409 Conflict:
    ```http
    HTTP/1.1 409 Conflict
    Retry-After: 2

    {
      "error": {
        "message": "A request with this Idempotency-Key is currently in progress",
        "type": "conflict_error",
        "code": "request_in_progress"
      }
    }
    ```

### 2.5 Upstream Failure / 5xx
- If the upstream provider returns an error (4xx/5xx) or times out, the `"in_flight"` record is deleted from Redis immediately.
- This ensures that client retries are not blocked by transient failures.

---

## 3. Storage Failure / Degradation Policy

If Redis is unreachable or returns an error during idempotency processing:
- The system **fails open**: the request proceeds directly to upstream execution.
- A warning is logged: `[idempotency] Redis error during key check, proceeding without idempotency protection`.
- No exception or 500 error is thrown out to the client.

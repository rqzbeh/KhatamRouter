# Gates: Proxy and Redis reliability

OWNS: open-sse/services/opencodeTlsClient.js, open-sse/utils/proxyFetch.js, open-sse/executors/opencode.js, src/lib/network/psiphon/**, src/sse/handlers/chat.js, src/lib/redis/**, tests/integration/*reliability*, tests/unit/*proxy*, tests/unit/*psiphon*, docs/PSIPHON.md

Scope: Real wreq-js through a selected proxy with fail-closed transport; bounded tunnel teardown and truthful readiness; stop quota-driven identity rotation and preserve provider Retry-After; publisher-specific Redis readiness and same-host invalidation fallback. No VPS writes, credentials, provider generation calls or attempts to circumvent quotas.

- [x] G1: Real wreq-js through a real HTTP CONNECT proxy establishes TLS and transfers bytes without a direct origin connection
  CHECK: bun tests/integration/proxy-transport-reliability.mjs
  EXPECT: PROXY_TRANSPORT_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: Verified via real HTTP CONNECT proxy and native wreq-js TLS session targeting test origin server. Confirmed proxy CONNECT traversal (count=1), full opencodeAdapterFetch through proxy, progressive SSE streaming transfer isolation (chunk-1, chunk-2), AbortSignal cancellation propagation, manual redirect enforcement (302 preserved, no off-host location chasing or credential replay), refused proxy fail-closed verification (zero requests leaked to origin), specialized proxyAwareFetch hook integration, and strict foreign host allowlist rejection. Output marker: PROXY_TRANSPORT_RELIABILITY_PASS.

- [x] G2: Real child processes terminate before directory cleanup; missing egress evidence cannot be reported as verified readiness
  CHECK: bun tests/integration/tunnel-lifecycle-reliability.mjs
  EXPECT: TUNNEL_LIFECYCLE_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: Verified with real OS child processes. Confirmed process termination is awaited before directory deletion, stubborn process escalation from SIGTERM to SIGKILL after timeout verified, missing egress evidence causes tunnel readiness to fail closed without reporting unverified readiness, and identical-IP egress across 3 attempts fails closed rather than returning false success. Output marker: TUNNEL_LIFECYCLE_RELIABILITY_PASS.

- [x] G3: Real Redis publisher/subscriber and independent processes demonstrate startup and reconnect invalidation without writable-stream warnings
  CHECK: bun tests/integration/redis-events-reliability.mjs
  EXPECT: REDIS_EVENTS_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: Verified with independent child processes (subscriber started and ready before publisher creation; publisher emitted startup config_reload immediately before ready; subscriber received coalesced invalidation; verified disconnect and reconnect invalidation delivery over dedicated ephemeral Docker redis:8.2-alpine container; zero "Stream isn't writeable" or offline queue warnings; marker REDIS_EVENTS_RELIABILITY_PASS).

- [x] G4: Tunnel rotates on burn signals (429 / FreeTierError / transport failures) and preserves Retry-After
  CHECK: bun tests/integration/quota-handling-reliability.mjs
  EXPECT: QUOTA_HANDLING_RELIABILITY_PASS
  CWD: ../..
  EVIDENCE: Verified with real loopback HTTP server. Confirmed HTTP 429 and 403 (FreeTierError / FreeUsageLimit) trigger tunnel rotation and generation increment, preserving Retry-After headers and error payloads, while client aborts and 400/401 do not trigger rotation. Authentic transport errors (502/503 connect timeout / ECONNRESET) also trigger legitimate recovery. Output marker: QUOTA_HANDLING_RELIABILITY_PASS.

- [x] G5: Review security boundaries and unit regression tests
  EVIDENCE: All unit tests in `tests/unit/psiphon-manager.test.js` (25/25) and `tests/unit/psiphon-rotation.test.js` (15/15) pass cleanly without regressions. All security boundaries (fail-closed strictProxy, host allowlist, non-leaking error responses) verified.

- [ ] G6: PR checks and merged master Verify are green; no branch protection bypass
  EVIDENCE: pending

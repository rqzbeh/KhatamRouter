# Plan: bounded proxy failover

## Source-grounded integration
Discovery identified `src/sse/handlers/chat.js` as the pre-response orchestration layer. Existing Psiphon and sidecar retries live here; generic executor retries in `open-sse/executors/base.js` reuse a proxy. `src/lib/network/connectionProxy.js` owns rotation candidates and selection, while `proxyHealthPolicy.js` classifies health failures. Classification currently treats generic 429 as pool health faults; this alone is insufficient to establish that an account restriction can safely be retried through another proxy.

## Contract
- Persist None (default/current behavior), Custom positive integer additional-proxy count, and All available modes through the settings route and proxy configuration UI. All snapshots the finite eligible authorized set; Custom never preallocates based on an untrusted count and stops at candidate exhaustion.
- Use the current provider/connection's authorized rotation candidate set and configured random/round-robin mode. Never broaden to all globally available proxies.
- Introduce a request-local visited set and budget, shared across retry layers. Fail closed to direct egress from the first opted-in proxied attempt.
- Classify retryable failures before account fallback without suppressing real account quota/auth/policy failures. Preserve final real errors/headers and authoritative retry instructions.
- Retry only replayable pre-response failures. Cancellation/deadline and successful stream return terminate the retry loop.
- Avoid duplicate mutable credential state across concurrent requests.

## Ownership and integration
Haiku implementation agent owns failover runtime/config/UI/tests in an isolated worktree. It imports the parent's integrated combo versions of `src/sse/handlers/chat.js` and `src/app/api/settings/route.js` before modifying those two shared files; parent freezes edits to them until return. Parent owns spec/docs, reviews implementation and runs integration checks. Existing scheduler and combo work must survive unchanged.

## Verification
Bind runnable gates to real test files once introduced. Tests must cover persisted None/Custom/All values, malformed settings, custom N+1 total attempt limits, All with more than ten candidates, no repeat attempts or unbounded snapshot growth, distinct candidates for random and round-robin, exhausted actual error/Retry-After, insufficient candidates, proxy-disabled no-op, auth/quota exclusions, no-direct initial/alternate attempts, cancellation and no post-stream replay. Test the runtime integration, not only isolated selection helpers. Run targeted regressions/lint and a final integrated production build.

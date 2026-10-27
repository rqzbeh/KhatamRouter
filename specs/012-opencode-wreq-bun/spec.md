# Specification: OpenCode Free Tier TLS Client (wreq-js) Native Bun Support

**Feature Branch**: `port/opencode-bun-native`  
**Status**: Ready for Planning  
**Classification**: Provider Compatibility, Network Resilience & Security Hardening

---

## 1. Problem Statement & Scope

KhatamRouter routes traffic across 40+ AI model providers, including the free community lane for OpenCode (`oc/*`). Upstream edge firewalls protecting OpenCode free endpoints (`https://opencode.ai/inference/v1/*`) reject requests with HTTP `429 FreeUsageLimitError` if the TLS ClientHello cipher suite order and contents diverge from expected fingerprints.

Upstream `decolua/9router` commit `ce060c79` addressed this via `wreq-js`, but introduced significant flaws:
1. It used a lazy downloader (`lazyRuntime.js`) that spawned `npm i --no-save wreq-js` at runtime via child process, violating container immutability and breaking under Bun-only environments.
2. It failed closed with an unhandled exception (`OpencodeTlsUnavailableError`) instead of failing open.
3. It leaked local system paths in the `<env>` marker prompt via `process.cwd()` and `os.tmpdir()`.
4. It executed `directFetch` without host validation, introducing potential SSRF and transport hijack risks.

This specification defines the Bun-native architecture for running `wreq-js@3.2.0` under Bun 1.4.3:
- Declaring `wreq-js` as a standard `optionalDependencies` package with zero runtime process spawning.
- Implementing the verbatim 17-cipher BoringSSL ClientHello list in `opencodeTlsClient.js`.
- Implementing a **REAL fail-open** policy falling back to native Bun `fetch`.
- Scoping `directFetch` strictly to `opencode.ai` and its subdomains while preserving proxy priority and `strictProxy` enforcement.
- Preserving fixed neutral constants in `<env>` marker prompts.
- Adopting upstream commit `1da5b0d7` (capping `oc/deepseek-v4.1-flash-free` context window at 330,000).
- Reconciling documentation, CHANGELOG, and upstream port ledgers.

---

## 2. Requirements

### FR-01: Bun-Native Packaging & wreq-js Dependency Lifecycle
- **Optional Dependency Declaration**: `wreq-js` MUST be declared in root `package.json` under `optionalDependencies` pinned to exact version `3.2.0`.
- **Zero Runtime Process Spawning**: `open-sse/services/opencodeTlsClient.js` MUST import `wreq-js` via native ESM dynamic `import("wreq-js")`. It MUST NOT import `lazyRuntime.js` or execute child processes (`child_process.exec`, `spawn`, `npm`, or `bun add`).
- **Next.js Bundler Externals**: `next.config.mjs` MUST include `"wreq-js"` in `serverExternalPackages` so Webpack does not inline or bundle native CJS bindings.
- **Standalone Build Distribution**: `scripts/copy-standalone-assets.mjs` MUST ensure `wreq-js` and its platform native binding package (`@wreq-js/binding-linux-x64-gnu`) are present in `.next/standalone/node_modules/` for standalone execution.
- **Docker Support**: `Dockerfile` and `Dockerfile.bun` MUST continue using `bun install --include=optional` in builder stages so platform bindings are cached and transferred to runner images. Both Dockerfile variants MUST remain byte-identical.
- **CLI Launcher Packaging**: `cli/package.json` and `cli/scripts/build-cli.js` MUST bundle or trace `wreq-js` assets to ensure the standalone CLI distribution can execute without internet downloads.

### FR-02: Transport Layer DirectFetch Wiring & Host Scoping
- **BaseExecutor Hook Forwarding**: `BaseExecutor.execute` in `open-sse/executors/base.js` MUST accept an optional `directFetch` parameter and forward it inside request options to `proxyAwareFetch`.
- **OpenCode Executor Integration**: `OpenCodeExecutor.execute` in `open-sse/executors/opencode.js` MUST pass a `directFetch` function delegating to `opencodeTlsFetch(url, init, { signal })`.
- **Proxy Priority Over DirectFetch**: `proxyAwareFetch` in `open-sse/utils/proxyFetch.js` MUST give configured proxies (connection proxy, environment proxy) strict priority over `directFetch`. If a proxy is resolved, requests MUST route through `getDispatcher(proxyUrl)` and bypass `directFetch`.
- **StrictProxy Fail-Closed**: If `strictProxy: true` is configured and a proxy is intended but fails to resolve, `proxyAwareFetch` MUST throw immediately without falling back to `directFetch` or direct IP routing.
- **Strict Host Scoping**: `options.directFetch` MUST ONLY be invoked if the target URL hostname is `opencode.ai` or a subdomain matching `*.opencode.ai`. For any other destination, `directFetch` MUST be ignored and normal fetch used.
- **Codex STT Safety**: `codexStt.js` passes `directFetch: codexHttpFetch` targeting `https://chatgpt.com/backend-api/transcribe`. Because `chatgpt.com` is outside the allowed `opencode.ai` domain, `proxyFetch.js` MUST NOT invoke `codexHttpFetch`. Codex STT requests MUST continue using native `fetch`.

### FR-03: Real Fail-Open Fallback to Bun Native Fetch
- **Single Warning Logging**: If `import("wreq-js")` fails (e.g. unsupported OS/architecture, missing native binary) or `createSession` fails, `opencodeTlsClient.js` MUST emit at most ONE diagnostic warning to `console.warn`:
  ```text
  [OpenCode TLS] wreq-js unavailable; falling back to native Bun fetch
  ```
- **Transparent Fallback**: When `wreq-js` is unavailable, `opencodeTlsFetch` MUST NOT throw. It MUST execute the request via `globalThis.fetch(url, init)` and return the resulting `Response`.
- **BoringSSL Cipher Hash Parity**: Because Bun's native BoringSSL client already emits JA4 cipher hash `5b57614c22b0`, fallback requests to OpenCode Free tier will maintain high compatibility without crashing.
- **No Disruption to Downstream Consumers**: The fallback `Response` object MUST support standard `.status`, `.statusText`, `.headers`, `.body` (`ReadableStream`), `.text()`, and `.json()` methods.

### FR-04: Security Invariants & Secret Protection
- **No Host Reconnaissance Leaks**: `open-sse/utils/opencodeFingerprint.js` MUST retain KhatamRouter's fixed neutral dummy constants (`/home/user/project`, `/var/cache/opencode`, platform `"linux"`). It MUST NOT call `process.cwd()`, `os.tmpdir()`, or read `process.platform`.
- **Credential Protection**: Outbound TLS requests MUST NOT log `Authorization` bearer tokens, API keys, or raw headers to console or disk logs.
- **Stream Integrity**: Streaming response bodies MUST be returned as live WHATWG `ReadableStream` instances directly from `res.body`. They MUST NOT be buffered in memory or converted to monolithic strings before passing downstream.
- **Abort Signal Propagation**: Client cancellation (`AbortSignal`) MUST propagate immediately to `session.fetch` options to terminate upstream connections and conserve provider quota.

### FR-05: Model Capability Window Re-Pinning (1da5b0d7)
- **Capability Pin**: `open-sse/providers/capabilities.js` MUST cap `oc/deepseek-v4.1-flash-free` with:
  ```javascript
  "deepseek-v4.1-flash-free": {
    vision: true,
    reasoning: true,
    thinkingFormat: "deepseek",
    contextWindow: 330000,
    maxOutput: 128000
  }
  ```
- **Context Length Invariant**: Ensures `max_completion_tokens <= context_length` so client IDEs (e.g. VS Code Copilot) compact conversations before hitting backend prompt limits.
- **Explicit Decision Record**: This change deliberately replaces the earlier KhatamRouter 200,000 / 32,000 pin per the user's explicit instruction (*"add all commits you skipped"*).
- **Test Baselines**: Existing capability tests asserting the old 200,000 / 32,000 values MUST be updated to verify `<=` 330,000 and maxOutput `<=` contextWindow.

### FR-06: Documentation & Upstream Port Reconciliations (3a978a63)
- **CHANGELOG Reconciliation**: `CHANGELOG.md` MUST include the upstream `v0.5.111` entry documenting the OpenCode Free TLS ClientHello restoration, the 330k context window cap, and the Bun-native adaptation.
- **Upstream Ports Ledger**: `docs/UPSTREAM-PORTS.md` section 2 ("Deliberately Skipped Upstream Commits") MUST be updated to remove `ce060c79` and `1da5b0d7` from the skipped list. A new entry MUST be added in section 1 detailing the Bun-native porting of `ce060c79` and `1da5b0d7` with security hardening.
- **ROADMAP & README Status**: `ROADMAP.md` and `README.md` MUST reflect the native Bun `wreq-js` TLS client support for OpenCode free tier.

### FR-07: Test Suite & Verification Matrix
- **Unit Tests with Mocked wreq-js**: `tests/unit/opencode-tls-client.test.js` MUST verify session creation with the verbatim 17-cipher list, session reuse across requests, live stream forwarding, and abort signal propagation without importing `lazyRuntime.js`.
- **Fail-Open Verification**: Unit tests MUST verify that when `wreq-js` fails to load, `opencodeTlsFetch` logs a single warning and transparently delegates to native `fetch`.
- **BaseExecutor Forwarding**: `tests/unit/base-executor-retry.test.js` (or dedicated test) MUST assert that `directFetch` passed to `BaseExecutor.execute` is received by `proxyAwareFetch`.
- **ProxyFetch Scoping Tests**: Unit tests MUST verify that:
  1. `directFetch` is called when no proxy is resolved for `opencode.ai`.
  2. `directFetch` is NOT called when a proxy is resolved.
  3. `directFetch` is NOT called for non-opencode hosts (e.g. `chatgpt.com`).
- **Live Probe Oracle (Opt-In)**: `tests/unit/opencode-tls-live.test.js` MUST provide an opt-in live test (skipped unless `OPENCODE_TLS_LIVE=1`) querying `https://tls.peet.ws/api/clean` through `wreq-js` and asserting JA4 cipher hash `5b57614c22b0`.

---

## 3. Non-Functional & Architectural Invariants

1. **Bun-Only Invariant**: All code MUST execute natively under Bun 1.4.3. No Node-only fallback drivers, child process spawn hacks, or npm shellouts.
2. **Zero Plaintext Token Logging**: Outbound request debugging (`dbg("FETCH", ...)`) MUST omit Authorization headers.
3. **Immutability of Container Builds**: No external runtime downloads inside containers; dependencies must be present in the built image.
4. **Disjoint Task Ownership**: Implementation tasks MUST strictly respect disjoint file boundaries.

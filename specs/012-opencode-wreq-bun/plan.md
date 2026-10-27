# Implementation Plan: OpenCode Free Tier TLS Client (wreq-js) Native Bun Support

**Feature Branch**: `port/opencode-bun-native`  
**Status**: Ready for Tasks  
**Classification**: Implementation Architecture

---

## 1. Architecture & Component Interaction

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Request Routing Pipeline                        │
│                                                                        │
│   Client Request (/v1/chat/completions or /v1/messages)                │
│                           │                                            │
│                           ▼                                            │
│   OpenCodeExecutor.execute(args)                                       │
│   • Prepares session affinity headers                                  │
│   • Injects directFetch: (url, opts) => opencodeTlsFetch(...)          │
│                           │                                            │
│                           ▼                                            │
│   BaseExecutor.execute(args)                                           │
│   • Forwards directFetch into proxyAwareFetch options                  │
│                           │                                            │
│                           ▼                                            │
│   proxyAwareFetch(url, options, proxyOptions)                          │
│   • [Step 1] Is proxy active? ──► YES ──► Route through ProxyAgent     │
│   • [Step 2] strictProxy intended but unresolved? ──► Fail closed      │
│   • [Step 3] No proxy AND host is (*.)opencode.ai AND directFetch?    │
│              YES ──► Call options.directFetch(url, options)            │
│              NO  ──► Call globalThis.fetch(url, options)               │
│                           │                                            │
│                           ▼                                            │
│   opencodeTlsFetch(url, init, { signal })                              │
│   • Dynamic import("wreq-js") (NO npm-spawn child process)             │
│   • Catch import/session failure:                                      │
│     - Log single warning: [OpenCode TLS] wreq-js unavailable ...       │
│     - Fail-open fallback: return globalThis.fetch(url, init)           │
│   • If wreq-js available:                                              │
│     - Reuse cached BoringSSL session (17-cipher list verbatim)         │
│     - Execute session.fetch(url, { ...init, signal })                  │
│     - Wrap res.body in native WHATWG Response (live ReadableStream)   │
│                           │                                            │
│                           ▼                                            │
│   Streaming SSE Tokens Return to Downstream Client                     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. File Modification & Disjoint Ownership Boundaries

The implementation is partitioned across four strictly disjoint file-ownership sets assigned to distinct tasks:

| Task ID | Task Name | Owned File Paths | Primary Verification Oracle |
|---|---|---|---|
| **T1** | Packaging & Build Infrastructure | `package.json`<br>`bun.lock`<br>`next.config.mjs`<br>`Dockerfile`<br>`Dockerfile.bun`<br>`scripts/copy-standalone-assets.mjs`<br>`cli/package.json`<br>`cli/scripts/build-cli.js`<br>`tests/unit/wreq-packaging.test.js` | `bun x vitest run unit/wreq-packaging.test.js` |
| **T2** | Transport Layer & TLS Client | `open-sse/services/opencodeTlsClient.js`<br>`open-sse/executors/base.js`<br>`open-sse/executors/opencode.js`<br>`open-sse/utils/proxyFetch.js`<br>`open-sse/utils/opencodeFingerprint.js`<br>`tests/unit/opencode-tls-client.test.js`<br>`tests/unit/opencode-fingerprint.test.js`<br>`tests/unit/opencode-session.test.js`<br>`tests/unit/base-executor-retry.test.js`<br>`tests/unit/opencode-freetier-direct-replay.test.js`<br>`tests/unit/opencode-tls-live.test.js` | `bun x vitest run unit/opencode-tls-client.test.js unit/opencode-session.test.js unit/base-executor-retry.test.js` |
| **T3** | Capabilities & Model Window Cap | `open-sse/providers/capabilities.js`<br>`tests/unit/capabilities.test.js`<br>`tests/unit/opencode-go-models.test.js`<br>`tests/__baseline__/*` | `bun x vitest run unit/capabilities.test.js unit/opencode-go-models.test.js` |
| **T4** | Documentation & Upstream Ledgers | `CHANGELOG.md`<br>`docs/UPSTREAM-PORTS.md`<br>`ROADMAP.md`<br>`README.md` | Audit script validating document presence and ledger updates |
| **T5** | Spec-Kit & Unlazy Gates Governance | `specs/012-opencode-wreq-bun/**`<br>`.unlazy/012-opencode-wreq-bun/**`<br>`specs/README.md` | `node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/012-opencode-wreq-bun/GATES.md` |

*Invariant*: All task ownership sets are completely disjoint. No file is shared across task boundaries.

---

## 3. Detailed Component Designs

### 3.1 Task T1: Packaging & Build Infrastructure

#### `package.json`
- Declare `wreq-js` under `optionalDependencies`:
  ```json
  "optionalDependencies": {
    "@aws-sdk/credential-providers": "^3.1135.0",
    "wreq-js": "3.2.0"
  }
  ```
- Run `bun install` to update `bun.lock` with the optional package and its platform-specific bindings (e.g. `@wreq-js/binding-linux-x64-gnu`).

#### `next.config.mjs`
- Append `"wreq-js"` to `serverExternalPackages`:
  ```javascript
  serverExternalPackages: ["bun:sqlite", "ioredis", "open", "@aws-sdk/credential-providers", "wreq-js"],
  ```
  This ensures Next.js Webpack treats `wreq-js` as an external runtime package and avoids attempting to bundle native bindings.

#### `Dockerfile` & `Dockerfile.bun`
- Ensure `bun install --include=optional --quiet` caches the optional binding.
- Standalone runner stage copies `.next/standalone` which resolves external packages from hoisted `node_modules`.
- Retain byte-identical synchronization between `Dockerfile` and `Dockerfile.bun`.

#### `scripts/copy-standalone-assets.mjs`
- Enhance `copyStandaloneAssets` to ensure `node_modules/wreq-js` and `node_modules/@wreq-js` are copied into `.next/standalone/node_modules/` if not automatically traced by Next.js standalone file collector.

#### `cli/package.json` & `cli/scripts/build-cli.js`
- Ensure standalone CLI build includes necessary optional assets in `cliAppDir/node_modules`.

#### `tests/unit/wreq-packaging.test.js`
- Verify `package.json` declares `wreq-js: 3.2.0` in `optionalDependencies`.
- Verify `next.config.mjs` includes `wreq-js` in `serverExternalPackages`.
- Verify `copyStandaloneAssets` handles `wreq-js` gracefully without throwing.

---

### 3.2 Task T2: Transport Layer & TLS Client

#### `open-sse/services/opencodeTlsClient.js`
- **Cipher Suite**: Maintain the verbatim 17-cipher BoringSSL list:
  ```javascript
  const OPENCODE_CIPHER_LIST = [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-ECDSA-AES128-SHA",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-ECDSA-AES256-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
  ].join(":");
  ```
- **Dynamic Import & Fail-Open Session**:
  ```javascript
  let sessionPromise = null;
  let hasLoggedWarning = false;

  async function loadSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const wreq = await import("wreq-js");
        const mod = wreq.default || wreq;
        if (typeof mod.createSession !== "function") {
          throw new Error("wreq-js missing createSession");
        }
        return mod.createSession({
          emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
        });
      })().catch((err) => {
        sessionPromise = null;
        if (!hasLoggedWarning) {
          hasLoggedWarning = true;
          console.warn(`[OpenCode TLS] wreq-js unavailable (${err?.message || "load failed"}); falling back to native Bun fetch`);
        }
        return null; // Return null to signal fallback
      });
    }
    return sessionPromise;
  }
  ```
- **Fetch Execution**:
  ```javascript
  export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = 120000 } = {}) {
    const session = await loadSession();
    if (!session) {
      // Real fail-open: transparently use Bun's native fetch
      return globalThis.fetch(url, { ...init, signal });
    }

    const options = {
      method: init.method || "GET",
      headers: init.headers,
      redirect: "follow",
      timeout: timeoutMs,
    };
    if (init.body !== undefined) options.body = init.body;
    if (signal) options.signal = signal;

    const res = await session.fetch(url, options);
    const headers = new Headers();
    res.headers?.forEach?.((val, key) => headers.append(key, val));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  ```

#### `open-sse/executors/base.js`
- Update `BaseExecutor.execute`:
  ```javascript
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, directFetch = null }) {
    // ...
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: activeHeaders,
      body: bodyStr,
      signal: mergedSignal,
      ...(directFetch ? { directFetch } : {}),
    }, proxyOptions);
    // ...
  }
  ```

#### `open-sse/executors/opencode.js`
- Pass `directFetch` in `OpenCodeExecutor.execute`:
  ```javascript
  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({
      ...args,
      credentials,
      directFetch: (url, options) => opencodeTlsFetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      }, { signal: options.signal }),
    });
  }
  ```

#### `open-sse/utils/proxyFetch.js`
- Implement origin checking and `directFetch` routing in `fetchWithTlsFallback`:
  ```javascript
  function isAllowedDirectFetchHost(url) {
    try {
      const hostname = new URL(typeof url === "string" ? url : url.toString()).hostname.toLowerCase();
      return hostname === "opencode.ai" || hostname.endsWith(".opencode.ai");
    } catch {
      return false;
    }
  }

  async function fetchWithTlsFallback(url, options, proxyUrl) {
    try {
      if (!proxyUrl && options.directFetch && isAllowedDirectFetchHost(url)) {
        return await options.directFetch(url, options);
      }
      const dispatcher = proxyUrl ? await getDispatcher(proxyUrl) : undefined;
      return await originalFetch(url, dispatcher ? { ...options, dispatcher } : options);
    } catch (err) {
      // ... TLS fallback handling
    }
  }
  ```

---

### 3.3 Task T3: Capabilities & Model Window Cap

#### `open-sse/providers/capabilities.js`
- Update `PROVIDER_CAPABILITIES["opencode"]`:
  ```javascript
  "opencode": {
    "mimo-v2.6-flash-free": { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1048576, maxOutput: 131072 },
    "deepseek-v4.1-flash-free": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 330000, maxOutput: 128000 },
  },
  ```
- Replace comments documenting the prior 200,000 / 32,000 pin with documentation explaining the 330,000 / 128,000 cap from commit `1da5b0d7`.

#### `tests/unit/capabilities.test.js`
- Assert `caps.contextWindow === 330000` (or `<= 330000`) and `caps.maxOutput === 128000`.
- Verify vision and reasoning support remain true.

---

### 3.4 Task T4: Documentation & Upstream Ledgers

#### `CHANGELOG.md`
- Add entry under `v0.5.111` detailing:
  - Bun-native port of `wreq-js` TLS client for OpenCode free tier.
  - Fail-open fallback to native Bun fetch.
  - Context window cap at 330k for `oc/deepseek-v4.1-flash-free`.

#### `docs/UPSTREAM-PORTS.md`
- Update Section 1 to document `ce060c79` and `1da5b0d7` as landed and hardened.
- Update Section 2 to remove `ce060c79` and `1da5b0d7` from the deliberately skipped commits list.
- Document the user decision and Bun-native architecture.

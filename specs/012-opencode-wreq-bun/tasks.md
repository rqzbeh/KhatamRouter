# Tasks: OpenCode Free Tier TLS Client (wreq-js) Native Bun Support

**Feature Branch**: `port/opencode-bun-native`  
**Status**: Ready for Implementation  
**Specification**: `specs/012-opencode-wreq-bun/spec.md`  
**Plan**: `specs/012-opencode-wreq-bun/plan.md`

---

## Task Overview & Ownership Map

| Task ID | Summary | Owns | Oracle | Gate ID |
|---|---|---|---|---|
| **T1** | Packaging, Bundling & Standalone Distribution | package.json, bun.lock, next.config.mjs, Dockerfile, Dockerfile.bun, scripts/copy-standalone-assets.mjs, cli/package.json, cli/scripts/build-cli.js, tests/unit/wreq-packaging.test.js | `cd tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x vitest run unit/wreq-packaging.test.js` | G1, G2 |
| **T2** | Transport Layer, OpenCode TLS Client & Real Fail-Open | open-sse/services/opencodeTlsClient.js, open-sse/executors/base.js, open-sse/executors/opencode.js, open-sse/utils/proxyFetch.js, open-sse/utils/opencodeFingerprint.js, tests/unit/opencode-tls-client.test.js, tests/unit/opencode-fingerprint.test.js, tests/unit/opencode-session.test.js, tests/unit/base-executor-retry.test.js, tests/unit/opencode-freetier-direct-replay.test.js, tests/unit/opencode-tls-live.test.js | `cd tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x vitest run unit/opencode-tls-client.test.js unit/opencode-session.test.js unit/base-executor-retry.test.js` | G4, G5 |
| **T3** | Provider Capabilities & Context Window Re-Pinning (1da5b0d7) | open-sse/providers/capabilities.js, tests/unit/capabilities.test.js, tests/unit/opencode-go-models.test.js, tests/__baseline__/providers-baseline.json | `cd tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x vitest run unit/capabilities.test.js unit/opencode-go-models.test.js` | G6 |
| **T4** | Documentation, CHANGELOG & Upstream Ports Reconciliation | CHANGELOG.md, docs/UPSTREAM-PORTS.md, ROADMAP.md, README.md | `node -e 'const fs=require("fs"); ["CHANGELOG.md","docs/UPSTREAM-PORTS.md","ROADMAP.md","README.md"].forEach(f=>fs.statSync(f)); console.log("DOCS_VALIDATED");'` | G1 |
| **T5** | Spec-Kit & Unlazy Acceptance Governance | specs/012-opencode-wreq-bun/spec.md, specs/012-opencode-wreq-bun/plan.md, specs/012-opencode-wreq-bun/tasks.md, specs/012-opencode-wreq-bun/research.md, .unlazy/012-opencode-wreq-bun/GATES.md, specs/README.md | `node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/012-opencode-wreq-bun/GATES.md` | G2, G3 |

*Disjointness Invariant*: Every owned file path appears in exactly one task row. No file is co-owned or modified by more than one task.

---

## Detailed Task Breakdown

### Task 1: Packaging, Bundling & Standalone Distribution (T1)
- [ ] Update `package.json`:
  - Add `"wreq-js": "3.2.0"` to `optionalDependencies`.
  - Run `bun install` to lock exact version and platform native bindings in `bun.lock`.
- [ ] Update `next.config.mjs`:
  - Add `"wreq-js"` to `serverExternalPackages` so Next.js Webpack preserves native CJS bindings without attempting bundle inlining.
- [ ] Update `scripts/copy-standalone-assets.mjs`:
  - Ensure `copyStandaloneAssets` copies `wreq-js` and `@wreq-js` native binding directories to `.next/standalone/node_modules/` during production packaging.
- [ ] Synchronize Dockerfiles:
  - Ensure `Dockerfile` and `Dockerfile.bun` remain byte-identical aliases.
  - Verify `bun install --include=optional` is used in builder stages.
- [ ] Update CLI launcher assets:
  - Update `cli/package.json` and `cli/scripts/build-cli.js` to ensure standalone distribution traces and packages native assets properly.
- [ ] Create `tests/unit/wreq-packaging.test.js`:
  - Assert `wreq-js: 3.2.0` in `optionalDependencies`.
  - Assert `wreq-js` in `serverExternalPackages`.
  - Assert `copyStandaloneAssets` runs cleanly without errors.

### Task 2: Transport Layer, OpenCode TLS Client & Real Fail-Open (T2)
- [ ] Implement `open-sse/services/opencodeTlsClient.js`:
  - Define the verbatim 17-cipher BoringSSL suite string (`OPENCODE_CIPHER_LIST`).
  - Implement session memoization with single-instance reuse and `resetOpencodeTlsSession()`.
  - Implement native dynamic `import("wreq-js")` with zero child-process spawning (do not import `lazyRuntime.js`).
  - Implement **REAL fail-open**: if loading fails or `createSession` throws, emit exactly ONE `console.warn` diagnostic and fall back transparently to `globalThis.fetch(url, init)`.
  - Construct standard WHATWG `Response` wrapping `res.body` as a live `ReadableStream` (preserving streaming without buffering).
  - Propagate `AbortSignal` to `session.fetch` options.
- [ ] Update `open-sse/executors/base.js`:
  - Accept optional `directFetch` in `BaseExecutor.execute({ ..., directFetch = null })`.
  - Forward `directFetch` in the options object passed to `proxyAwareFetch`.
- [ ] Update `open-sse/executors/opencode.js`:
  - In `OpenCodeExecutor.execute(args)`, pass `directFetch: (url, opts) => opencodeTlsFetch(url, opts, { signal: opts.signal })`.
- [ ] Update `open-sse/utils/proxyFetch.js`:
  - In `fetchWithTlsFallback`, inspect `options.directFetch`.
  - Route through `options.directFetch` ONLY if no proxy is active AND target hostname is `opencode.ai` or ends with `.opencode.ai`.
  - Keep strictProxy fail-closed behavior intact: if proxy is intended but unresolvable, throw without fallback.
  - Keep configured proxies at top priority: an active proxy bypasses `directFetch`.
  - For non-opencode hosts (including `chatgpt.com` from `codexStt.js`), ignore `directFetch` and use standard fetch.
- [ ] Verify `open-sse/utils/opencodeFingerprint.js`:
  - Confirm fixed neutral dummy constants (`/home/user/project`, `/var/cache/opencode`, `'linux'`) are preserved.
- [ ] Unit & Integration Tests:
  - Port and adapt `tests/unit/opencode-tls-client.test.js`: test 17-cipher suite, session reuse, live stream forwarding, signal propagation, and real fail-open with mocked `wreq-js`.
  - Create `tests/unit/base-executor-retry.test.js` cases verifying `directFetch` forwarding.
  - Create `tests/unit/opencode-tls-live.test.js`: opt-in test (`OPENCODE_TLS_LIVE=1`) querying `https://tls.peet.ws/api/clean` and asserting JA4 cipher hash `5b57614c22b0`.

### Task 3: Provider Capabilities & Context Window Re-Pinning (T3)
- [ ] Update `open-sse/providers/capabilities.js`:
  - Under `PROVIDER_CAPABILITIES["opencode"]`, cap `deepseek-v4.1-flash-free`:
    ```javascript
    "deepseek-v4.1-flash-free": {
      vision: true,
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 330000,
      maxOutput: 128000
    }
    ```
  - Document that this replaces the previous 200,000 / 32,000 pin per user directive to adopt commit `1da5b0d7`.
- [ ] Update `tests/unit/capabilities.test.js`:
  - Verify `caps.contextWindow <= 330000` and `caps.maxOutput <= caps.contextWindow`.
  - Verify vision and reasoning remain `true`.
- [ ] Update `tests/__baseline__/providers-baseline.json` if required by capability snapshot verification.

### Task 4: Documentation, CHANGELOG & Upstream Ports Reconciliation (T4)
- [ ] Update `CHANGELOG.md`:
  - Reconcile `v0.5.111` upstream release notes with KhatamRouter adaptations:
    - OpenCode Free TLS ClientHello restoration via native Bun `wreq-js` and fail-open fallback.
    - `oc/deepseek-v4.1-flash-free` context window cap at 330k.
- [ ] Update `docs/UPSTREAM-PORTS.md`:
  - Move `ce060c79` and `1da5b0d7` from Section 2 ("Deliberately Skipped Upstream Commits") into Section 1 ("Ported Commits Matrix").
  - Document the Bun-native architectural adaptation, real fail-open behavior, and security hardening.
- [ ] Update `ROADMAP.md` and `README.md`:
  - Mark OpenCode Free TLS client restoration as completed under Bun.

### Task 5: Spec-Kit & Unlazy Acceptance Governance (T5)
- [ ] Create Spec-Kit package `specs/012-opencode-wreq-bun/` (`spec.md`, `plan.md`, `tasks.md`, `research.md`).
- [ ] Create Unlazy ledger `.unlazy/012-opencode-wreq-bun/GATES.md`.
- [ ] Run `gate-lint.mjs` against `.unlazy/012-opencode-wreq-bun/GATES.md` to ensure zero lint findings.
- [ ] Update `specs/README.md` with specification status ("In progress").

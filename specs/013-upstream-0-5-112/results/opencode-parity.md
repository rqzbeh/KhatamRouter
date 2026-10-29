# OpenCode Free TLS Client & Dockerfile Parity Proof

## Upstream Release Window: v0.5.111..v0.5.112
**Target Upstream Commits**:
- `e70ea24d`: "Fix OpenCode" (`open-sse/services/lazyRuntime.js`)
- `3b7acf72`: "fix(docker): bundle lazy runtime deps so OpenCode Free resolves" (`Dockerfile`)

---

## 1. Executive Summary

Upstream 9Router addresses OpenCode Free TLS requirements via on-demand dynamic package installation (`lazyRuntime.js` spawning child processes to run `npm install`) and Docker builder hacks (`/opt/lazy-runtime` npm bundling).

In accordance with KhatamRouter Constitution Principle II (Strict Bun-Only Runtime, Zero Child-Process npm Spawners) and Spec 012 / PR #78, KhatamRouter achieves complete behavioural parity natively under Bun. Rather than downloading packages dynamically at runtime, KhatamRouter:
1. Declares `wreq-js` as an official `optionalDependency` in `package.json`.
2. Installs optional dependencies at container build time via `bun install --include=optional`.
3. Copies native `wreq-js` and `@wreq-js/*` packages directly into the standalone runner stage.
4. Directly imports `wreq-js` in `open-sse/services/opencodeTlsClient.js` without Webpack `createRequire` stub workarounds.
5. Employs true fail-open semantics: if `wreq-js` or its native platform bindings are unavailable, requests log a single warning and fall back to native Bun fetch (`globalThis.fetch`), rather than failing with 502.
6. Enforces SSRF and credential leak protections (`isOpencodeHost`, manual redirect handling, automatic session cookie clearing).
7. Preserves 100% byte-identity between `Dockerfile` and `Dockerfile.bun`.

---

## 2. Detailed Behaviour-by-Behaviour Parity Matrix

| # | Upstream Commit & Location | Upstream Behaviour & Intent | Problem Solved in Upstream | KhatamRouter File & Line | Proving Test in Test Suite | Parity Status |
|---|---|---|---|---|---|---|
| **1** | `e70ea24d` `lazyRuntime.js:24-34` | Dynamic `import("node:module")` to get `createRequire` with `createRequirePromise` caching | Static `import { createRequire } from "node:module"` is stubbed out by Webpack server bundler | `open-sse/services/opencodeTlsClient.js:59-76` | `tests/unit/opencode-tls-client.test.js:40-61,259-286` | **PARITY EXCEEDED**: Bun natively resolves ESM imports without requiring `createRequire` or Webpack unbundling workarounds. |
| **2** | `e70ea24d` `lazyRuntime.js:40-47` | Creates synthetic `package.json` in `~/.9router/runtime` before spawning `npm install` | Prevents npm from traversing upwards to parent directories and corrupting root manifest | `package.json:56-59`, `Dockerfile:36` | `tests/unit/opencode-tls-client.test.js:250-258` | **PARITY EXCEEDED**: `wreq-js` is declared in root `optionalDependencies`; no runtime directory synthesis or npm execution needed. |
| **3** | `e70ea24d` `lazyRuntime.js:56-70` | `installIntoRuntime` runs child process `npm install --no-audit --no-fund --prefer-online` | Fetches `wreq-js` binary on first request if omitted from distribution | `package.json:58`, `Dockerfile:36,94-95` | `tests/unit/opencode-tls-client.test.js:250-258` | **PARITY EXCEEDED**: Dependencies installed during standard build phase; zero runtime network downloads, zero child-process execution. |
| **4** | `e70ea24d` `lazyRuntime.js:78-87` | Resolves and imports package using `import(/* webpackIgnore: true */ pathToFileURL(runtimeRequire.resolve(pkg)).href)` | Evades Webpack bundling of dynamic filesystem paths | `open-sse/services/opencodeTlsClient.js:62` (`await import("wreq-js")`) | `tests/unit/opencode-tls-client.test.js:40-61` | **PARITY EXCEEDED**: Direct ESM dynamic import cleanly resolved by Bun runtime. |
| **5** | `e70ea24d` `lazyRuntime.js:93-100` | Deletes broken install directory and retries install once if module resolution fails | Recovers from partial npm extractions | `open-sse/services/opencodeTlsClient.js:148-170` | `tests/unit/opencode-tls-client.test.js:179-217` | **PARITY EXCEEDED**: Rather than spawning recursive npm calls, KhatamRouter logs a warning once and fails open to native Bun fetch, guaranteeing zero request interruption. |
| **6** | `3b7acf72` `Dockerfile:36-52` | Runs `mkdir -p /opt/lazy-runtime && npm install wreq-js playwright-core` in builder stage | Next standalone tracing excludes lazily required packages from production container | `Dockerfile:36`, `package.json:58` (`bun install --include=optional`) | `tests/unit/opencode-tls-client.test.js:250-258,288-302` | **PARITY EXCEEDED**: Bun installs optional dependencies cleanly during build; no isolated `/opt/lazy-runtime` npm stage required. |
| **7** | `3b7acf72` `Dockerfile:70-71` | `COPY --from=builder /opt/lazy-runtime/node_modules/. ./node_modules/` in runner stage | Ensures runner stage contains runtime packages omitted by Next tracing | `Dockerfile:94-95` (`COPY --from=builder /app/node_modules/wreq-js ./node_modules/wreq-js`, `COPY .../@wreq-js ...`) | `tests/unit/opencode-tls-client.test.js:250-258` | **VERIFIED**: Runner stage explicitly receives `wreq-js` and native `@wreq-js/*` platform binaries directly from builder `node_modules`. |
| **8** | `3b7acf72` `Dockerfile:103` | Verifies wreq-js availability in container | Validates wreq-js runtime resolution | `Dockerfile:103`, `Dockerfile.bun:103` (`bun -e "import('wreq-js').then(...)"`) | `specs/013-upstream-0-5-112/results/dockerfile-identity.txt` | **VERIFIED**: Dockerfile contains smoke test verifying `createSession` function on image build. |

---

## 3. Upstream Gaps Closed & KhatamRouter Hardening

1. **Zero Child Processes & Zero npm at Runtime**:
   Upstream's approach requires node/npm binaries in production environments, exposing attack surface to arbitrary package execution and filesystem mutation in `~/.9router/runtime`. KhatamRouter completely eliminates runtime package downloads.

2. **Security & SSRF Hardening**:
   - `isOpencodeHost(url)`: Validates that outgoing requests strictly target `opencode.ai` or its subdomains over HTTPS (`open-sse/services/opencodeTlsClient.js:47-57`).
   - `redirect: "manual"`: Prevents OpenCode credentials from leaking to off-host endpoints across HTTP redirects (`open-sse/services/opencodeTlsClient.js:113`).
   - `session.clearCookies()`: Guarantees that cookies set by one user/request are never replayed on subsequent requests (`open-sse/services/opencodeTlsClient.js:125`).

3. **Byte-Identical Dockerfiles**:
   Upstream modified only `Dockerfile`, diverging from any alternate docker configurations. KhatamRouter maintains 100% byte-identity between `Dockerfile` and `Dockerfile.bun`, verified by automated regression checks (`tests/unit/opencode-tls-client.test.js:299-301` and `specs/013-upstream-0-5-112/results/dockerfile-identity.txt`).

---

## 4. Verification Evidence

- **Unit Test Command**:
  ```bash
  cd /tmp/khatam-013/tests && env -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy bun x --bun vitest run unit/opencode-tls-client.test.js
  ```
  Result: **17 passed** (17 tests, 54 `expect(` assertions, 0 skips).
- **Dockerfile Identity**:
  `cmp Dockerfile Dockerfile.bun` returns exit code 0 (`DOCKERFILES_IDENTICAL`).

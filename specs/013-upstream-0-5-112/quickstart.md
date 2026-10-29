# Quickstart 013: Upstream v0.5.112 Port Developer Guide

This guide walks through verifying and running the features and fixes ported in Spec 013.

## 1. Prerequisites
- **Runtime**: Bun strictly required (`bun --version` >= 1.4.3).
- **Environment**: Linux, macOS, or Windows (WSL2 / native).
- **Optional**: Redis running locally (`redis-server`) for multi-worker cluster testing.

---

## 2. Test Execution Commands

Run all tests associated with Spec 013 packages:

```bash
# From repository root
cd tests

# 1. Package 1: Core Routing, Protocols & Error Handling
bun x vitest run unit/gemini-schema-array-items-predicate.test.js
bun x vitest run unit/nonstream-sse-error.test.js
bun x vitest run unit/param-support.test.js
bun x vitest run unit/codebuddy-channel-headers.test.js
bun x vitest run unit/codebuddy-intl-backoff.test.js
bun x vitest run unit/bulk-add-names.test.js
bun x vitest run unit/deepseek-pow-hash.test.js

# 2. Package 2: Provider Registry & Model Catalogs
bun x vitest run unit/codex-gpt6-lite.test.js
bun x vitest run unit/qoder-frontier-models.test.js
bun x vitest run unit/github-claude-5-5-thinking.test.js
bun x vitest run unit/commandcode-headers.test.js
bun x vitest run unit/commandcode-usage.test.js
bun x vitest run unit/nace-systemone-provider.test.js

# 3. Package 3: Auth & MiniMax Desktop Lease
bun x vitest run unit/minimax-code-lease.test.js

# 4. Package 4: OpenCode TLS & Full Regression Verification
bun x vitest run unit/opencode-tls-client.test.js
```

---

## 3. Regenerating Registry Index and Baselines

When modifying provider definitions or adding new providers (such as `nace`):

```bash
# 1. Regenerate open-sse/providers/registry/index.js
bun run scripts/migrate-registry.mjs

# 2. Verify and update provider and alias baseline snapshots
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

---

## 4. Verifying MiniMax Desktop Lease Broker Locally

To test the MiniMax Desktop Lease broker without running the full desktop application:

```javascript
// Quick mock socket runner (POSIX Unix domain socket)
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dataDir = path.join(os.tmpdir(), "mcode-test");
const runDir = path.join(dataDir, "run");
fs.mkdirSync(runDir, { recursive: true });

const cap = "A".repeat(43);
fs.writeFileSync(path.join(runDir, "mcode-auth-lease-v1.cap"), cap);

const sockPath = path.join(runDir, "mcode-auth-lease-v1.sock");
try { fs.unlinkSync(sockPath); } catch {}

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    // Reply with a valid lease frame
    const payload = Buffer.from(JSON.stringify({
      ok: true,
      requestId: "mock",
      result: {
        accessToken: "mock-jwt-token",
        generation: 1,
        expiresAtMs: Date.now() + 300000,
      }
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
  });
});

server.listen(sockPath, () => {
  console.log(`Mock MiniMax broker listening on ${sockPath}`);
});
```

---

## 5. Dockerfile Byte-Identity Check

Verify that `Dockerfile` and `Dockerfile.bun` remain 100% byte-identical:

```bash
cmp Dockerfile Dockerfile.bun && echo "DOCKERFILES_IDENTICAL"
```

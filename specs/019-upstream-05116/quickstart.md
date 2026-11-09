# Validation quickstart

Run commands from the isolated port checkout, not the unrelated dirty primary tree. Runtime prerequisites: Bun matching `.bun-version`, Git and GitHub CLI. Container checks are performed by a Haiku verification worker against a pinned revision using isolated container/data names.

```bash
bun install --frozen-lockfile
cd tests
bun install --frozen-lockfile
bun x --bun vitest run unit/no-typescript-guard.test.js unit/display-branding-guard.test.js
cd ..
bun tests/__baseline__/verify-providers.mjs
bun tests/__baseline__/verify-alias.mjs
bun tests/__baseline__/verify-oauth-urls.mjs
bun scripts/verify-docs-claims.mjs
```

```bash
bun scripts/verify-019.mjs --self-test
bun scripts/verify-019.mjs
cd tests && bun x --bun vitest run \
  translator/thinking-tool-result-turns.test.js \
  unit/audio-voices-internal-auth.test.js \
  unit/cli-019-bun.test.js \
  unit/cli-launcher-process.test.js \
  unit/cli-tools-add-all-active-models.test.js \
  unit/cli-tray-runtime.test.js \
  unit/codebuddy-intl-system-prompt.test.js \
  unit/codex-native-image-generation.test.js \
  unit/commandcode-import-guard.test.js \
  unit/dashscope-claude-cache.test.js \
  unit/deepseek-thinking-budget.test.js \
  unit/econnreset-repro.test.js \
  unit/gemini-request-tool-results.test.js \
  unit/media-019-security.test.js \
  unit/oauth-commandcode-auto-import.test.js \
  unit/proxy-keepalive-dead-socket.test.js \
  unit/tool-dedupe.test.js \
  unit/transport-019-safety.test.js \
  unit/transport-019-packaging.test.js \
  unit/web-fetch-formats.test.js \
  translator/agent-client-fixes.test.js \
  unit/opencode-test-no-probe.test.js \
  unit/qoder-proxy-replay.test.js \
  unit/qoder.test.js
```

## Evidence review

1. Verify release boundaries and exhaustive commit inventory against upstream history.
2. Check each disposition against current local source and behavior-specific tests.
3. Inspect Bun-only adaptations and negative authentication/network scenarios.
4. Re-run leaf gates independently, then integration/build/container checks.
5. Reconcile any concurrent master changes; re-run impacted checks before merge.
6. Confirm all required GitHub checks pass, merge the reviewed PR and verify its resulting master revision.

Refer to [contracts/parity.md](contracts/parity.md) for runtime/security boundaries and [data-model.md](data-model.md) for evidence states. Live provider calls are not made without configured authorized credentials, and mocked results are never labeled live verification.

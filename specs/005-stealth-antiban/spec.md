# Feature Specification: Wave 5 — Stealth and Anti-Ban Suite

**Feature Branch**: `005-stealth-antiban`
**Created**: 2026-10-22
**Status**: Draft
**Input**: User description: "Wave 5: stealth and anti-ban suite. Canonical CLI header and field ordering, reverse-proxy header scrubbing, tool-name cloaking with schema sanitisation and RESTORE map, zero-width joiner obfuscation with Persian half-space preservation, and first-message SHA-256 session stickiness with fail-open semantics. All capabilities default-OFF behind CLI_COMPAT_<PROVIDER>=1 / STEALTH_*=1 flags."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Canonical CLI Header and Field Ordering (Priority: P1)

Upstream AI providers inspect the presence, exact casing, and serialization ordering of HTTP headers and JSON request body fields to detect third-party proxies and automation tools. When CLI compatibility is enabled for a provider, outgoing requests must match the exact header order and top-level JSON body field sequence of official native CLI tools (Claude Code, OpenAI Codex, GitHub Copilot, Google Antigravity, Cursor).

**Why this priority**: Header and JSON key order are primary fingerprinting surfaces used by provider gateways to flag accounts or reject traffic.

**Independent Test**: Pass unordered headers and arbitrary body fields through `applyFingerprint(provider, headers, body)` and verify that the output headers and JSON string keys match the official profile's specified sequence with unlisted fields appended in original order.

**Acceptance Scenarios**:

1. **Given** CLI compat is enabled for `codex`, **When** headers and body are processed, **Then** headers follow `["Host", "Content-Type", "Authorization", "Accept", "User-Agent", "Accept-Encoding"]` and body fields follow `["model", "stream", "input", ...]` with unlisted items preserved at the end.
2. **Given** CLI compat is enabled for `claude`, **When** headers are processed, **Then** headers follow the canonical Title-Case / Stainless / Anthropic sequence.
3. **Given** CLI compat is disabled (default), **When** `applyFingerprint` is invoked, **Then** headers and body remain untouched.
4. **Given** request body containing internal engine markers (`_khatam*`, `_omniroute*`, `_claudeCodeRequiresLowercaseToolNames`), **When** processed, **Then** internal markers are stripped before upstream transmission.

---

### User Story 2 - Reverse-Proxy Header Scrubbing and Encoding Normalization (Priority: P1)

When traffic passes through reverse proxies (e.g. Nginx, Cloudflare, local gateway) or Electron/browser clients, HTTP request headers contain tracking headers (`x-forwarded-for`, `x-real-ip`, `via`) and browser fingerprints (`sec-ch-ua*`, `sec-fetch-*`, `priority`, `zstd` in `accept-encoding`). Sending these reveals third-party proxy infrastructure.

**Why this priority**: Proxy headers explicitly signal to upstreams that requests are being forwarded rather than originating from native developer terminals.

**Independent Test**: Pass headers containing forwarding headers, Chromium sec-ch tags, and non-standard encoding to `scrubHeaders()` and verify all proxy/browser markers are stripped while standard Node.js encoding (`gzip, deflate, br`) is enforced.

**Acceptance Scenarios**:

1. **Given** headers with `x-forwarded-for`, `x-real-ip`, `via`, `forwarded`, **When** scrubbed, **Then** all proxy tracing headers are removed.
2. **Given** headers with `sec-ch-ua`, `sec-fetch-mode`, `priority`, **When** scrubbed, **Then** all browser markers are removed.
3. **Given** headers with `Accept-Encoding: gzip, deflate, br, zstd`, **When** scrubbed with encoding normalization enabled, **Then** `Accept-Encoding` is normalized to `gzip, deflate, br`.
4. **Given** stealth scrub is disabled (default), **When** `scrubHeaders` is invoked, **Then** the headers object is returned untouched.

---

### User Story 3 - Tool-Name Cloaking, Schema Sanitisation, and RESTORE Map (Priority: P1)

Providers inspect tool definitions and tool calls. Third-party agent frameworks often emit non-standard snake_case tool names (`read_file`, `run_command`, `bash`) or schemas with disallowed keywords (`$schema`, `$id`, `$ref`, empty `required`). Outgoing tools must be sanitized and mapped to canonical PascalCase names (`Read`, `Bash`) with a RESTORE map stored so upstream responses can be transparently decloaked before reaching the client.

**Why this priority**: Prevents provider-side tool signature bans while ensuring client tools continue functioning as intended.

**Independent Test**: Pass a body declaring `read_file` and `run_command` with `$schema` in parameters to `cloakToolsInRequest()`. Verify tools and history calls are renamed to `Read` and `Bash`, parameters are sanitized, and `decloakToolsInResponse()` reverses `Read` back to `read_file` in both JSON objects and SSE text deltas.

**Acceptance Scenarios**:

1. **Given** a request with lowercase/snake_case tool declarations (`bash`, `read_file`, `grep_search`), **When** cloaked, **Then** tools are converted to canonical PascalCase names (`Bash`, `Read`, `Grep`) and a RESTORE map is returned.
2. **Given** tool parameters containing `$schema`, `$id`, or empty `required: []`, **When** sanitized, **Then** non-standard keywords are cleanly stripped and root `type: "object"` is ensured without mutating input.
3. **Given** Anthropic built-in server tools (`web_search_20250305`, `bash_20250124`) or MCP tools (`mcp__*`), **When** processed, **Then** they are preserved without modification.
4. **Given** a streaming SSE chunk or JSON response containing cloaked tool calls, **When** passed through `decloakToolsInResponse(response, restoreMap)`, **Then** original client tool names are restored.

---

### User Story 4 - Zero-Width Obfuscation and Persian Half-Space Preservation (Priority: P2)

Agent words (e.g. `opencode`, `cline`, `khatam`) in system prompts or user text can trigger anti-bot detection. Obfuscating them by inserting `U+200D` (ZERO WIDTH JOINER) after the initial character conceals the words from naive substring filters. When stripping zero-width joiners on output, legitimate linguistic characters—specifically `U+200C` (ZERO WIDTH NON-JOINER / نیم‌فاصله in Persian/Farsi) and emoji sequences—must be strictly preserved.

**Why this priority**: Protects prompt text while guaranteeing zero corruption of Persian text and emoji sequences.

**Independent Test**: Pass agent keywords, Persian text with half-spaces (`می‌روم`, `کتاب‌ها`), and emoji ZWJ sequences (`👨‍👩‍👧`) through obfuscation and stripping functions.

**Acceptance Scenarios**:

1. **Given** the word `opencode`, **When** obfuscated, **Then** a `U+200D` joiner is inserted after the first letter (`o‍pencode`).
2. **Given** an obfuscated word `o‍pencode`, **When** stripped with `stripObfuscationZeroWidth()`, **Then** the joiner between ASCII word characters is removed, restoring `opencode`.
3. **Given** Persian text with ZWNJ (`می‌روم`, `کتاب‌ها`, `ارائه‌دهنده`), **When** processed with `stripObfuscationZeroWidth()`, **Then** the `U+200C` half-space is preserved intact.
4. **Given** emoji ZWJ sequences (`👨‍👩‍👧`), **When** processed, **Then** the emoji joiners are preserved intact.

---

### User Story 5 - First-Message Session Stickiness with Fail-Open Semantics (Priority: P2)

Multi-turn conversations routed across different upstream accounts on each turn lose prompt-cache benefits and cause rapid cache eviction or provider account scrutiny. Session stickiness pins a conversation to a healthy connection using the SHA-256 hash of the conversation's first user message.

**Why this priority**: Maximizes upstream prompt-caching hit rates (cutting token costs and latency) and maintains consistent session affinity.

**Independent Test**: Generate session keys from multi-turn message arrays, record and lookup sticky connection bindings, verify TTL expiration, LRU eviction at cap, and fail-open behavior on malformed inputs.

**Acceptance Scenarios**:

1. **Given** a message array with an initial user message, **When** `computeSessionKey()` is called across different turns of the same conversation, **Then** the key is identical.
2. **Given** an active pinned connection, **When** `getStickyConnection()` is called within TTL (15 minutes), **Then** the pinned `connectionId` is returned.
3. **Given** a pin whose TTL has expired, **When** `getStickyConnection()` is called, **Then** it returns `null` and cleans the entry.
4. **Given** malformed inputs, missing messages, or unexpected object types, **When** stickiness functions are called, **Then** they fail open and return `null` without throwing.

---

## Non-Functional Requirements

- **NR1: Default-Off Isolation**: Every capability is completely inactive when its controlling flag (`CLI_COMPAT_<PROVIDER>`, `CLI_COMPAT_ALL`, `STEALTH_*`, `STEALTH_ALL`) is unset or 0.
- **NR2: Fail-Open Resilience**: No stealth function may crash the request pipeline; any parsing or processing errors fall back to returning original inputs untouched.
- **NR3: Pure & Unit-Testable**: Modules in `src/lib/stealth/` must be pure functions or self-contained state stores with zero unmockable side effects.
- **NR4: Security & Privacy**: No credentials, auth tokens, or user data may be leaked into logs or persistent storage.

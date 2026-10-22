# Implementation Plan: Wave 5 — Stealth and Anti-Ban Suite

**Branch**: `005-stealth-antiban` | **Date**: 2026-10-22 | **Spec**: [Feature Spec](./spec.md)

**Input**: Feature specification from `/specs/005-stealth-antiban/spec.md`

---

## Summary

Wave 5 implements client signature emulation, anti-fingerprinting defenses, and prompt-cache affinity across five pure, modular JavaScript components under `src/lib/stealth/`:

1. **`cliFingerprints.js`**: Canonical HTTP header and JSON body field ordering per native CLI tool profile (`codex`, `claude`, `claude-code-compatible`, `github`, `antigravity`, `cursor`). Strips internal router markers and orders headers case-insensitively.
2. **`headerScrub.js`**: Strips proxy-tracing headers (`x-forwarded-for`, `x-real-ip`, `via`), Chromium/browser metadata (`sec-ch-*`, `sec-fetch-*`), and normalizes `Accept-Encoding` to Node.js defaults (`gzip, deflate, br`).
3. **`toolCloak.js`**: JSON schema sanitisation (stripping `$schema`, `$id`, `$ref`, empty `required`) and canonical PascalCase tool remapping with a bidirectional RESTORE map for transparent response decloaking.
4. **`zeroWidth.js`**: Sensitive agent word obfuscation via `U+200D` insertion between ASCII word characters, paired with selective joiner stripping that strictly preserves Persian half-spaces (`U+200C`) and emoji ZWJ sequences.
5. **`stickiness.js`**: SHA-256 first-message conversation affinity caching with 15-minute TTL, LRU bounded eviction (500 entries), and strict fail-open semantics.

All components are completely inactive unless activated by operator environment flags (`CLI_COMPAT_<PROVIDER>=1`, `CLI_COMPAT_ALL=1`, `STEALTH_*=1`, `STEALTH_ALL=1`).

## Technical Context

**Language/Version**: JavaScript ES2022 (ESM modules). Bun 1.4.3 runtime; Node 22+ fallback.
**Target Subtree**: `src/lib/stealth/*.js`, `tests/unit/wave5-stealth.test.js`.
**Typecheck**: Checked by `tsconfig.typecheck-core.json` (`src/lib/**/*.js`).
**Testing**: Vitest (`tests/unit/wave5-stealth.test.js`).

## Design Decisions

### D1. Pure, non-mutating transformation interfaces
All transformation functions (`orderHeaders`, `orderFields`, `scrubHeaders`, `sanitizeToolSchema`, `cloakToolsInRequest`, `decloakToolsInResponse`, `stripObfuscationZeroWidth`) return fresh objects or strings rather than mutating their inputs. This prevents subtle side-effects on request retry or fallback paths.

### D2. Fine-grained and global feature flags
Operators can enable stealth globally (`STEALTH_ALL=1` or `CLI_COMPAT_ALL=1`) or per-feature (`STEALTH_FINGERPRINTS=1`, `STEALTH_HEADER_SCRUB=1`, `STEALTH_TOOL_CLOAK=1`, `STEALTH_ZERO_WIDTH=1`, `STEALTH_STICKINESS=1`) or per-provider (`CLI_COMPAT_<PROVIDER>=1`). When unconfigured, all functions act as zero-overhead passthroughs.

### D3. Robust boundary preservation for zero-width characters
Stripping joiners uses lookbehind/lookahead assertion `(?<=[A-Za-z0-9_])[‌‍]+(?=[A-Za-z0-9_]|$)` so non-ASCII characters (such as Persian / Arabic letters `می‌روم` and emojis `👨‍👩‍👧`) are never matched or corrupted.

### D4. In-memory, bounded session stickiness
Session affinity pins use an in-memory Map with timestamps and a hard ceiling of 500 entries to prevent memory exhaustion, expiring after 15 minutes. Any lookup or hashing failure safely returns `null` (fail-open) to allow normal target ordering.

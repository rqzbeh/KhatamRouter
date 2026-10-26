# Research & Design Decisions: Dashboard and Tooling

**Branch**: `spec/010-wave8-dashboard-tooling`  
**Date**: 2026-10-26  
**Status**: Completed  

---

## 1. Plain JavaScript (ESM) & Next.js App Router Architecture

### Decision
Keep Next.js App Router with Webpack bundler (`--webpack`) as ratified in Wave 7.5. Maintain plain JavaScript (ESM) per project Principle II across all components (`ConnectionLimitsModal.js`, `KeyQuotaView.js`, `SpendTrendsChart.js`, `CapacityBadges.js`). No TypeScript.

### Rationale
- Turbopack was formally evaluated and rejected in Wave 7.5 (Spec 0075) due to +52% standalone bundle inflation (137 MB vs 90 MB) and inotify overhead on dynamic filesystem imports. Webpack remains fast, stable, and correctly respects custom module exclusions.
- Full compliance with Principle II (CLAUDE.md): plain JavaScript (ESM), NO TypeScript.
- Pure JavaScript components coexist seamlessly with `@/*` path aliases resolved via `jsconfig.json`.

### Alternatives Considered
- *TypeScript Migration*: Rejected per project constitution Principle II and PR #64.
- *Pure JS with PropTypes / JSDoc*: Adopted. JSDoc type annotations provide developer guidance without TypeScript compiler build overhead.

---

## 2. Per-Connection Limits Modal & Persistence Architecture

### Decision
Implement `src/shared/components/ConnectionLimitsModal.js` as a focused dialog triggered from a "Limits" action button on `ConnectionRow.js`. Persist limits via authenticated endpoint `PUT /api/providers/[id]` (reusing existing connection update pipeline) or dedicated `PUT /api/providers/[id]/limits` (fail-closed, requires dashboard session auth). Inputs are validated and sanitized via `open-sse/services/rateLimitManager/overrides.js` (`sanitizeConnectionLimitOverrides` and `validateConnectionLimitOverrides`).

### Rationale
- Existing SQLite schema already includes `providerConnections.rate_limit_overrides_json` (added in Wave 2, wired in Wave 3).
- `open-sse/services/rateLimitManager/overrides.js` already provides strict sanitization for `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxConcurrent`, `maxWaitMs`, `executionMaxWaitMs`, and `modelConcurrency`.
- Adding `maxBudgetUsd` to `ALLOWED_NUM_FIELDS` in `overrides.js` as an additive non-negative finite number (`>= 0`) allows storing and displaying connection-level budget caps without dropping the field during sanitization.
- *Budget enforcement note*: Request-time spend caps in KhatamRouter are currently enforced per-API-key via `api_key_quota_limits` and `request_cost_ledger`. Because `request_cost_ledger` records usage by `(api_key_id, provider, model)` and does not track connection IDs, connection-level budget enforcement does not exist in the runtime today. In this delivery, `maxBudgetUsd` is strictly scoped to STORING and DISPLAYING the cap in connection views; active request-time budget blocking is an explicit out-of-scope follow-up.
- Keeping the Limits modal dedicated rather than stuffing all fields into `EditConnectionModal.js` keeps credentials/proxy configuration isolated from operational rate limiting.

### Alternatives Considered
- *Overloading EditConnectionModal*: Rejected. `EditConnectionModal.js` is already 390 lines handling Azure, AWS Bedrock SSO, Cloudflare AI, proxy pools, and credential testing. A separate modal follows single-responsibility principles.

---

## 3. Key Quota Tabs & Spend Trends Architecture

### Decision
On `/dashboard/quota`, introduce a top-level tab switcher (`SegmentedControl`) toggling between "Provider Limits" (the existing `ProviderLimits/index.js`) and "API Key Quotas" (`KeyQuotaView.js`). Additionally expose key quota details via drawer or link from `/dashboard/endpoint`. Backed by authenticated route `GET /api/keys/[id]/quota` and `PUT /api/keys/[id]/quota`.

### Rationale
- `/dashboard/quota` currently only hosts `ProviderLimits` (upstream account quota tracking for Claude, Codex, Kiro). Adding API key quota tracking here unifies all quota management in one logical dashboard location.
- The data layers already exist from Wave 2 and Wave 3:
  - `api_key_quota_limits`: defines `rpm`, `rph`, `rpd`, `tpm`, `tpd`, `daily_usd`, `weekly_usd`, `monthly_usd`.
  - `api_key_quota_counters`: sliding-window counter buckets stored in SQLite or Redis.
  - `request_cost_ledger`: per-request transaction ledger with prompt/completion tokens and total USD cost.
- Function `getCumulativeSpendForWindow` and `getCumulativeSpendFromLedger` in `src/lib/db/keyQuota.js` can be queried to compute spend trends over 24h, 7D, and 30D without any schema changes.

### Alternatives Considered
- *Inlining key quota tables directly into Endpoint page*: Rejected. Endpoint page is already over 1100 lines and focuses on connection URLs, tunnels (Tailscale/Cloudflare), and key generation. Quota analytics belongs under `/dashboard/quota`.

---

## 4. Capability Modality Badges Architecture

### Decision
Create `src/shared/constants/capacityMeta.ts` and `src/shared/components/CapacityBadges.tsx` to supersede `src/shared/components/CapacityBadges.js` with backward-compatible re-exports. Expand badge definitions from just `vision` and `reasoning` to all 9 supported modalities and features in `open-sse/providers/capabilities.js`:
- `vision`: Visibility icon (`visibility`), blue (`text-blue-500`)
- `pdf`: Document icon (`description`), orange (`text-orange-500`)
- `audioInput`: Mic icon (`mic`), purple (`text-purple-500`)
- `videoInput`: Video camera icon (`videocam`), rose (`text-rose-500`)
- `imageOutput`: Image icon (`image`), emerald (`text-emerald-500`)
- `audioOutput`: Speaker icon (`volume_up`), indigo (`text-indigo-500`)
- `search`: Grounding icon (`travel_explore`), cyan (`text-cyan-500`)
- `tools`: Tool icon (`build`), green (`text-emerald-600`)
- `reasoning`: Brain/neurology icon (`neurology`), amber (`text-amber-500`)

For combos, badges are computed via `aggregateComboCapabilities()`:
- Modalities & Search: Union (`some`)
- Tools: Intersection (`every`)
- Reasoning: Primary model thinking capabilities (`first`)

### Rationale
- Single source of truth: `open-sse/providers/capabilities.js` already exports `DEFAULT_CAPABILITIES`, `MODEL_CAPABILITIES`, and `aggregateComboCapabilities()`.
- Clear, visual indicators prevent operators from dispatching images to text-only models or building combos where fallback models lack required tool capabilities.

---

## 5. CLI Launcher Architecture (Plain JavaScript)

### Decision
Preserve the existing lightweight plain JavaScript CLI routines under `cli/`:
- `cli/cli.js`: Executable shebang script that parses CLI flags, runs the actionable `ensureBun()` check, and handles operational commands.
- `cli/scripts/build-cli.js`: Packaging script for published `9router` npm bundle without native Go binaries.
- The proposed TypeScript CLI rewrite (`cli/src/ts/**`) was removed to adhere strictly to Principle II (NO TypeScript).

### Rationale
- Backward compatibility: Existing npm users invoke `9router` via global bin `./cli.js` with flags like `--port`, `--host`, `--no-browser`, `show`, `connect`.
- Safe runtime check: The actionable Bun prerequisite message in `cli/cli.js` is critical because Node-only fallback drivers were removed in Wave 7.5.
- Single runtime / no TS build step: Eliminating TypeScript in the CLI removes build complexity, dependencies, and adheres strictly to project conventions.

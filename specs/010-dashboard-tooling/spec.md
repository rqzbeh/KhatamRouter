# Feature Specification: Dashboard and Tooling

**Feature Branch**: `spec/010-wave8-dashboard-tooling`  
**Created**: 2026-10-26  
**Status**: Completed (PR #71, PR #72; converted to plain JavaScript)  
**Input**: User description: "Dashboard and Tooling: (1) Plain JS limits modals for per-connection rate limits/concurrency/budget caps, (2) key quota tabs (per-key quota utilisation, sliding-window consumption, spend trends), (3) capability badges on provider tables + combo builders."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Per-Connection Rate Limits, Concurrency Ceilings & Budget Caps (Priority: P1)

As an API gateway administrator, I need a dedicated React dialog (`ConnectionLimitsModal.js`) on the Providers dashboard to configure per-connection rate limits (`rpm`, `rpd`), token limits (`tpm`, `tpd`), inter-request pacing (`minTime`), wait ceilings (`maxWaitMs`), in-flight concurrency caps (`maxConcurrent`, per-model concurrency map), and USD budget caps (`maxBudgetUsd`), so that I can prevent upstream provider rate-limit bans, balance workloads across accounts, and prevent accidental overspending.

**Why this priority**: Directly protects upstream provider accounts from being banned or depleted due to sudden bursts. Complements Wave 3 granular limits by providing administrators with full UI visibility and control over `rate_limit_overrides_json` without manual database manipulation.

**Independent Test**: Can be tested independently by opening the Limits modal on a provider connection row in the dashboard, setting limit values (e.g. RPM: 60, maxConcurrent: 4, minTime: 500ms, modelConcurrency: `{"claude-sonnet-4": 2}`), submitting the form, and asserting that:
1. The sanitized values persist in `providerConnections.rate_limit_overrides_json` via `PUT /api/providers/[id]`.
2. Connection-level rate and concurrency limits are enforced during subsequent gateway requests.
3. Invalid inputs (negative numbers, non-numeric strings, unknown keys) trigger clear client-side validation errors and fail closed.

**Acceptance Scenarios**:

1. **Given** an existing provider connection on `/dashboard/providers/[id]`, **When** the administrator clicks the "Limits" action on a connection row, **Then** the `ConnectionLimitsModal` opens, displaying current values populated from `connection.rate_limit_overrides_json` (or empty defaults when no overrides are set).
2. **Given** numeric inputs for `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxWaitMs`, `executionMaxWaitMs`, and `maxConcurrent`, **When** positive finite values are entered and saved, **Then** the gateway updates `rate_limit_overrides_json` with integer-floored values for counts and millisecond timestamps for timeouts.
3. **Given** a per-model concurrency requirement, **When** the administrator adds entries to the model concurrency sub-table (e.g. `gpt-5.6-sol`: 2), **Then** `modelConcurrency` is saved as an object mapping model IDs to positive integers.
4. **Given** a budget ceiling, **When** `maxBudgetUsd` is specified, **Then** the modal validates and persists the cap in `providerConnections.rate_limit_overrides_json` and displays the configured budget cap in connection views; connection-level request-time budget enforcement against `request_cost_ledger` is explicitly out-of-scope for Wave 8 (rate limits, minTime, and concurrency are enforced in-flight; connection-level cost aggregation requires adding connection attribution to `request_cost_ledger` in a follow-up wave).
5. **Given** blank or zero inputs, **When** saved, **Then** those specific limits are cleared from `rate_limit_overrides_json` without affecting other configured fields.
6. **Given** unauthorized or unauthenticated requests to the connection limits API, **Then** the request is rejected with `401 Unauthorized`.

---

### User Story 2 — Key Quota Tabs & Spend Trends Visualization (Priority: P1)

As an API administrator, I need dedicated dashboard views on the Quota and Endpoint pages providing real-time visualization of per-key quota utilization, sliding-window consumption, and historical spend trends, so that I can monitor API consumption, identify heavy consumers, inspect rate-limit buckets, and forecast infrastructure costs.

**Why this priority**: Critical operational visibility. While Wave 2 and Wave 3 introduced `api_key_quota_limits`, `api_key_quota_counters`, and `request_cost_ledger`, operators currently lack a unified UI to inspect live key usage and spend trends across sliding windows.

**Independent Test**: Can be tested independently by navigating to `/dashboard/quota` (or `/dashboard/endpoint` API Key details), switching between "Provider Limits" and "API Key Quotas", selecting an API key, and asserting that:
1. The key quota utilization progress bars display live usage percentages against configured RPM, RPH, RPD, TPM, TPD, and USD budget caps.
2. The sliding-window consumption table displays current active buckets and time-to-reset.
3. The spend trends chart displays cumulative spend and token volumes across 24h, 7d, and 30d periods derived from `request_cost_ledger`.

**Acceptance Scenarios**:

1. **Given** an administrator navigating to `/dashboard/quota`, **When** viewing the page, **Then** a tab switcher allows toggling between "Provider Limits" and "API Key Quotas" (`KeyQuotaView.js`).
2. **Given** an API key with configured rate limits (`rpm`, `rph`, `rpd`) or token limits (`tpm`, `tpd`), **When** viewing its quota card, **Then** progress bars show current consumption, percentage of limit used, and time remaining until the active window resets.
3. **Given** an API key with USD spend caps (`daily_usd`, `weekly_usd`, `monthly_usd`), **When** viewing spend trends, **Then** the UI shows total expenditure versus budget cap with color-coded status (green < 70%, amber 70-90%, red > 90%).
4. **Given** historical requests recorded in `request_cost_ledger`, **When** selecting a period (Today, 24h, 7D, 30D), **Then** `SpendTrendsChart.js` renders a daily/hourly time-series chart showing aggregated USD cost and token breakdown (prompt vs completion).
5. **Given** an unconfigured API key (no explicit quota limits set), **When** inspected in the quota view, **Then** the UI indicates "Unlimited (no quotas enforced)" with option to configure quota limits directly.
6. **Given** a database or Redis storage disconnect, **When** loading key quota views, **Then** the UI gracefully reports degraded state without crashing the dashboard.

---

### User Story 3 — Capability Modality Badges on Provider Tables & Combo Builders (Priority: P2)

As an API user and administrator configuring provider connections and model combos, I need rich visual capability badges across model tables, model pickers, and combo builders highlighting supported input/output modalities (`vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`, `search`, `tools`, `reasoning`), so that I can immediately determine model suitability for multimodal tasks and avoid constructing incompatible combos.

**Why this priority**: Prevents configuration mistakes and enhances discoverability. Operators frequently route multimodal requests (images, audio, documents, thinking models) to combos or models that cannot process them, resulting in runtime 400 errors or silent degradation.

**Independent Test**: Can be tested independently by inspecting `CapacityBadges.js` rendering across:
1. Provider model rows (`src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`): models with vision, reasoning, tools, audio, or search display corresponding colored icon badges with descriptive tooltips.
2. Combo list and combo cards (`src/app/(dashboard)/dashboard/combos/page.js`): combos display aggregated modality badges reflecting the union of inputs, intersection of tools, and primary model reasoning.
3. Combo editor modal (`ComboFormModal.js` and `ModelSelectModal.js`): models in selection lists clearly display their capability badges.

**Acceptance Scenarios**:

1. **Given** a model with capability metadata defined in `open-sse/providers/capabilities.js` (e.g. `claude-fable-5-1`, `gpt-6-sol`, `qwen*vl`), **When** displayed in `ModelRow`, **Then** icon badges render for each active capability:
   - `vision`: visibility icon, blue
   - `pdf`: description icon, orange
   - `audioInput`: mic icon, purple
   - `videoInput`: videocam icon, rose
   - `imageOutput`: image icon, emerald
   - `audioOutput`: volume_up icon, indigo
   - `search`: travel_explore icon, cyan
   - `tools`: build icon, green
   - `reasoning`: neurology icon, amber
2. **Given** a combo definition containing multiple models, **When** rendered on `/dashboard/combos`, **Then** the aggregated combo badges display:
   - Modalities (vision, pdf, audio, video, image, search): active if ANY constituent model supports it (union).
   - Tools: active only if ALL constituent models support tool calls (intersection).
   - Reasoning: reflects the primary (first) model's reasoning capabilities and thinking format.
3. **Given** a custom model added by an administrator with a typed service kind (e.g. `imageToText`, `image`, `stt`, `tts`), **When** displayed in tables and pickers, **Then** `capabilitiesFromServiceKind` maps service kinds into corresponding capability badges.
4. **Given** hover over any capability badge, **When** the cursor hovers, **Then** a tooltip displays the capability name and description (e.g. "Vision — Supports image input").

---

### User Story 4 — Standalone CLI Launcher Preservation (Priority: P2)

As a developer and system operator using the KhatamRouter command-line interface, I need the CLI launcher routines (`cli/cli.js`), configuration inspectors (`9router show`, `9router connect`), utility subcommands (`9router xai video`), and runtime scripts to remain lightweight plain JavaScript (ESM) per project Principle II, while strictly preserving published `9router` package compatibility, command-line flags, and actionable Bun runtime verification.

**Why this priority**: Honors project constitution Principle II (plain JavaScript, NO TypeScript). The proposed TypeScript CLI rewrite and opt-in core under `cli/src/ts/` was removed to keep the CLI lightweight and dependency-free.

**Independent Test**: Can be tested independently by verifying that:
1. `cli/cli.js` continues to function as the primary executable entrypoint with identical argument routing.
2. If Bun is absent, `ensureBun()` aborts with exit code 1 and prints the exact actionable installation instructions.
3. `9router show`, `9router connect`, and `9router xai video` execute with unchanged behavior, flags, and outputs.
4. Operational commands connect to local gateway instances over HTTP/TCP and report structured status.
5. Published CLI runs without TypeScript build artifacts or compiler dependencies.

**Acceptance Scenarios**:

1. **Given** execution of `9router` with no arguments, **When** Bun is available, **Then** the CLI launches the gateway server on default port `20128` (or custom `--port`), verifies TCP readiness, and opens the dashboard unless `--no-browser` is passed.
2. **Given** execution of `9router` in an environment without Bun, **When** invoked, **Then** `ensureBun()` intercepts execution before any child spawn and prints the standard Wave 7.5 Bun-only error message with installation links.
3. **Given** execution of subcommands (`9router show`, `9router connect <url>`), **When** invoked, **Then** the CLI routes to existing command handlers, masking API keys in output and verifying remote connectivity.
4. **Given** execution of `9router status`, **When** the server is running on the local port, **Then** the CLI queries `/api/health` and displays operational metrics (PID, port, uptime, active connections, Redis status).
5. **Given** CLI source code, **Then** plain JavaScript is executed directly under Bun with zero TypeScript dependencies.

---

## Edge Cases

- **Invalid Limit Numbers**: If a user inputs negative numbers, zero, `NaN`, or strings like `"unlimited"` in rate limit fields, the modal must reject the input client-side and the backend sanitizer (`sanitizeConnectionLimitOverrides`) must drop them.
- **Concurrent Limits Updates**: If two dashboard administrators update connection limits concurrently, the SQLite database layer executes an atomic transaction with `busy_timeout = 5000` to prevent partial writes.
- **Empty Quota Ledger**: When viewing key quota tabs for a newly generated API key with zero recorded requests, the spend trend charts must show zero baselines with an empty state placeholder rather than throwing null pointer exceptions.
- **Unsupported Modalities on Combo Models**: When building a combo where the primary model lacks vision but a fallback model supports vision, the combo aggregate badge shows `vision: true` (union), but tool calls only show active if all models in the fallback chain support tools (intersection).
- **Offline / Non-TTY CLI Execution**: When running CLI commands in CI, piped environments, or non-interactive shells, spinners and interactive ANSI cursor movements must automatically disable (`process.stdout.isTTY` check).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a React modal (`ConnectionLimitsModal.js`) accessible from each connection row on `/dashboard/providers/[id]`.
- **FR-002**: System MUST allow configuring and persisting connection limits: `rpm`, `rpd`, `tpm`, `tpd`, `minTime`, `maxWaitMs`, `executionMaxWaitMs`, `maxConcurrent`, `modelConcurrency`, and `maxBudgetUsd`. Note: In this delivery, `maxBudgetUsd` is validated, persisted in `providerConnections.rate_limit_overrides_json`, and displayed in the UI; request-time budget enforcement is an explicit out-of-scope follow-up as `request_cost_ledger` does not yet track connection attribution.
- **FR-003**: System MUST validate all connection limit fields via `validateConnectionLimitOverrides()` and sanitize inputs before saving to `providerConnections.rate_limit_overrides_json`. The backend validator in `open-sse/services/rateLimitManager/overrides.js` MUST additively permit `maxBudgetUsd` as a non-negative finite number (`>= 0`) while strictly preserving existing validation for all other fields.
- **FR-004**: System MUST provide a dedicated "API Key Quotas" view (`KeyQuotaView.js`) on `/dashboard/quota` accessible via a segmented tab control.
- **FR-005**: System MUST compute and display per-key quota utilization percentages and remaining time to window reset for sliding-window rate/token limits.
- **FR-006**: System MUST aggregate historical cost and token data from `request_cost_ledger` and display interactive spend trends (`SpendTrendsChart.js`) across configurable periods (Today, 24h, 7D, 30D, All).
- **FR-007**: System MUST provide authenticated API endpoints `GET /api/keys/[id]/quota` and `PUT /api/keys/[id]/quota` protected by dashboard session cookies and fail-closed access verification.
- **FR-008**: System MUST expand `CapacityBadges.js` to render visual icon badges and informative tooltips for all model capabilities: `vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`, `search`, `tools`, and `reasoning`.
- **FR-009**: System MUST display capability badges on provider model rows (`ModelRow.js`), model selectors (`ModelSelectModal.js`), and combo builder views (`combos/page.js` and `ComboFormModal.js`).
- **FR-010**: Combo capability badges MUST reflect aggregated capabilities computed via `aggregateComboCapabilities` (modality union, tools intersection, primary reasoning).
- **FR-011**: System preserves the plain JavaScript launcher architecture in `cli/cli.js` (TypeScript CLI core removed per Principle II).
- **FR-012**: System MUST preserve published `9router` CLI package backward compatibility, maintaining `./cli.js` as the bin executable, identical flag support (`--port`, `--host`, `--no-browser`), and actionable Bun prerequisite checks.
- **FR-013**: Every UI and tooling task MUST include a runnable test oracle in `tests/unit/` executable via `bun x vitest run`.

---

### Key Entities

- **ConnectionLimitOverrides**: Structured object stored in `providerConnections.rate_limit_overrides_json` defining per-connection rate limits, spacing, wait ceilings, concurrency limits, and budget caps.
- **ApiKeyQuotaLimits**: Database records in `api_key_quota_limits` specifying window type (`rpm`, `rph`, `rpd`, `tpm`, `tpd`, `daily_usd`, `weekly_usd`, `monthly_usd`), limit value, and enforcement action.
- **RequestCostLedgerEntry**: Records in `request_cost_ledger` capturing per-request token usage, prompt/completion token distribution, unit pricing, total USD cost, status, and timestamp.
- **ModelCapabilities**: Normalized dictionary of boolean modality flags, feature switches, thinking format details, and numeric token limits for a specific provider/model tuple.
- **CliCommandContext**: Typed runtime configuration passed to CLI subcommands, containing parsed arguments, flags, base URLs, machine IDs, and HTTP client instances.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Administrators can view and edit connection limits within 2 clicks from the Providers dashboard without page reload.
- **SC-002**: Connection limit updates are validated, sanitized, and persisted in SQLite within 50ms of form submission.
- **SC-003**: Key quota utilization and spend trends render on `/dashboard/quota` in under 300ms for keys with up to 100,000 recorded ledger rows.
- **SC-004**: 100% of supported modalities (`vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`, `search`, `tools`, `reasoning`) display accurate visual badges across provider tables and combo builders.
- **SC-005**: The plain JavaScript CLI passes all unit and integration tests with zero regressions against existing CLI fixtures.
- **SC-006**: Components are implemented in plain JavaScript (ESM) coexisting seamlessly with existing JavaScript App Router routes.

---

## Assumptions

- Next.js App Router remains the dashboard host framework; Webpack is retained as the bundler per Wave 7.5 architectural evaluation.
- Plain JavaScript (ESM) is maintained per Principle II across all dashboard and CLI components.
- Bun `v1.4.3+` is the sole server and test execution runtime.
- Existing database tables (`providerConnections`, `api_key_quota_limits`, `api_key_quota_counters`, `request_cost_ledger`) established in Wave 2 and 3 provide the complete persistence foundation without requiring schema migration.
- Connection Budget Cap Scope: Unlike API key quotas (which enforce daily/weekly/monthly spend caps via `api_key_quota_limits` and `request_cost_ledger` in `domain/keyQuota.js`), provider connections do not currently record connection IDs in `request_cost_ledger`. In this delivery, `maxBudgetUsd` support is strictly scoped to storing and displaying the cap in the UI and backend schemas (`overrides.js`, `providerConnections.rate_limit_overrides_json`, `ConnectionLimitsModal.js`). Active request-time budget blocking is an explicit out-of-scope follow-up.
- `DATA_DIR` temp isolation is used in all automated test oracles touching database adapters to guarantee test independence.

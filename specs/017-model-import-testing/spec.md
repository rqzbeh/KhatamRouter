# Feature Specification: Model Import, Capability Discovery & Batch Testing

**Feature Branch**: `017-model-import-testing`

**Created**: 2026-11-08

**Status**: Draft

**Input**: User description: "Model discovery/import and test all with optional disable failures informed by OmniRoute, plus scoped proxy rotation failures and configurable retry intervals. Imported models should best-effort discover correct context window and capabilities (such as vision), and each model must allow user overrides of incomplete or changed results; manual overrides must survive refresh. Optional automatic model sync with a global settings default and per-provider override including built-in providers and user-created OpenAI/Anthropic-compatible gateways; inherit/enabled/disabled semantics; preserve manual metadata. Distinguish transport health from account quota/access restrictions; never treat retry interval as permission to violate upstream Retry-After or bypass regional restrictions. Bulk tests must flag quota/cost and never disable on indeterminate transport errors. When creating/editing a combo, offer configurable failed-member cooldown (e.g. 1m, 5m, 1h); skip failed members in round-robin and restore eligibility silently after the interval, with correct failover and isolation. Integrate OmniRoute's free proxy providers as opt-in free proxy pools with clear privacy/security implications. The Psiphon VPS investigation must result in an evidence-based fix, with diagnosis contingent on VPS evidence."

> **Lineage**: This feature extends the Wave 6 model-discovery/capability work (Spec 006) and is design-informed by OmniRoute's batch model-test surface (`/api/models/test-all`), its 429 quota-vs-rate-limit classifier, and its scoped proxy-rotation validation model. It is additive: it must not regress the 7-tier capability precedence cascade, the manual-pin protection in the context reconciler, the 4-state circuit breaker (Spec 004), or the Psiphon/strict-proxy fail-closed contract (Specs 014, 016).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover and import models from any connection (Priority: P1)

As an operator, I want to pull the list of models a provider or gateway actually advertises and import them into my catalog in one action, so I do not hand-enter models and never route to a model the upstream has stopped serving.

This must work for built-in providers and for user-created OpenAI-compatible and Anthropic-compatible gateways. Import is defensive: a provider that returns a partial, mixed-shape, or malformed model listing must still import every well-formed record and complete with a report of what failed, never abort the whole import.

**Why this priority**: Without import there is no catalog to test, sync, or override. It is the prerequisite for every other story.

**Independent Test**: Point the importer at a mock gateway returning a well-formed list, then at one returning mixed/malformed records, and confirm the same set of valid models is imported both times with a non-throwing summary (added / updated / skipped / failed).

**Acceptance Scenarios**:

1. **Given** an OpenAI-compatible gateway that advertises `[a, b, c]`, **When** the operator imports, **Then** all three appear in the catalog tagged as imported from that connection.
2. **Given** a listing containing a valid model, a null entry, a string entry, and an entry with an empty id, **When** import runs, **Then** the valid model is imported and the remaining entries are counted as failed/skipped without an exception.
3. **Given** a model already imported, **When** the same listing is imported again, **Then** the model is updated in place (no duplicate) and counts as updated, not added.
4. **Given** a user-created Anthropic-compatible gateway, **When** the operator imports, **Then** import succeeds using that gateway's advertised listing.

---

### User Story 2 - Best-effort capability discovery with durable manual overrides (Priority: P1)

As an operator, I want imported models to have their context window, maximum output, and capabilities (vision, tools, reasoning, and other declared modalities) discovered on a best-effort basis from what the upstream exposes, so the router can make correct routing decisions without me entering every field. When discovery is incomplete, ambiguous, or later changes, I must be able to override any field per model, and my manual overrides must survive every future refresh, re-import, or automatic sync.

**Why this priority**: Incorrect capability data silently corrupts routing (e.g. sending an image to a text-only model) and wrong context windows cause premature truncation. Discovery plus durable overrides are the correctness core of the whole feature.

**Independent Test**: Import a model whose upstream advertises vision and a 200k context window; confirm those values are captured. Set a manual override on the same model for context window and one capability; run repeated syncs/re-imports; confirm the manual values persist and remain identified as operator-set.

**Acceptance Scenarios**:

1. **Given** an upstream record declaring image input and a context window, **When** imported, **Then** the model is recorded with vision supported and that context window.
2. **Given** an upstream record that exposes no modality or limit information, **When** imported, **Then** those fields are marked unknown/incomplete (not fabricated), and any hard capability requirement remains fail-closed.
3. **Given** a model with a manual context-window override, **When** discovery later reports a different value, **Then** the manual override wins and is not overwritten.
4. **Given** a model with a manual capability override, **When** five consecutive refreshes occur, **Then** the manual value is unchanged on every refresh.
5. **Given** a model whose upstream stops advertising a previously discovered capability, **When** refreshed, **Then** a manual override for that capability (if present) is retained and the divergence is surfaced, not silently discarded.
6. **Given** a model with both discovered and operator-overridden fields, **When** the operator inspects it, **Then** each field's provenance (discovered vs. manual) is visible.

---

### User Story 3 - Batch "test all" with safe, optional auto-disable (Priority: P1)

As an operator, I want to run a single action that tests many models on a connection (or across a provider), get a per-model pass/fail report with the reason, and optionally auto-disable models that are genuinely broken — so I can prune dead models quickly without accidentally disabling models that merely hit quota, a regional block, a rate limit, or a transient network failure.

Every result must be classified before any disable decision. Quota/cost exhaustion and access/regional restrictions must be flagged distinctly. Models disabled by the batch run must be re-enableable, and the reason and time of the disable must be recorded.

**Why this priority**: This is the operator-facing payoff of import and capability data; done carelessly it is also the most damaging (mass-disabling healthy models). Safety of the disable decision is the dominant constraint.

**Independent Test**: Run a batch over a fixture that returns, per model, a success, a hard model-not-found error, a quota-exhausted response, a regional 403, a 429 rate-limit, and a connection timeout. With auto-disable enabled, confirm only the hard-failure model is disabled, quota/cost is flagged, and all other classes remain enabled.

**Acceptance Scenarios**:

1. **Given** auto-disable disabled (default), **When** a batch runs, **Then** no model's availability changes regardless of results.
2. **Given** auto-disable enabled and a model returns a hard, model-specific failure, **When** the batch completes, **Then** only that model is disabled and its disable reason and time are recorded.
3. **Given** auto-disable enabled and a model returns quota/cost exhaustion, **When** the batch completes, **Then** the result is flagged as quota/cost and the model is NOT disabled.
4. **Given** auto-disable enabled and a model returns an access/regional restriction, **When** the batch completes, **Then** the model is NOT disabled and the result is flagged as an access restriction (not as a transient failure).
5. **Given** auto-disable enabled and a model returns an indeterminate transport error (timeout, connection reset, proxy transport failure), **When** the batch completes, **Then** the model is NOT disabled and the result is flagged as transport-indeterminate.
6. **Given** consecutive rate-limit (or bot-block) results across models, **When** the configured storm threshold is reached, **Then** the batch halts early, reports the stop reason, and does not disable anything on account of the halt.
7. **Given** a model disabled by a batch run, **When** the operator re-enables it, **Then** it returns to service and the prior disable record is retained for audit.

---

### User Story 4 - Optional automatic model sync with global default and per-provider override (Priority: P2)

As an operator, I want automatic model sync to be optional, controlled by a global setting, and overridable per provider — including built-in providers and user-created OpenAI/Anthropic-compatible gateways — using inherit / enabled / disabled semantics. Automatic sync must preserve my manual metadata.

**Why this priority**: Automation reduces drift, but must be opt-in and must never overwrite operator intent. It depends on Stories 1 and 2.

**Independent Test**: Set the global default to disabled, set one provider to enabled and another to inherit, then run the scheduler: only the explicitly enabled provider syncs. Flip the global default to enabled and confirm the inheriting provider now syncs while the disabled provider does not. Confirm manual overrides and metadata are unchanged after every sync.

**Acceptance Scenarios**:

1. **Given** global default disabled and a provider set to inherit, **When** the scheduler runs, **Then** that provider does not sync.
2. **Given** global default enabled and a provider set to inherit, **When** the scheduler runs, **Then** that provider syncs.
3. **Given** a provider explicitly set to enabled while the global default is disabled, **When** the scheduler runs, **Then** that provider syncs.
4. **Given** a provider explicitly set to disabled while the global default is enabled, **When** the scheduler runs, **Then** that provider does not sync.
5. **Given** a user-created compatible gateway with sync enabled, **When** the scheduler runs, **Then** its models are synced like a built-in provider.
6. **Given** a provider sync that fails or returns a partial listing, **When** it completes, **Then** existing catalog entries and all manual overrides/metadata are preserved, and the failure is reported without wiping the catalog.

---

### User Story 5 - Scoped proxy rotation failures (Priority: P2)

As an operator, I want a proxy-rotation failure to be attributed to the scope where it occurred (global, provider, account, combo, or key) so that a failing rotation for one account or provider does not poison routing for unrelated scopes, and so I can see exactly which scope failed.

**Why this priority**: Rotation is a transport-health concern. Misattributing it (e.g. as an account quota failure) would disable healthy accounts; unscoped attribution would cascade failures. It builds on the proxy-pool and strict-proxy contracts.

**Independent Test**: Force a rotation failure on one account scope while another account and the provider scope are healthy; confirm only the failing scope records the failure, the others keep serving, and a non-global scope without an identifier is rejected.

**Acceptance Scenarios**:

1. **Given** a rotation failure on an account-scoped assignment, **When** recorded, **Then** the record names that scope and only that scope.
2. **Given** a rotation failure on one account, **When** another account or the provider-level pool is used, **Then** the unrelated scope's availability is unchanged.
3. **Given** a non-global scope submitted without a scope identifier, **When** the request is validated, **Then** it is rejected rather than treated as global.
4. **Given** a rotation failure, **When** the failure is classified, **Then** it is treated as transport health, never as account quota exhaustion or credential invalidation.
5. **Given** a strict-proxy or Psiphon-bound connection whose rotation fails, **When** a request is attempted, **Then** the existing fail-closed behavior is preserved (no direct-egress fallback).

---

### User Story 6 - Configurable retry intervals that respect upstream limits (Priority: P2)

As an operator, I want to configure retry intervals (a global default and per-scope/provider overrides) to pace retries and background sync, while the system still honors upstream `Retry-After` and never uses a retry setting to defeat regional or access restrictions.

**Why this priority**: Configurable pacing is operationally valuable, but it must be subordinate to protocol-mandated backoff and legal/regional boundaries. It also feeds the sync scheduler in Story 4 and the batch pacing in Story 3.

**Independent Test**: Configure a retry interval shorter than an upstream `Retry-After`, trigger a rate-limit response, and confirm the effective wait is the longer upstream value. Configure a retry interval and trigger a regional block; confirm retries do not circumvent the block.

**Acceptance Scenarios**:

1. **Given** a configured retry interval shorter than an upstream `Retry-After`, **When** a retry is scheduled, **Then** the effective wait is the upstream value (the configured interval is never allowed to shorten it).
2. **Given** a configured retry interval longer than an upstream `Retry-After`, **When** a retry is scheduled, **Then** the configured interval applies.
3. **Given** any retry-interval configuration, **When** a response indicates a regional/access restriction, **Then** retries are not used to bypass the restriction.
4. **Given** an out-of-range or malformed retry-interval value, **When** saved, **Then** it is rejected with a clear validation error.
5. **Given** a per-provider retry-interval override, **When** that provider retries, **Then** the override applies; other providers keep the global default.

---

### User Story 7 - Configurable combo failed-member cooldown with correct failover and isolation (Priority: P1)

As an operator editing a combo, I want to choose how long a failed member stays out of rotation (for example 1 minute, 5 minutes, or 1 hour), so that a member that just hit a rate limit or outage is skipped on the next round-robin pass and silently becomes eligible again once the interval elapses — without a manual reset and without poisoning healthy members.

**Why this priority**: This extends shipping combo cooldown behavior; getting the scope, the failover timing, and the retry-hint parsing wrong causes exactly the production failures observed (see the regression scenario below), so correctness here is high-risk and high-value.

**Independent Test**: Configure a 5-minute member cooldown, force one member to return a rate-limit, and confirm the next request skips it and fails over promptly to an eligible member; after the interval the member is used again with no operator action; confirm a different combo/scope is unaffected.

**Acceptance Scenarios**:

1. **Given** a combo with a per-combo member cooldown set to 5 minutes, **When** a member fails with a rate-limit, **Then** the next request skips that member and routes to an eligible member.
2. **Given** a member in cooldown, **When** the configured interval elapses, **Then** the member becomes eligible again silently (no operator action, no error surfaced).
3. **Given** a member in cooldown for combo A, **When** combo B or a different caller scope runs, **Then** that member's cooldown does not affect the other scope.
4. **Given** the cooldown options offered when creating/editing a combo, **When** the operator selects a value, **Then** the value is persisted and applied to that combo's member cooldowns.
5. **Given** a member fails, **When** the failure is a hard model-specific error, **Then** the accounting for that failure follows the same scope isolation as the rate-limit case and does not cool down unrelated members.

**Regression scenario — real nested-limit failure (priority: P1)**

A production combo returned an outer `503` whose embedded body carried an upstream `[429]` and a message like "daily free-model limit … reset 00:00 UTC" plus a "Retry after 11114 seconds" hint alongside other, shorter nested reset hints.

1. **Given** a combo member whose upstream responds with an outer 503 wrapping an embedded upstream 429 carrying a daily-limit message and a long retry hint, **When** the request runs, **Then** the route fails over promptly to an eligible combo member (no long stall on the failed member).
2. **Given** the same response, **When** the cooldown for the failed member is set, **Then** it is scoped to that combo/caller scope and respects the reliable retry-after value (the longest trustworthy hint), and the account-vs-model scope is attributed correctly (an account-level daily limit must not be recorded as a model-specific cooldown, and vice versa).
3. **Given** the untrusted error message contains multiple, conflicting reset hints, **When** parsed, **Then** parsing is conservative: only well-formed, bounded values are honored, malformed or absurd values are ignored, and no unrelated member, combo, or account is placed into cooldown as a side effect.

---

### User Story 8 - Free proxy providers as opt-in free proxy pools (Priority: P3)

As an operator, I want to optionally pull rotating proxy lists from public/free proxy providers and use them as a free proxy pool, so I can route without buying a proxy — accepting, with clear disclosure, that these are shared, untrusted, low-trust endpoints.

**Why this priority**: It is a convenience source, not a correctness requirement; it is off by default and carries privacy/security caveats that must be surfaced before use.

**Independent Test**: With all free-proxy sources disabled by default, confirm no outbound fetching occurs and no pool is populated. Enable one source, run a sync, and confirm proxies land in a distinct free pool with provenance; confirm the dashboard shows the privacy/security disclosure.

**Acceptance Scenarios**:

1. **Given** the feature is not enabled, **When** the system runs, **Then** no free-proxy source is contacted and no free-proxy pool is created.
2. **Given** an operator enables a source, **When** a sync runs, **Then** proxies are imported into a pool tagged with that source's provenance.
3. **Given** free proxies are in use, **When** the operator views them, **Then** a clear warning states that these endpoints are third-party, shared, potentially malicious/logging, low-reliability, and unsuitable for sensitive traffic or credentials.
4. **Given** a free proxy that is private/loopback metadata or otherwise unsafe, **When** imported, **Then** it is rejected by the outbound-URL guard.
5. **Given** a free-proxy pool bound to a strict-proxy or Psiphon-scoped connection, **When** the pool is unavailable, **Then** fail-closed behavior is preserved (no direct-egress fallback).
6. **Given** a source that requires a credential or API key, **When** no key is configured, **Then** the source is treated as disabled rather than erroring.

---

### User Story 9 - Evidence-based Psiphon VPS diagnosis and fix (Priority: P3)

As an operator, I want the reported Psiphon VPS problem investigated to root cause using real VPS evidence, then fixed with a reproducible regression test — so we do not ship a guess.

**Why this priority**: A speculative fix would mask the issue and add risk; this story exists specifically to gate a fix behind evidence.

**Independent Test**: With the diagnostic artifacts collected from the VPS, the failing behavior is reproduced in a test, the fix is applied, and the regression test passes; if evidence cannot be obtained, the story is reported blocked rather than "fixed".

**Acceptance Scenarios**:

1. **Given** the Psiphon VPS report, **When** diagnosis begins, **Then** concrete diagnostics are collected (tunnel lifecycle/exit logs, readiness/timing, exit-IP and region observations, error signatures) and recorded as evidence.
2. **Given** collected evidence, **When** a root cause is stated, **Then** it is directly supported by that evidence; a diagnosis MUST NOT be claimed without it.
3. **Given** a confirmed root cause, **When** a fix is implemented, **Then** a reproducible regression test encodes the failure and passes after the fix.
4. **Given** evidence is insufficient to identify a cause, **When** the work concludes, **Then** the story is reported as blocked/unresolved with the evidence gathered — not closed as fixed.

### User Story 10 - Safe custom-gateway discovery and automated sync (Priority: P1)

As an operator, I want model discovery and automated sync against user-created gateway URLs to be safe: the URL is validated against server-side request forgery (SSRF) across literal addresses, DNS resolution, and every redirect hop; I can explicitly declare that a gateway is local/self-hosted; and automated sync handles my gateway credentials safely within bounded scheduling.

**Why this priority**: Custom gateway URLs are operator-supplied and point at arbitrary hosts. Without DNS- and redirect-aware validation, a URL can reach internal services or cloud metadata; an unguarded automated sync that carries credentials can leak them. This is a security boundary adjacent to the import/sync work.

**Independent Test**: With a gateway URL that resolves to a private address (but is not a literal private IP), confirm discovery and sync refuse it; with a URL that redirects from a public host to an internal host, confirm the redirect target is re-validated and refused; with an explicitly declared local/self-hosted gateway on a trusted local origin, confirm it is allowed; confirm credentials are never sent to a redirect target on a different host and never appear in logs.

**Acceptance Scenarios**:

1. **Given** a custom gateway URL whose hostname resolves to a private/loopback/link-local/metadata address but whose literal string is public-looking, **When** discovery or sync fetches it, **Then** the request is refused before any connection is made.
2. **Given** an allowed public gateway URL that responds with a redirect to an internal target, **When** the redirect is followed, **Then** the redirect target is re-validated and refused, and the internal target is never fetched.
3. **Given** an operator explicitly marks a gateway as local/self-hosted on a trusted local origin, **When** discovery or sync runs, **Then** the local endpoint is allowed, and the same is NOT allowed for a request that arrives through a proxy or a non-local peer.
4. **Given** automated sync sends gateway credentials, **When** the endpoint redirects to a different host, **Then** credentials are not forwarded to the new host.
5. **Given** automated sync runs on a schedule, **When** it executes, **Then** it is bounded (finite timeout, maximum redirects, bounded concurrency, a validated interval range) and never blocks request routing.
6. **Given** a gateway with no configured credential or one whose credential is unset, **When** sync runs, **Then** it proceeds only as far as the missing credential permits and never logs the credential value.

---

### Edge Cases

- Upstream model listing is empty, non-JSON, or truncated mid-stream: import completes with zero additions and a clear failure summary; no exception escapes.
- A model disappears from a complete authoritative upstream listing: remove the previously imported model from the active catalog for that source, preserve manual overrides and audit provenance, and report affected combos. Never prune from a failed, partial, filtered, fallback or pagination-incomplete listing, or erase a model still advertised by another source.
- Discovery reports a capability that contradicts a manual override: the manual override wins and the contradiction is visible.
- A model is imported from two connections of the same provider: entries are keyed so they do not duplicate, and provenance distinguishes the connection.
- Auto-sync runs while an operator is editing an override: the edit is never overwritten by the concurrent sync.
- Batch test encounters a mix of quota, regional, rate-limit, and transport failures: every result is classified, none is disabled, and the report separates the classes.
- Batch test is stopped early by a storm threshold: partial results are reported and no disable decision is inferred for untested models.
- Proxy rotation fails on a global scope: the failure is recorded globally but must not be reclassified as an account quota failure.
- Retry interval is set to zero or absurdly high: validation bounds it; a zero interval must not cause a hot retry loop.
- A regional restriction arrives as a generic 403: classification must not treat every 403 as a ban or as transient; only explicit restriction signals are access restrictions.
- A combo member fails with an outer 503 wrapping an embedded 429 and several conflicting reset hints: the shortest trustworthy hint must not cause a premature retry, and the longest must not be truncated into a shorter window; malformed hints are ignored.
- A combo member cooldown set to 1 minute vs. 1 hour: both restore eligibility silently and neither causes a permanent exclusion or a thundering-herd retry at expiry.
- A free-proxy source returns loopback/private/metadata addresses or a malformed list: entries are rejected, the sync completes with an error summary, and the import is not aborted for that reason.
- Only one free-proxy source is enabled and it becomes unreachable: the free pool is not emptied wholesale and existing entries are retained with a reported sync failure.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Discovery & Import

- **FR-001**: System MUST discover the model listing advertised by a selected connection for both built-in providers and user-created OpenAI-compatible and Anthropic-compatible gateways.
- **FR-002**: System MUST import discovered models into the catalog, recording provenance (imported) and the originating connection.
- **FR-003**: Import MUST be defensive: malformed, partial, null, or mixed-shape records MUST be isolated so they never abort the import or throw out of the normalization path.
- **FR-004**: Import MUST be idempotent: re-importing an already-known model MUST update it in place rather than create a duplicate.
- **FR-005**: Import MUST return a summary distinguishing added, updated, skipped, failed and removed records; removal counts are separate from input records.
- **FR-005a**: Import and automatic sync MUST remove confirmed obsolete, previously imported models from active catalog visibility only after a complete successful authoritative snapshot of the relevant source. Missing pagination, malformed/partial/fallback/filtered results and failures MUST suppress pruning; validated authoritative-empty results require explicit handling. Manual overrides, manually created entries and models owned by other active sources MUST be preserved. Affected combo references MUST be surfaced without silent substitution.
- **FR-005b**: Once implemented, the actual discovery/import service MUST be validated against current public provider listings using an isolated disposable database, without production writes or paid inference, in addition to deterministic deletion and failure-safety regression tests.

#### Capability & Context Discovery with Overrides

- **FR-006**: On import and on refresh, System MUST best-effort derive, from what the upstream exposes: context window, maximum output tokens, and capabilities including vision, tools, reasoning, and any declared audio/video modalities.
- **FR-006a**: Capability discovery MUST extend beyond context windows: the existing `contextReconciler` only reconciles context, so capability reconciliation (vision/tools/reasoning/modalities) MUST be added rather than assumed to exist. (Verified: `src/lib/models/contextReconciler.js` reconciles context windows only.)
- **FR-007**: Fields that cannot be determined MUST be marked unknown/incomplete rather than fabricated; hard capability requirements MUST remain fail-closed when support is unconfirmed.
- **FR-008**: System MUST allow the operator to override, per model, any context-window, output-limit, or capability field.
- **FR-008a**: Capability overrides MUST be persisted keyed by provider, model, and source (manual vs auto:discovery), not only by model pattern. (Verified: `model_capability_overrides` today has `model_pattern`, `capabilities_json` only — no `provider`, `model_id`, or `source` columns.)
- **FR-009**: Resolution MUST follow an explicit precedence in which operator (manual) overrides outrank auto-discovered values, which outrank static/pattern/default catalog values; provenance MUST be recorded per field.
- **FR-009a**: Resolution MUST be per-field, not record-level: an override of one field (e.g. context window) MUST NOT discard discovered/static values for other fields. (Verified: `resolveModelCapabilities` currently returns the first matching record wholesale.)
- **FR-009b**: The request-path capability lookup is synchronous, so override reads MUST be served from a cached, invalidated view (populated from persisted rows and invalidated on write/config-reload) rather than an async DB read on the hot path.
- **FR-010**: Manual overrides MUST survive every re-import, refresh, and automatic sync; discovery MUST NOT overwrite a manual override.
- **FR-011**: When discovery diverges from a manual override, System MUST retain the manual value and surface the divergence; redundant auto-discovered values that merely restate a manual choice MUST NOT shadow it.
- **FR-012**: System MUST expose, for each model, which fields are operator-overridden versus discovered.

#### Optional Automatic Model Sync

- **FR-013**: Automatic model sync MUST be optional and controlled by a global default setting.
- **FR-013a**: Sync MUST target the actual configured providers/connections and their advertised model listings, not merely the global `models.dev` catalog. (Verified: `src/lib/modelCatalog/sync.js` fetches only `https://models.dev/api.json` and diffs against the built-in registry; it does not call per-provider `/models` endpoints.)
- **FR-014**: System MUST support a per-provider sync setting with three semantics: inherit (resolve to the global default), enabled, and disabled.
- **FR-015**: Per-provider sync settings MUST apply to built-in providers and to user-created OpenAI/Anthropic-compatible gateways.
- **FR-016**: Automatic sync MUST preserve all manual metadata and manual overrides; it MUST NOT overwrite operator edits.
- **FR-017**: A failed or partial sync MUST NOT wipe or truncate an existing catalog; failures MUST be reported and existing entries retained.
- **FR-018**: Sync scheduling MUST use its own configurable, bounded sync interval (distinct from the retry interval in FR-032..FR-035) and MUST fail open without blocking request routing when sync is unavailable.

#### Batch "Test All" with Optional Auto-Disable

- **FR-019**: System MUST provide a batch test that tests a set of models for a provider/connection and returns a per-model result.
- **FR-020**: System MUST classify every batch result into at least: success, hard model-specific failure, quota/cost exhaustion, access/regional restriction, rate-limited, and transport/indeterminate.
- **FR-021**: Auto-disable MUST be opt-in and, when enabled, MUST disable only hard model-specific failures.
- **FR-022**: System MUST NOT auto-disable on quota/cost exhaustion, access/regional restriction, rate limiting, or indeterminate transport errors.
- **FR-023**: Batch results MUST flag quota/cost outcomes distinctly from rate-limit and transport outcomes.
- **FR-024**: Batch testing MUST halt early after a configurable (or documented default) number of consecutive rate-limit or bot-block results, and report the stop reason; results skipped or untested MUST NOT be treated as failures.
- **FR-025**: Every model disabled by a batch run MUST be re-enableable, and the disable MUST record its reason and time for audit.
- **FR-025a**: Disable-audit metadata MUST be additive and backward-compatible: existing callers of the disabled-model store that expect a `string[]` of ids MUST keep receiving `string[]` (or an equivalent projection), so adding reason/time MUST NOT break `src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, or `src/app/api/models/disabled/route.js`. (Verified: all three callers treat the value as `string[]`.)
- **FR-026**: Batch testing MUST pace requests according to the retry/rate policy and MUST NOT bypass upstream backoff.

#### Scoped Proxy Rotation Failures

- **FR-027**: Proxy-rotation failures MUST be attributed to a scope: global, provider, account, combo, or key.
- **FR-028**: A rotation failure in one scope MUST NOT change the availability, cooldown, or disable state of other scopes.
- **FR-029**: A non-global scope MUST require a scope identifier; a request omitting it MUST be rejected and MUST NOT be silently treated as global.
- **FR-030**: Rotation failures MUST be treated as transport health and MUST NOT be reclassified as account quota exhaustion or credential invalidation.
- **FR-031**: Scoped rotation failures MUST NOT cause credential cycling, and MUST preserve the fail-closed behavior of strict-proxy and Psiphon-bound connections (no direct-egress fallback).

#### Configurable Retry Intervals

- **FR-032**: System MUST allow a configurable retry interval as a global default and per-scope/provider override.
- **FR-033**: The configured retry interval MUST be a floor only: the effective wait MUST be the greater of the configured interval and any upstream `Retry-After`, and MUST never be shorter than upstream backoff.
- **FR-034**: Retry-interval configuration MUST NOT be used to bypass, shorten, or defeat regional/access restrictions, and MUST NOT override a terminal quota/access decision.
- **FR-035**: Retry-interval values MUST be validated against documented bounds; invalid values MUST be rejected. A zero or near-zero interval MUST NOT create an unbounded retry loop.

#### Cross-Cutting

- **FR-036**: Failure classification MUST keep transport health, quota/cost, access/regional restriction, rate limiting, and hard model failure as distinct categories, and each MUST drive only its own handling.
- **FR-037**: All new operator-facing endpoints and actions MUST require the existing dashboard authentication, and secrets/credentials MUST NOT be logged.
- **FR-038**: Import, sync, batch test, and rotation-failure recording MUST be idempotent and bounded in size/concurrency so repeated runs do not compound state.
- **FR-038a**: Every schema change MUST be added as a new migration registered in `src/lib/db/migrations/index.js` with a unique, monotonically increasing version, using the guarded/idempotent `addColumnIfMissing` pattern; the existing `_khatam_migrations` runner records applied versions. (Verified: migrations `001`–`004` are imported and sorted in `migrations/index.js`; `migrate.js` applies by version.)

#### Combo Failed-Member Cooldown

- **FR-039**: When creating or editing a combo, System MUST offer a configurable failed-member cooldown with presets (at minimum 1 minute, 5 minutes, and 1 hour) and persist the selection per combo.
- **FR-040**: While a combo member is in cooldown, round-robin (and other rotation) selection MUST skip that member and MUST route to an eligible member (or fail over) promptly rather than stalling on the cooling member.
- **FR-041**: A member's cooldown MUST expire silently: once the configured interval elapses, the member becomes eligible again with no operator action and no user-visible error.
- **FR-042**: Combo member cooldown MUST be isolated by caller scope so a failure in one combo/scope MUST NOT suppress that member in another combo/scope (no cross-tenant quota denial).
- **FR-043**: Cooldown attribution MUST distinguish an account-level limit from a model-specific failure, and MUST place only the correctly-scoped target into cooldown.
- **FR-043a**: The request handler MUST thread the caller cooldown scope into combo execution so per-request scoped cooldown is actually active; today `handleComboChat` accepts `cooldownScope` but `src/sse/handlers/chat.js` does not pass it, so scoped cooldown is effectively off from the HTTP handler. (Verified.)
- **FR-043b**: Proxy-aware routing MUST integrate the proxy-pool fitness/rotation signals when selecting a pool; today `pickProxyPoolId` (`src/lib/network/connectionProxy.js`) picks by round-robin/random without consulting `proxyPoolFitness.js`, and no production module imports `proxyPoolFitness.js` (only `open-sse/executors/freebuff.js` uses `markPoolUnfit`). (Verified.)
- **FR-044**: When an upstream error carries an outer status wrapping an embedded upstream status and message (for example an outer 503 with an embedded upstream 429), System MUST classify using the embedded signal and honor the most reliable retry-after hint.
- **FR-045**: Parsing of retry/reset hints from untrusted error messages MUST be conservative: only well-formed, bounded values are honored; malformed, non-finite, or absurd values are ignored; and parsing MUST NOT cause an unrelated model, combo, account, or scope to enter cooldown.
- **FR-046**: Cooldown duration MUST NOT truncate a legitimate long retry-after into a shorter window, and MUST NOT extend a short retry into an unbounded stall.

#### Free Proxy Providers (opt-in)

- **FR-047**: System MUST support importing proxy lists from external free-proxy sources as free proxy pools, disabled by default.
- **FR-048**: Enabling a free-proxy source MUST be explicit and per-source; when disabled, no outbound request to that source MUST occur.
- **FR-049**: Imported free proxies MUST be stored in a pool distinguished by source provenance and MUST be separable from operator-owned pools.
- **FR-050**: Imported proxies MUST be validated against the outbound-URL guard; private, loopback, link-local, and metadata addresses MUST be rejected.
- **FR-051**: System MUST present a clear, unavoidable privacy/security disclosure that free proxies are third-party, shared, potentially logging or malicious, low-reliability, and unsuitable for sensitive data or credentials.
- **FR-052**: Free-proxy pools MUST NOT bypass strict-proxy/fail-closed semantics: a connection bound to a strict or Psiphon pool MUST NOT fall back to direct egress when a free proxy is unavailable.
- **FR-053**: A source requiring credentials MUST be treated as disabled when unconfigured, and MUST NOT surface its credential in logs or results.

#### Psiphon VPS Investigation (evidence-gated)

- **FR-054**: The Psiphon VPS problem MUST be investigated by collecting concrete diagnostics from the affected environment and recording them as evidence.
- **FR-055**: A root-cause claim MUST be supported by the collected evidence; no diagnosis may be stated without it.
- **FR-056**: A fix MUST be accompanied by a reproducible regression test that encodes the failure and passes after the fix; the fix is contingent on the identified cause.
- **FR-057**: If evidence is insufficient to identify a cause, the work MUST be reported as blocked/unresolved with the evidence gathered, and MUST NOT be reported as fixed.

#### Custom Gateway Discovery & Automated Sync Safety

- **FR-058**: Operator-supplied custom gateway URLs MUST be validated against SSRF at three layers — literal address/hostname checks, DNS-resolution checks (so a public-looking hostname resolving to a private/loopback/link-local/metadata address is rejected), and redirect-target re-validation on every hop.
- **FR-059**: Redirect following MUST be bounded (maximum hops) and each hop's target MUST be re-validated through the same DNS-aware check before it is fetched.
- **FR-060**: The model-discovery fetch path MUST NOT use an unguarded raw fetch of an operator-supplied URL; it MUST use the DNS- and redirect-aware guarded fetch.
- **FR-061**: Creating or updating a custom gateway MUST apply the same URL validation as validating it, so an unvalidated base URL cannot be persisted (no create/update path may skip the guard).
- **FR-062**: System MUST support an explicit local/self-hosted declaration for gateways, allowing private targets only when the operator has declared them AND the request originates from a trusted local origin; the allow MUST NOT apply to requests arriving through a reverse proxy or a non-local peer.
- **FR-062a**: The local/self-hosted declaration MUST be persisted on the gateway and remain valid for background work (scheduled sync, batch tests) that has no inbound request context, so an authorized local gateway continues to sync unattended while still never granting that allowance to a non-local or proxied request.
- **FR-063**: Automated sync MUST handle gateway credentials safely: credentials MUST be scoped to their intended host and MUST NOT be forwarded across an origin/host change on redirect, and MUST NOT appear in logs, result payloads, or error messages.
- **FR-063a**: Gateway TLS verification MUST NOT be silently disabled; outbound TLS to a custom gateway MUST verify certificates by default. Any opt-in relaxation for a self-signed/local gateway MUST be explicit, scoped to the declared local/self-hosted gateway, and MUST NOT apply to remote gateways or to strict-proxy/Psiphon-bound egress.
- **FR-064**: Automated sync scheduling MUST be bounded: finite request timeout, bounded maximum redirects, bounded concurrency/batch size, and a validated interval range; a sync failure MUST fail open and MUST NOT block request routing or wipe the catalog.
- **FR-065**: The capability/override resolution cascade and the discovery reconciler MUST be wired into the actual request/discovery runtime paths (not only unit-tested in isolation), so that operator overrides and auto-discovered values affect routing decisions at runtime.

### Key Entities *(include if data involved)*

- **Imported Model**: A model known to the catalog from a connection. Key attributes: model identifier, originating connection, provenance (imported/manual), and lifecycle state (active/stale/disabled).
- **Capability Record**: The resolved per-model view of context window, max output, and capabilities, with per-field provenance (manual override vs. auto-discovered vs. static/default).
- **Manual Override**: An operator-set value for a capability or limit field on a specific model; highest precedence and durable across refresh.
- **Sync Policy**: The global default plus per-provider override, each with inherit/enabled/disabled semantics.
- **Model Test Result**: The outcome and classification for one model in a batch run (success / hard failure / quota / access-restricted / rate-limited / transport-indeterminate), plus latency and diagnostic detail.
- **Batch Test Run**: A bounded set of model test results with summary counts, stop reason, and any disable actions taken.
- **Proxy Rotation Failure Record**: A transport-health failure attributed to exactly one scope (global/provider/account/combo/key), with reason and time.
- **Retry Policy**: The configured pacing interval (global + per-scope/provider overrides), bounded and subordinate to upstream `Retry-After`.
- **Combo Member Cooldown**: A per-combo, per-member, scope-isolated exclusion with a configurable duration and an expiry time; eligibility returns silently at expiry. Distinct from an account cooldown.
- **Free Proxy Source**: An external third-party provider of proxy lists, individually enable/disable, with provenance and optional credentials.
- **Free Proxy Pool**: A pool of imported free proxies, sourced and tagged by provenance, isolated from operator-owned pools, gated by the outbound-URL guard, and subject to the fail-closed contract.
- **Psiphon VPS Diagnostic Evidence**: The recorded diagnostics (logs, timings, exit-IP/region observations, error signatures) that must support any root-cause claim and its regression test.
- **Gateway URL Safety Policy**: The validation applied to operator-supplied gateway URLs — literal checks, DNS-resolution checks, bounded redirect re-validation, and an explicit local/self-hosted trust declaration tied to a trusted local origin.
- **Sync Credential Scope**: The binding of a gateway credential to its intended host, such that it is not forwarded across a host change and is never logged.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can import a gateway's advertised model list in a single action, with 100% of well-formed records imported and zero unhandled errors in the import path.
- **SC-002**: Under malformed or partial upstream payloads, import still completes with a summary and never throws (0 uncaught failures across the adversarial fixture set).
- **SC-003**: Manual overrides survive at least 5 consecutive refresh/re-import/sync cycles with 0% overwrite.
- **SC-004**: Best-effort discovery correctly captures context window and vision support for the representative upstream payload shapes exercised by the test suite (standard OpenAI, OpenRouter-style, label-based, and native local-server shapes).
- **SC-005**: Across a fixture matrix of success, hard failure, quota, access-restriction, rate-limit, and transport-indeterminate results, auto-disable triggers 0 times on non-hard categories and exactly on the hard failures.
- **SC-006**: A batch run halts within the configured storm threshold on consecutive rate-limit/bot-block results and reports the stop reason, with no disable inferred for untested models.
- **SC-007**: A rotation failure recorded in one scope changes the availability of 0 other scopes.
- **SC-008**: In every retry scenario, the effective wait is never shorter than the upstream `Retry-After` (0 violations).
- **SC-009**: Sync-policy resolution is deterministic: for all combinations of global default (enabled/disabled) and provider setting (inherit/enabled/disabled), the resolved outcome matches the documented table.
- **SC-010**: Standardized model test results classify each of the six result categories correctly across the fixture set (0 misclassifications of quota as hard failure, or transport as quota).
- **SC-011**: 0 credential/secret values appear in logs or in stored batch-test result payloads.
- **SC-012**: An operator can re-enable a batch-disabled model and return it to service without re-importing.
- **SC-013**: For each combo cooldown preset (1m, 5m, 1h), a cooled member is skipped in round-robin and restored silently at expiry, with 0 cross-scope suppressions.
- **SC-014**: Given the real nested-limit failure shape, the route fails over to an eligible combo member on the first request after the failure (0 long stalls on the failed member), and exactly the correctly-scoped member is cooled down.
- **SC-015**: Across a malformed/conflicting retry-hint fixture set, 0 valid long hints are truncated incorrectly, 0 malformed hints are honored, and 0 unrelated scopes are cooled down.
- **SC-016**: With all free-proxy sources disabled (default), 0 outbound requests reach any free-proxy source and 0 free-proxy pools exist.
- **SC-017**: Of the imported free-proxy fixture set, 100% of private/loopback/link-local/metadata addresses are rejected.
- **SC-018**: A root-cause claim for the Psiphon VPS issue is accompanied by recorded evidence, and its fix is accompanied by a passing reproducible regression test (or the work is reported blocked; 0 fixes ship without evidence).
- **SC-019**: Across an SSRF fixture set (public-looking hostname resolving private, literal private, redirect-to-internal, IPv4-mapped IPv6, trailing-dot localhost), 100% are refused and 0 internal targets are fetched.
- **SC-020**: An explicitly declared local/self-hosted gateway on a trusted local origin succeeds, while the same is refused when the request arrives through a proxy or non-local peer (0 bypasses).
- **SC-021**: Gateway credentials are forwarded only to their intended host: 0 credentials are sent to a redirect target on a different host, and 0 credential values appear in logs/result payloads.
- **SC-022**: Automated sync never exceeds its configured bounds (timeout, redirect hops, concurrency, interval range) and a failing sync leaves the catalog intact (0 catalog wipes).
- **SC-023**: A persisted local/self-hosted declaration authorizes background sync for that gateway with 0 inbound request context, while a non-local or proxied request to the same URL is refused (0 background-auth bypasses).
- **SC-024**: Default gateway TLS verification is on: 0 remote-gateway connections succeed with certificate verification silently disabled, and any self-signed relaxation applies only to the declared local gateway (0 remote relaxations).
- **SC-025**: Runtime wiring proof: a manual override and a discovered value change actual routing/capability decisions in at least one request-path and one discovery-path integration test (not only pure-function unit tests).
- **SC-026**: Per-field resolution proof: overriding only `contextWindow` leaves the discovered `vision`/`tools` values intact (0 fields lost to the override), and a provider+model+source keyed capability override resolves and persists with provenance.
- **SC-027**: Backward compatibility: `getDisabledModels()` continues to be consumed as `string[]` by `src/app/api/models/route.js`, `src/app/api/v1/models/route.js`, and `src/app/api/models/disabled/route.js` (0 type-break regressions), while the audit reason/time is retrievable separately.
- **SC-028**: Sync targets real providers: a sync run queries each enabled provider/connection's advertised models and does not depend solely on `models.dev` (0 providers silently skipped for lacking a models.dev entry).
- **SC-029**: Handler threading proof: a combo request through `src/sse/handlers/chat.js` actually engages scoped cooldown (a cooled member is skipped), verified at the handler boundary not just `handleComboChat` in isolation.
- **SC-030**: Proxy pool selection consults fitness/rotation state (an unfit pool is not selected ahead of a fit one) in at least one selection-path integration test.
- **SC-031**: Every new schema column has a registered, idempotent migration with a unique version; a fresh DB and an upgrade DB both reach the expected schema (0 unregistered migration changes).

---

## Assumptions

- The Wave 6 discovery, capability-resolution cascade, and context reconciler (Spec 006) exist as tested modules but are **not wired into the production request path**: `src/lib/models/discovery.js` and `src/lib/models/contextReconciler.js` are imported only by tests, and `resolveModelCapabilities` is called only by the reconciler while the runtime request path uses `getCapabilitiesForModel` (verified). This feature must wire them in (FR-065) rather than assume they already run.
- OmniRoute's batch model-test endpoint informs the design (sequential, rate-respecting dispatch; consecutive rate-limit/bot-block early-stop; per-result classification flags such as rate-limited, quota, transient, timeout, skipped); it is a design reference, not a runtime dependency.
- Built-in providers expose a provider-specific model listing; user-created compatible gateways expose an OpenAI-style or Anthropic-style listing.
- Automatic model sync is **off by default** ("optional"); per-provider `inherit` resolves to the global default.
- Auto-disable is a reversible soft-disable (consistent with the existing disabled-model store), never a destructive delete.
- Retry intervals are operational pacing only and are always subordinate to protocol-mandated backoff and access/regional boundaries.
- Regional/access restrictions are surfaced to the operator and are not circumvented by rotation, retries, or credential cycling.
- All operator-facing actions run behind the existing dashboard authentication surface.
- The combo cooldown feature extends the shipping scoped-cooldown implementation (commit `20a40ef8`, "isolate cooldowns and preserve upstream status and Retry-After"); it must preserve that fix's scope isolation, bounded map, `Retry-After` parsing, and abort cleanup rather than regressing them.
- The nested-limit regression scenario mirrors a real production combo failure (outer 503 wrapping an embedded upstream 429 with a daily free-model limit and a ~11114-second retry hint plus shorter conflicting hints); it is captured as a regression, not a new parity claim.
- Free-proxy providers are opt-in and off by default; the source inventory and feasibility (which providers, their APIs, and reliability) are being researched separately and may reduce which sources are implemented in the first pass.
- The Psiphon VPS investigation outcome is unknown until diagnostics are collected; the spec fixes the process (evidence before claim) rather than presuming a cause.
- OmniRoute's "Resilience" settings surface (backoff / retry / cooldown configuration) is a design reference for this feature's configurable retry intervals and combo cooldowns; it is to be reviewed during research/planning. This is a study of behavior and configuration shape only — direct code or license compatibility MUST NOT be presumed, and any ported behavior must be re-implemented against this repo's own runtime contracts and separately reviewed.
- The repository already provides a layered SSRF guard (literal checks, DNS resolution, redirect-aware fetch) and a local-request detector; this feature verifies that the custom-gateway discovery, create/update, and automated-sync paths actually use the DNS- and redirect-aware layer rather than the literal-only layer or a raw fetch, and closes any path that does not.
- Local/self-hosted gateways are a first-class, explicitly declared capability; the trust declaration is tied to a trusted local peer and must not be inferable from a proxied or remote request.
- Out of scope: distributing or bundling third-party proxy binaries, host-execution bridges, and any change to translator/routing semantics beyond capability gating and combo member selection.

## Dependencies

- **Spec 006** — model discovery normalization, 7-tier capability precedence cascade, context reconciler with manual-pin protection.
- **Spec 004** — failure-kind taxonomy, 4-state circuit breaker, cooldowns.
- **Specs 014 / 016** — proxy pools, Psiphon, strict-proxy fail-closed transport, and `Retry-After` preservation (including the combo scoped-cooldown fix `20a40ef8`).
- **Model catalog sync** — existing scheduling surface to be gated by the new sync policy.
- **External free-proxy sources** — third-party availability and terms; a research artifact is a prerequisite for implementing specific sources.
- **OmniRoute "Resilience" backoff settings surface** — a research/planning input for retry intervals and cooldown configuration. It is behavioral reference material only; direct code/license compatibility is not assumed, and a dedicated discovery workflow is in progress.
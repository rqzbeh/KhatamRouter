# Feature Specification: Bounded Proxy Failover

**Feature Branch**: Not yet created; implementation remains uncommitted
**Created**: 2026-11-10
**Status**: Specified
**Input**: When a configured proxy fails, silently try other proxies before returning the actual error, using random or round-robin routing. Support None (current behavior), a custom additional-proxy count, and All available; five/ten were examples only.

## User Scenarios & Testing

### User Story 1 — Recover without exposing intermediate errors (P1)
As an operator using proxies, I want recoverable proxy failures retried through other eligible proxies so clients receive a successful answer when an alternative works.

**Independent Test**: Configure five alternatives, fail the first two proxies, succeed on the third, and observe one successful client response.

**Acceptance Scenarios**:
1. Given failover enabled and a retryable failure before response content is delivered, when another eligible proxy succeeds, then only its response reaches the client.
2. Given every alternative fails, when the configured budget is exhausted, then the final real error and relevant retry metadata reach the client.
3. Given failover disabled or proxy routing disabled, then no additional proxy attempts are introduced.

### User Story 2 — Configure bounded alternatives (P1)
As an operator, I can choose None, a custom positive integer number of additional proxies, or All available, and retain the choice across edit/save/reopen and restart.

**Independent Test**: Save each supported budget and selection strategy, reload settings, and verify attempt counts with controlled failures.

**Acceptance Scenarios**:
1. Custom N alternatives permit at most N+1 attempts including the initial attempt, limited by the finite available candidate set.
2. All available tries each distinct eligible proxy from the configured rotation set snapshot at most once; it is not capped at five or ten and never refills indefinitely.
3. Random and round-robin selection respect authorized pool membership and avoid already-attempted proxies.
4. Fewer eligible proxies end retrying early without recycling the same proxy or going direct.
5. None preserves current behavior with no added proxy failover; malformed custom counts, fractions and non-positive integers are rejected.

### Edge Cases
- Client cancellation or an exhausted request deadline stops further attempts.
- A stream already delivering content is never replayed through a new proxy.
- Authentication, malformed requests, content-policy refusals, account billing/quota failures, and application-enforced limits are not bypassed by proxy changes.
- Retryable 429 respects upstream retry instructions; IP/proxy-block evidence is distinguished from account restrictions.
- Nested transport/provider retries cannot multiply the configured request-level budget.
- Unreplayable request bodies do not enter automatic retries.

## Requirements

### Functional Requirements
- **FR-001**: Failover MUST be opt-in and offer None (default/current behavior), Custom positive integer additional-proxy count, and All available eligible configured proxies.
- **FR-002**: Retrying MUST apply only when proxy routing is configured and enabled.
- **FR-003**: Eligible transient network/proxy failures and retryable upstream failures, including applicable 429 responses, MUST be classified before deciding to retry.
- **FR-004**: Authentication, account/global quotas, validation and content-policy protections MUST remain enforced; proxy changes MUST NOT be used to bypass them.
- **FR-005**: Custom N MUST bound total attempts to N+1; All MUST be bounded by a finite snapshot of the authorized eligible configured proxies. No proxy may be revisited, new pools may not indefinitely extend the request, and nested mechanisms MUST NOT multiply either budget.
- **FR-006**: Alternative proxies MUST follow the existing random or round-robin strategy, exclude attempted and ineligible proxies, and never silently fall back to direct egress.
- **FR-007**: The original client request MUST remain pending through internal retries. No intermediate HTTP error, SSE error frame or fake model output may reach the client. A successful alternative returns its normal output; exhaustion returns the final real upstream failure rather than invented success or a generic replacement.
- **FR-008**: Client cancellation and deadlines MUST stop retrying; committed streams MUST NOT be replayed.
- **FR-009**: Settings MUST persist and reject unsupported or malformed values with a clear error.
- **FR-010**: Operator diagnostics MUST identify attempt counts/outcomes without exposing credentials or proxy userinfo.
- **FR-011**: Each attempt MUST have a bounded timeout and the logical request MUST have an overall deadline, including All mode. Dead proxies must not consume the entire chain indefinitely; failed response bodies and transport resources must be released.
- **FR-012**: Connection lifetime handling MUST account for server/reverse-proxy HTTP idle limits as well as transport keep-alive. No premature response commitment or artificial output may be introduced merely to keep a connection open; final HTTP status fidelity and stream protocol compatibility must be preserved. Deployment idle-timeout constraints must be documented.

- **FR-013**: Failover MUST honor the existing temporary removal/cooldown policy: quarantine the failed concrete proxy for the configured interval (respecting applicable retry-time floors), skip it across requests while cooling, and allow it again after expiry. Recheck eligibility before each attempt.
- **FR-014**: Feed-source groups such as 1proxy, Proxifly and IPLocate MUST NOT share a health penalty merely because they share a source. A failed imported endpoint MUST NOT quarantine healthy sibling endpoints or an entire feed group.

### Key Entities
- **Failover policy**: Enabled/disabled state and maximum alternative proxy count.
- **Attempt context**: Request-scoped attempted proxy identities, remaining budget and cancellation/deadline.
- **Eligible proxy**: Configured active proxy satisfying existing routing and network safety requirements.

## Success Criteria
- **SC-001**: Controlled success on any eligible attempt within the budget yields exactly one successful client response and no intermediate error.
- **SC-002**: Exhaustion never exceeds initial plus custom N alternatives or the finite All candidate snapshot, and returns the final observed failure. Tests include non-preset custom counts and more than ten available proxies.
- **SC-003**: Disabled routing/failover, cancelled requests and committed streams produce zero additional failover attempts.
- **SC-004**: All supported settings survive save/reopen; invalid values are rejected.
- **SC-005**: Tests demonstrate no direct-egress fallback or bypass of authentication/account quotas.
- **SC-006**: Controlled hung attempts and slow first responses settle within declared per-attempt/overall bounds; disconnect cancels further attempts and releases owned resources without sending intermediate client errors.

- **SC-007**: With two proxies from the same feed, failure cools only the first, the sibling can succeed, subsequent requests skip the failed endpoint until expiry, and it becomes eligible afterward. Other source groups remain unaffected.

## Assumptions & Dependencies
- None preserves existing behavior. Custom values count additional proxies, not total attempts; All means the current authorized rotation set, not unrelated global pools. All remains subject to the client/request deadline, cancellation, eligibility and retry safety rules.
- Failover is sequential within the pending client request, not detached work after returning a response.
- Existing selection, network trust, health classification and request deadline mechanisms will be reused.
- Implementation integration points and managed sidecar interactions require source discovery before the plan is finalized.

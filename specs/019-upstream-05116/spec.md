# Feature Specification: 9router Release Parity

**Feature Branch**: `019-upstream-05116`

**Created**: 2026-11-08

**Status**: Complete — implementation verified, PR / CI pending

**Input**: Port applicable 9router changes covering 0.5.112 through 0.5.116, preserve this fork's runtime and security guarantees, verify the result and merge a pull request.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive upstream fixes without losing fork capabilities (Priority: P1)

An operator upgrading KhatamRouter receives every applicable upstream feature and fix in the requested release range without losing existing provider support, authentication protections, persistence, or routing behavior.

**Why this priority**: Upstream parity is useful only if the upgrade remains a safe replacement for the existing deployment.

**Independent Test**: Compare the complete upstream change inventory with the implemented behavior and run representative success and failure scenarios for each outstanding change.

**Acceptance Scenarios**:

1. **Given** an applicable outstanding upstream fix, **When** the corresponding scenario is exercised after upgrade, **Then** the corrected behavior is observed.
2. **Given** functionality already implemented differently in the fork, **When** upstream changes the same feature, **Then** equivalent functionality and stronger local protections remain intact with documented evidence.
3. **Given** a user without permission or an unsafe network target, **When** changed functionality is invoked, **Then** existing access and network boundaries remain enforced.

---

### User Story 2 - Audit completeness of the upgrade (Priority: P1)

A maintainer can trace each upstream commit to its local implementation, existing equivalent behavior, or a specific architectural non-applicability explanation without hidden omissions.

**Why this priority**: A partial port that appears complete creates untracked compatibility debt.

**Independent Test**: Independently enumerate the authoritative release interval and reconcile it with the published disposition ledger.

**Acceptance Scenarios**:

1. **Given** authoritative release/version boundaries, **When** the ledger is reconciled, **Then** every commit has exactly one disposition and concrete evidence.
2. **Given** an untagged or unavailable release, **When** scope is established, **Then** the actual release evidence and any unavailable boundary are reported honestly rather than inferred.

---

### User Story 3 - Receive a verified, isolated delivery (Priority: P2)

The operator receives a reviewed, merged upgrade while unrelated unfinished work and live deployment data remain untouched.

**Why this priority**: Parallel work and deployment state must not be damaged by an upstream import.

**Independent Test**: Review changed paths, verification evidence, pull request checks and merged revision; compare unrelated worktree state.

**Acceptance Scenarios**:

1. **Given** unfinished sidecar work in another checkout, **When** the upstream port is delivered, **Then** that work is neither overwritten nor included in the release.
2. **Given** passing upgrade verification and pull request checks, **When** the change is merged, **Then** the merged revision contains the reviewed changes and documentation accurately describes shipped behavior.

### Edge Cases

- A fix in 0.5.112 was already ported, only partially ported, or subsequently superseded.
- Later versions exist as package version commits without corresponding tags.
- Upstream implementation would weaken local authentication, secret handling, proxy isolation or address restrictions.
- Upstream packaging or storage assumptions conflict with the fork's supported runtime.
- Another session merges documentation or source changes before this pull request merges.
- Live provider credentials are unavailable; mocked checks cannot be presented as live verification.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The delivery MUST account for every commit in the authoritative requested interval, including checking the existing 0.5.112 port for gaps.
- **FR-002**: Every applicable outstanding change MUST have observable behavior and regression evidence; no applicable feature may silently be omitted.
- **FR-003**: Existing fork capabilities, supported runtime, persistence and security protections MUST remain supported.
- **FR-004**: The disposition ledger MUST distinguish implemented, adapted, already equivalent, superseded and architecturally inapplicable changes with evidence.
- **FR-005**: Verification MUST cover changed behavior, relevant negative/security scenarios and cross-component regressions before merge.
- **FR-006**: Delivery MUST isolate unrelated unfinished work and avoid modifying existing deployment data.
- **FR-007**: Documentation MUST reflect the actual delivered scope and distinguish verified behavior from unavailable live checks.
- **FR-008**: The pull request MUST be created, pass required checks, be merged, and have its resulting revision verified before completion is claimed.

### Key Entities

- **Upstream commit**: Immutable change identifier, parent history, subject, affected files and behavior.
- **Release boundary**: Authoritative evidence associating a requested upstream version with an immutable revision.
- **Disposition**: One decision per upstream commit linked to local evidence and verification.
- **Verification evidence**: Reproducible checks tied to the actual reviewed and merged artifacts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of commits in the verified interval have a reviewed, evidence-backed disposition; zero remain unclassified.
- **SC-002**: 100% of applicable outstanding behavior has passing targeted regression evidence with no newly introduced failures in required checks.
- **SC-003**: Zero unrelated unfinished files or deployment records are overwritten or included in the delivery.
- **SC-004**: All required pull request checks pass and the merged revision is independently verified.

## Assumptions

- The lower release is audited inclusively because prior work may already implement it; duplicate behavior is not reintroduced.
- Source history may establish release boundaries when tags are absent; unavailable versions will be surfaced instead of fabricated.
- Delivery means repository integration and release-build verification, not an unsolicited rollout to an unspecified live server.
- Existing operator credentials and production data are not required for deterministic regression tests.
- The user authorizes creation and merge of this task's pull request, not cleanup of another session's branches or unfinished work.

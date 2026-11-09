# Specification Quality Checklist: Model Import, Capability Discovery & Batch Testing

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-08
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Amended Requirements Coverage

- [x] Best-effort discovery of context window and capabilities (e.g. vision) for imported models is specified (FR-006, FR-007, US2, SC-004)
- [x] Per-model user overrides of incomplete or changed discovery results are specified (FR-008, FR-012, US2)
- [x] Manual overrides survive refresh / re-import / automatic sync (FR-010, FR-011, SC-003)
- [x] Optional automatic model sync with a global settings default is specified (FR-013, US4)
- [x] Per-provider override with inherit / enabled / disabled semantics is specified (FR-014, SC-009)
- [x] Sync scope covers built-in providers AND user-created OpenAI/Anthropic-compatible gateways (FR-015, US1 AC4, US4 AC5)
- [x] Sync preserves manual metadata (FR-016, US4 AC6)
- [x] Transport health is distinguished from account quota/access restrictions (FR-030, FR-036, US5 AC4)
- [x] Retry interval never shortens or violates upstream `Retry-After` (FR-033, SC-008, US6 AC1)
- [x] Retry interval never bypasses regional/access restrictions (FR-034, US6 AC3)
- [x] Bulk tests flag quota/cost (FR-023, US3 AC3) and never disable on indeterminate transport errors (FR-022, US3 AC5)
- [x] Configurable combo failed-member cooldown presets (1m/5m/1h) at create/edit is specified (FR-039, US7, SC-013)
- [x] Failed members are skipped in round-robin and restored silently at expiry, with failover and scope isolation (FR-040, FR-041, FR-042, US7)
- [x] Account-vs-model attribution and nested outer-503/embedded-429 handling are specified (FR-043, FR-044, US7 regression, SC-014)
- [x] Untrusted retry/reset message hints parsed conservatively with no accidental unrelated cooldown (FR-045, SC-015)
- [x] Free proxy providers integrated as opt-in free proxy pools with provenance (FR-047, FR-048, FR-049, US8, SC-016)
- [x] Privacy/security implications disclosed; unsafe hosts rejected; fail-closed preserved (FR-050, FR-051, FR-052, SC-017)
- [x] Psiphon VPS investigation is evidence-gated: diagnosis contingent on VPS evidence, fix has reproducible regression, blocked if no evidence (FR-054..FR-057, US9, SC-018)
- [x] OmniRoute "Resilience" backoff-settings review recorded as a research/planning input with an explicit no-presumed-code/license-compatibility caveat (Assumptions, Dependencies)
- [x] Custom-gateway URL safety is specified across literal, DNS-resolution, and bounded redirect re-validation layers (FR-058, FR-059, FR-060, FR-061, US10, SC-019)
- [x] Explicit local/self-hosted support is tied to a trusted local origin and denied for proxied/non-local requests (FR-062, US10 AC3, SC-020)
- [x] Automated sync credential handling is host-scoped, never forwarded across host change, never logged (FR-063, US10 AC4/AC6, SC-021)
- [x] Automated sync scheduling is bounded (timeout, redirects, concurrency, interval) and fails open without wiping the catalog (FR-064, US10 AC5, SC-022)
- [x] Research finding verified against source: `provider-nodes` create/update routes lack the guard, `providers/suggested-models` uses a raw unguarded fetch, and `provider-nodes/validate` uses literal-only `assertPublicUrl` (not `assertPublicUrlResolved`/`fetchPublic`) — recorded in Assumptions

## Independent Audit Corrections (2026-11-08)

- [x] `model_capability_overrides` missing provider/model_id/source → FR-008a, new registered migration, data-model updated
- [x] Cascade is record-level → per-field merge contract (FR-009a, SC-026)
- [x] Disabled-model `string[]` callers → backward-compatible audit (FR-025a, SC-027)
- [x] S0 wrongly gated → S0 independent of Foundational (plan + tasks)
- [x] Sync must target real providers, not only models.dev (FR-013a, SC-028)
- [x] Synchronous runtime/UI → OverrideCache + invalidation (FR-009b, T021/T022/T036)
- [x] Handler must thread combo cooldown (FR-043a, T045, SC-029)
- [x] Migration register/version requirement (FR-038a, T018/T019/T023, SC-031)
- [x] Context reconciler is context-only → capability reconciliation added (FR-006a)
- [x] Proxy selection must integrate fitness (FR-043b, T072, SC-030)
- [x] Overrides API task missing → explicit `src/app/api/models/overrides/route.js` tasks (T035, T024–T036)
- [x] Dependencies separated from tasks; source cited in `research.md` R13

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
- No `[NEEDS CLARIFICATION]` markers were required; reasonable defaults are documented in the Assumptions section (auto-sync default off, auto-disable opt-in and reversible, retry interval always subordinate to upstream backoff).
- Deliberately excluded from this feature: bundling proxy binaries, host-execution bridges, and routing/translator changes beyond capability gating.
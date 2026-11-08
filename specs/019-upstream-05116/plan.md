# Implementation Plan: 9router Release Parity

**Branch**: `019-upstream-05116` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Exhaustive applicable upstream parity covering 0.5.112–0.5.116 with Bun-native adaptations and verified self-merged PR.

## Summary

Establish immutable release boundaries, audit every upstream behavioral change against current fork equivalents, then implement outstanding changes in narrow Haiku-owned leaves. Preserve local Bun-only architecture and stronger security guarantees. Use Spec-Kit artifacts and Unlazy runnable gates for source, tests, integration, container smoke and shipment. The isolated checkout is `/tmp/khatam-upstream-019`; other sessions' dirty files and branches are not part of this delivery.

## Technical Context

**Language/Version**: Plain JavaScript ESM; Bun only for all commands and tests, runtime pinned by `.bun-version`.

**Primary Dependencies**: Existing Next.js dashboard/gateway, provider-agnostic `open-sse` engine; no new dependency assumed before source audit.

**Storage**: Existing `bun:sqlite` WAL repositories/migration authority and Redis coordination. Do not import upstream storage replacements.

**Testing**: Independent Vitest package in `tests/`, `bun x --bun vitest`; existing provider/alias/OAuth baseline scripts; lint/import/build and isolated Docker smoke via Haiku worker.

**Target Platform**: Existing Bun-supported server/CLI deployments; local container verification linux/amd64.

**Project Type**: Existing gateway and dashboard plus independently versioned CLI launcher.

**Performance Goals**: No avoidable hot-path work or fork optimization regressions; do not claim performance improvements without measurements.

**Constraints**: Haiku workers only; preserve authentication, secret redaction, SSRF and strict-proxy behavior; no unrelated sidecar/quota-rotation changes; do not modify the primary checkout; no force merges or CI bypass.

**Scale/Scope**: Requested upstream release interval plus inclusive audit of already ported .112. Exact outstanding change clusters are a blocking research dependency, documented in `upstream-inventory.md` and `local-audit.md` when workers return.

## Constitution Check

- I Upstream integrity: every SHA explicitly accounted for; no silent skips. Pending exhaustive inventory review before implementation.
- II Single runtime: Bun only and plain JS; do not import Node execution or TypeScript tooling.
- III Persistence: preserve SQLite/Redis authorities; translate any upstream persistence changes through existing repositories.
- IV Graph first: structural discovery and per-path coverage, direct source fallback where graph points to dirty primary rather than isolated checkout. Local audit records actual coverage.
- V Spec/Unlazy: spec, plan, tasks, per-leaf gates before implementation; lint zero errors, independently re-run approved checks.
- VI Runtime compatibility: preserve stateless executors, granular limits, circuit-breaker exemptions and capability behavior.
- Delegation: user's explicit Haiku-only worker request overrides older Sonnet implementation preference; orchestrator retains judgment/review.

Pre-research result: permitted research-only phase. Implementation is blocked until release scope and local applicability are source-verified and per-leaf file ownership/gates are fixed. Post-design check will be updated from those findings.

## Project Structure

```text
specs/019-upstream-05116/
  spec.md
  plan.md
  tasks.md
  research.md
  upstream-inventory.md
  upstream-commits.json
  local-audit.md
  data-model.md
  contracts/parity.md
  quickstart.md
  checklists/requirements.md
.unlazy/upstream-019/       # local-only coordination/evidence
  PLAN.md
  GATES.md
  gates/leaf-*.md
  dispatch.json
src/                       # existing app interfaces, only applicable changes
open-sse/                  # existing routing/translation engine
cli/                       # independent launcher; only if applicable
scripts/                   # repeatable parity verification
 tests/                    # targeted behavioral and security regressions
```

**Structure Decision**: Extend existing modules; do not create a parallel upstream subsystem. Source edit paths and independent implementation leaves are finalized after inventory review, not guessed in advance.

## Delivery sequencing

1. Haiku upstream release inventory and local parity/architecture audit in parallel; orchestrator independently verifies.
2. Finalize research, exact behavioral requirements, tasks, disjoint file sets and runnable acceptance gates before production edits.
3. Haiku workers implement complete clusters with tests, four-pass review and leaf self-checks; orchestrator re-runs and reviews them.
4. Integration regression/security review, build/container smoke, documentation and complete SHA disposition ledger.
5. Reconcile latest master and peer documentation changes, create PR, wait for all required checks, merge, verify resulting revision and clean up only this task's finished refs/worktree.

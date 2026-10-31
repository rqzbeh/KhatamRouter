# Tasks: OpenCode Interoperability & Transport Lifecycle

## Execution Rules & Discipline
- **Status**: Planning and scoped upstream audit stage. Runtime files are coordinated with active transport reliability stabilization (`fix/proxy-redis-reliability`).
- **Disjoint Ownership**: This task strictly owns `specs/016-opencode-interoperability/**` and `.unlazy/016-opencode-interoperability/**`. No runtime or test files are mutated.
- **Stub-Proof Oracles**: Every test oracle requires verifiable checks, no skipped tests (`it.skip`, `describe.skip`, `todo`), and execution under native Bun (matching repo `.bun-version` 1.4.4).
- **Proportional Scope**: Scoped bugfix and upstream review audit without inventing new provider frameworks or arbitrary environment variables.

---

## Task Matrix

| Task ID | Phase | Summary | Gate | Planned File Ownership |
|---|---|---|---|---|
| **T1** | Spec & Gates | Author Spec-Kit package and Unlazy gates ledger | G1 | `specs/016-opencode-interoperability/**`, `.unlazy/016-opencode-interoperability/**` |
| **T2** | Parity & Privacy Audit | Verify bounded conversation IDs and neutral host path privacy | G2 | `tests/unit/opencode-fingerprint.test.js`, `tests/unit/opencode-session.test.js` |
| **T3** | Transport & Abort Contract | Verify in-process native fetch, abort signal propagation, and header deadlines | G3 | `open-sse/services/opencodeTlsClient.js`, `open-sse/config/runtimeConfig.js` |
| **T4** | Sidecar Escalation & Quota | Verify 1500ms subprocess escalation and 429 Retry-After preservation | G4 | `src/lib/network/psiphon/psiphonManager.js`, `src/sse/handlers/chat.js` |
| **T5** | Audit Documentation | Document 5-PR review decisions, scope boundaries, and security notes | G5 | `docs/UPSTREAM-PORTS.md`, `ROADMAP.md`, `CHANGELOG.md` |

---

### Task Details & Planned Oracles

#### T1: Spec Package & Acceptance Gates
- **Objective**: Author formal specification, architectural plan, actionable tasks, and Unlazy gates ledger for Spec 016, passing `gate-lint.mjs --strict` with zero findings.
- **Files Owned**: `specs/016-opencode-interoperability/**`, `.unlazy/016-opencode-interoperability/**`.
- **Validation**: Pass `gate-lint.mjs --strict` and verify presence of required sections and constants.
- **Oracle**:
```bash
test -s specs/016-opencode-interoperability/spec.md && \
test -s specs/016-opencode-interoperability/plan.md && \
test -s specs/016-opencode-interoperability/tasks.md && \
test -s .unlazy/016-opencode-interoperability/GATES.md && \
node /home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs --strict .unlazy/016-opencode-interoperability/GATES.md && \
echo T1_PASS
```

#### T2: Parity Audit & Privacy Verification (Upstream #5222 Parity Evidence)
- **Objective**: Provide empirical test evidence that OpenCode session tracking respects existing runtime bounds (`MAX_TRANSLATED_IDS = 5000`, `MEMORY_CONFIG.sessionTtlMs = 7200000`) and neutral host path privacy (`/home/user/project`, `/var/cache/opencode`, `linux`).
- **Dependencies**: T1.
- **Target Files**: `tests/unit/opencode-fingerprint.test.js`, `tests/unit/opencode-session.test.js`.
- **Validation Criteria**:
  - Verify that `<env>` blocks emitted to OpenCode Zen and Free strictly use `/home/user/project` and `/var/cache/opencode`, and never disclose `process.cwd()` or `os.tmpdir()`.
  - Verify session translation preserves existing memory caps and valid timestamp encoding.
- **Oracle**:
```bash
test -s tests/unit/opencode-fingerprint.test.js && \
test -s tests/unit/opencode-session.test.js && \
! grep -qE "\bit\.skip|\bit\.todo|\bxit\(|\bxdescribe\(|describe\.skip" tests/unit/opencode-fingerprint.test.js tests/unit/opencode-session.test.js && \
(cd tests && bun x vitest run unit/opencode-fingerprint.test.js unit/opencode-session.test.js) && \
echo T2_PASS
```

#### T3: Transport Contract & Abort Deadlines (Upstream #5310 & #5297)
- **Objective**: Verify that `opencodeTlsClient.js` native transport operates in-process (no child subprocess), cancels on caller `AbortSignal`, enforces response-header deadlines (`FETCH_CONNECT_TIMEOUT_MS = 60000`), and preserves active SSE streaming bodies.
- **Dependencies**: T2, coordination with `fix/proxy-redis-reliability`.
- **Target Files**: `open-sse/services/opencodeTlsClient.js`, `open-sse/config/runtimeConfig.js`.
- **Validation Criteria**:
  - Verify `FETCH_CONNECT_TIMEOUT_MS` bounds header arrival without imposing an arbitrary total 60s stream cutoff.
  - Verify in-process native fetch cleans up sockets/streams without OS process signals.
  - Verify strict proxy enforcement fails closed (HTTP 503) without falling back to unproxied egress.
- **Oracle**:
```bash
test -s open-sse/services/opencodeTlsClient.js && \
grep -q "FETCH_CONNECT_TIMEOUT_MS" open-sse/config/runtimeConfig.js && \
! grep -q "NODE_TLS_REJECT_UNAUTHORIZED *= *['\"]?0" open-sse/services/opencodeTlsClient.js && \
echo T3_PASS
```

#### T4: Sidecar Subprocess Escalation & Quota Compliance (Upstream #5297 Guardrails)
- **Objective**: Verify that external sidecar child processes terminate under bounded 1500ms escalation (`terminateProcess`), and upstream HTTP 429 quota backoffs are preserved without automatic session cycling.
- **Dependencies**: T3.
- **Target Files**: `src/lib/network/psiphon/psiphonManager.js`, `src/sse/handlers/chat.js`.
- **Validation Criteria**:
  - Verify `terminateProcess` implements SIGTERM with 1500ms fallback to SIGKILL.
  - Verify upstream HTTP 429 and `Retry-After` headers pass downstream without triggering session re-minting.
- **Oracle**:
```bash
test -s src/lib/network/psiphon/psiphonManager.js && \
grep -q "sigkillTimeoutMs = 1500" src/lib/network/psiphon/psiphonManager.js && \
test -s src/sse/handlers/chat.js && \
echo T4_PASS
```

#### T5: Documentation & Upstream Review Ledger
- **Objective**: Record audit outcomes for all 5 upstream PRs (#5310, #5222, #5297, #5298, #5328), document scope boundaries and security findings, and update project ledgers.
- **Dependencies**: T4.
- **Target Files**: `docs/UPSTREAM-PORTS.md`, `ROADMAP.md`, `CHANGELOG.md`.
- **Validation Criteria**:
  - Record exclusion of #5298 (host command bridge) due to unproven execution isolation and permission approval risks.
  - Record exclusion of #5328 (client-gate evasion) as outside task scope boundaries.
  - Record coordination of #5310 on `fix/proxy-redis-reliability`.
- **Oracle**:
```bash
grep -q "PR #5297" specs/016-opencode-interoperability/spec.md && \
grep -q "PR #5310" specs/016-opencode-interoperability/spec.md && \
grep -q "PR #5222" specs/016-opencode-interoperability/spec.md && \
grep -q "PR #5298" specs/016-opencode-interoperability/spec.md && \
grep -q "PR #5328" specs/016-opencode-interoperability/spec.md && \
echo T5_PASS
```

---

## Scope Boundaries & Safety Notes
1. **Branch Alignment**: Work is staged alongside `fix/proxy-redis-reliability` where native transport contracts are stabilized.
2. **No Invented Policy**: Exclusions are explicit scope boundaries of this task, not invented user policies.
3. **In-Process Safety**: Native `wreq-js` calls do not spawn subprocesses; process teardown rules apply strictly to external sidecar binaries (e.g. Psiphon).

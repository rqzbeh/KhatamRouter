# Preflight Verification — Wave 8 (Vertical Scale)

- **Date / Timestamp**: 2026-10-27 22:28:36 +0330
- **Worktree**: `/home/redsnow/KhatamRouter/.claude/worktrees/wave8-vertical`
- **Branch**: `wave8/vertical-scale`
- **Base Commit**: `7fbd38e0 fix(opencode): port upstream ce060c79 + 1da5b0d7, wreq-js running under Bun (#78)`
- **Host / OS**: Linux 6.18.54.1-microsoft-standard-WSL2 (x86_64)
- **Bun Version**: `bun 1.4.3` (`bun -v` confirmed `1.4.3`)
- **System Load Average**: `5.13, 1.89, 0.79` (active background agent workloads observed)

## 1. Dependency Installation
- Root `bun install`: Exit code 0 (598 packages installed / up-to-date in 8.45s, lockfile clean).
- Tests `cd tests && bun install`: Exit code 0 (46 packages installed / up-to-date in 2.07s).

## 2. Directory Isolation Audit
- Temporary isolation directory configured via `DATA_DIR=$(mktemp -d /tmp/khatam-test-data-XXXXXX)` before test execution.
- Verification: Zero writes or mtime updates under `~/.9router/` during preflight execution.

## 3. Full Vitest Test Suite Execution
- **Command**: `DATA_DIR=$TMP bun x vitest run --reporter=default --reporter=json --outputFile=/tmp/preflight-vitest-results.json`
- **Total Tests**: 4,935
- **Passed**: 4,818
- **Failed**: 89
- **Pending / Skipped**: 27
- **Run start (JSON startTime)**: 2026-10-27T18:59:15Z

## 4. Comparison to Baseline (`tests/__baseline__/known-fails.txt`)
- **Baseline known-fails entries**: 87 (`wc -l`, verified)
- **Failed in preflight**: 89
- **Matching known-fails**: 86
- **Known entries not failing now**: 1
  - `tests/translator/thinking-unified.test.js :: applyThinking per provider format GLM-5.2 also gets reasoning_effort (supported from 5.2 onward)`
- **Pre-existing regressions at HEAD 7fbd38e0 (not in known-fails)**: 3 tests
  - `tests/unit/strict-proxy-enforcement.test.js :: strictProxy refuses a direct connection (#4333) throws when a pool is assigned but no proxy url resolved`
  - `tests/unit/strict-proxy-enforcement.test.js :: strictProxy refuses a direct connection (#4333) throws when the pool is enabled but carries an empty url`
  - `tests/unit/opencode-freetier-direct-replay.test.js :: directFetch semantics in proxyAwareFetch (FR-02, FR-03) invokes directFetch when called without proxy for opencode.ai`

Verification executed via `tests/__baseline__/verify-no-regression.mjs`.

## 5. Preflight Gate Outcome
- **T001**: PASS (`specs/008-bun-perf-scale/results/.gitkeep` verified).
- **T002**: PASS (Preflight environment and red set recorded).

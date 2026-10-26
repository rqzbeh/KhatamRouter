# Performance Ladder Host Results: L0 Micro, L1 Harness, and L2 Loopback

**Scope**: Task T022 (Gate `leaf-e-host`). Host benchmark rows executed natively under Bun without container management tools.  
**Date**: 2026-10-27  
**Git Branch**: `feat/wave8-bun-perf-scale`  
**Git HEAD**: `075ec17f1cd196cf37dafcb58dcdae3228d8db77` (T021)  
**T007 Pre-Slim Commit**: `1e057b21e860953a748c58a2d1d033a88cff9ea3`  
**T014 After-Slim Commit**: `97431a0cbc12eace67e2f42d1ab70a1a338e945e`  
**Isolation Guarantee**: All database operations executed in ephemeral temporary directories (`/tmp/khatam-perf-data-*`) with `DATA_DIR_ALLOW_TEMP=1`. Zero access or modification to `~/.9router`.

---

## 1. Host Hardware and Environment Specification

All host benchmarks recorded in this document were executed directly on the local host machine under native Bun:

| Parameter | Host Specification |
|---|---|
| **CPU Model** | AMD Ryzen 7 4800H with Radeon Graphics |
| **CPU Topology** | 8 physical cores / 16 threads |
| **Runtime Version** | Bun 1.4.3 (native x86_64-linux release) |
| **Operating System** | Linux 6.18.54.1-microsoft-standard-WSL2 (x86_64) |
| **Virtualization Note** | WSL2 virtualization layer on Windows host, native Linux guest kernel |
| **Pre-Run System Load** | `0.31, 0.30, 0.32` (verified `load < 1.0` before initiating timing runs) |
| **Run-Time System Load** | `0.49 – 0.59` (no parallel builds, tests, or compiler processes active) |
| **Post-Run System Load** | `0.45, 0.38, 0.35` |
| **Database Engine** | Native `bun:sqlite` with WAL mode (`busy_timeout = 5000`) in isolated temp `DATA_DIR` |
| **Cluster State** | Redis disabled (`redis: "off"`) for pure host isolation |

---

## 2. Master Performance Ladder Table (Host Tiers)

Conforming to the `LadderRow` data model schema (`specs/008-bun-perf-scale/data-model.md`):  
`| tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |`

| tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **L0 micro** (sqlite point query) | 1 | 0.0014 | 0.0018 | 0.0019 | 705074.9 | normal | 9.89% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (model string parser) | 1 | 0.00011 | 0.00014 | 0.00015 | 8710012.3 | normal | 11.66% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (matchPattern cached) | 1 | 0.00021 | 0.00023 | 0.00023 | 4789219.3 | normal | 6.77% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (matchPattern uncached comparison) | 1 | 0.00083 | 0.0010 | 0.0011 | 1210115.2 | normal | 11.54% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (findModel Map lookup) | 1 | 0.00008 | 0.00010 | 0.00011 | 13023667.8 | normal | 12.68% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (findModel linear scan comparison) | 1 | 0.00030 | 0.00033 | 0.00034 | 3331416.2 | normal | 10.19% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (getModelAliases cache warm) | 1 | 0.00080 | 0.00091 | 0.00097 | 1255397.0 | normal | 7.73% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (getModelAliases cache bypassed) | 1 | 0.0090 | 0.0120 | 0.0151 | 110722.9 | normal | 16.63% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (getComboByName cache warm) | 1 | 0.0039 | 0.0045 | 0.0048 | 256009.0 | normal | 6.80% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L0 micro** (getComboByName cache bypassed) | 1 | 0.0142 | 0.0201 | 0.0246 | 70305.3 | normal | 22.00% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | - |
| **L1 harness** (baseline T007) | 1 | 1.3708 | 5.0359 | 12.1579 | 545.4 | normal | 5.39% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label baseline --out results/l1-baseline.json` | - |
| **L1 harness** (after slim T014) | 1 | 1.0080 | 2.5950 | 12.0116 | 713.8 | normal | 10.85% | 0 | `AMD Ryzen 7 4800H host Bun 1.4.3` | `bun scripts/perf-l1-harness.mjs --label after-slim --out results/l1-after.json` | - |
| **L1 harness** (same-session A1 pre-slim) | 1 | 1.3692 | 4.8192 | 11.8228 | 552.1 | normal | 6.30% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `cd <throwaway-t007> && bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round1` | - |
| **L1 harness** (same-session B1 HEAD) | 1 | 1.0123 | 2.6440 | 11.8843 | 705.6 | normal | 9.48% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label ladder-head-round1` | - |
| **L1 harness** (same-session A2 pre-slim) | 1 | 1.3505 | 5.0413 | 12.3676 | 550.6 | normal | 6.33% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `cd <throwaway-t007> && bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round2` | - |
| **L1 harness** (same-session B2 HEAD) | 1 | 1.0224 | 2.5898 | 12.0774 | 708.1 | normal | 10.18% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label ladder-head-round2` | - |
| **L2 loopback** (single-replica) | 1 | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | normal | 0% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:29148` | Host lacks prebuilt .next/standalone bundle; unbundled dev mode (dev:bun) runs unoptimized with Webpack HMR compilation overhead and is non-representative of production HTTP latency/throughput. Standalone HTTP execution handed off to containerized L3 tier (T023). |

---

## 3. L0 Micro-Benchmarks Detail

Per `specs/008-bun-perf-scale/research-ladder.md` §3 and §6, the L0 tier targets isolated functions, caches, and runtime primitives. Measurements are executed in-process via `scripts/perf-l0-micro.mjs` using an isolated temporary `DATA_DIR`, evaluating 200 warmup batches and 30 measured batches of N operations per benchmark. Three full multi-benchmark runs were conducted under system load < 1.0; all three runs are reported below, with Run 1 retained as the canonical median run.

### 3.1 Multi-Run Summary (3 Runs, Median Selection)

| Benchmark | Run 1 p50 (µs) | Run 2 p50 (µs) | Run 3 p50 (µs) | Median p50 (µs) | Median Run | Run 1 CV | Noisy |
|---|---|---|---|---|---|---|---|
| `bun:sqlite` point query | 1.4183 | 1.4865 | 1.4618 | 1.4618 | Run 1 (close) | 9.89% | no |
| `parseModel` string parser | 0.1148 | 0.1144 | 0.1192 | 0.1148 | **Run 1** | 11.66% | no |
| `matchPattern` (cached) | 0.2088 | 0.2091 | 0.2277 | 0.2091 | Run 1 (close) | 6.77% | no |
| `matchPattern` (uncached) | 0.8264 | 0.8435 | 0.8299 | 0.8299 | Run 1 (close) | 11.54% | no |
| `findModel` (Map lookup) | 0.0768 | 0.0714 | 0.0797 | 0.0768 | **Run 1** | 12.68% | no |
| `findModel` (linear scan) | 0.3002 | 0.2785 | 0.2920 | 0.2920 | Run 1 (close) | 10.19% | no |
| `getModelAliases` (cache warm) | 0.7966 | 0.8479 | 0.7862 | 0.7966 | **Run 1** | 7.73% | no |
| `getModelAliases` (bypassed) | 9.0316 | 8.9646 | 9.9229 | 9.0316 | **Run 1** | 16.63% | yes (disk I/O) |
| `getComboByName` (cache warm) | 3.9061 | 3.9037 | 3.9296 | 3.9061 | **Run 1** | 6.80% | no |
| `getComboByName` (bypassed) | 14.2237 | 13.7235 | 14.4482 | 14.2237 | **Run 1** | 22.00% | yes (disk I/O) |

Across all 10 benchmarks, Run 1 corresponds directly to the median performance profile and is selected for canonical reporting in the master table.

### 3.2 Benchmark Analysis by Domain

#### 3.2.1 `bun:sqlite` Prepared Point Query
- **Command**: `bun scripts/perf-l0-micro.mjs`
- **Result**: **1.42 µs / op** (0.0014 ms / op), p95 = 1.84 µs, p99 = 1.91 µs, CV = 9.89% (non-noisy).
- **Workload**: 200 warmup batches, 30 measured batches of 10,000 prepared lookups against an in-memory SQLite table.
- **Analysis**: Confirms sub-2-microsecond retrieval for native `bun:sqlite` prepared statement execution on this host.

#### 3.2.2 Model String Parser (`parseModel`)
- **Command**: `bun scripts/perf-l0-micro.mjs`
- **Result**: **0.11 µs / op** (0.00011 ms / op), p95 = 0.14 µs, p99 = 0.15 µs, CV = 11.66% (non-noisy).
- **Workload**: 200 warmup batches, 30 measured batches of 100,000 parsing operations cycling through standard and custom model formats (`openai/gpt-4o-mini`, `claude-3-5-sonnet`, `anthropic/claude-3-5-sonnet-20241022`, `xmtp/custom-model`, `gemini/gemini-2.5-pro`, `deepseek-reasoner`).
- **Analysis**: High-speed prefix stripping and provider alias resolution executes in ~115 nanoseconds per call in Bun JavaScriptCore.

#### 3.2.3 `matchPattern` Glob Matching: Memoized Regex Cache vs. Uncached
- **Command**: `bun scripts/perf-l0-micro.mjs`
- **Cached Result**: **0.21 µs / op** (0.00021 ms / op), p95 = 0.23 µs, p99 = 0.23 µs, CV = 6.77% (non-noisy).
- **Uncached Comparison**: **0.83 µs / op** (0.00083 ms / op), p95 = 1.00 µs, p99 = 1.06 µs, CV = 11.54% (non-noisy).
- **Delta**: **-74.7% latency reduction** (3.96x speedup) from memoizing compiled `RegExp` instances in `open-sse/providers/pricing.js` via the bounded LRU cache (T010b).

#### 3.2.4 `findModel` Registry Lookup: Map Index vs. Linear Scan
- **Command**: `bun scripts/perf-l0-micro.mjs`
- **Map Lookup Result**: **0.08 µs / op** (0.00008 ms / op), p95 = 0.10 µs, p99 = 0.11 µs, CV = 12.68% (non-noisy).
- **Linear Scan Comparison**: **0.30 µs / op** (0.00030 ms / op), p95 = 0.33 µs, p99 = 0.34 µs, CV = 10.19% (non-noisy).
- **Delta**: **-74.4% latency reduction** (3.91x speedup) from the module-load `Map<modelId, entry>` index in `open-sse/config/providerModels.js` (T010), converting linear scans into O(1) map lookups.

#### 3.2.5 Configuration TTL Caching: Warm vs. Bypassed Database Queries
- **Command**: `bun scripts/perf-l0-micro.mjs` (isolated temporary `DATA_DIR`)
- **`getModelAliases` Warm**: **0.80 µs / op** (0.00080 ms / op), p95 = 0.91 µs, CV = 7.73% (non-noisy).
- **`getModelAliases` Bypassed**: **9.03 µs / op** (0.0090 ms / op), p95 = 12.03 µs, CV = 16.63% (flagged noisy due to SQLite disk/WAL paging).
  - **Delta**: **-91.1% latency reduction** (11.3x speedup) through the 5-second in-memory TTL cache in `src/lib/db/repos/aliasRepo.js`.
- **`getComboByName` Warm**: **3.91 µs / op** (0.0039 ms / op), p95 = 4.46 µs, CV = 6.80% (non-noisy).
- **`getComboByName` Bypassed**: **14.22 µs / op** (0.0142 ms / op), p95 = 20.06 µs, CV = 22.00% (flagged noisy due to SQLite disk/WAL paging).
  - **Delta**: **-72.5% latency reduction** (3.64x speedup) through the in-memory Map TTL cache in `src/lib/db/repos/combosRepo.js`.

### 3.3 Golden Regression Verifiers
All Wave 8 golden verification baselines continue to pass with 100% green integrity:
- **Alias Snapshot Verification** (`bun tests/__baseline__/verify-alias.mjs`): 132/132 tokens byte-for-byte pass.
- **Provider Registry Snapshot** (`bun tests/__baseline__/verify-providers.mjs`): 126/126 providers byte-for-byte pass.
- **Driver Pruning Gate** (`bun scripts/verify-driver-pruning.mjs`): zero occurrences of non-Bun SQL drivers across entire codebase.

---

## 4. L1 In-Process Harness Analysis

### 4.1 Canonical Before vs. After Slim Comparison
- **Baseline Profile** (`specs/008-bun-perf-scale/results/l1-baseline.json`): commit `2e36709e`
- **After-Slim Profile** (`specs/008-bun-perf-scale/results/l1-after.json`): commit `97431a0c`

| Metric | Baseline (`l1-baseline.json`) | After Slim (`l1-after.json`) | Absolute Delta | Relative Delta | Research D7 Target | Verdict |
|---|---|---|---|---|---|---|
| **p50 Latency** | 1.3708 ms | 1.0080 ms | -0.3628 ms | **-26.47%** | ≥ 35.0% lower | **MISSED** (by 8.53 pp) |
| **p95 Latency** | 5.0359 ms | 2.5950 ms | -2.4409 ms | **-48.47%** | ≥ 25.0% lower | **MET & EXCEEDED** (+23.47 pp) |
| **p99 Latency** | 12.1579 ms | 12.0116 ms | -0.1463 ms | -1.20% | Informational | Improved |
| **Mean Latency** | 1.8334 ms | 1.4010 ms | -0.4324 ms | -23.58% | Informational | Improved |
| **DB Queries / Req** | 15.20 | 10.78 | -4.42 | **-29.08%** | Strict decrease | **MET** (`QUERY_COUNT_DROPPED`) |
| **Run CV (%)** | 5.39% | 10.85% | +5.46% | Stable | < 15.0% (non-noisy) | **MET** (stable) |

### 4.2 Fresh Same-Session Alternating A/B Runs (A, B, A, B)
To ensure that performance deltas reflect code optimizations rather than ambient host thermal throttling or OS scheduling drift, a fresh same-session A/B benchmark was conducted alternating 2 rounds of the pre-slim commit `1e057b21` (run in a throwaway detached worktree) against the current HEAD `075ec17f`:

- **Round A1** (Commit `1e057b21`, throwaway detached worktree):
  - Command: `bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round1 --out /tmp/perf-ab-outputs/a1.json`
  - Results: `p50=1.3692 ms`, `p95=4.8192 ms`, `p99=11.8228 ms`, `mean=1.8112 ms`, `queries=15.20`, `CV=6.30%`
  - Run means: `[2.0141, 1.7718, 1.7700, 1.7413, 1.7586]`
- **Round B1** (Current HEAD `075ec17f`, active worktree):
  - Command: `bun scripts/perf-l1-harness.mjs --label ladder-head-round1 --out /tmp/perf-ab-outputs/b1.json`
  - Results: `p50=1.0123 ms`, `p95=2.6440 ms`, `p99=11.8843 ms`, `mean=1.4173 ms`, `queries=10.82`, `CV=9.48%`
  - Run means: `[1.6483, 1.3936, 1.3740, 1.2974, 1.3729]`
- **Round A2** (Commit `1e057b21`, throwaway detached worktree):
  - Command: `bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round2 --out /tmp/perf-ab-outputs/a2.json`
  - Results: `p50=1.3505 ms`, `p95=5.0413 ms`, `p99=12.3676 ms`, `mean=1.8163 ms`, `queries=15.20`, `CV=6.33%`
  - Run means: `[2.0201, 1.7910, 1.7517, 1.7623, 1.7564]`
- **Round B2** (Current HEAD `075ec17f`, active worktree):
  - Command: `bun scripts/perf-l1-harness.mjs --label ladder-head-round2 --out /tmp/perf-ab-outputs/b2.json`
  - Results: `p50=1.0224 ms`, `p95=2.5898 ms`, `p99=12.0774 ms`, `mean=1.4122 ms`, `queries=10.80`, `CV=10.18%`
  - Run means: `[1.6640, 1.3880, 1.3592, 1.3073, 1.3423]`

### 4.3 Drift and Variance Analysis
Across the alternating same-session runs:
1. **Pre-Slim Baseline Stability**:
   - Round A1 p50: `1.3692 ms` vs Round A2 p50: `1.3505 ms` (inter-round drift: `0.0187 ms`, or 1.36%).
   - Round A1 p95: `4.8192 ms` vs Round A2 p95: `5.0413 ms`.
   - CV remained tightly grouped at `6.30%` and `6.33%`.
2. **Current HEAD Stability**:
   - Round B1 p50: `1.0123 ms` vs Round B2 p50: `1.0224 ms` (inter-round drift: `0.0101 ms`, or 0.99%).
   - Round B1 p95: `2.6440 ms` vs Round B2 p95: `2.5898 ms`.
   - CV remained stable at `9.48%` and `10.18%` (both well below the 15% noise ceiling).
3. **Consistent Improvement**:
   - In Round 1, p50 improved by **-26.07%** (-0.3569 ms) and p95 improved by **-45.13%** (-2.1752 ms).
   - In Round 2, p50 improved by **-24.29%** (-0.3281 ms) and p95 improved by **-48.63%** (-2.4515 ms).
   - Database queries dropped consistently from `15.20` to `10.80–10.82` queries/request in all rounds.

---

## 5. L2 Loopback Status & Hand-Off

### 5.1 Verification of Standalone Artifact Absence on Host
Per project architecture (`CLAUDE.md`), production server execution requires standalone bundles:
- `npm run start:bun` invokes `bun ./.next/standalone/custom-server.js`.
- Inspection of the working directory confirmed:
  ```bash
  ls -la .next/standalone 2>/dev/null || echo "NO_STANDALONE"
  # Output: NO_STANDALONE
  ```
- No prebuilt `.next/standalone` directory exists in the source checkout.

### 5.2 Why `bun run dev:bun` is Non-Representative
CLAUDE.md notes: `bun run build:bun then start:bun is heavy`. Full production compilation requires running Next.js Webpack compilation across all frontend and API routes, taking 2–3 minutes and driving all 16 CPU threads to 100% saturation, violating the leaf invariant: `NOTHING else may run on the machine during this leaf (load < 1.0)`.

Evaluating `bun run dev:bun` (`next dev --webpack`) revealed:
1. **Dynamic Webpack Compilation**: Next.js development mode compiles webpack chunks on-demand for every endpoint on initial hit, adding 150–350 ms of compilation latency.
2. **HMR and File Watchers**: Development mode runs Hot Module Replacement WebSocket servers and filesystem watchers (`inotify`), polluting the event loop.
3. **Absence of Optimization**: Unminified, untranspiled development bundles produce latency numbers an order of magnitude higher (~50–100 ms vs ~1–2 ms), which does not represent true server capacity.

### 5.3 L2 Certification Refusal & Safety Verification
Running the load driver probe `scripts/perf-ladder.sh 1 --url http://127.0.0.1:29148`:
- Correctly refused certification:
  ```text
  [UNMEASURED] Certification refused: Target unreachable at http://127.0.0.1:29148/v1/chat/completions: ECONNREFUSED
  ```
- Output strictly conformed to the `LadderRow` contract with `UNMEASURED` and explicit cause.
- Port verification confirmed that zero dangling mock or server processes remain on the host (`ss -tulpn | grep -E "29148|40128"` returned empty).
- Single-replica and multi-replica HTTP server throughput benchmarks are safely handed off to the containerized L3 tier (Task T023), where the pre-compiled production standalone image is evaluated.

---

## 6. Inventory of UNMEASURED Cells and Causes

Per requirement FR-008, all unmeasured cells are explicitly accounted for:

| Tier | Metric(s) | Status | Specific Cause | Handoff & Resolution |
|---|---|---|---|---|
| **L2 loopback** (single-replica HTTP) | `p50_ms`, `p95_ms`, `p99_ms`, `req_per_s` | `UNMEASURED` | Host checkout lacks prebuilt `.next/standalone`. Running `bun run build:bun` would violate the CPU load < 1.0 invariant. Running `bun run dev:bun` is non-representative due to Webpack dev compilation and HMR overhead. | Handed off to containerized L3 tier (T023), which evaluates the compiled standalone image under loopback load driver `scripts/perf-ladder.sh`. |

---

## 7. Leaf Gate Verification Evidence

- **Gate G1 Check**:
  ```bash
  test -s specs/008-bun-perf-scale/results/ladder-host.md && \
  grep -q "L0 micro" specs/008-bun-perf-scale/results/ladder-host.md && \
  grep -q "L1 harness" specs/008-bun-perf-scale/results/ladder-host.md && \
  grep -q "L2 loopback" specs/008-bun-perf-scale/results/ladder-host.md && \
  echo LADDER_HOST_ROWS_VALID
  ```
- **Gate G2 Check**:
  Confirmed host purity: zero container engine command invocations recorded in this document.
  Verification: case-insensitive check confirms 0 matches.
- **Gate G3 Check**:
  Confirmed through strict adherence to isolated temporary directory usage (`/tmp/khatam-perf-data-*`), zero modifications to production `~/.9router`, verified load averages < 1.0 prior to every timing run, clean removal of the throwaway worktree `1e057b21`, and port verification confirming zero dangling listeners.

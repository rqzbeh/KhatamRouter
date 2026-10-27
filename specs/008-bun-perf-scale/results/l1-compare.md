# L1 In-Process Performance Comparison: Baseline vs After-Slim vs Control

> **Measurement Context**: In-process benchmark via `scripts/perf-l1-harness.mjs` using a mock executor. Workload: 1,000 requests/run, 100 warmup requests, 5 runs across 40% direct, 40% translated, 20% combo mix on Bun 1.4.3 (AMD Ryzen 7 4800H, 8 cores). Isolated `DATA_DIR` per harness run.

## Summary Table

| Metric | Baseline (`7fbd38e0`) | Control (`7fbd38e0`) | After-Slim (`7ec97d1f`) | Delta vs Base (%) | Delta vs Control (%) | D7 Target | Verdict |
|---|---|---|---|---|---|---|---|
| **Total p50** | 1.3483 ms | 1.3686 ms | 1.0022 ms | -25.67% | -26.77% | $\ge$ 35% reduction | **MISSED** (25.67% < 35.0%) |
| **Total p95** | 4.9256 ms | 4.9995 ms | 2.5635 ms | -47.96% | -48.72% | $\ge$ 25% reduction | **MET** (47.96% $\ge$ 25.0%) |
| **Total p99** | 12.3036 ms | 12.4095 ms | 10.8114 ms | -12.13% | -12.88% | n/a | n/a |
| **Total Mean** | 1.8010 ms | 1.8223 ms | 1.3828 ms | -23.22% | -24.12% | n/a | n/a |
| **DB Queries/Req** | 15.20 | 15.20 | 10.78 | -29.08% | -29.08% | $\le$ 11.0 | **MET** (10.78 $\le$ 11.0) |
| **Run CV** | 8.03% | 7.70% | 10.37% | +2.34% pts | +2.67% pts | $\le$ 15% | **MET** (10.37% $\le$ 15%) |

## D7 Threshold Evaluation (Honest Verdict)

- **D7 Criterion 1 (p50 reduction $\ge$ 35%)**: **MISSED**.
  - Baseline p50: 1.3483 ms $\to$ After-slim p50: 1.0022 ms (reduction: **25.67%** vs baseline, **26.77%** vs contemporaneous control).
  - Target of $\ge$ 35% was not met. This run did not profile the source of the remaining p50 time. `dispatch_glue` is the largest phase (see `l1-hotspots.md`), but no causal attribution for the p50 gap was measured.
- **D7 Criterion 2 (p95 reduction $\ge$ 25%)**: **MET**.
  - Baseline p95: 4.9256 ms $\to$ After-slim p95: 2.5635 ms (reduction: **47.96%** vs baseline, **48.72%** vs control).
  - Per-phase attribution for the p95 change was not measured in this run.
- **D7 Criterion 3 (db_queries_per_req $\le$ 11.0)**: **MET**.
  - Baseline: 15.20 queries/req $\to$ After-slim: 10.78 queries/req (reduction: **29.08%**).
  - Target $\le$ 11.0 is satisfied. The per-query source of the 4.42 removed queries was not traced in this run.

## Per-Phase Breakdown (Means in ms)

| Phase | Baseline Mean | Control Mean | After-Slim Mean | Delta vs Base (%) | Delta vs Control (%) | Notes |
|---|---|---|---|---|---|---|
| `auth_acl` | 0.0963 ms | 0.0967 ms | 0.0343 ms | -64.38% | -64.53% | Largest relative drop; cause not profiled in this run |
| `model_info` | 0.0484 ms | 0.0501 ms | 0.0503 ms | +3.93% | +0.40% | Flat within noise |
| `translate` (combined) | 0.0280 ms | 0.0269 ms | 0.0133 ms | -52.50% | -50.56% | Cause not profiled in this run |
| `translate_request` | 0.0238 ms | 0.0240 ms | 0.0088 ms | -63.03% | -63.33% | Cause not profiled in this run |
| `translate_response` | 0.0041 ms | 0.0029 ms | 0.0045 ms | +9.76% | +55.17% | Sub-0.01 ms; within noise |
| `executor_mock` | 0.0117 ms | 0.0119 ms | 0.0103 ms | -11.97% | -13.45% | Mock executor |
| `dispatch_glue` | 1.2073 ms | 1.2089 ms | 0.8771 ms | -27.35% | -27.45% | Largest phase; cause not profiled in this run |
| `stream_drain` | 0.1616 ms | 0.1620 ms | 0.1505 ms | -6.87% | -7.10% | Stream reader consumption |
| `bookkeeping` | 0.2489 ms | 0.2659 ms | 0.2484 ms | -0.20% | -6.58% | Usage logging + SQLite `db.immediate` transaction |
| `other` | 0.0000 ms | 0.0000 ms | 0.0000 ms | 0.00% | 0.00% | Unaccounted time |

## Variance and Environmental Controls

- **Machine Load (1-min, from `uptime`)**: Control run: 0.68 before, 1.28 after. After-slim run: 0.62 and 0.81 (`uptime` read before and after). Baseline (original) load was not recorded in this session.
- **Run CVs**: Baseline: 8.03%, Control: 7.70%, After-slim: 10.37% (all strictly under the 15% threshold).
- **Control Consistency**: Baseline vs contemporaneous Control results are within 1.5% across all total percentiles, proving minimal host drift between runs.

# Performance Ladder Master Results: Integrated Host, Harness, and Container Benchmarks

**Document Identifier**: `specs/008-bun-perf-scale/ladder-results.md`  
**Scope**: Task T024 (Gate `leaf-f-closeout`, US3 completion). Master integration of host benchmarks (`results/ladder-host.md`), container multi-replica benchmarks (`results/ladder-l3.md`), and L1 harness profiling (`results/l1-compare.md`).  
**Date**: 2026-10-27  
**Git Branch**: `feat/wave8-bun-perf-scale`  
**Git HEAD**: `a2c23acc`  
**Commits Measured**:
- Baseline Pre-Slim: `2e36709e` / `1e057b21`
- After-Slim In-Process: `97431a0c` / `075ec17f`
- Initial Container Overlay: `0455a34e`
- Attribution Container Experiments: `dc10ad3d`
- SQLite Immediate Concurrency Fix & Controlled Follow-up: `4375977f` / `5d43ac6a` / `a2c23acc`
**Hardware / Host Topology**:
- CPU: AMD Ryzen 7 4800H with Radeon Graphics (8 physical cores / 16 threads, 3.0 GHz base / 4.2 GHz boost)
- OS: Linux 6.18.54.1-microsoft-standard-WSL2 (x86_64)
- Runtime: Native Bun 1.4.3 (JSC engine)
- Storage / DB: `bun:sqlite` in WAL mode (`busy_timeout = 5000`) on ephemeral temporary `DATA_DIR` (host) and shared named volume `9router-data` (containers)

---

## 1. Master Performance Ladder Table

Conforming strictly to the `LadderRow` data model schema (`specs/008-bun-perf-scale/data-model.md`):  
`| tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |`

| Tier / Category | Replicas | p50 (ms) | p95 (ms) | p99 (ms) | Throughput (req/s) | Mode | CV (%) | Errors | Environment | Command / Pointer | Cause / Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **L0 micro** (sqlite point query) | 1 | 0.0014 | 0.0018 | 0.0019 | 705074.9 | normal | 9.89% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | Sub-2µs native `bun:sqlite` prepared statement lookup. |
| **L0 micro** (model string parser) | 1 | 0.00011 | 0.00014 | 0.00015 | 8710012.3 | normal | 11.66% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | ~115ns fast-path model prefix and provider alias resolution. |
| **L0 micro** (matchPattern cached) | 1 | 0.00021 | 0.00023 | 0.00023 | 4789219.3 | normal | 6.77% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | 3.96x speedup via memoized RegExp cache in `pricing.js` (T010b). |
| **L0 micro** (matchPattern uncached comparison) | 1 | 0.00083 | 0.0010 | 0.0011 | 1210115.2 | normal | 11.54% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | Baseline uncached regex recompilation on every glob match. |
| **L0 micro** (findModel Map lookup) | 1 | 0.00008 | 0.00010 | 0.00011 | 13023667.8 | normal | 12.68% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | 3.91x speedup via module-load `Map<modelId, entry>` index (T010). |
| **L0 micro** (findModel linear scan comparison) | 1 | 0.00030 | 0.00033 | 0.00034 | 3331416.2 | normal | 10.19% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | Baseline linear search across provider models array. |
| **L0 micro** (getModelAliases cache warm) | 1 | 0.00080 | 0.00091 | 0.00097 | 1255397.0 | normal | 7.73% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | 5-second in-memory TTL cache in `aliasRepo.js` (T009). |
| **L0 micro** (getModelAliases cache bypassed) | 1 | 0.0090 | 0.0120 | 0.0151 | 110722.9 | noisy | 16.63% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | CV > 15% (16.63%) due to filesystem/WAL paging variance; marked noisy per protocol and must not be used for quantitative claims. |
| **L0 micro** (getComboByName cache warm) | 1 | 0.0039 | 0.0045 | 0.0048 | 256009.0 | normal | 6.80% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | 5-second in-memory Map TTL cache in `combosRepo.js` (T009). |
| **L0 micro** (getComboByName cache bypassed) | 1 | 0.0142 | 0.0201 | 0.0246 | 70305.3 | noisy | 22.00% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l0-micro.mjs` | CV > 15% (22.00%) due to filesystem/WAL paging variance; marked noisy per protocol and must not be used for quantitative claims. |
| **L1 harness** (baseline T007) | 1 | 1.3708 | 5.0359 | 12.1579 | 545.4 | normal | 5.39% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label baseline --out results/l1-baseline.json` | Baseline commit `2e36709e` before request slimming. |
| **L1 harness** (after slim T014) | 1 | 1.0080 | 2.5950 | 12.0116 | 713.8 | normal | 10.85% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label after-slim --out results/l1-after.json` | Post-slimming commit `97431a0c`; p95 reduced by 48.47%. |
| **L1 harness** (same-session A1 pre-slim) | 1 | 1.3692 | 4.8192 | 11.8228 | 552.1 | normal | 6.30% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `cd <throwaway-t007> && bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round1` | Same-session A/B round 1 baseline (commit `1e057b21`). |
| **L1 harness** (same-session B1 HEAD) | 1 | 1.0123 | 2.6440 | 11.8843 | 705.6 | normal | 9.48% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label ladder-head-round1` | Same-session A/B round 1 post-slim (commit `075ec17f`); p50 -26.07%, p95 -45.13%. |
| **L1 harness** (same-session A2 pre-slim) | 1 | 1.3505 | 5.0413 | 12.3676 | 550.6 | normal | 6.33% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `cd <throwaway-t007> && bun scripts/perf-l1-harness.mjs --label t007-pre-slim-round2` | Same-session A/B round 2 baseline (commit `1e057b21`). |
| **L1 harness** (same-session B2 HEAD) | 1 | 1.0224 | 2.5898 | 12.0774 | 708.1 | normal | 10.18% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `bun scripts/perf-l1-harness.mjs --label ladder-head-round2` | Same-session A/B round 2 post-slim (commit `075ec17f`); p50 -24.29%, p95 -48.63%. |
| **L2 loopback** (single-replica) | 1 | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | normal | 0.00% | 0 | AMD Ryzen 7 4800H host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:29148` | Host lacks prebuilt .next/standalone bundle because full build would saturate host load; unbundled dev mode runs with Webpack HMR compilation overhead and is not run for production benchmarks. Standalone HTTP execution handed off to containerized L3 tier (T023). |
| **L3 initial** (1-replica control) | 1 | 50.04 | 69.42 | 84.94 | 188.2 | normal | 9.41% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:30128` | Initial control run at commit `0455a34e` ($C=10$). |
| **L3 initial** (2-replica scaled) | 2 | 35.89 | 61.22 | 76.26 | 274.7 | normal | 13.36% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128` | Initial 2-replica scaled run ($C=10$); ratio 1.46x vs 1-replica. |
| **L3 initial** (4-replica scaled) | 4 | 25.36 | 62.45 | 80.37 | 337.7 | normal | 14.77% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 4 --url http://127.0.0.1:30128` | Initial 4-replica scaled run ($C=10$); ratio 1.79x vs 1-replica. |
| **L3 initial** (2-replica Redis down) | 2 | 33.41 | 63.82 | 79.99 | 284.1 | degraded | 13.09% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128` | Degraded mode drill (Redis halted); 1.03x throughput parity, 0 errors. |
| **L3 attribution** (A1: Variable LB, $C=10$) | 1 | 52.65 | 72.83 | 88.31 | 183.5 | normal | 8.99% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:30128 --concurrency 10` | Section 10 baseline run at commit `dc10ad3d`. |
| **L3 attribution** (A2: Variable LB, $C=40$, exploratory) | 1 | 209.90 | 253.81 | 260.23 | 186.5 | normal | 9.18% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:30128 --concurrency 40` | Exploratory high concurrency load; refutes client bottleneck. |
| **L3 attribution** (A3: Variable LB, $C=10$) | 2 | 35.80 | 65.57 | 85.50 | 273.4 | normal | 12.84% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 10` | Section 10 2-replica run; ratio 1.49x vs A1. |
| **L3 attribution** (A4: Variable LB, $C=40$, exploratory) | 2 | 129.22 | 267.06 | 302.27 | 275.9 | normal | 13.62% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 40` | Exploratory high concurrency; throughput shifts by only +0.9%. |
| **L3 attribution** (B1: Keepalive 64, $C=10$, exploratory) | 1 | 45.06 | 89.99 | 111.55 | 195.4 | normal | 9.76% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:30128 --concurrency 10` | Exploratory Nginx keepalive tuning; +6.5% req/s over A1. |
| **L3 attribution** (B2: Keepalive 64, $C=10$, exploratory) | 2 | 29.13 | 71.43 | 88.17 | 301.2 | normal | 14.08% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 10` | Exploratory Nginx keepalive tuning; ratio 1.54x vs B1. |
| **L3 attribution** (B2-info: Keepalive, $C=40$, exploratory) | 2 | 125.58 | 243.34 | 294.22 | 297.4 | normal | 14.06% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 40` | Exploratory Nginx keepalive at $C=40$; confirms connection ceiling. |
| **L3 attribution** (C1: Direct LB-Bypass, $C=20$, exploratory) | 1 | 90.75 | 136.01 | 193.32 | 207.0 | normal | 9.66% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://172.31.250.4:20128 --concurrency 20` | Exploratory direct container dispatch bypassing Nginx load balancer. |
| **L3 attribution** (C2: Direct LB-Bypass, $2\times C=20$, exploratory) | 2 | 110.42 | 158.78 | 237.90 | 341.6 | normal | 9.68% | 0 | Linux x64 host Bun 1.4.3 | `Parallel in-net drivers: W1 172.31.250.4 + W2 172.31.250.5` | Exploratory direct bypass (171.3 + 170.3 req/s); ratio 1.65x vs C1. |
| **L3 controlled R1** (1-rep via Nginx, shipped path) | 1 | 99.89 | 126.34 | 139.01 | 196.1 | normal | 4.64% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://127.0.0.1:30128 --concurrency 20` | Shipped Nginx path (repo config); 3 repeats [192.7, 196.0, 199.6] req/s. |
| **L3 controlled R2** (2-rep via Nginx, 1 driver $C=40$) | 2 | 119.91 | 240.85 | 283.72 | 306.4 | normal | 6.49% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 2 --url http://127.0.0.1:30128 --concurrency 40` | Shipped Nginx path; 3 repeats [292.2, 311.7, 315.3] req/s. |
| **L3 controlled R3** (2-rep via Nginx, 2 drivers $2\times C=20$, shipped path) | 2 | 121.68 | 234.21 | 268.71 | 310.2 | normal | 6.60% | 0 | Linux x64 host Bun 1.4.3 | `2x parallel scripts/perf-ladder.sh to http://127.0.0.1:30128` | Shipped Nginx path; 3 repeats [302.2, 309.4, 318.9] req/s; R3/R1 mean ratio = 1.58x. |
| **L3 controlled R4a** (1-rep Direct, 1 driver $C=20$, exploratory) | 1 | 91.02 | 140.49 | 199.40 | 205.3 | normal | 4.96% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh 1 --url http://172.31.250.4:20128 --concurrency 20` | Exploratory direct bypass baseline; 3 repeats [200.4, 206.3, 209.3] req/s. |
| **L3 controlled R4b** (1-rep Direct, 2 drivers $2\times C=10$, exploratory) | 1 | 90.30 | 141.94 | 194.96 | 208.3 | normal | 4.05% | 0 | Linux x64 host Bun 1.4.3 | `2x drivers to http://172.31.250.4:20128` | Exploratory 2-driver control; 3 repeats [203.9, 209.8, 211.1] req/s. |
| **L3 controlled R5** (2-rep Direct, 1 driver $C=40$ RR, exploratory) | 2 | 115.05 | 216.09 | 256.66 | 321.5 | normal | 6.58% | 0 | Linux x64 host Bun 1.4.3 | `scripts/perf-ladder.sh --url RR --concurrency 40` | Exploratory client round-robin; 3 repeats [312.4, 330.1, 322.1] req/s. |
| **L3 controlled R6** (2-rep Direct matched, 2 drivers $2\times C=20$, exploratory) | 2 | 111.60 | 164.96 | 243.66 | 339.7 | normal | 4.49% | 0 | Linux x64 host Bun 1.4.3 | `2x drivers direct to replicas (172.31.250.4 + 172.31.250.5)` | Exploratory direct bypass; 3 repeats [330.8, 336.9, 351.4] req/s. |
| **L3 controlled R7** (2-rep via Nginx tuned keepalive, 2 drivers, exploratory) | 2 | 117.14 | 245.03 | 276.31 | 321.4 | normal | 6.21% | 0 | Linux x64 host Bun 1.4.3 | `2x drivers to http://127.0.0.1:30128 (keepalive 64)` | Exploratory tuned Nginx keepalive; 3 repeats [308.8, 325.7, 329.6] req/s. |

---

## 2. Plain-Language Verdict on Whether the Ceiling Moved

### 2.1 Executive Summary
Did the performance ceiling move?
- **In-Process Gateway Overhead**: **YES, the in-process request processing overhead dropped substantially**. End-to-end request latency was reduced, query amplification dropped from 15.2 to ~10.8 queries/request, and tail latency (p95) was cut nearly in half (~45–49% reduction).
- **End-to-End System Throughput Ceiling Through Nginx**: **NO, the end-to-end throughput ceiling through the shipped Nginx overlay on this host did not change by a certified amount**. Under the shipped overlay configuration (`deploy/nginx-scale.conf`), 2-replica scaling achieved a mean throughput ratio of **1.58x** (min-max range: 1.51x–1.65x), which fails to certify the strict D7 requirement ($\ge 1.60\times$).

### 2.2 In-Process L1 Evaluation Against Research D7 Targets
Research D7 established two strict in-process latency reduction targets for the gateway request path under identical workload:

| Tier / Metric | Baseline (T007 / A1/A2) | After Slim (T014 / B1/B2) | Absolute Delta | Measured Reduction | Research D7 Target | Verdict |
|---|---|---|---|---|---|---|
| **L1 p50 Latency (all runs)** | 1.3708 ms | 1.0080 ms | -0.3628 ms | **-26.47%** | $\ge 35.0\%$ lower | **MISSED TARGET** (by 8.53 pp) |
| **L1 p50 (steady-state runs 2–5)** | 1.3708 ms | 0.9730 ms | -0.3978 ms | **-29.02%** | $\ge 35.0\%$ lower | **MISSED TARGET** (by 5.98 pp) |
| **L1 p50 (same-session A1 vs B1)** | 1.3692 ms | 1.0123 ms | -0.3569 ms | **-26.07%** | $\ge 35.0\%$ lower | **MISSED TARGET** (by 8.93 pp) |
| **L1 p50 (same-session A2 vs B2)** | 1.3505 ms | 1.0224 ms | -0.3281 ms | **-24.29%** | $\ge 35.0\%$ lower | **MISSED TARGET** (by 10.71 pp) |
| **L1 p95 Latency (all runs)** | 5.0359 ms | 2.5950 ms | -2.4409 ms | **-48.47%** | $\ge 25.0\%$ lower | **MET & EXCEEDED** (+23.47 pp) |
| **L1 p95 (same-session A1 vs B1)** | 4.8192 ms | 2.6440 ms | -2.1752 ms | **-45.13%** | $\ge 25.0\%$ lower | **MET & EXCEEDED** (+20.13 pp) |
| **L1 p95 (same-session A2 vs B2)** | 5.0413 ms | 2.5898 ms | -2.4515 ms | **-48.63%** | $\ge 25.0\%$ lower | **MET & EXCEEDED** (+23.63 pp) |
| **Database Queries / Request** | 15.20 | 10.78 – 10.82 | -4.42 queries | **-29.08%** | Strict decrease | **MET** (`QUERY_COUNT_DROPPED`) |
| **Measurement Stability (CV %)** | 5.39% – 6.33% | 9.48% – 10.85% | +4.5% to +5.4% | Stable | $< 15.0\%$ noise ceiling | **MET** (non-noisy) |

#### Analysis of L1 Outcomes
1. **Authoritative Same-Session A/B Comparison**: The alternating same-session runs (A1 $\to$ B1 $\to$ A2 $\to$ B2) provide the authoritative benchmark, eliminating ambient thermal or OS scheduling drift. Across all comparisons, p50 latency dropped by **~24% to 29%**, consistently missing the 35% reduction target.
2. **p95 Latency Victory**: Tail latency was slashed by **~45% to 49%** (saving > 2.4 ms/req). This win was driven by:
   - Eliminating dynamic RegExp compilation bursts in `matchPattern` via LRU caching (T010b, -74.7% micro-latency).
   - Replacing linear model array scans with O(1) map indexing in `findModel` (T010, -74.4% micro-latency).
   - Eliminating redundant `apiKeys` database lookups and threading `keyRecord` through request handlers (T012, -63.5% auth latency).
3. **Run 1 Warm-up Behavior**: Across all L1 test series, Run 1 is consistently warm-up-high (~20–25% higher latency than runs 2–5) due to initial JavaScriptCore JIT optimization and connection pool priming. Coefficient of variation (CV) remained tightly bounded between 9.48% and 10.85%, well below the 15.0% noise ceiling.

---

### 2.3 Multi-Replica Scaling Evaluation Against Research D7 Target
Requirement D7 specifies that 2-replica scaling throughput must reach $\ge 1.60\times$ the 1-replica throughput under identical workload:

| Tier / Variant Description | Comparison Pair | Mean Ratio | Min-Max Spread | D7 Target ($\ge 1.60\times$) | Certification Verdict |
|---|---|---|---|---|---|
| **Shipped Nginx LB Overlay Path** | Controlled R3 ($2\times C=20$) / R1 ($1\times C=20$) | $\mathbf{1.58\times}$ | $[1.51\times, 1.65\times]$ | $\ge 1.60\times$ | **NOT CERTIFIED** (mean 1.58x, range 1.51–1.65x) |
| **Shipped Nginx vs. 2-Driver Control** | Controlled R3 ($2\times C=20$) / R4b ($2\times C=10$) | $\mathbf{1.49\times}$ | $[1.43\times, 1.56\times]$ | $\ge 1.60\times$ | **NOT CERTIFIED** |
| **Initial L3 Run (Commit 0455a34e)** | L3 Initial 2-replica / 1-replica control ($C=10$) | $\mathbf{1.46\times}$ | $[1.31\times, 1.60\times]$ | $\ge 1.60\times$ | **NOT CERTIFIED** |
| **Exploratory Direct LB-Bypass (Matched 2-Driver)** | Controlled R6 ($2\times C=20$) / R4b ($2\times C=10$) | $\mathbf{1.63\times}$ | $[1.57\times, 1.72\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** (not product path; spread straddles 1.6x) |
| **Exploratory Direct LB-Bypass (2-Driver vs 1-Driver)** | Controlled R6 ($2\times C=20$) / R4a ($1\times C=20$) | $\mathbf{1.65\times}$ | $[1.58\times, 1.75\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** (not product path; spread straddles 1.6x) |
| **Exploratory Tuned Nginx Keepalive** | Controlled R7 ($2\times C=20$) / R1 ($1\times C=20$) | $\mathbf{1.64\times}$ | $[1.55\times, 1.71\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** (not product path; spread straddles 1.6x) |
| **Exploratory Tuned Nginx vs Direct Baseline** | Controlled R7 ($2\times C=20$) / R4b ($2\times C=10$) | $\mathbf{1.54\times}$ | $[1.46\times, 1.62\times]$ | $\ge 1.60\times$ | **EXPLORATORY ONLY** |

#### Mandated Multi-Replica Verdict
1. **Shipped Nginx Overlay (Product Path)**: Through the shipped repository overlay (`deploy/nginx-scale.conf`), the controlled 3-repeat measurement (R3/R1) achieved a mean throughput scaling ratio of **1.58x** (310.2 req/s vs 196.1 req/s) with a min-max range of **1.51x–1.65x**.
   - **Verdict**: **NOT CERTIFIED (mean 1.58x, range 1.51–1.65x)**.
   - The mean is below the 1.60x target and the min-max spread straddles it. We do not write MET and do not write MISSED by a wide margin; we report strictly that the target is not certified under the shipped configuration.
2. **Exploratory Variants Are NOT the Product Path**:
   - Direct-to-replica bypass achieves 1.63x [1.57, 1.72] (R6/R4b) and 1.65x [1.58, 1.75] (R6/R4a).
   - Tuned Nginx with static upstream keepalive achieves 1.64x [1.55, 1.71] (R7/R1).
   - **Crucial Rule**: None of these exploratory variants certifies the D7 target. They are not the shipped product path, and their measured min-max ranges also straddle 1.60x. Additionally, R6/R4b is not a perfectly matched concurrency pairing (2 drivers at C=20 delivering 40 concurrent requests vs 2 drivers at C=10 delivering 20 concurrent requests).
3. **Nginx Variable `proxy_pass` Trade-Off**:
   - The shipped overlay employs dynamic DNS re-resolution via `set $khatam_upstream http://9router:20128; proxy_pass $khatam_upstream;` so scaled container replicas can register and deregister dynamically.
   - In Nginx, using a variable in `proxy_pass` prevents upstream HTTP keepalive connection pooling.
   - The connection churn costs approximately **4%** (R3 310.2 req/s vs R7 321.4 req/s) to **10%** (Section 10 experiment A3 273.4 req/s vs B2 301.2 req/s) in throughput, with overlapping spreads.
   - This is reported as a modest, not precisely measured cost and an intentional architectural trade-off: dynamic DNS re-resolution is required for scaled replicas, whereas a static upstream with keepalive cannot dynamically discover scaled containers without Nginx Plus or external service mesh tooling.

---

## 3. Corrections to Earlier Reports (Refuted Hypotheses & Live Fixes)

Two significant claims from early benchmark passes were investigated, empirically tested, and formally refuted or corrected:

### 3.1 Correction 1: Refutation of "Client Concurrency ($C=10$) is the Primary Limiter"
- **Earlier Claim** (from initial L3 report, Section 4.2 & Defect 1):  
  *"The client load driver concurrency ($C=10$) is the primary limiter capping multi-replica throughput scaling below 1.60x via Little's Law saturation."*
- **Empirical Refutation**:
  - In Section 10 (Rows A1–A4), offered concurrency was quadrupled from $C=10$ to $C=40$. Throughput shifted by only **+1.6%** on 1 replica (183.5 $\to$ 186.5 req/s) and **+0.9%** on 2 replicas (273.4 $\to$ 275.9 req/s). Meanwhile, p50 queueing latency quadrupled from 52.65 ms to 209.90 ms on 1 replica and from 35.80 ms to 129.22 ms on 2 replicas.
  - In Section 11 (Controlled Follow-up, Rows R1–R3 and R4a–R4b), adding a second independent driver process changed throughput by approximately **1%** (R4b at 208.3 req/s vs R4a at 205.3 req/s; R3 at 310.2 req/s vs R2 at 306.4 req/s). Driver CPU utilization remained between 10.2% and 25.4%, far below client exhaustion.
- **Correction**: The client driver was never the primary throughput bottleneck. The gateway replicas were operating near their true capacity under $C=10$; increasing concurrency merely increased closed-loop queueing delays.

### 3.2 Correction 2: Correction of "SQLite Contention is a Minor Secondary Factor"
- **Earlier Claim** (from Section 10.4):  
  *"SQLite concurrent write lock contention produces ~114 SQLITE_BUSY contention instances, but 9router replicas fail open cleanly, making this a minor secondary factor."*
- **Empirical Investigation & Discovery**:
  - While client requests received 200 OK responses (failing open for client traffic), the database suffered **silent usage-row loss**: 114 occurrences of `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` per ~5,000 requests caused 60.8% of background usage write operations to fail under multi-replica concurrent write bursts.
  - In default deferred transactions (`BEGIN DEFERRED`), multiple replica processes acquire shared read locks simultaneously, then attempt to upgrade to exclusive write locks when persisting usage records. When two replicas attempt lock upgrades concurrently, `SQLITE_BUSY_SNAPSHOT` occurs and one transaction is aborted.
- **Live Fix & Verification**:
  - Commit `4375977f` implemented upfront write lock acquisition via `BEGIN IMMEDIATE` (`db.immediate()`) in `src/lib/db/repos/usageRepo.js` (`saveRequestUsage`).
  - **Live Container Verification** (Section 11.1): Evaluated under 3,000 concurrent streaming requests ($C=40$) across 2 replicas:
    - Logged occurrences of `SQLITE_BUSY`: **0** (down from 114).
    - Logged occurrences of `SQLITE_BUSY_SNAPSHOT`: **0** (down from 114).
    - `request_cost_ledger` persistence: **3,000 / 3,000 rows (100.0% integrity, 0 lost records)**.
    - `usageHistory` recorded 2,965 rows (the 35-row shortfall was traced to intentional millisecond deduplication in `usageRepo.js`, not SQLite errors).
- **Correction**: SQLite lock contention was not a minor benign symptom; it was causing silent accounting loss. It is now completely eliminated by `BEGIN IMMEDIATE` transaction serialization.

---

## 4. Environment Caveats & Boundary Conditions

To maintain strict scientific integrity, all findings must be interpreted under the following physical and architectural boundary conditions:

1. **Single-Host Co-Location**:
   - The test client (`scripts/perf-ladder.sh`), Nginx load balancer (`172.31.250.254`), mock upstream server (`khatam-mock-upstream:40128`), and all `9router` replicas were co-located on a single physical host: AMD Ryzen 7 4800H (8 physical cores / 16 logical threads) running under WSL2 Linux.
   - During 2-replica runs, active CPU utilization reached ~2.7–3.0 physical cores. During 4-replica runs, total container CPU reached ~4.4 cores and the host client reached ~1.4 cores (~5.8 cores total).
   - While the host did not experience 100% core exhaustion, context switching, network namespace traversal, and CPU cache thrashing on the shared host impact multi-replica scaling. Absolute numbers do not represent distributed production capacity.
2. **Ceiling Statement Boundary**:
   - The performance ceiling claim is strictly limited to this single-host test environment: **the in-process gateway overhead per request dropped substantially (p95 reduced ~48%), but the end-to-end multi-replica throughput ceiling through Nginx on this host did not change by a certified amount (mean 1.58x vs target 1.60x)**.
3. **Mock Zero-Latency Upstream**:
   - The upstream server (`scripts/perf-mock-upstream.mjs`) responds in ~0.5–1.0 ms with static JSON/SSE chunks. This benchmark measures the **pure overhead of the 9router gateway engine** (routing, translation, auth, ledger writes), not real-world LLM provider latency.

---

## 5. Next Bottlenecks (from Empirical Profiling)

Based on granular per-phase attribution (`l1-after.json`), container resource telemetry (`ladder-l3.md`), and transaction logs, the next primary engineering bottlenecks are:

### 5.1 In-Process Latency Bottlenecks
1. **Gateway Dispatch Glue (~0.62 ms p50)**:
   - In `src/sse/handlers/chat.js` and `open-sse/handlers/chatCore.js`, request orchestration, model routing resolution, combo expansion, format detection, and connection semaphore checking consume ~0.62 ms (accounting for over 60% of remaining p50 latency).
2. **Synchronous Post-Response Bookkeeping Writes (~0.16 ms p50)**:
   - After a streaming response completes, synchronous calls to `insertRequestCostLedger` and `saveRequestUsage` execute unbatched `INSERT` and `UPDATE` statements on the SQLite database.
3. **Web Streams Machinery (~0.11 ms p50)**:
   - Pipeline setup (`TransformStream`, chunk decoding, `pipeWithDisconnect`) imposes a fixed JavaScript engine allocation floor of ~0.11 ms per streaming request.

### 5.2 Scaling & Multi-Replica Bottlenecks
1. **Per-Request CPU Consumption (~6–7 ms CPU-time per request)**:
   - Across all container benchmarks, each replica consumed between 5.16 ms (1 replica) and 6.94 ms (2 replicas) of raw CPU core time per request. At ~6.5 ms CPU per request, a single CPU core is physically bounded at ~150 req/s.
2. **Nginx Upstream Connection Churn**:
   - The lack of keepalive connection pooling in dynamic DNS `proxy_pass` adds ~6 ms of latency per request and burns ~7–10% additional Nginx CPU.
3. **Single Shared SQLite Writer Serialisation**:
   - While `BEGIN IMMEDIATE` resolved lock upgrade deadlocks (`SQLITE_BUSY_SNAPSHOT`) and prevented accounting data loss, it forces all concurrent replica write transactions into strict serial queueing. Under intense multi-replica write bursts, replica event loops can block waiting on the write lock up to `busy_timeout = 5000ms`. For larger scale clusters, asynchronous write batching or offloading usage logging to Redis/PostgreSQL is the next architectural frontier.

---

## 6. Complete Inventory of UNMEASURED Cells and Causes

Per Requirement FR-008, all unmeasured cells are accounted for with root cause and handoff:

| Tier / Metric | Status | Specific Cause | Handoff & Resolution |
|---|---|---|---|
| **L2 loopback** (single-replica HTTP) | `UNMEASURED` | Host checkout lacks prebuilt `.next/standalone` bundle because running `bun run build:bun` would violate the CPU load < 1.0 test invariant. Running `bun run dev:bun` is unoptimized with Webpack HMR compilation overhead and is not run for production benchmarks. | Handed off to containerized L3 tier (T023), which evaluates the pre-compiled standalone production image under `scripts/perf-ladder.sh`. |

All remaining rows (L0 micro-benchmarks, L1 in-process harness, L3 initial container benchmarks, L3 attribution benchmarks, and L3 controlled follow-up trials) achieved 100% measured coverage with zero silent gaps.

---

## 7. Methodological and Honesty Checklist

- [x] **No Fabricated or Inflated Numbers**: All latency percentiles, throughput rates, and CPU percentages are cited verbatim from `specs/008-bun-perf-scale/results/*.md`.
- [x] **Unrounded Ranges Quoted**: Scaling ratios are reported with exact means and min-max intervals (e.g., `1.58x [1.51x, 1.65x]`).
- [x] **No Docker Run in Main Agent**: All container benchmarks were executed exclusively by delegated container subagents; host benchmarks were run purely under native Bun without container tools.
- [x] **Pre-existing Containers Protected**: Container `hindsight` was verified untouched and unmanaged before and after all runs; zero bulk prune commands executed.
- [x] **Ambition Checked Honestly**: p50 reduction target ($\ge 35\%$) reported honestly as MISSED; 2-replica scaling target ($\ge 1.60\times$) reported honestly as NOT CERTIFIED under the shipped configuration.

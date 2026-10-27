# L1 Performance Comparison: Before vs. After Slimming

**Date**: 2026-10-26  
**Artifacts**:
- Baseline: `specs/008-bun-perf-scale/results/l1-baseline.json` (commit `2e36709e`)
- Baseline (same-session A/B): commit `1e057b21` run in throwaway detached worktree
- After Slim: `specs/008-bun-perf-scale/results/l1-after.json` (commit `97431a0c`)  
**Harness**: `scripts/perf-l1-harness.mjs` (5 runs × 1000 requests, 100 warmup, mix: 40% direct, 40% translated with tools, 20% combo)  
**Host Environment**: AMD Ryzen 7 4800H (8 cores / 16 threads), Bun 1.4.3, Linux 6.18.54.1-microsoft-standard-WSL2, isolated SQLite in temp `DATA_DIR`

---

## 1. Executive Summary & Verdict Against Research D7

Research D7 (`specs/008-bun-perf-scale/research.md`) established two strict in-process latency reduction targets for Wave 8 US1:
- **L1 p50 reduction target**: **≥ 35.0%**
- **L1 p95 reduction target**: **≥ 25.0%**

### Research D7 Verdict Table

| Metric | Baseline (`l1-baseline.json`) | Baseline (Same-Session A/B) | After Slim (`l1-after.json`) | Delta vs Baseline | % Delta vs Baseline | D7 Threshold | Verdict |
|---|---|---|---|---|---|---|---|
| **p50 Latency** | 1.3708 ms | 1.3307 ms | **1.0080 ms** | -0.3628 ms | **-26.47%** | ≥ 35.0% lower | **MISSED** (by 8.53%) |
| **p95 Latency** | 5.0359 ms | 4.9391 ms | **2.5950 ms** | -2.4409 ms | **-48.47%** | ≥ 25.0% lower | **MET & EXCEEDED** (+23.47%) |
| **p99 Latency** | 12.1579 ms | 11.9238 ms | **12.0116 ms** | -0.1463 ms | **-1.20%** | Informational | Improved |
| **Mean Latency** | 1.8334 ms | 1.7669 ms | **1.4010 ms** | -0.4324 ms | **-23.58%** | Informational | Improved |
| **DB Queries / Req** | 15.20 | 15.20 | **10.78** | -4.42 queries | **-29.08%** | Strict decrease | **MET** (`QUERY_COUNT_DROPPED`) |
| **Run CV (%)** | 5.39% | 5.47% | **10.85%** | +5.46% | N/A | < 15.0% (non-noisy) | **MET** (stable) |

*(Note: Against the same-session A/B run of commit `1e057b21`, p50 reduction was **-24.25%** (-0.3227 ms, missing by 10.75%), and p95 reduction was **-47.46%** (-2.3441 ms, exceeding by +22.46%). If evaluating steady-state runs 2–5 with initial warmup noise excluded, p50 is **0.9730 ms**, representing a **-29.02%** reduction vs baseline (missing by 5.98%) and a **-26.88%** reduction vs same-session A/B.)*

### Honest Verdict Statement
- **p95 reduction (≥ 25%)**: **MET AND EXCEEDED**. Tail latency was slashed by **48.47%** (saving **2.44 ms / req**), driven by the elimination of dynamic regex compilation bursts in `matchPattern` (T010b), O(1) map indexing for model lookups (T010), and SQLite query contention smoothing (T012).
- **p50 reduction (≥ 35%)**: **MISSED**. Median latency improved from 1.3708 ms to 1.0080 ms (a saving of **0.3628 ms / req**, or **26.47% reduction** across all runs, and **0.9730 ms / 29.02% reduction** across steady-state runs 2–5), falling short of the ambitious 35% target by **8.53 percentage points** (or 5.98 pp on runs 2–5).
- **DB queries per request**: **MET**. Queries dropped from **15.20 to 10.78 queries/req** (**-29.08% drop**), fully satisfying leaf gate G3.

---

## 2. Per-Phase Before vs. After Breakdown

All metrics are in milliseconds (ms), measured across 5,000 requests per profile.

| Phase | Metric | Baseline (`l1-baseline.json`) | After Slim (`l1-after.json`) | Absolute Delta (ms) | Relative Delta (%) | Notes |
|---|---|---|---|---|---|---|
| **auth_acl** | Mean | 0.0971 | 0.0354 | -0.0617 | -63.54% | 4 redundant `apiKeys` queries eliminated (T012) |
| | p50 | 0.0834 | 0.0304 | -0.0530 | **-63.55%** | Key lookup executed once and threaded down |
| | p95 | 0.1610 | 0.0603 | -0.1007 | -62.55% | Substantially tighter tail |
| | p99 | 0.2586 | 0.1116 | -0.1470 | -56.84% | SQLite contention reduced |
| **model_info** | Mean | 0.0497 | 0.0509 | +0.0012 | +2.41% | 5s TTL caches (T009) absorb repeat queries |
| | p50 | 0.0393 | 0.0423 | +0.0030 | +7.63% | Microsecond noise range (within ~3µs) |
| | p95 | 0.0919 | 0.0888 | -0.0031 | -3.37% | Tail bounded by cached nodes |
| | p99 | 0.1508 | 0.1572 | +0.0064 | +4.24% | Identical ceiling |
| **translate** | Mean | 0.0266 | 0.0131 | -0.0135 | -50.75% | Total format translation |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Zero for passthrough/fastpath |
| | p95 | 0.0877 | 0.0442 | -0.0435 | **-49.60%** | Slashed by T010b regex memoization |
| | p99 | 0.1320 | 0.0820 | -0.0500 | -37.88% | Tail cut in half |
| *-- translate_request* | Mean | 0.0237 | 0.0093 | -0.0144 | -60.76% | Request transformation pipeline |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Passthrough requests skip conversion |
| | p95 | 0.0779 | 0.0329 | -0.0450 | -57.77% | Thinking & tool call normalization sped up |
| | p99 | 0.1189 | 0.0607 | -0.0582 | -48.95% | Large tail reduction |
| *-- translate_response*| Mean | 0.0029 | 0.0038 | +0.0009 | +31.03% | SSE response chunk conversion |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Negligible (~4µs) |
| | p95 | 0.0103 | 0.0085 | -0.0018 | -17.48% | Slightly faster tail |
| | p99 | 0.0230 | 0.0227 | -0.0003 | -1.30% | Small improvement |
| **executor_mock** | Mean | 0.0133 | 0.0114 | -0.0019 | -14.29% | In-process mock executor execution |
| | p50 | 0.0085 | 0.0074 | -0.0011 | -12.94% | Pure CPU mock execution |
| | p95 | 0.0215 | 0.0160 | -0.0055 | -25.58% | Consistent execution time |
| | p99 | 0.0595 | 0.0575 | -0.0020 | -3.36% | Uniform |
| **dispatch_glue** | Mean | 1.1933 | 0.8925 | -0.3008 | -25.21% | Gateway JS orchestration |
| | p50 | 0.8705 | 0.6177 | -0.2528 | **-29.04%** | T012 memoization + T010 Map lookups |
| | p95 | 2.8088 | 1.4064 | -1.4024 | **-49.93%** | Tail cut by half |
| | p99 | 8.9878 | 9.6370 | +0.6492 | +7.22% | Dominated by long-tail scheduling |
| **stream_drain** | Mean | 0.1748 | 0.1438 | -0.0310 | -17.73% | Native Web Streams chunk pumping |
| | p50 | 0.1407 | 0.1132 | -0.0275 | -19.55% | `await res.text()` consumption |
| | p95 | 0.2668 | 0.2251 | -0.0417 | -15.63% | Consistent pump throughput |
| | p99 | 0.4267 | 0.3791 | -0.0476 | -11.16% | Stable |
| **bookkeeping** | Mean | 0.2787 | 0.2550 | -0.0237 | -8.50% | SQLite writes for usage, ledger, stats |
| | p50 | 0.1704 | 0.1577 | -0.0127 | -7.45% | Sped up by pricing regex memoization |
| | p95 | 0.3139 | 0.3090 | -0.0049 | -1.56% | Unbatched SQLite writes remain dominant |
| | p99 | 1.8736 | 1.8259 | -0.0477 | -2.55% | Tail dominated by synchronous `run()` |
| **other** | Mean | 0.0000 | 0.0000 | 0.0000 | 0.0% | Zero residual (100% accounted for) |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| | p95 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| | p99 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| **Total** | Mean | **1.8334** | **1.4010** | **-0.4324** | **-23.58%** | Overall end-to-end request dispatch |
| | p50 | **1.3708** | **1.0080** | **-0.3628** | **-26.47%** | Median latency improved by ~0.36 ms |
| | p95 | **5.0359** | **2.5950** | **-2.4409** | **-48.47%** | Tail latency slashed by 2.44 ms |
| | p99 | **12.1579** | **12.0116** | **-0.1463** | **-1.20%** | Bounded by OS scheduling & SQLite write locks |

---

## 3. Database Query Count Drop

The leaf gate G3 check was executed via `node .unlazy/008-bun-perf-scale/scripts/query-count-drop.mjs`:
- Baseline query count: **15.20 queries / request**
- After-slim query count: **10.78 queries / request**
- Absolute drop: **-4.42 queries / request** (-29.08% decrease)
- Output: `QUERY_COUNT_DROPPED 15.2->10.78`

### Source of Query Reductions
In `src/sse/handlers/chat.js` (T012):
1. `authenticateApiKey(apiKey)` loads the `apiKeys` record once into `keyRecord`.
2. Passed directly to `handleSingleModelChat` and `keyAccessContextFromRecord`, eliminating redundant calls to `getApiKeyByKey(apiKey)` and repeated lookups in `apiKeyCache.js`.
3. Pre-resolved combo record passed into `getComboModels` and `getModelInfo` to avoid repeated `getComboByName` queries.
4. Provider nodes query skipped for built-in/known providers where prefix routing is unambiguous.

---

## 4. Run Variance & Stability (CV Analysis)

Per research requirements, CV must remain under the 15.0% noise ceiling to certify validity.

| Profile | Run 1 Mean (ms) | Run 2 Mean (ms) | Run 3 Mean (ms) | Run 4 Mean (ms) | Run 5 Mean (ms) | Overall CV (%) | Noise Ceiling Check |
|---|---|---|---|---|---|---|---|
| **Baseline (`l1-baseline.json`)** | 2.0053 | 1.7852 | 1.7544 | 1.8102 | 1.8121 | **5.39%** | Passed (< 15.0%) |
| **Baseline Same-Session (T007 A/B)** | 1.9351 | 1.7586 | 1.7294 | 1.6970 | 1.7145 | **5.47%** | Passed (< 15.0%) |
| **After-Slim (`l1-after.json`)** | 1.6676 | 1.3730 | 1.3464 | 1.2918 | 1.3263 | **10.85%** | Passed (< 15.0%) |

### Warm-Up Noise Note
Run 1 (1.6676 ms) is consistently ~25% (+24.97%) above the average of Runs 2–5 (1.3344 ms) due to initial JIT warmup and DB connection pool priming.
- **All-runs p50**: **1.0080 ms** (-26.47% vs baseline)
- **Runs 2–5 p50**: **0.9730 ms** (-29.02% vs baseline)

With all-runs CV = 10.85% (and runs 2–5 CV = 3.51%), the measurement strictly satisfies the non-noisy constraint (< 15%).

---

## 5. Why p50 Missed the 35% Reduction Target (Honest Post-Mortem)

While p95 was dramatically reduced (-48.47%), p50 reduction reached **26.47%** across all runs (saving 0.363 ms / req) and **29.02%** across steady-state runs 2–5 (saving 0.398 ms / req), falling short of the 35% target (which required saving ≥ 0.480 ms / req to reach ≤ 0.891 ms).

Three architectural factors explain why the median did not drop past 0.97 ms:

1. **The Incompressible Floor**:
   - `stream_drain` (Web Streams pump & text decoding): **0.1132 ms**
   - `bookkeeping` (synchronous SQLite writes for cost ledger & usage): **0.1577 ms**
   - `auth_acl` (minimum 1 authoritative SQLite read for fail-closed API key auth): **0.0304 ms**
   - `model_info` (combo and connection queries): **0.0423 ms**
   - Pure runtime overhead (Next.js `Request`/`Response` allocations, URL parsing, microtasks): **~0.15 ms**
   - Total fixed floor: **~0.49 – 0.55 ms**.
2. **Synchronous Unbatched Post-Response Writes**:
   `saveRequestUsage` and `insertRequestCostLedger` execute synchronous `bun:sqlite` `run()` calls (`INSERT INTO request_cost_ledger`, `UPDATE usageDaily`, `UPDATE usageHistory`). While regex memoization sped up pricing lookup, the native disk write lock (`run()`) still takes ~0.15 – 0.25 ms per request and cannot be cached.
3. **Dispatch Glue Residual**:
   Although T012 removed duplicate DB reads and T010/T010b eliminated map and regex overhead, `dispatch_glue` at p50 is **0.6177 ms**. This consists of stream transform pipeline setup (`pipeWithDisconnect`, `TransformStream`), connection concurrency counter checks, session token parsing, and async dispatch closures.

---

## 6. The Next Bottleneck

Based on the measured numbers in `l1-after.json`, the primary bottlenecks in order of impact are:

1. **`dispatch_glue` (p50: 0.6177 ms / 61.3% of total p50; mean: 0.8925 ms / 63.7% of total mean)**:
   - **Stream pipeline wiring**: Allocating `TransformStream`, event listeners, disconnect handlers, and error handlers for every single request.
   - **Connection rate limit & concurrency checks**: Iterating connection lists and active counter maps.
   - **Async dispatch indirection**: Hops through `handleChatCore` and `streamingHandler`.
2. **`bookkeeping` (p50: 0.1577 ms / 15.6% of total p50; mean: 0.2550 ms / 18.2% of total mean)**:
   - **Synchronous SQLite write lock contention**: `insertRequestCostLedger` and `saveRequestUsage` write to SQLite synchronously via `adapter.run()` inside an explicit transaction. Under high request rates, WAL write locks serialize across requests.
   - **Remedy for future waves**: Write-behind batching or queueing for usage statistics and spend ledgers (e.g. flushing every 100ms or 100 requests).
3. **`stream_drain` (p50: 0.1132 ms / 11.2% of total p50; mean: 0.1438 ms / 10.3% of total mean)**:
   - Consumption of SSE chunks and native string concatenation. This is standard Web Streams machinery and is largely bounded by Bun's native implementation.

# L1 Performance Comparison: Before vs. After Slimming

**Date**: 2026-10-26  
**Artifacts**:
- Baseline: `specs/008-bun-perf-scale/results/l1-baseline.json` (commit `2e36709e`)
- Baseline (same-session A/B): commit `1e057b21` run in throwaway detached worktree
- After Slim: `specs/008-bun-perf-scale/results/l1-after.json` (commit `21eb7c52`)  
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
| **p50 Latency** | 1.3708 ms | 1.3307 ms | **0.9775 ms** | -0.3933 ms | **-28.69%** | ≥ 35.0% lower | **MISSED** (by 6.31%) |
| **p95 Latency** | 5.0359 ms | 4.9391 ms | **2.6269 ms** | -2.4090 ms | **-47.84%** | ≥ 25.0% lower | **MET & EXCEEDED** (+22.84%) |
| **p99 Latency** | 12.1579 ms | 11.9238 ms | **11.8107 ms** | -0.3472 ms | **-2.86%** | Informational | Improved |
| **Mean Latency** | 1.8334 ms | 1.7669 ms | **1.3486 ms** | -0.4848 ms | **-26.44%** | Informational | Improved |
| **DB Queries / Req** | 15.20 | 15.20 | **10.76** | -4.44 queries | **-29.21%** | Strict decrease | **MET** (`QUERY_COUNT_DROPPED`) |
| **Run CV (%)** | 5.39% | 5.47% | **11.59%** | +6.20% | N/A | < 15.0% (non-noisy) | **MET** (stable) |

*(Note: Against the same-session A/B run of commit `1e057b21`, p50 reduction was **-26.54%** (-0.3532 ms, missing by 8.46%), and p95 reduction was **-46.81%** (-2.3122 ms, exceeding by +21.81%).)*

### Honest Verdict Statement
- **p95 reduction (≥ 25%)**: **MET AND EXCEEDED**. Tail latency was slashed by **47.84%** (saving **2.41 ms / req**), driven by the elimination of dynamic regex compilation bursts in `matchPattern` (T010b), O(1) map indexing for model lookups (T010), and SQLite query contention smoothing (T012).
- **p50 reduction (≥ 35%)**: **MISSED**. Median latency improved from 1.3708 ms to 0.9775 ms (a saving of **0.3933 ms / req**, or **28.69% reduction**), falling short of the ambitious 35% target by **6.31 percentage points**.
- **DB queries per request**: **MET**. Queries dropped from **15.20 to 10.76 queries/req** (**-29.21% drop**), fully satisfying leaf gate G3.

---

## 2. Per-Phase Before vs. After Breakdown

All metrics are in milliseconds (ms), measured across 5,000 requests per profile.

| Phase | Metric | Baseline (`l1-baseline.json`) | After Slim (`l1-after.json`) | Absolute Delta (ms) | Relative Delta (%) | Notes |
|---|---|---|---|---|---|---|
| **auth_acl** | Mean | 0.0971 | 0.0343 | -0.0628 | -64.68% | 4 redundant `apiKeys` queries eliminated (T012) |
| | p50 | 0.0834 | 0.0296 | -0.0538 | **-64.51%** | Key lookup executed once and threaded down |
| | p95 | 0.1610 | 0.0595 | -0.1015 | -63.04% | Substantially tighter tail |
| | p99 | 0.2586 | 0.1033 | -0.1553 | -60.05% | SQLite contention reduced |
| **model_info** | Mean | 0.0497 | 0.0513 | +0.0016 | +3.22% | 5s TTL caches (T009) absorb repeat queries |
| | p50 | 0.0393 | 0.0415 | +0.0022 | +5.60% | Microsecond noise range (within ~2µs) |
| | p95 | 0.0919 | 0.0868 | -0.0051 | -5.55% | Tail bounded by cached nodes |
| | p99 | 0.1508 | 0.1507 | -0.0001 | -0.07% | Identical ceiling |
| **translate** | Mean | 0.0266 | 0.0159 | -0.0107 | -40.23% | Total format translation |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Zero for passthrough/fastpath |
| | p95 | 0.0877 | 0.0409 | -0.0468 | **-53.36%** | Slashed by T010b regex memoization |
| | p99 | 0.1320 | 0.0716 | -0.0604 | -45.76% | Tail cut in half |
| *-- translate_request* | Mean | 0.0237 | 0.0107 | -0.0130 | -54.85% | Request transformation pipeline |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Passthrough requests skip conversion |
| | p95 | 0.0779 | 0.0313 | -0.0466 | -59.82% | Thinking & tool call normalization sped up |
| | p99 | 0.1189 | 0.0517 | -0.0672 | -56.52% | Large tail reduction |
| *-- translate_response*| Mean | 0.0029 | 0.0052 | +0.0023 | +79.31% | SSE response chunk conversion |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Negligible (~5µs) |
| | p95 | 0.0103 | 0.0089 | -0.0014 | -13.59% | Slightly faster tail |
| | p99 | 0.0230 | 0.0203 | -0.0027 | -11.74% | Small improvement |
| **executor_mock** | Mean | 0.0133 | 0.0105 | -0.0028 | -21.05% | In-process mock executor execution |
| | p50 | 0.0085 | 0.0072 | -0.0013 | -15.29% | Pure CPU mock execution |
| | p95 | 0.0215 | 0.0158 | -0.0057 | -26.51% | Consistent execution time |
| | p99 | 0.0595 | 0.0572 | -0.0023 | -3.87% | Uniform |
| **dispatch_glue** | Mean | 1.1933 | 0.8469 | -0.3464 | -29.03% | Gateway JS orchestration |
| | p50 | 0.8705 | 0.5995 | -0.2710 | **-31.13%** | T012 memoization + T010 Map lookups |
| | p95 | 2.8088 | 1.3717 | -1.4371 | **-51.16%** | Tail cut by more than half |
| | p99 | 8.9878 | 7.6338 | -1.3540 | -15.07% | Noticeable GC/tail smoothing |
| **stream_drain** | Mean | 0.1748 | 0.1396 | -0.0352 | -20.14% | Native Web Streams chunk pumping |
| | p50 | 0.1407 | 0.1096 | -0.0311 | -22.10% | `await res.text()` consumption |
| | p95 | 0.2668 | 0.2185 | -0.0483 | -18.10% | Consistent pump throughput |
| | p99 | 0.4267 | 0.4058 | -0.0209 | -4.90% | Stable |
| **bookkeeping** | Mean | 0.2787 | 0.2525 | -0.0262 | -9.40% | SQLite writes for usage, ledger, stats |
| | p50 | 0.1704 | 0.1541 | -0.0163 | -9.57% | Sped up by pricing regex memoization |
| | p95 | 0.3139 | 0.2733 | -0.0406 | -12.93% | Unbatched SQLite writes remain dominant |
| | p99 | 1.8736 | 1.7845 | -0.0891 | -4.76% | Tail dominated by synchronous `run()` |
| **other** | Mean | 0.0000 | 0.0000 | 0.0000 | 0.0% | Zero residual (100% accounted for) |
| | p50 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| | p95 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| | p99 | 0.0000 | 0.0000 | 0.0000 | 0.0% | Exact attribution |
| **Total** | Mean | **1.8334** | **1.3486** | **-0.4848** | **-26.44%** | Overall end-to-end request dispatch |
| | p50 | **1.3708** | **0.9775** | **-0.3933** | **-28.69%** | Median latency improved by ~0.4 ms |
| | p95 | **5.0359** | **2.6269** | **-2.4090** | **-47.84%** | Tail latency slashed by 2.4 ms |
| | p99 | **12.1579** | **11.8107** | **-0.3472** | **-2.86%** | Bounded by OS scheduling & SQLite write locks |

---

## 3. Database Query Count Drop

The leaf gate G3 check was executed via `node .unlazy/008-bun-perf-scale/scripts/query-count-drop.mjs`:
- Baseline query count: **15.20 queries / request**
- After-slim query count: **10.76 queries / request**
- Absolute drop: **-4.44 queries / request** (-29.21% decrease)
- Output: `QUERY_COUNT_DROPPED 15.2->10.76`

### Source of Query Reductions
In `src/sse/handlers/chat.js` (T012):
1. `authenticateApiKey(apiKey)` loads the `apiKeys` record once into `keyRecord`.
2. Passed directly to `handleSingleModelChat` and `getKeyAccessContext`, eliminating redundant calls to `getApiKeyByKey(apiKey)` and repeated lookups in `apiKeyCache.js`.
3. Pre-resolved combo record passed into `getComboModels` and `getModelInfo` to avoid repeated `getComboByName` queries.
4. Provider nodes query skipped for built-in/known providers where prefix routing is unambiguous.

---

## 4. Run Variance & Stability (CV Analysis)

Per research requirements, CV must remain under the 15.0% noise ceiling to certify validity.

| Profile | Run 1 Mean (ms) | Run 2 Mean (ms) | Run 3 Mean (ms) | Run 4 Mean (ms) | Run 5 Mean (ms) | Overall CV (%) | Noise Ceiling Check |
|---|---|---|---|---|---|---|---|
| **Baseline (`l1-baseline.json`)** | 2.0053 | 1.7852 | 1.7544 | 1.8102 | 1.8121 | **5.39%** | Passed (< 15.0%) |
| **Baseline Same-Session (T007 A/B)** | 1.9351 | 1.7586 | 1.7294 | 1.6970 | 1.7145 | **5.47%** | Passed (< 15.0%) |
| **After-Slim (`l1-after.json`)** | 1.6242 | 1.3168 | 1.2715 | 1.2862 | 1.2443 | **11.59%** | Passed (< 15.0%) |

The after-slim run exhibited a higher mean on Run 1 (1.6242 ms) during initial JIT steady-state before settling to ~1.24 – 1.31 ms across Runs 2–5. With CV = 11.59%, the run satisfies the non-noisy constraint (< 15%).

---

## 5. Why p50 Missed the 35% Reduction Target (Honest Post-Mortem)

While p95 was dramatically reduced (-47.84%), p50 reduction reached **28.69%** (saving 0.393 ms / req), falling short of the 35% target (which required saving ≥ 0.480 ms / req to reach ≤ 0.891 ms).

Three architectural factors explain why the median did not drop past 0.97 ms:

1. **The Incompressible Floor**:
   - `stream_drain` (Web Streams pump & text decoding): **0.1096 ms**
   - `bookkeeping` (synchronous SQLite writes for cost ledger & usage): **0.1541 ms**
   - `auth_acl` (minimum 1 authoritative SQLite read for fail-closed API key auth): **0.0296 ms**
   - `model_info` (combo and connection queries): **0.0415 ms**
   - Pure runtime overhead (Next.js `Request`/`Response` allocations, URL parsing, microtasks): **~0.15 ms**
   - Total fixed floor: **~0.485 – 0.55 ms**.
2. **Synchronous Unbatched Post-Response Writes**:
   `saveRequestUsage` and `insertRequestCostLedger` execute synchronous `bun:sqlite` `run()` calls (`INSERT INTO request_cost_ledger`, `UPDATE usageDaily`, `UPDATE usageHistory`). While regex memoization sped up pricing lookup, the native disk write lock (`run()`) still takes ~0.15 – 0.25 ms per request and cannot be cached.
3. **Dispatch Glue Residual**:
   Although T012 removed duplicate DB reads and T010/T010b eliminated map and regex overhead, `dispatch_glue` at p50 is **0.5995 ms**. This consists of stream transform pipeline setup (`pipeWithDisconnect`, `TransformStream`), connection concurrency counter checks, session token parsing, and async dispatch closures.

---

## 6. The Next Bottleneck

Based on the measured numbers in `l1-after.json`, the primary bottlenecks in order of impact are:

1. **`dispatch_glue` (p50: 0.5995 ms / 61.3% of total p50; mean: 0.8469 ms / 62.8% of total mean)**:
   - **Stream pipeline wiring**: Allocating `TransformStream`, event listeners, disconnect handlers, and error handlers for every single request.
   - **Connection rate limit & concurrency checks**: Iterating connection lists and active counter maps.
   - **Async dispatch indirection**: Hops through `handleChatCore` and `streamingHandler`.
2. **`bookkeeping` (p50: 0.1541 ms / 15.8% of total p50; mean: 0.2525 ms / 18.7% of total mean)**:
   - **Synchronous SQLite write lock contention**: `insertRequestCostLedger` and `saveRequestUsage` write to SQLite synchronously via `adapter.run()` inside an explicit transaction. Under high request rates, WAL write locks serialize across requests.
   - **Remedy for future waves**: Write-behind batching or queueing for usage statistics and spend ledgers (e.g. flushing every 100ms or 100 requests).
3. **`stream_drain` (p50: 0.1096 ms / 11.2% of total p50; mean: 0.1396 ms / 10.4% of total mean)**:
   - Consumption of SSE chunks and native string concatenation. This is standard Web Streams machinery and is largely bounded by Bun's native implementation.

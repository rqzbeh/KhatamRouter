# L1 Hotspot Analysis & Re-Ranked Slimming Plan

**Date**: 2026-10-26  
**Artifact**: `specs/008-bun-perf-scale/results/l1-baseline.json`  
**Harness**: `scripts/perf-l1-harness.mjs` (in-process mock executor, temp `DATA_DIR`, isolated SQLite)  
**Profile Run**: 5 runs × 1000 requests, 100 warmup, mix: 40% direct, 40% translated with tools, 20% combo.  

---

## 1. Measured Per-Phase Breakdown

The baseline run (`specs/008-bun-perf-scale/results/l1-baseline.json`) measured total per-request dispatch latency at **p50 = 1.3708 ms**, **mean = 1.8334 ms**, **p95 = 5.0359 ms**, and **db_queries_per_req = 15.20** with **CV = 5.39%** (stable, well under the 15% noise ceiling).

| Phase | Mean (ms) | p50 (ms) | p95 (ms) | Share of Mean (%) | Description |
|---|---|---|---|---|---|
| **dispatch_glue** | 1.1933 | 0.8705 | 2.8088 | 65.1% | Gateway JS orchestration (session, auth check, ACL, capability detection, combo routing, model finding, rate limiting, stream pipeline setup) |
| **bookkeeping** | 0.2787 | 0.1704 | 0.3139 | 15.2% | Post-response persistence: SQLite writes for `request_cost_ledger`, `usageHistory`, `usageDaily`, `_meta`, `requestDetails`, plus pricing calculation |
| **stream_drain** | 0.1748 | 0.1407 | 0.2668 | 9.5% | Stream consumption: reading chunks to EOF via `await res.text()`, text decoding, Web Streams `TransformStream` mechanics |
| **auth_acl** | 0.0971 | 0.0834 | 0.1610 | 5.3% | Synchronous SQLite query time for `apiKeys` (5 queries per request) |
| **model_info** | 0.0497 | 0.0393 | 0.0919 | 2.7% | Synchronous SQLite query time for `combos`, `providerConnections`, `providerNodes`, and `kv` (aliases) |
| **translate** | 0.0266 | 0.0000 | 0.0877 | 1.5% | Total format translation: request (0.0237 ms) + response SSE chunks (0.0029 ms) |
| **executor_mock** | 0.0133 | 0.0085 | 0.0215 | 0.7% | In-process mock executor execution |
| **other** | 0.0000 | 0.0000 | 0.0000 | 0.0% | Residual (fully attributed across exclusive phases) |
| **Total** | **1.8334** | **1.3708** | **5.0359** | **100.0%** | In-process end-to-end request dispatch & drain |

---

## 2. CPU Profile: Top Functions & Call Hierarchy

A CPU profile was captured using Bun's native profiler (`bun --cpu-prof --cpu-prof-md scripts/perf-l1-harness.mjs --label prof --runs 2 --requests 1000 --warmup 100`):

### Top Functions by Self Time
| Self% | Self (ms) | Function | Source Location | Category |
|------:|----------:|----------|-----------------|----------|
| 17.28% | 977.28 | `run` | `[native code]` (`bun:sqlite`) | Database engine (writes) |
| 8.33% | 471.15 | `get` | `[native code]` (`bun:sqlite`) | Database engine (reads) |
| 8.28% | 468.28 | `matchPattern` | `open-sse/providers/pricing.js:405` | Pricing glob regex recompilation |
| 4.55% | 257.13 | `(anonymous)` | `open-sse/providers/pricing.js:404` | Pattern array search loop |
| 3.28% | 185.29 | `importModule` | `[native code]` | Dynamic module loading |
| 2.70% | 152.40 | `onRSDefaultControllerStartFulfilled` | `[native code]` | Web Streams readable controller |
| 2.40% | 135.85 | `anonymous` | `[native code]` | Runtime closures / microtasks |
| 2.17% | 122.93 | `all` | `[native code]` (`bun:sqlite`) | Database engine (batch reads) |
| 2.02% | 114.39 | `map` | `[native code]` | Array transformations |
| 1.54% | 86.80 | `stringify` | `[native code]` | JSON serialization (`requestDetails`, `usageDaily`) |
| 1.52% | 85.97 | `Response` | `[native code]` | Web standard Response allocation |
| 1.35% | 76.58 | `parse` | `[native code]` | JSON deserialization |
| 1.25% | 70.49 | `transform` | `open-sse/utils/stream.js:143` | SSE stream transform callback |
| 1.21% | 68.68 | `handleChatCore` | `open-sse/handlers/chatCore.js:94` | Dispatch orchestration logic |
| 1.16% | 65.86 | `getProviderByAlias` | `src/shared/constants/providers.js:113` | Provider constant lookups |
| 0.88% | 49.55 | `trackPendingRequest` | `src/lib/db/repos/usageRepo.js:153` | Concurrency tracking updates |
| 0.82% | 46.33 | `keys` | `[native code]` | Object reflection |
| 0.80% | 45.28 | `onReadableStreamToTextChunksFulfilled` | `[native code]` | Stream text conversion |
| 0.75% | 42.46 | `TransformStream` | `[native code]` | Stream pipe allocation |
| 0.75% | 42.25 | `pipeThrough` | `[native code]` | Stream transform pipeline |
| 0.66% | 37.35 | `handleStreamingResponse` | `open-sse/handlers/chatCore/streamingHandler.js:74` | Streaming response builder |
| 0.59% | 33.14 | `decode` | `[native code]` | `TextDecoder` chunk decoding |
| 0.54% | 30.43 | `handleChat` | `src/sse/handlers/chat.js:43` | Top-level Next/gateway route |
| 0.53% | 30.04 | `pipeWithDisconnect` | `open-sse/utils/streamHandler.js:194` | Stream disconnect wiring |
| 0.51% | 28.82 | `Request` | `[native code]` | Web standard Request allocation |

### Top Functions by Inclusive Time
| Inclusive% | Inclusive (ms) | Function | Source Location | Role |
|-----------:|---------------:|----------|-----------------|------|
| 29.09% | 1644.92 | `handleChatCore` | `open-sse/handlers/chatCore.js:94` | Core dispatch orchestration |
| 17.28% | 977.28 | `run` | `[native code]` (`bun:sqlite`) | SQLite write executions |
| 16.22% | 917.18 | `saveRequestUsage` | `src/lib/db/repos/usageRepo.js:242` | Usage persistence & cost calc |
| 15.42% | 871.82 | `matchPattern` | `open-sse/providers/pricing.js:403` | Pricing pattern matching |
| 14.04% | 793.80 | `transaction` | `bun:sqlite:392` | Synchronous SQLite transactions |
| 10.86% | 614.24 | `(anonymous)` | `scripts/perf-l1-harness.mjs:147` | Harness query instrumentation |
| 9.01% | 509.31 | `insertRequestCostLedger` | `src/lib/db/keyQuota.js:125` | Spend ledger insertions |
| 8.88% | 502.06 | `get` | `src/lib/db/adapters/bunSqliteAdapter.js:111` | SQLite read executions |
| 8.75% | 494.88 | `translateRequest` | `open-sse/translator/index.js:68` | Request format translation |
| 7.05% | 398.82 | `(anonymous)` | `src/lib/db/repos/usageRepo.js:257` | Usage transaction body |
| 4.74% | 268.08 | `transform` | `open-sse/utils/stream.js:143` | SSE chunk transformation |
| 4.58% | 258.84 | `applyThinking` | `open-sse/translator/concerns/thinkingUnified.js:434` | Thinking block normalization |
| 4.57% | 258.49 | `handleStreamingResponse` | `open-sse/handlers/chatCore/streamingHandler.js:74` | Streaming response creation |

---

## 3. What "Other" (Unattributed Latency) Actually Consisted Of

In the preliminary measurement, `other` accounted for **74% of the mean (1.54 ms)**. Investigation via call stacks and query tracing uncovered two causes:

1. **Misclassified DB Queries in the Old Harness**:
   The previous harness attributed queries matching `apiKeys` to `auth_acl`, and queries matching `combos`, `providerConnections`, `providerNodes`, or `kv` to `model_info`. All other queries defaulted to `dispatch_glue`. In reality, the database queries in that `else` branch were **post-response persistence queries** (`request_cost_ledger`, `usageHistory`, `usageDaily`, `_meta`, `requestDetails`), totaling ~0.30 ms. They were not dispatch glue at all.
2. **Unmeasured Gateway JS Execution**:
   The actual JavaScript execution time of `handleChat` and `handleChatCore` (session identity, tri-state ACL, tool dedup, capability checks, connection rate limit checking, stream controller setup) was not tracked by any dedicated timer and fell into `other` (~1.19 ms).
3. **Unmeasured Stream Drain Overhead**:
   The time spent in `await res.text()` reading SSE chunks and driving the Web Streams pipeline was not isolated, contributing ~0.17 ms to the unmeasured bucket.
4. **Unawaited Microtask Leakage**:
   `saveRequestUsage` is invoked fire-and-forget in `onStreamComplete`. Its asynchronous promise and microtasks resolved across subsequent request boundaries, running synchronous SQLite writes and pricing regex compilations during the next request's dispatch window.

With explicit exclusive phases added for `dispatch_glue`, `stream_drain`, and `bookkeeping`, **`other` is reduced to 0.00 ms (100% accounted for)**.

---

## 4. Measured Ranking vs. Static Research Profile

The measured latency profile starkly contradicts the static estimate in `specs/008-bun-perf-scale/research-profile.md`:

| Subsystem | Static Estimate (`research-profile.md`) | Measured Reality (`l1-baseline.json`) | Variance & Root Cause |
|---|---|---|---|
| **Model-Info & DB** | ~3.2 ms (40%) | **0.15 ms (8.0%)** (DB reads) | **-95% vs estimate**. `bun:sqlite` in-memory/WAL queries take ~10-25µs each, not hundreds of microseconds. |
| **Request Translation** | ~2.8 ms (35%) | **0.027 ms (1.5%)** | **-99% vs estimate**. Message iteration and regex checks in V8/Bun JIT take microseconds on small/medium prompts. |
| **Dispatch Glue & Orchestration** | ~2.0 ms (25%) | **1.19 ms (65.1%)** | **Dominant hotspot**. 5x duplicate `apiKeys` reads, capability detection, session identity, connection limits, and stream setup account for the majority of gateway latency. |
| **Post-Response Bookkeeping** | *Unmodeled in static trace* | **0.28 ms (15.2%)** | Post-flight ledger insertions, daily stats aggregation, and pricing regexes add significant overhead. |
| **Stream Drain Machinery** | *Unmodeled in static trace* | **0.17 ms (9.5%)** | Native `TransformStream` chunk pumping and SSE parsing. |

---

## 5. Re-Ranked Slimming Plan (Tasks T009–T012)

Per tasks.md T007: *if the measured ranking differs, re-rank T009–T012 before any code change; T011 only proceeds if translation is a top-2 phase*.

Translation is ranked **#6 of 7** (1.5% share), so **T011 is SKIPPED**.

### Priority 1: T012 — Request-Scoped Memoization & Redundant Query Elimination
- **Evidence**: Query tracing proves that a single request executes `SELECT * FROM apiKeys WHERE key = ?` **5 times** (lines 93, 166, 196, 296 in `chat.js`, and inside `apiKeyCache.js`). Additionally, `getComboByName` is called twice for combo requests.
- **Scope**: Resolve `keyRecord` and combo once in `handleChat`, and pass them down into `handleSingleModelChat` and `getKeyAccessContext`.
- **Expected Latency Saving**: **~0.25 – 0.35 ms / req** (eliminates 4 synchronous SQLite queries + associated object mapping and async promise hops).
- **Expected DB Query Saving**: **-4.0 queries / req** (reduces dispatch queries from 7 to 3).
- **Recommendation**: **DO (Top Priority)**. Directly attacks the largest controllable dispatch glue cost.

### Priority 2: T009 — Alias, Combo & Node In-Memory TTL Caches
- **Evidence**: `combos`, `providerConnections`, and `kv` (modelAliases) take 0.05 ms of SQLite time and allocate transient objects on every request.
- **Scope**: Add 5-second process-level TTL caches for `getModelAliases`, `getComboByName`, and `getProviderNodes` matching `settingsCache`. Invalidate on local writes and Redis `config_reload`.
- **Expected Latency Saving**: **~0.04 – 0.06 ms / req**.
- **Expected DB Query Saving**: **-1.0 to -2.0 queries / req**.
- **Recommendation**: **DO**. Low complexity, standard cache pattern, cluster-safe with 5s TTL cap.

### Priority 3: T010 — Indexed `findModel` Lookups in `providerModels.js`
- **Evidence**: CPU profile shows `findModel` invoked 6 times per request in `chatCore.js` running linear array searches across large model arrays (up to 100+ items).
- **Scope**: Build module-load `Map<modelId, ModelEntry>` in `providerModels.js` for O(1) lookups with baseModelId fallback.
- **Expected Latency Saving**: **~0.03 – 0.05 ms / req**.
- **Expected DB Query Saving**: 0 queries / req (CPU optimization only).
- **Recommendation**: **DO**. Zero DB impact, safe pure-JS refactoring.

### Priority 4: T011 — Translation Short-Circuits
- **Evidence**: Measured translation latency is **0.0266 ms (1.45% of total)**.
- **Tasks.md Rule**: "T011 only proceeds if translation is a top-2 phase. If T007 says skip, mark the task skipped (measured: <share>%)".
- **Expected Latency Saving**: < 0.01 ms / req (negligible).
- **Recommendation**: **SKIP (measured: 1.45% share)**. Touching translation concerns introduces regression risk across golden suites for near-zero latency gain.

---

## 6. Evaluation Against D7 Verdict Thresholds

**Target Thresholds (from `specs/008-bun-perf-scale/research.md` D7)**:
- L1 p50: ≥ 35% reduction (from baseline p50 1.3708 ms → target ≤ 0.8910 ms; required saving: **≥ 0.48 ms**)
- L1 p95: ≥ 25% reduction (from baseline p95 5.0359 ms → target ≤ 3.7769 ms; required saving: **≥ 1.26 ms**)

### Feasibility Analysis
1. **Controllable In-Process Savings**:
   - T012 (apiKey/combo memoization): ~0.25 – 0.35 ms
   - T009 (TTL caches): ~0.04 – 0.06 ms
   - T010 (Map index): ~0.03 – 0.05 ms
   - Total plausible saving from T009 + T010 + T012: **~0.32 – 0.46 ms / req**.
2. **Ceiling Assessment**:
   - At p50, achieving **~0.95 – 1.05 ms** is highly likely (~25% to 30% reduction). Reaching the strict **35% reduction (≤ 0.89 ms)** is on the razor's edge of feasibility in-process.
   - At p95, reducing tail latency from 5.03 ms to < 3.77 ms depends on eliminating the SQLite transaction contention caused by unawaited `saveRequestUsage` and `request_cost_ledger` writes running concurrently with new request dispatches.
3. **The Incompressible Floor**:
   - Web standard request/response framing: `Request`, `Response`, URL parsing (~0.20 ms)
   - Stream drain machinery: `TransformStream`, chunk decoding (~0.17 ms)
   - Synchronous bookkeeping writes: `usageHistory`, `usageDaily`, `request_cost_ledger` (~0.28 ms)
   - Total fixed floor: **~0.65 – 0.75 ms**.
4. **Honest Stance**:
   We will execute T012, T009, and T010 with high rigor. If the post-slimming re-measurement falls slightly short of the ambitious 35% target (e.g. achieving 28-32%), we will report the result honestly per D7 ("ceiling did not move sufficiently to clear threshold") and identify unbatched post-response writes as the primary limiter.

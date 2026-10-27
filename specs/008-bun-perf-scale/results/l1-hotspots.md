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
- **Evidence**: Measured translation latency in the initial harness breakdown was **0.0266 ms (1.45% of total)**. Corrected profiling reveals `translateRequest` takes 10.35% (0.259 ms/req), but 73.6% of that is `matchPattern` (addressed by T010b). Translation exclusive of `matchPattern` is only **2.73% (0.068 ms/req)**, with the specific T011 targets (`ensureToolCallIds`, `fixMissingToolResponses`, `filterToOpenAIFormat`) totaling only **0.25% (0.006 ms/req)**.
- **Tasks.md Rule**: "T011 only proceeds if translation is a top-2 phase. If T007 says skip, mark the task skipped (measured: <share>%)".
- **Expected Latency Saving**: < 0.01 ms / req (negligible).
- **Recommendation**: **SKIP (measured: 2.73% exclusive share, 0.25% targeted functions)**. Touching translation concerns introduces regression risk across golden suites for near-zero latency gain. The real translation bottleneck is regex compilation, captured in T010b.

---

## 6. Evaluation Against D7 Verdict Thresholds

**Target Thresholds (from `specs/008-bun-perf-scale/research.md` D7)**:
- L1 p50: ≥ 35% reduction (from baseline p50 1.3708 ms → target ≤ 0.8910 ms; required saving: **≥ 0.48 ms**)
- L1 p95: ≥ 25% reduction (from baseline p95 5.0359 ms → target ≤ 3.7769 ms; required saving: **≥ 1.26 ms**)

### Feasibility Analysis
1. **Controllable In-Process Savings**:
   - T012 (apiKey/combo memoization): ~0.25 – 0.35 ms
   - T010b (matchPattern regex memoization): ~0.30 – 0.35 ms
   - T009 (TTL caches): ~0.04 – 0.06 ms
   - T010 (Map index): ~0.03 – 0.05 ms
   - Total plausible saving from T012 + T010b + T009 + T010: **~0.62 – 0.81 ms / req**.
2. **Ceiling Assessment**:
   - With T010b added to the plan, achieving the strict **35% reduction (saving ≥ 0.48 ms, p50 ≤ 0.89 ms)** shifts from "on the razor's edge" to **highly achievable**.
   - At p95, eliminating regex compilation bursts and SQLite query contention substantially smooths tail latency.
3. **The Incompressible Floor**:
   - Web standard request/response framing: `Request`, `Response`, URL parsing (~0.20 ms)
   - Stream drain machinery: `TransformStream`, chunk decoding (~0.17 ms)
   - Synchronous bookkeeping writes: `usageHistory`, `usageDaily`, `request_cost_ledger` (~0.28 ms)
   - Total fixed floor: **~0.65 – 0.75 ms**.
4. **Honest Stance**:
   We will execute T012, T010b, T009, and T010 with high rigor. If the post-slimming re-measurement falls slightly short of the ambitious 35% target, we will report the result honestly per D7 ("ceiling did not move sufficiently to clear threshold") and identify unbatched post-response writes as the primary limiter.

---

## 7. Correction: Full Call-Tree Attribution, matchPattern Bottleneck & Task T010b (2026-10-26)

### 7.1 Problem Statement
The preliminary harness `translate` phase timer (reported as 1.5% / 0.0266 ms) only timed `openaiToClaudeRequest` (the single registered converter hook in `scripts/perf-l1-harness.mjs:213`), completely omitting the broader `translateRequest` pipeline:
- `applyThinking` (`open-sse/translator/concerns/thinkingUnified.js:434`)
- `prepareClaudeRequest` (`open-sse/translator/formats/claude.js:494`)
- `filterToOpenAIFormat` (`open-sse/translator/formats/openai.js:9`)
- `ensureToolCallIds` and `fixMissingToolResponses` (`open-sse/translator/concerns/toolCall.js`)
- `captureThinking` and `stripContentTypes` (`open-sse/translator/index.js`)

Consequently, `dispatch_glue` (65.1%) functioned as an unmodeled residual catch-all that absorbed the outer translation stages and pre-dispatch capability detection.

### 7.2 Profiling Re-Run on Quiet Machine
A fresh CPU profile was captured on a quiet machine (`uptime` load average: 0.19, well under 1.0):
```bash
bun --cpu-prof --cpu-prof-md scripts/perf-l1-harness.mjs --label prof --runs 2 --requests 1000 --warmup 100
```
- Total requests executed: **2,100** (100 warmup + 2,000 measured across 2 runs)
- Total CPU profile duration: **5,253.30 ms**
- Average CPU per request: **2.5016 ms / req**

### 7.3 Inclusive Cost Split by Top-Level Responsibility (1 Request's Worth)

| Responsibility | Total Inclusive (ms) | Inclusive Share (%) | Cost per Request (ms/req) | Key Subsystems & Locations |
|---|---:|---:|---:|---|
| **Stream machinery & chunk processing** | 1,072.40 | 20.41% | 0.5107 | `handleStreamingResponse`, `TransformStream`, `pipeWithDisconnect`, chunk transforms (`transform`, `flush`, `finalizeStream`), `decode`, `drain`, native Web Streams pumping |
| **`saveRequestUsage` (post-response persistence)** | 876.35 | 16.68% | 0.4173 | `onStreamComplete` microtask writes: `insertRequestCostLedger` (425.9 ms), SQLite transactions (375 ms), `calculateCost` (93.2 ms) |
| **`matchPattern` total (all callers)** | 786.48 | 14.97% | 0.3745 | `open-sse/providers/pricing.js:404`: compiling a new `RegExp` on every glob match |
| **Auth & ACL (`apiKeys`)** | 346.91 | 6.60% | 0.1652 | `authenticateApiKey`, `getApiKeyByKey`, `getKeyAccessContext` across 5x SQLite reads per request |
| **`getModelInfo` / alias / combo / nodes** | 263.59 | 5.02% | 0.1255 | `getProviderConnections` (80 ms), `getAll` kv modelAliases (56 ms), `getComboByName`, `findModel`, `getProviderByAlias` (50 ms), `resolveProviderId` (72 ms) |
| **`translateRequest` (EXCLUSIVE of `matchPattern`)** | 143.53 | 2.73% | 0.0683 | Format conversion logic without regex recompilation overhead |
| **Harness query instrumentation (pure self-time)** | 27.26 | 0.52% | 0.0130 | Harness closures (`perf-l1-harness.mjs:143-167`) and `recordQuery` self-time |

### 7.4 The `matchPattern` Bottleneck & Driver Attribution
`matchPattern` (`open-sse/providers/pricing.js:404`) constructs a dynamic regular expression on **every single call**:
```javascript
export function matchPattern(pattern, model) {
  const regex = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return regex.test(model);
}
```
Because `PATTERN_CAPABILITIES` contains **113 glob patterns**, a model lookup that does not match early compiles dozens of identical regular expressions.

Across the profile, `matchPattern` accounts for **786.48 ms (14.97% of CPU, 0.3745 ms/req)**. The exact call chains driving this overhead are:
1. **`getCapabilitiesForModel` (`open-sse/providers/capabilities.js:808`)**: **708.29 ms (13.48% of total CPU, 0.3373 ms/req)**
   - via `handleChatCore` (pre-dispatch capability check, line 216): **307.94 ms (5.86%, 0.1466 ms/req)**
   - via `applyThinking` (`thinkingUnified.js:434`, line 440): **254.39 ms (4.84%, 0.1211 ms/req)**
   - via `prepareClaudeRequest` (`claude.js:494`, line 514): **79.70 ms (1.52%, 0.0380 ms/req)**
   - via `openaiToClaudeRequest` (`openai-to-claude.js:16`, line 23): **66.25 ms (1.26%, 0.0315 ms/req)**
2. **`getPricingForModel` (`open-sse/providers/pricing.js:419`)**: **78.19 ms (1.49% of total CPU, 0.0372 ms/req)**
   - via `onStreamComplete` -> `saveRequestUsage` (`streamingHandler.js:153`): **46.29 ms (0.88%, 0.0220 ms/req)**
   - via `getPricingForModel` (`pricingRepo.js:69`): **31.90 ms (0.61%, 0.0152 ms/req)**

### 7.5 Real Translation-Related Cost & Dissection
`translateRequest` total inclusive time is **543.87 ms (10.35% of profile CPU, 0.2590 ms / req)**.

Dissecting `translateRequest` reveals that `matchPattern` inside `getCapabilitiesForModel` is the overwhelmingly dominant component:
- `matchPattern` inside `translateRequest`: **400.34 ms (7.62% of profile CPU, 0.1906 ms/req, or 73.61% of `translateRequest`)**
  * inside `applyThinking`: 254.39 ms
  * inside `prepareClaudeRequest`: 79.70 ms
  * inside `openaiToClaudeRequest`: 66.25 ms
- `translateRequest` **EXCLUSIVE of `matchPattern`**: **143.53 ms (2.73% of profile CPU, 0.0683 ms/req)**

Breakdown of the non-regex translation remainder (143.53 ms):
- `prepareClaudeRequest` body transformation (excl. matchPattern): 47.37 ms (0.90%, 0.0226 ms/req)
- `openaiToClaudeRequest` converter (excl. matchPattern): 41.22 ms (0.78%, 0.0196 ms/req)
- `applyThinking` thinking intent mapping (excl. matchPattern): 13.04 ms (0.25%, 0.0062 ms/req)
- `captureThinking`: 5.86 ms (0.11%, 0.0028 ms/req)
- `filterToOpenAIFormat`: 5.06 ms (0.10%, 0.0024 ms/req)
- `fixMissingToolResponses`: 4.07 ms (0.08%, 0.0019 ms/req)
- `ensureToolCallIds`: 4.00 ms (0.08%, 0.0019 ms/req)
- `stripContentTypes`: 3.81 ms (0.07%, 0.0018 ms/req)
- `detectClientLastRole`: 1.23 ms (0.02%, 0.0006 ms/req)
- Other function call / closure glue: ~17.87 ms (0.34%, 0.0085 ms/req)

### 7.6 Harness Instrumentation Overhead Analysis
In the preliminary profile, the harness query wrapper `(anonymous) scripts/perf-l1-harness.mjs:147` was reported with 10.86% inclusive time.

Detailed call-tree analysis proves:
- Harness wrapper total inclusive time: **682.54 ms (12.99%)**
- Underlying native SQLite query execution (`origRun()`, `origGet()`, `origAll()` in `bun:sqlite`): **655.28 ms (12.47%)**
- Harness wrapper pure self-time: **10.26 ms (0.20%, 0.0049 ms/req)**
- `recordQuery` parsing and accounting: **17.00 ms (0.32%, 0.0081 ms/req)**
- **Total pure instrumentation self-overhead: 27.26 ms (0.52% of total runtime, 0.0130 ms / req)**.

This confirms that the harness wrapper adds only ~13 microseconds per request of pure overhead. The 10.9% inclusive figure was entirely an artifact of wrapping the synchronous SQLite execution calls. The baseline measurement is solid and uncorrupted by instrumentation.

### 7.7 Revised Plan: Addition of Task T010b & Honest T011 Decision

1. **New Task T010b: Memoize Compiled Regex in `matchPattern`**:
   - **Scope**: Memoize compiled `RegExp` objects in `open-sse/providers/pricing.js` using a bounded cache (e.g. Map with max capacity or module-level static map for known patterns).
   - **Invariants**: Strict behavioral identity, including case-insensitivity (`"i"` flag), wildcard conversion (`*` -> `.*`), and regex special-character escaping.
   - **Tests**: Write `tests/unit/pattern-match-cache.test.js` first.
   - **Expected Impact**: Eliminates **~0.30 – 0.35 ms / req** (12% to 14% of overall gateway CPU) across dispatch, translation, and bookkeeping.
   - **Ownership**: `open-sse/providers/pricing.js`, `tests/unit/pattern-match-cache.test.js` (Phase B, [P], disjoint ownership, depends on T007).

2. **Honest T011 Decision (Skip Confirmed)**:
   - Translation exclusive of `matchPattern` is **2.73% of total CPU (0.0683 ms/req)**.
   - The specific functions targeted by T011 (`ensureToolCallIds`, `fixMissingToolResponses`, `filterToOpenAIFormat`) account for a combined **13.13 ms (0.25% share, 0.0062 ms/req)**.
   - Modifying core translator normalization logic introduces significant regression risk across the four golden suites for an upper-bound win of at most ~6 microseconds per request.
   - **Verdict**: **SKIP T011 (measured: 2.73% exclusive share, 0.25% targeted functions)**. The true translation bottleneck was `matchPattern` inside `applyThinking` and `prepareClaudeRequest`, which is addressed cleanly and safely in T010b.

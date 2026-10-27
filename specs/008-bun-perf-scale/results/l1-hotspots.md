# L1 Profile Hotspot Analysis (Post-Slimming)

> **Context**: Breakdown of remaining CPU hotspots based on `specs/008-bun-perf-scale/results/l1-after.json` (5 runs x 1,000 requests, mock executor in-process). Total mean latency: **1.3828 ms** (p50: 1.0022 ms, p95: 2.5635 ms).

## Remaining Hotspots Ranked by Phase Mean

| Rank | Phase | Mean Latency | Share of Total | p50 | p95 | p99 | Primary Mechanism |
|---|---|---|---|---|---|---|---|
| 1 | `dispatch_glue` | 0.8771 ms | 63.43% | 0.6310 ms | 1.4918 ms | 8.3400 ms | Route handling, account selection loop, Promise chain dispatch, object allocation |
| 2 | `bookkeeping` | 0.2484 ms | 17.96% | 0.1501 ms | 0.2767 ms | 1.8573 ms | Synchronous SQLite `saveRequestUsage` write via `db.immediate` transaction |
| 3 | `stream_drain` | 0.1505 ms | 10.88% | 0.1110 ms | 0.2226 ms | 0.3644 ms | SSE chunk consumption via Bun `ReadableStream` reader pump |
| 4 | `model_info` | 0.0503 ms | 3.64% | 0.0422 ms | 0.0883 ms | 0.1395 ms | Repo generation counter checks and model metadata lookup |
| 5 | `auth_acl` | 0.0343 ms | 2.48% | 0.0298 ms | 0.0597 ms | 0.0987 ms | Initial API key lookup and permission verification |
| 6 | `translate` | 0.0133 ms | 0.96% | 0.0000 ms | 0.0429 ms | 0.0740 ms | Format translation (model map fast path + cached regex) |
| 7 | `executor_mock` | 0.0103 ms | 0.75% | 0.0071 ms | 0.0152 ms | 0.0592 ms | Synthetic mock upstream dispatch |

---

## Deep Dive into Top Hotspots

### 1. `dispatch_glue` (63.4% of total time)
- **Observations**: Although reduced by 27.35% from baseline (1.2073 ms $\to$ 0.8771 ms), `dispatch_glue` accounts for the vast majority of execution time. It also drives tail latency: p99 is 8.34 ms.
- **Root Causes**: Not measured in this run. The phase is a timed span, and this run did not profile inside it. Candidate causes to verify with a CPU profile are: Next.js/request wrapper work, account selection in `src/sse/handlers/chat.js`, and async chaining between handler and executor.
- **Next-Bottleneck Recommendation**: Profile `dispatch_glue` (e.g. `bun --cpu-prof`) before choosing a fix. Do not act on the candidate causes above unverified.

### 2. `bookkeeping` (18.0% of total time)
- **Observations**: Down slightly from baseline (0.2489 ms $\to$ 0.2484 ms), but represents the second largest hotspot.
- **Root Causes**: The phase covers `saveRequestUsage` inside `db.immediate(...)` (per `tasks.md` T011). Its share of the time was not broken down further in this run.
- **Next-Bottleneck Recommendation**: Measure the write cost before changing it. An async batched write buffer is one option, but it changes durability and is not justified by this profile alone.

### 3. `stream_drain` (10.9% of total time)
- **Observations**: 0.1505 ms mean. Chunk consumption in the stream path.
- **Root Causes**: Not measured in this run.
- **Next-Bottleneck Recommendation**: Profile before changing the chunk path.

---

## Conclusion & Readiness for US2

Measured against baseline (single run set, in-process, mock executor):
- `auth_acl` mean down **64.4%**; `translate` mean down **52.5%**; `dispatch_glue` mean down **27.3%**
- Overall p95 down **48.0%**; overall p50 down **25.7%** (D7 target 35%: MISSED)
- DB queries/req down **29.1%** (15.20 to 10.78; D7 target <= 11.0: MET)

Largest remaining phase is `dispatch_glue` (63% of mean). Its cause is unprofiled. Whether multi-process scaling (US2) is the right next step depends on a CPU profile of that phase, which this run did not produce. The gate ledger's G4 manual review remains pending for the orchestrator.

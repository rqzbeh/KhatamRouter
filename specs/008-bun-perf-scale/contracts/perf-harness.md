# Contract: Performance Harness & Vertical Ladder CLI

**Spec**: `specs/008-bun-perf-scale/spec.md` (US1, US3 / FR-001..FR-006, FR-017..FR-019)  
**Target Runtime**: Bun 1.4.3  
**Classification**: Performance Benchmark & Metric Contracts

---

## 1. L1 In-Process Gateway Harness (`scripts/perf-l1-harness.mjs`)

Evaluates the in-process request processing pipeline (JSON parsing, auth verification, ACL, model resolution, translation transformation, and response stream creation) using an in-process mock executor without network socket latency.

```bash
bun scripts/perf-l1-harness.mjs [options]
```

### CLI Options

| Flag | Type / Default | Meaning |
|---|---|---|
| `--label <s>` | `string` / `baseline` | Label stamped in output telemetry (e.g. `baseline`, `after-slim`). |
| `--runs <n>` | `number` / `5` | Number of measurement iterations. Reported summary is the median of means. |
| `--warmup <n>` | `number` / `100` | Number of unmeasured sequential warmup requests to prime Bun JIT and inline caches. |
| `--requests <n>` | `number` / `1000` | Requests per measurement iteration. |
| `--out <path>` | `string` / stdout | Destination path for output `L1Profile` JSON. |
| `--redis <on\|off>` | `string` / `off` | Enable Redis cluster state testing (`on` requires active `REDIS_URL`). |

### Hard Guarantees
1. **Isolated Ephemeral DB**: Creates an isolated temporary directory via `mkdtemp` and sets `DATA_DIR` before loading any repository or database adapter module. Refuses to start with non-zero exit and error message containing `refusing production DATA_DIR` if `DATA_DIR` resolves under `~/.9router`.
2. **Zero Network Egress**: Uses an in-process mock executor returning simulated upstream responses in ~0.5ms. Requires no external credentials.
3. **Seeded Test Fixtures**: Automatically seeds one API key, one combo, and two provider connections (`openai`, `anthropic`) in the ephemeral SQLite database.
4. **Oracle Exit Status**: Exits 0 with final stdout line `PERF_L1_OK <label>` only if all runs complete successfully. Exits non-zero on failure.
5. **Query Counting Proof**: Counts and outputs `db_queries_per_req` via database adapter interception, providing direct proof of database call reduction.
6. **Workload Mix**: 40% direct passthrough, 40% cross-format translation with tool definitions, 20% capability-gated combo resolution.

---

## 2. In-Process Micro-Benchmarks (`scripts/perf-l0-micro.mjs`)

Measures runtime primitive operations in nanosecond/microsecond isolation:
- `bun:sqlite` prepared statement point query vs uncached query.
- Fast-path model string prefix parsing (`parseModelString`).
- `matchPattern` regex cache hit vs uncached RegExp recompilation.
- `findModel` module-load `Map` index lookup vs linear array search.
- In-memory TTL cache reads (`getModelAliases`, `getComboByName`, `getProviderNodes`).

---

## 3. Vertical Ladder Load Driver (`scripts/perf-ladder.sh`)

Drives closed-loop HTTP load against an already-running KhatamRouter instance configured with 1, 2, 4, or N vertical worker processes on the local host.

```bash
scripts/perf-ladder.sh <workers> [options]
```

### Parameters & Flags

| Argument / Flag | Default | Description |
|---|---|---|
| `<workers>` | Positional (1, 2, 4, 6) | Number of vertical workers configured on the target instance (recorded in `LadderRow`). |
| `--url <url>` | `http://127.0.0.1:20128` | Target gateway HTTP URL. |
| `--concurrency <c>` | `10` | Number of concurrent client request loops. |
| `--requests <n>` | `1000` | Total requests per run iteration. |
| `--runs <n>` | `5` | Number of measured run iterations (drops high and low, reports median of 3). |
| `--warmup <n>` | `100` | Warmup requests before measurement. |
| `--key <key>` | `sk-mock-perf-key` | Bearer API token sent in Authorization header. |

### Hard Guarantees
1. **Loopback Execution**: Drives load strictly over local HTTP sockets.
2. **Zero Docker Invocations**: Contains no Docker commands. Does not manage container or process lifecycles.
3. **Structured Output**: Emits a formatted markdown table row conforming to the `VerticalLadderRow` data model schema.
4. **Noise Discipline**: Flags runs with coefficient of variation $CV > 15\%$ as `noisy`. Unmeasured or noisy runs cannot certify improvement.

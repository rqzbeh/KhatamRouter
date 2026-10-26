# Contract: perf harness CLI

`bun scripts/perf-l1-harness.mjs [options]`

| Flag | Default | Meaning |
|---|---|---|
| `--label <s>` | `baseline` | recorded in output |
| `--runs <n>` | 5 | measured runs; the median of means is reported |
| `--warmup <n>` | 100 | sequential warm-up requests |
| `--requests <n>` | 1000 | requests per run |
| `--out <path>` | stdout | write the `L1Profile` JSON |
| `--redis <on\|off>` | `off` | `on` requires `REDIS_URL` |

**Hard guarantees**
1. Creates its own `DATA_DIR` via `mkdtemp` and exports it BEFORE importing any `src/lib/db` module. It refuses to start if `DATA_DIR` resolves under `~/.9router`.
2. Uses an in-process mock executor. It makes no network calls and needs no credentials.
3. Seeds one API key, one combo, and two provider connections (openai-compatible and anthropic) in the temp DB.
4. Exit 0 plus the final line `PERF_L1_OK <label>` only if all runs completed. Otherwise exit non-zero.
5. Prints `db_queries_per_req`, so a slimming change is proven by query-count drop as well as latency.

**Workload mix**: 40% direct passthrough, 40% cross-format translation with tools, 20% combo/alias resolution.

**Ladder driver**: `scripts/perf-ladder.sh <1|2|4>` runs the L2/L3 loopback load against an already-running stack and emits a `LadderRow`. It never invokes `docker`. Stack lifecycle belongs to the container subagent.

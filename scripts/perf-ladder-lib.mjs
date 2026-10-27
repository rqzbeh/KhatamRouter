/**
 * Pure math and formatting utilities for Wave 8 performance ladder (T021).
 *
 * Provides:
 * - computeStats: p50, p95, p99, and mean latency percentiles.
 * - computeCV: coefficient of variation (stdDev / mean * 100) and noisy flag (>15%).
 * - selectMedianRun: drops high and low runs from 5 measured runs, selects median of middle 3.
 * - evaluateLadderCertification: enforces error rate <=0.5%, CV <=15%, and target reachable;
 *   returns certified status, metrics or UNMEASURED, and cause.
 * - formatLadderRow: formats a markdown table row complying with data-model.md LadderRow schema.
 */

/**
 * Compute latency percentiles (p50, p95, p99) and mean.
 * @param {number[]} values - Array of duration/latency numbers in ms.
 * @returns {{ p50: number, p95: number, p99: number, mean: number }}
 */
export function computeStats(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const p = (q) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return Number(sorted[idx].toFixed(2));
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / n).toFixed(2));
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    mean,
  };
}

/**
 * Compute Coefficient of Variation (CV) across run means or throughput values.
 * CV = (sample_standard_deviation / mean) * 100
 * Runs with CV > 15% are flagged as noisy.
 * @param {number[]} numbers - Array of run metrics.
 * @returns {{ cv_pct: number, noisy: boolean }}
 */
export function computeCV(numbers) {
  if (!numbers || numbers.length <= 1) {
    return { cv_pct: 0, noisy: false };
  }
  const n = numbers.length;
  const mean = numbers.reduce((acc, v) => acc + v, 0) / n;
  if (mean === 0) return { cv_pct: 0, noisy: false };
  const variance = numbers.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const cvPct = (stdDev / mean) * 100;
  return {
    cv_pct: Number(cvPct.toFixed(2)),
    noisy: cvPct > 15,
  };
}

/**
 * Outlier filtering per research-ladder.md:
 * Given 5 measured runs, drop the highest and lowest, and return the median of the middle 3.
 * If fewer than 5 runs are provided, returns the median of available runs.
 * @param {Array<object>} runs - Array of run objects containing sortKey.
 * @param {string} [sortKey="mean_ms"] - Key to sort by.
 * @returns {object|null} The selected median run.
 */
export function selectMedianRun(runs, sortKey = "mean_ms") {
  if (!runs || runs.length === 0) return null;
  if (runs.length <= 2) return runs[0];

  const sorted = [...runs].sort((a, b) => (a[sortKey] ?? 0) - (b[sortKey] ?? 0));
  // If 5 or more runs, drop lowest and highest
  const middle = sorted.length >= 5 ? sorted.slice(1, sorted.length - 1) : sorted;
  // Return the median (middle element) of the filtered array
  const midIndex = Math.floor(middle.length / 2);
  return middle[midIndex];
}

/**
 * Evaluate certification criteria:
 * - Target must be reachable.
 * - Error rate must be <= 0.5% (0.005).
 * - Coefficient of variation must be <= 15% (not noisy).
 *
 * If any check fails, returns certified=false, metric values set to "UNMEASURED",
 * and an explicit explanation in cause.
 *
 * @param {object} params
 * @param {object|null} params.medianRun - The selected median run object.
 * @param {{ cv_pct: number, noisy: boolean }} params.cv - CV results.
 * @param {number} params.errorRate - Ratio of failed requests (0.0 to 1.0).
 * @param {boolean} params.targetReachable - Whether target endpoint responded.
 * @param {string} [params.unreachableCause] - Detail if unreachable.
 * @returns {object} Certification result with p50_ms, p95_ms, p99_ms, req_per_s, cause, certified.
 */
export function evaluateLadderCertification({
  medianRun,
  cv,
  errorRate,
  targetReachable = true,
  unreachableCause = "",
}) {
  if (!targetReachable) {
    return {
      certified: false,
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      cause: unreachableCause || "Target unreachable (connection refused or timeout)",
    };
  }

  if (errorRate > 0.005) {
    const errorPct = (errorRate * 100).toFixed(2);
    return {
      certified: false,
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      cause: `Error rate ${errorPct}% exceeded threshold 0.5%`,
    };
  }

  if (cv && cv.noisy) {
    return {
      certified: false,
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      cause: `Coefficient of variation ${cv.cv_pct}% exceeded threshold 15% (noisy)`,
    };
  }

  if (!medianRun) {
    return {
      certified: false,
      p50_ms: "UNMEASURED",
      p95_ms: "UNMEASURED",
      p99_ms: "UNMEASURED",
      req_per_s: "UNMEASURED",
      cause: "No runs recorded",
    };
  }

  return {
    certified: true,
    p50_ms: typeof medianRun.p50_ms === "number" ? medianRun.p50_ms : "UNMEASURED",
    p95_ms: typeof medianRun.p95_ms === "number" ? medianRun.p95_ms : "UNMEASURED",
    p99_ms: typeof medianRun.p99_ms === "number" ? medianRun.p99_ms : "UNMEASURED",
    req_per_s: typeof medianRun.req_per_s === "number" ? medianRun.req_per_s : "UNMEASURED",
    cause: "-",
  };
}

/**
 * Format markdown table row matching data-model.md LadderRow schema:
 * | tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |
 * @param {object} row
 * @returns {string} Markdown table row.
 */
export function formatLadderRow({
  tier = "L2",
  replicas = 1,
  p50_ms = "UNMEASURED",
  p95_ms = "UNMEASURED",
  p99_ms = "UNMEASURED",
  req_per_s = "UNMEASURED",
  mode = "normal",
  cv_pct = "0%",
  errors = 0,
  env = "host",
  command = "",
  cause = "-",
}) {
  const formatNum = (v) => (typeof v === "number" ? v.toString() : String(v));
  const formatCv = (v) => (typeof v === "number" ? `${v}%` : String(v));

  return `| ${tier} | ${replicas} | ${formatNum(p50_ms)} | ${formatNum(p95_ms)} | ${formatNum(p99_ms)} | ${formatNum(req_per_s)} | ${mode} | ${formatCv(cv_pct)} | ${errors} | ${env} | ${command} | ${cause} |`;
}

/**
 * Return markdown table header for LadderRow tables.
 * @returns {string}
 */
export function formatLadderHeader() {
  return [
    "| tier | replicas | p50_ms | p95_ms | p99_ms | req_per_s | mode | cv_pct | errors | env | command | cause |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ].join("\n");
}

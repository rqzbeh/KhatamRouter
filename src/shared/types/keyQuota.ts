/**
 * API Key Quota, Sliding-Window Utilization & Spend Trends Data Models.
 *
 * Backed by tables:
 *  - `api_key_quota_limits`
 *  - `api_key_quota_counters`
 *  - `request_cost_ledger`
 *
 * Security:
 *  - Raw API keys and cleartext secrets must NEVER be returned or logged.
 *  - Keys are masked via `maskApiKey()` before rendering or sending in responses.
 */

export const VALID_QUOTA_WINDOW_TYPES = [
  "rpm",
  "rph",
  "rpd",
  "tpm",
  "tpd",
  "daily_usd",
  "weekly_usd",
  "monthly_usd",
] as const;

export type QuotaWindowType = typeof VALID_QUOTA_WINDOW_TYPES[number];

export const VALID_QUOTA_ACTIONS = ["reject", "warn", "throttle"] as const;
export type QuotaAction = typeof VALID_QUOTA_ACTIONS[number];

export interface ApiKeyQuotaLimit {
  id?: string;
  apiKey?: string;
  windowType: QuotaWindowType;
  limitValue: number;
  action?: QuotaAction;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiKeyQuotaPayload {
  limits: Array<{
    id?: string;
    windowType: QuotaWindowType;
    limitValue: number;
    action?: QuotaAction;
  }>;
}

export interface WindowUtilization {
  windowType: QuotaWindowType;
  limit: number;
  used: number;
  remaining: number;
  utilizationPercent: number;
  resetMs: number;
  resetsAtIso: string;
  action?: QuotaAction;
}

export interface SpendSummary {
  todayUsd: number;
  thisWeekUsd: number;
  thisMonthUsd: number;
  totalTokensToday: number;
}

export interface ApiKeyQuotaUtilization {
  keyId: string;
  keyName: string;
  keyMasked: string;
  limits: WindowUtilization[];
  spendSummary: SpendSummary;
  status: "healthy" | "warning" | "exceeded";
}

export interface SpendTrendPoint {
  timestamp: string;
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  requestCount: number;
}

export interface KeyQuotaApiResponse {
  keyId: string;
  keyName: string;
  keyMasked: string;
  limits: ApiKeyQuotaLimit[];
  utilization?: ApiKeyQuotaUtilization;
  spendTrends?: SpendTrendPoint[];
  unconfigured?: boolean;
  degraded?: boolean;
}

/**
 * Mask an API key for safe UI display and API responses.
 * Leaves the first 8 characters and last 4 characters, replacing the middle with ***.
 * Never leaks the entire key or secret tokens.
 */
export function maskApiKey(key?: string | null): string {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length <= 12) {
    return trimmed.length > 0 ? `${trimmed.charAt(0)}***` : "";
  }
  return `${trimmed.slice(0, 8)}***${trimmed.slice(-4)}`;
}

/**
 * Validate an incoming ApiKeyQuotaPayload against the contract schema.
 */
export function validateApiKeyQuotaPayload(payload: unknown): {
  ok: boolean;
  value?: ApiKeyQuotaPayload;
  error?: string;
} {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Payload must be a non-null object" };
  }

  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.limits)) {
    return { ok: false, error: "Missing or invalid 'limits' array" };
  }

  const validatedLimits: ApiKeyQuotaPayload["limits"] = [];

  for (let i = 0; i < obj.limits.length; i++) {
    const item = obj.limits[i];
    if (!item || typeof item !== "object") {
      return { ok: false, error: `Limit at index ${i} must be an object` };
    }

    const { windowType, limitValue, action = "reject", id } = item as Record<string, unknown>;

    if (typeof windowType !== "string" || !VALID_QUOTA_WINDOW_TYPES.includes(windowType as QuotaWindowType)) {
      return {
        ok: false,
        error: `Limit at index ${i} has invalid windowType: '${String(windowType)}'`,
      };
    }

    const numericLimit = Number(limitValue);
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      return {
        ok: false,
        error: `Limit at index ${i} has non-positive or non-finite limitValue: '${String(limitValue)}'`,
      };
    }

    const normAction = typeof action === "string" ? action.toLowerCase().trim() : "reject";
    if (!VALID_QUOTA_ACTIONS.includes(normAction as QuotaAction)) {
      return {
        ok: false,
        error: `Limit at index ${i} has invalid action: '${String(action)}'`,
      };
    }

    validatedLimits.push({
      id: typeof id === "string" ? id : undefined,
      windowType: windowType as QuotaWindowType,
      limitValue: numericLimit,
      action: normAction as QuotaAction,
    });
  }

  return { ok: true, value: { limits: validatedLimits } };
}

/**
 * Pure calculation of UTC window boundaries without server runtime dependencies.
 * Duplicated from src/lib/db/keyQuota.js so the client bundle does not pull bun:sqlite.
 * Parity with the server implementation is enforced by tests/unit/key-quota-tabs.test.js.
 */
export function getUtcWindowBoundaries(windowType: string, now: number = Date.now()) {
  const d = new Date(now);
  const norm = String(windowType || "daily").toLowerCase().trim();

  if (norm === "daily" || norm === "1d" || norm === "day" || norm === "daily_usd") {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
    return {
      sinceIso: start.toISOString(),
      untilIso: end.toISOString(),
      resetMs: Math.max(0, end.getTime() - now),
    };
  }

  if (norm === "weekly" || norm === "week" || norm === "7d" || norm === "weekly_usd") {
    const day = d.getUTCDay();
    // In UTC, Sunday is 0. If Sunday, go back 6 days to Monday; otherwise go back (day - 1) days.
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday, 0, 0, 0, 0));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      sinceIso: start.toISOString(),
      untilIso: end.toISOString(),
      resetMs: Math.max(0, end.getTime() - now),
    };
  }

  if (norm === "monthly" || norm === "month" || norm === "30d" || norm === "monthly_usd") {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    return {
      sinceIso: start.toISOString(),
      untilIso: end.toISOString(),
      resetMs: Math.max(0, end.getTime() - now),
    };
  }

  // Fallback to 24h rolling
  const start = new Date(now - 24 * 60 * 60 * 1000);
  return {
    sinceIso: start.toISOString(),
    untilIso: new Date(now).toISOString(),
    resetMs: 24 * 60 * 60 * 1000,
  };
}

/**
 * Calculate the reset timestamp and remaining milliseconds for a given window type.
 */
export function calculateWindowReset(
  windowType: QuotaWindowType,
  now: number = Date.now()
): { resetMs: number; resetsAtIso: string } {
  const norm = String(windowType || "").toLowerCase().trim();

  // Minute windows: next minute boundary
  if (norm === "rpm" || norm === "tpm" || norm === "1m") {
    const winMs = 60_000;
    const bucket = Math.floor(now / winMs);
    const resetAtMs = (bucket + 1) * winMs;
    return {
      resetMs: Math.max(0, resetAtMs - now),
      resetsAtIso: new Date(resetAtMs).toISOString(),
    };
  }

  // Hour window: next hour boundary
  if (norm === "rph" || norm === "1h") {
    const winMs = 3_600_000;
    const bucket = Math.floor(now / winMs);
    const resetAtMs = (bucket + 1) * winMs;
    return {
      resetMs: Math.max(0, resetAtMs - now),
      resetsAtIso: new Date(resetAtMs).toISOString(),
    };
  }

  // Daily, weekly, monthly calendar windows (aligned with UTC midnight)
  if (norm === "rpd" || norm === "tpd" || norm === "daily_usd" || norm === "daily") {
    const bounds = getUtcWindowBoundaries("daily", now);
    return {
      resetMs: bounds.resetMs,
      resetsAtIso: bounds.untilIso,
    };
  }

  if (norm === "weekly_usd" || norm === "weekly") {
    const bounds = getUtcWindowBoundaries("weekly", now);
    return {
      resetMs: bounds.resetMs,
      resetsAtIso: bounds.untilIso,
    };
  }

  if (norm === "monthly_usd" || norm === "monthly") {
    const bounds = getUtcWindowBoundaries("monthly", now);
    return {
      resetMs: bounds.resetMs,
      resetsAtIso: bounds.untilIso,
    };
  }

  // Default fallback to 24h rolling
  const defaultResetAtMs = now + 86_400_000;
  return {
    resetMs: 86_400_000,
    resetsAtIso: new Date(defaultResetAtMs).toISOString(),
  };
}

/**
 * Format a duration in milliseconds into a concise countdown string.
 * Example: 45000 -> "45s", 125000 -> "2m 5s", 3665000 -> "1h 1m"
 */
export function formatResetTimer(resetMs: number): string {
  if (!resetMs || resetMs <= 0) return "0s";

  const totalSec = Math.ceil(resetMs / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }

  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  }

  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 24) {
    return remMin > 0 ? `${totalHours}h ${remMin}m` : `${totalHours}h`;
  }

  const totalDays = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${totalDays}d ${remHours}h` : `${totalDays}d`;
}

/**
 * Calculate utilization percentage rounded to 1 decimal place.
 */
export function calculateUtilizationPercent(used: number, limit: number): number {
  if (!limit || limit <= 0 || !Number.isFinite(limit)) return 0;
  const pct = (used / limit) * 100;
  return Math.round(pct * 10) / 10;
}

/**
 * Classify quota utilization into health status:
 *  - "healthy": < 70%
 *  - "warning": 70% to 90%
 *  - "exceeded": > 90%
 */
export function getQuotaStatus(utilizationPercent: number): "healthy" | "warning" | "exceeded" {
  if (utilizationPercent > 90) return "exceeded";
  if (utilizationPercent >= 70) return "warning";
  return "healthy";
}

/**
 * Aggregate and compute key quota utilization summary.
 */
export function computeKeyQuotaUtilization(params: {
  keyId: string;
  keyName: string;
  rawKey?: string;
  keyMasked?: string;
  limitsWithUsage: Array<{
    windowType: QuotaWindowType;
    limit: number;
    used: number;
    resetMs: number;
    resetsAtIso: string;
    action?: QuotaAction;
  }>;
  spendSummary: SpendSummary;
}): ApiKeyQuotaUtilization {
  const { keyId, keyName, rawKey, keyMasked, limitsWithUsage, spendSummary } = params;

  const masked = keyMasked || maskApiKey(rawKey);

  let worstStatus: "healthy" | "warning" | "exceeded" = "healthy";

  const limits: WindowUtilization[] = limitsWithUsage.map((item) => {
    const utilizationPercent = calculateUtilizationPercent(item.used, item.limit);
    const remaining = Math.max(0, item.limit - item.used);
    const itemStatus = getQuotaStatus(utilizationPercent);

    if (itemStatus === "exceeded") worstStatus = "exceeded";
    else if (itemStatus === "warning" && worstStatus !== "exceeded") worstStatus = "warning";

    return {
      windowType: item.windowType,
      limit: item.limit,
      used: item.used,
      remaining,
      utilizationPercent,
      resetMs: item.resetMs,
      resetsAtIso: item.resetsAtIso,
      action: item.action,
    };
  });

  return {
    keyId,
    keyName,
    keyMasked: masked,
    limits,
    spendSummary,
    status: worstStatus,
  };
}

/**
 * Group raw cost ledger rows into hourly or daily trend points.
 */
export function aggregateSpendTrends(
  rows: Array<{
    created_at?: string;
    total_cost_usd?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }>,
  period: string = "24h"
): SpendTrendPoint[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const isHourly = period === "24h" || period === "today";

  const buckets = new Map<string, SpendTrendPoint>();

  for (const row of rows) {
    if (!row.created_at) continue;

    let bucketKey = row.created_at.slice(0, 10); // YYYY-MM-DD
    if (isHourly) {
      bucketKey = `${row.created_at.slice(0, 10)} ${row.created_at.slice(11, 13)}:00`;
    }

    const current = buckets.get(bucketKey) || {
      timestamp: bucketKey,
      totalCostUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };

    const cost = Number(row.total_cost_usd) || 0;
    const prompt = Number(row.prompt_tokens) || 0;
    const comp = Number(row.completion_tokens) || 0;
    const total = Number(row.total_tokens) || prompt + comp;

    current.totalCostUsd += cost;
    current.promptTokens += prompt;
    current.completionTokens += comp;
    current.totalTokens = (current.totalTokens || 0) + total;
    current.requestCount += 1;

    buckets.set(bucketKey, current);
  }

  return Array.from(buckets.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

/**
 * Query request_cost_ledger for spend trends.
 * Fully parameterized SQL, bounded time window and row limit.
 * Fail-open: returns { points: [], degraded: true } on database failure or missing db.
 */
export async function getSpendTrendsFromLedger(
  params: {
    apiKeyId: string;
    period?: string;
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
    now?: number;
  },
  customDb: unknown = null
): Promise<{ points: SpendTrendPoint[]; degraded: boolean }> {
  if (!customDb) {
    return { points: [], degraded: true };
  }

  const { apiKeyId, period = "24h", limit = 1000, now: rawNow } = params;
  const now = rawNow || Date.now();

  let sinceIso = params.sinceIso;
  let untilIso = params.untilIso || new Date(now).toISOString();

  if (!sinceIso) {
    if (period === "today") {
      const bounds = getUtcWindowBoundaries("daily", now);
      sinceIso = bounds.sinceIso;
    } else if (period === "24h") {
      sinceIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    } else if (period === "7d") {
      sinceIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (period === "30d") {
      sinceIso = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      // Default to 90d cap to protect performance
      sinceIso = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const isHourly = period === "24h" || period === "today";
  const strftimeFormat = isHourly ? "%Y-%m-%d %H:00" : "%Y-%m-%d";

  try {
    const db = customDb as any;
    const query = `
      SELECT
        strftime(?, created_at) AS bucket,
        COALESCE(SUM(total_cost_usd), 0.0) AS total_cost_usd,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COUNT(*) AS request_count
      FROM request_cost_ledger
      WHERE api_key_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ?
    `;

    const rows = db.all(query, [
      strftimeFormat,
      apiKeyId,
      sinceIso,
      untilIso,
      Math.min(limit, 1000),
    ]);

    const points: SpendTrendPoint[] = (rows || []).map((r: any) => ({
      timestamp: String(r.bucket || ""),
      totalCostUsd: Number(r.total_cost_usd) || 0.0,
      promptTokens: Number(r.prompt_tokens) || 0,
      completionTokens: Number(r.completion_tokens) || 0,
      totalTokens: Number(r.total_tokens) || 0,
      requestCount: Number(r.request_count) || 0,
    }));

    return { points, degraded: false };
  } catch (err: any) {
    console.warn(`[keyQuota:trends] Failed to query spend trends (failing open): ${err?.message ?? err}`);
    return { points: [], degraded: true };
  }
}

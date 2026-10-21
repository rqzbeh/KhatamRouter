/**
 * Database access layer for API Key Quotas and Cost Ledger.
 *
 * Backed by tables:
 *  - `api_key_quota_limits`
 *  - `api_key_quota_counters`
 *  - `request_cost_ledger`
 *
 * Security:
 *  - API keys must always be hashed before storing in quota keys/counters.
 *  - Raw credentials are never logged or persisted cleartext in quota tables.
 */

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "./driver.js";

/**
 * Hash an API key with SHA-256. Safe for logging and storage in quota keys.
 */
export function hashApiKey(key) {
  if (!key) return "";
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

/**
 * Calculate UTC window boundaries for daily, weekly, and monthly accounting windows.
 */
export function getUtcWindowBoundaries(windowType, now = Date.now()) {
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
 * Fetch all quota limits defined for an API key.
 * Searches by hashed key, raw key, or apiKeyId.
 */
export async function getApiKeyQuotaLimits(keyOrHash, customDb = null) {
  const db = customDb || (await getAdapter());
  const hash = hashApiKey(keyOrHash);
  const rows = db.all(
    `SELECT * FROM api_key_quota_limits WHERE api_key = ? OR api_key = ? ORDER BY created_at ASC`,
    [keyOrHash, hash]
  );
  return rows || [];
}

/**
 * Insert or update a limit row in api_key_quota_limits.
 */
export async function upsertApiKeyQuotaLimit(limitData, customDb = null) {
  const db = customDb || (await getAdapter());
  const {
    id = uuidv4(),
    apiKey,
    windowType,
    limitValue,
    action = "reject",
  } = limitData;

  const hash = hashApiKey(apiKey);
  const nowIso = new Date().toISOString();

  try {
    db.run(
      `INSERT INTO api_key_quota_limits (id, api_key, window_type, limit_value, action, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         window_type = excluded.window_type,
         limit_value = excluded.limit_value,
         action = excluded.action,
         updated_at = excluded.updated_at`,
      [id, hash, windowType, limitValue, action, nowIso, nowIso]
    );
    return { id, apiKey: hash, windowType, limitValue, action, updatedAt: nowIso };
  } catch (err) {
    console.warn(`[keyQuota:db] Failed to upsert quota limit: ${err?.message ?? err}`);
    throw err;
  }
}

/**
 * Record a transaction into request_cost_ledger.
 */
export async function insertRequestCostLedger(entry, customDb = null) {
  const db = customDb || (await getAdapter());
  const {
    id = uuidv4(),
    requestId = uuidv4(),
    apiKeyId = null,
    provider,
    model,
    promptTokens = 0,
    completionTokens = 0,
    totalTokens = 0,
    inputCostPerMillion = 0,
    outputCostPerMillion = 0,
    totalCostUsd = 0,
    status = "success",
    createdAt = new Date().toISOString(),
  } = entry;

  try {
    db.run(
      `INSERT INTO request_cost_ledger (
         id, request_id, api_key_id, provider, model,
         prompt_tokens, completion_tokens, total_tokens,
         input_cost_per_million, output_cost_per_million,
         total_cost_usd, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        requestId,
        apiKeyId,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        inputCostPerMillion,
        outputCostPerMillion,
        totalCostUsd,
        status,
        createdAt,
      ]
    );
    return { id, requestId, totalCostUsd };
  } catch (err) {
    console.warn(`[keyQuota:db] Failed to insert request_cost_ledger: ${err?.message ?? err}`);
    // Fail-open: do not throw to protect routing
    return null;
  }
}

/**
 * Aggregate cumulative spend and tokens from request_cost_ledger for an API key ID.
 */
export async function getCumulativeSpendFromLedger(params, customDb = null) {
  const { apiKeyId, sinceIso, untilIso } = params;
  const db = customDb || (await getAdapter());

  try {
    let query = `SELECT COALESCE(SUM(total_cost_usd), 0.0) AS total_usd,
                        COALESCE(SUM(total_tokens), 0) AS total_tokens
                 FROM request_cost_ledger
                 WHERE api_key_id = ? AND created_at >= ?`;
    const args = [apiKeyId, sinceIso];

    if (untilIso) {
      query += ` AND created_at < ?`;
      args.push(untilIso);
    }

    const row = db.get(query, args);
    return {
      totalUsd: Number(row?.total_usd) || 0.0,
      totalTokens: Number(row?.total_tokens) || 0,
    };
  } catch (err) {
    console.warn(`[keyQuota:db] Failed to compute cumulative spend (failing open): ${err?.message ?? err}`);
    return { totalUsd: 0.0, totalTokens: 0, degraded: true };
  }
}

/**
 * Aggregate cumulative spend for a standardized window (daily, weekly, monthly).
 */
export async function getCumulativeSpendForWindow(params, customDb = null) {
  const { apiKeyId, windowType = "daily", now = Date.now() } = params;
  const { sinceIso, untilIso, resetMs } = getUtcWindowBoundaries(windowType, now);
  const spend = await getCumulativeSpendFromLedger({ apiKeyId, sinceIso, untilIso }, customDb);

  return {
    ...spend,
    windowType,
    sinceIso,
    untilIso,
    resetMs,
  };
}

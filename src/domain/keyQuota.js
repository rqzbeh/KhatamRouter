/**
 * Domain Service for API Key Quota Management and Cost Ledger Accounting.
 *
 * Implements:
 *  - checkKeyQuota: evaluates rate/token limits and USD spend caps over api_key_quota_limits
 *  - recordKeyQuotaUsage: records transactions into request_cost_ledger and updates counters
 *
 * Operational Invariant:
 *  - Limits infrastructure failures (database errors, Redis disconnects)
 *    MUST FAIL OPEN with `{ allowed: true, degraded: true }`.
 *  - Only an actual exceeded policy limit returns `{ allowed: false, ... }`.
 *  - Never throws on the request path.
 *
 * Security:
 *  - API keys are always hashed (SHA-256) before passing to storage engines or logging.
 */

import { getQuotaStore } from "@/lib/quota/storeFactory.js";
import {
  hashApiKey,
  getApiKeyQuotaLimits,
  getCumulativeSpendForWindow,
  insertRequestCostLedger,
} from "@/lib/db/keyQuota.js";

/**
 * Window type to duration in milliseconds mapping for sliding windows.
 */
function windowTypeToMs(windowType) {
  const norm = String(windowType || "").toLowerCase().trim();
  switch (norm) {
    case "rpm":
    case "1m":
      return 60_000;
    case "rph":
    case "1h":
      return 3_600_000;
    case "rpd":
    case "1d":
      return 86_400_000;
    case "tpm":
      return 60_000;
    case "tpd":
      return 86_400_000;
    default: {
      const parsed = Number(norm);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
  }
}

/**
 * Check whether an API key has exceeded any configured quota or spend limit.
 *
 * Checks:
 *  1. Sliding-window limits in api_key_quota_limits (rpm, rph, rpd, tpm, tpd, etc.)
 *  2. USD budget caps in api_key_quota_limits (daily_usd, weekly_usd, monthly_usd)
 *
 * Fails open: returns `{ allowed: true, degraded: true }` on infrastructure error.
 */
export async function checkKeyQuota(params = {}) {
  const {
    apiKey,
    apiKeyId,
    requestedTokens = 1,
    costUsd = 0,
    now: rawNow,
    store,
    db,
  } = params;

  const now = Number(rawNow) || Date.now();
  const keyIdentifier = apiKeyId || (apiKey ? hashApiKey(apiKey) : null);

  if (!keyIdentifier) {
    return { allowed: true };
  }

  let degraded = false;

  try {
    const limits = await getApiKeyQuotaLimits(apiKey || keyIdentifier, db);
    if (!limits || limits.length === 0) {
      return { allowed: true };
    }

    const quotaStore = store || getQuotaStore();

    for (const lim of limits) {
      const winType = lim.window_type?.toLowerCase()?.trim();
      const limitVal = Number(lim.limit_value) || 0;

      if (limitVal <= 0) continue;

      // Handle USD spend caps
      if (
        winType === "daily_usd" ||
        winType === "weekly_usd" ||
        winType === "monthly_usd" ||
        winType === "daily" ||
        winType === "weekly" ||
        winType === "monthly"
      ) {
        let spendRes;
        try {
          spendRes = await getCumulativeSpendForWindow(
            {
              apiKeyId: keyIdentifier,
              windowType: winType,
              now,
            },
            db
          );
        } catch (spendErr) {
          console.warn(`[keyQuota] Spend ledger query failed (failing open): ${spendErr?.message ?? spendErr}`);
          degraded = true;
          continue;
        }

        if (spendRes?.degraded) {
          degraded = true;
        }

        const currentSpend = spendRes?.totalUsd || 0.0;
        if (currentSpend + costUsd > limitVal) {
          return {
            allowed: false,
            reason: "budget_exceeded",
            limitType: winType,
            limit: limitVal,
            current: currentSpend,
            retryAfterMs: Math.max(1000, spendRes?.resetMs || 60_000),
          };
        }
        continue;
      }

      // Handle Sliding-Window Rate / Token Limits
      const winMs = windowTypeToMs(winType);
      if (winMs) {
        const isTokenLimit = winType.startsWith("tp") || winType.includes("token");
        const amount = isTokenLimit ? Math.max(1, Number(requestedTokens) || 1) : 1;

        let res;
        try {
          res = await quotaStore.consume({
            key: keyIdentifier,
            limit: limitVal,
            windowMs: winMs,
            amount,
            counterType: `key:${winType}`,
            now,
          });
        } catch (storeErr) {
          console.warn(`[keyQuota] QuotaStore consume error (failing open): ${storeErr?.message ?? storeErr}`);
          degraded = true;
          continue;
        }

        if (res?.degraded) {
          degraded = true;
        }

        if (res && res.allowed === false) {
          return {
            allowed: false,
            reason: isTokenLimit ? "token_limit_exceeded" : "rate_limit_exceeded",
            limitType: winType,
            limit: limitVal,
            current: res.current,
            retryAfterMs: Math.max(1000, res.resetMs || 1000),
          };
        }
      }
    }

    return {
      allowed: true,
      ...(degraded ? { degraded: true } : {}),
    };
  } catch (err) {
    console.warn(`[keyQuota] checkKeyQuota unexpected error (failing open): ${err?.message ?? err}`);
    return {
      allowed: true,
      degraded: true,
    };
  }
}

/**
 * Record API key usage post-flight into request_cost_ledger and update counters.
 *
 * Never throws on the request path.
 */
export async function recordKeyQuotaUsage(params = {}) {
  const {
    apiKey,
    apiKeyId,
    requestId,
    provider,
    model,
    promptTokens = 0,
    completionTokens = 0,
    totalTokens = 0,
    costUsd = 0,
    inputCostPerMillion = 0,
    outputCostPerMillion = 0,
    status = "success",
    now: rawNow,
    db,
  } = params;

  const keyIdentifier = apiKeyId || (apiKey ? hashApiKey(apiKey) : null);
  const now = Number(rawNow) || Date.now();
  const createdAtIso = new Date(now).toISOString();

  try {
    const result = await insertRequestCostLedger(
      {
        requestId,
        apiKeyId: keyIdentifier,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        inputCostPerMillion,
        outputCostPerMillion,
        totalCostUsd: Number(costUsd) || 0,
        status,
        createdAt: createdAtIso,
      },
      db
    );

    return {
      success: Boolean(result),
      id: result?.id,
    };
  } catch (err) {
    console.warn(`[keyQuota] recordKeyQuotaUsage error (failing open): ${err?.message ?? err}`);
    return {
      success: false,
      degraded: true,
    };
  }
}

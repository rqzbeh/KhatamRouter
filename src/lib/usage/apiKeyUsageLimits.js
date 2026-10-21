/**
 * API Key Usage Limits and Spend Cap Enforcement.
 *
 * Enforces:
 *  - daily_usage_limit_usd and weekly_usage_limit_usd when usage_limit_enabled === 1
 *  - rate_limits array of { limit, window } (e.g. "1m", "1h", "1d", or ms)
 *
 * Operational Invariant:
 *  - Limits infrastructure failures (database errors, Redis disconnects)
 *    MUST FAIL OPEN with `{ allowed: true, degraded: true }`.
 *  - A quota or storage outage must never take down inference routing.
 *  - Only an actual exceeded policy limit returns `{ allowed: false, ... }`.
 *  - Never throws on the request path.
 *
 * Security:
 *  - API keys are always hashed (SHA-256) before passing to storage engines or logging.
 */

import { getQuotaStore } from "@/lib/quota/storeFactory.js";
import { hashApiKey, getCumulativeSpendForWindow } from "@/lib/db/keyQuota.js";

/**
 * Parse window representation into milliseconds.
 * Supports: "1m", "1h", "1d", "60s", milliseconds (e.g. 5000), or seconds.
 */
export function parseWindowDuration(window) {
  if (window === null || window === undefined) return null;

  if (typeof window === "number") {
    if (!Number.isFinite(window) || window <= 0) return null;
    // Standard seconds notation vs milliseconds
    return window <= 86400 ? Math.floor(window * 1000) : Math.floor(window);
  }

  if (typeof window === "string") {
    const trimmed = window.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
    if (!match) return null;

    const val = parseFloat(match[1]);
    if (!Number.isFinite(val) || val <= 0) return null;

    const unit = match[2];
    switch (unit) {
      case "ms":
        return Math.floor(val);
      case "s":
        return Math.floor(val * 1000);
      case "m":
        return Math.floor(val * 60 * 1000);
      case "h":
        return Math.floor(val * 3600 * 1000);
      case "d":
        return Math.floor(val * 86400 * 1000);
      default:
        return Math.floor(val <= 86400 ? val * 1000 : val);
    }
  }

  return null;
}

/**
 * Parse and sanitize rate_limits array from JSON string or object.
 * Returns array of { limit: number, windowMs: number, windowStr: string }.
 */
export function parseRateLimits(raw) {
  if (!raw) return [];
  let parsed = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const validEntries = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const limit = Number(entry.limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;

    const windowMs = parseWindowDuration(entry.window);
    if (!windowMs || windowMs <= 0) continue;

    validEntries.push({
      limit: Math.floor(limit),
      windowMs,
      windowStr: String(entry.window),
    });
  }

  return validEntries;
}

/**
 * Check an API key row for usage limit spend caps and rate limit lists.
 *
 * Operational Invariant:
 *  - Storage errors FAIL OPEN: returns { allowed: true, degraded: true }.
 *  - Only limit breaches return { allowed: false, ... }.
 */
export async function checkApiKeyUsageLimits(params = {}) {
  const {
    apiKeyRow,
    estimatedCostUsd = 0,
    now: rawNow,
    store,
    db,
  } = params;

  if (!apiKeyRow) {
    return { allowed: true };
  }

  const now = Number(rawNow) || Date.now();
  const keyIdentifier = apiKeyRow.id || (apiKeyRow.key ? hashApiKey(apiKeyRow.key) : "default");
  let degraded = false;

  try {
    // 1. USD Spend Caps (daily and weekly)
    const usageLimitEnabled =
      apiKeyRow.usage_limit_enabled === 1 ||
      apiKeyRow.usage_limit_enabled === true ||
      apiKeyRow.usageLimitEnabled === 1 ||
      apiKeyRow.usageLimitEnabled === true;

    if (usageLimitEnabled) {
      const dailyLimit = Number(apiKeyRow.daily_usage_limit_usd ?? apiKeyRow.dailyUsageLimitUsd) || 0;
      const weeklyLimit = Number(apiKeyRow.weekly_usage_limit_usd ?? apiKeyRow.weeklyUsageLimitUsd) || 0;

      // Check Daily USD Cap
      if (dailyLimit > 0) {
        let dailySpend;
        try {
          dailySpend = await getCumulativeSpendForWindow(
            { apiKeyId: apiKeyRow.id || keyIdentifier, windowType: "daily", now },
            db
          );
        } catch (spendErr) {
          console.warn(`[apiKeyUsageLimits] Daily spend query error (failing open): ${spendErr?.message ?? spendErr}`);
          degraded = true;
        }

        if (dailySpend?.degraded) degraded = true;

        const currentDaily = dailySpend?.totalUsd || 0.0;
        if (currentDaily + estimatedCostUsd > dailyLimit) {
          return {
            allowed: false,
            reason: "budget_exceeded",
            limitType: "daily_usage_limit_usd",
            limit: dailyLimit,
            current: currentDaily,
            retryAfterMs: Math.max(1000, dailySpend?.resetMs || 60_000),
          };
        }
      }

      // Check Weekly USD Cap
      if (weeklyLimit > 0) {
        let weeklySpend;
        try {
          weeklySpend = await getCumulativeSpendForWindow(
            { apiKeyId: apiKeyRow.id || keyIdentifier, windowType: "weekly", now },
            db
          );
        } catch (spendErr) {
          console.warn(`[apiKeyUsageLimits] Weekly spend query error (failing open): ${spendErr?.message ?? spendErr}`);
          degraded = true;
        }

        if (weeklySpend?.degraded) degraded = true;

        const currentWeekly = weeklySpend?.totalUsd || 0.0;
        if (currentWeekly + estimatedCostUsd > weeklyLimit) {
          return {
            allowed: false,
            reason: "budget_exceeded",
            limitType: "weekly_usage_limit_usd",
            limit: weeklyLimit,
            current: currentWeekly,
            retryAfterMs: Math.max(1000, weeklySpend?.resetMs || 60_000),
          };
        }
      }
    }

    // 2. Sliding-Window Rate Limits List
    const rateLimits = parseRateLimits(apiKeyRow.rate_limits ?? apiKeyRow.rateLimits);
    if (rateLimits.length > 0) {
      const quotaStore = store || getQuotaStore();
      const hashedKey = hashApiKey(apiKeyRow.key || keyIdentifier);

      for (const rl of rateLimits) {
        let res;
        try {
          res = await quotaStore.consume({
            key: `ak:${hashedKey}`,
            limit: rl.limit,
            windowMs: rl.windowMs,
            amount: 1,
            counterType: `rl:${rl.windowMs}`,
            now,
          });
        } catch (storeErr) {
          console.warn(`[apiKeyUsageLimits] QuotaStore consume error (failing open): ${storeErr?.message ?? storeErr}`);
          degraded = true;
          continue;
        }

        if (res?.degraded) {
          degraded = true;
        }

        if (res && res.allowed === false) {
          return {
            allowed: false,
            reason: "rate_limit_exceeded",
            limitType: rl.windowStr,
            limit: rl.limit,
            current: res.current,
            retryAfterMs: Math.max(1000, res.resetMs || 1000),
            windowMs: rl.windowMs,
          };
        }
      }
    }

    return {
      allowed: true,
      ...(degraded ? { degraded: true } : {}),
    };
  } catch (err) {
    // Top-level fail open guard: never throw on routing path
    console.warn(`[apiKeyUsageLimits] Top-level failure (failing open): ${err?.message ?? err}`);
    return {
      allowed: true,
      degraded: true,
    };
  }
}

/**
 * Format a standard HTTP 429 response envelope and headers for rejected requests.
 */
export function formatQuotaErrorResponse(verdict) {
  const retryAfterSec = Math.max(1, Math.ceil((verdict.retryAfterMs || 1000) / 1000));

  if (verdict.reason === "budget_exceeded") {
    const spent = Number(verdict.current || 0).toFixed(2);
    const limit = Number(verdict.limit || 0).toFixed(2);
    return {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "Content-Type": "application/json",
      },
      body: {
        error: {
          message: `Daily/Weekly expenditure limit reached for this API key ($${spent}/$${limit}).`,
          type: "requests",
          code: "budget_exceeded",
        },
      },
    };
  }

  return {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSec),
      "Content-Type": "application/json",
    },
    body: {
      error: {
        message: `Rate limit reached for API key. Please retry after ${retryAfterSec}s.`,
        type: "requests",
        code: "rate_limit_exceeded",
      },
    },
  };
}

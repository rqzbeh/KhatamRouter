import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getApiKeyById, getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { getAdapter } from "@/lib/db/driver.js";
import { hashApiKey, getCumulativeSpendForWindow } from "@/lib/db/keyQuota.js";
import { getQuotaStore } from "@/lib/quota/storeFactory.js";
import {
  maskApiKey,
  validateApiKeyQuotaPayload,
  calculateWindowReset,
  computeKeyQuotaUtilization,
  getSpendTrendsFromLedger,
} from "@/shared/types/keyQuota";

export const dynamic = "force-dynamic";

/**
 * Window type to milliseconds mapping for sliding windows.
 *
 * @param {string} winType
 * @returns {number}
 */
function windowTypeToMs(winType) {
  const norm = String(winType || "").toLowerCase().trim();
  switch (norm) {
    case "rpm":
    case "1m":
    case "tpm":
      return 60_000;
    case "rph":
    case "1h":
      return 3_600_000;
    case "rpd":
    case "1d":
    case "tpd":
    case "daily_usd":
      return 86_400_000;
    default:
      return 60_000;
  }
}

/**
 * Dashboard session and CLI token authentication check.
 * Fails closed unless requireLogin is explicitly false or valid token is presented.
 *
 * @param {Request} request
 * @returns {Promise<boolean>}
 */
async function isAuthenticated(request) {
  try {
    const settings = await getSettings();
    if (settings && settings.requireLogin === false) {
      return true;
    }
  } catch {
    // If settings lookup fails, fail closed (require auth)
  }

  // Extract auth_token from cookies
  let token = null;
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token && "cookies" in request && typeof request.cookies?.get === "function") {
    token = request.cookies.get("auth_token")?.value || null;
  }

  if (token) {
    const valid = await verifyDashboardAuthToken(token);
    if (valid) return true;
  }

  // Check CLI machine auth token
  const cliToken = request.headers.get("x-9r-cli-token");
  if (cliToken) {
    try {
      const { getConsistentMachineId } = await import("@/shared/utils/machineId");
      const expected = await getConsistentMachineId("9r-cli-auth");
      if (expected && cliToken === expected) return true;
    } catch {
      // CLI token verification failed
    }
  }

  return false;
}

// GET /api/keys/[id]/quota - Fetch quota configuration, utilization and spend trends
export async function GET(request, { params }) {
  try {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    let key = null;
    try {
      key = await getApiKeyById(id);
    } catch (dbErr) {
      console.warn(`[keyQuota:api] Failed to get API key (failing open): ${dbErr?.message ?? dbErr}`);
      return NextResponse.json({
        keyId: id,
        keyName: "Unknown Key",
        keyMasked: "Unknown",
        limits: [],
        utilization: {
          keyId: id,
          keyName: "Unknown Key",
          keyMasked: "Unknown",
          limits: [],
          spendSummary: { todayUsd: 0, thisWeekUsd: 0, thisMonthUsd: 0, totalTokensToday: 0 },
          status: "healthy",
        },
        spendTrends: [],
        unconfigured: true,
        degraded: true,
      }, { status: 200 });
    }

    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const maskedKey = maskApiKey(key.key);

    let period = "24h";
    try {
      const { searchParams } = new URL(request.url);
      period = searchParams.get("period") || "24h";
    } catch {}

    const now = Date.now();

    // Query limits and trends inside fail-open try/catch block
    try {
      const db = await getAdapter();
      const hash = hashApiKey(key.key);

      const limitsRows = db.all(
        `SELECT * FROM api_key_quota_limits WHERE api_key = ? OR api_key = ? OR api_key = ? ORDER BY created_at ASC`,
        [key.key, hash, key.id]
      );

      const sanitizedLimits = (limitsRows || []).map((r) => ({
        id: r.id,
        windowType: r.window_type,
        limitValue: Number(r.limit_value),
        action: r.action || "reject",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      // Calculate spend summaries
      const [todaySpend, weekSpend, monthSpend] = await Promise.all([
        getCumulativeSpendForWindow({ apiKeyId: key.id, windowType: "daily", now }, db),
        getCumulativeSpendForWindow({ apiKeyId: key.id, windowType: "weekly", now }, db),
        getCumulativeSpendForWindow({ apiKeyId: key.id, windowType: "monthly", now }, db),
      ]);

      const spendSummary = {
        todayUsd: todaySpend?.totalUsd || 0.0,
        thisWeekUsd: weekSpend?.totalUsd || 0.0,
        thisMonthUsd: monthSpend?.totalUsd || 0.0,
        totalTokensToday: todaySpend?.totalTokens || 0,
      };

      const quotaStore = getQuotaStore();

      // Compute usage for each configured limit
      const limitsWithUsage = await Promise.all(
        sanitizedLimits.map(async (lim) => {
          const winType = lim.windowType;
          const limitVal = lim.limitValue;

          if (
            winType === "daily_usd" ||
            winType === "weekly_usd" ||
            winType === "monthly_usd"
          ) {
            const spend =
              winType === "weekly_usd"
                ? weekSpend
                : winType === "monthly_usd"
                ? monthSpend
                : todaySpend;

            return {
              windowType: winType,
              limit: limitVal,
              used: spend?.totalUsd || 0.0,
              resetMs: spend?.resetMs || calculateWindowReset(winType, now).resetMs,
              resetsAtIso: spend?.untilIso || calculateWindowReset(winType, now).resetsAtIso,
              action: lim.action,
            };
          }

          // Sliding window rate/token limits
          const winMs = windowTypeToMs(winType);
          let used = 0;
          let resetMs = calculateWindowReset(winType, now).resetMs;
          let resetsAtIso = calculateWindowReset(winType, now).resetsAtIso;

          try {
            const peekRes = await quotaStore.peek({
              key: hash || key.id,
              limit: limitVal,
              windowMs: winMs,
              counterType: `key:${winType}`,
              now,
            });

            if (peekRes) {
              used = peekRes.current || 0;
              if (peekRes.resetMs !== undefined) resetMs = peekRes.resetMs;
              if (peekRes.resetAtMs) resetsAtIso = new Date(peekRes.resetAtMs).toISOString();
            }
          } catch {
            // Fail open for store peek error
          }

          return {
            windowType: winType,
            limit: limitVal,
            used,
            resetMs,
            resetsAtIso,
            action: lim.action,
          };
        })
      );

      const utilization = computeKeyQuotaUtilization({
        keyId: key.id,
        keyName: key.name,
        keyMasked: maskedKey,
        limitsWithUsage,
        spendSummary,
      });

      const trendsRes = await getSpendTrendsFromLedger({
        apiKeyId: key.id,
        period,
        now,
      }, db);

      return NextResponse.json({
        keyId: key.id,
        keyName: key.name,
        keyMasked: maskedKey,
        limits: sanitizedLimits,
        utilization,
        spendTrends: trendsRes.points || [],
        unconfigured: sanitizedLimits.length === 0,
        degraded: trendsRes.degraded || false,
      });
    } catch (err) {
      console.warn(`[keyQuota:api] Failed to fetch quota data for key ${key.id} (failing open): ${err?.message ?? err}`);
      // Fail open: return 200 with degraded state instead of crashing 500
      return NextResponse.json({
        keyId: key.id,
        keyName: key.name,
        keyMasked: maskedKey,
        limits: [],
        utilization: {
          keyId: key.id,
          keyName: key.name,
          keyMasked: maskedKey,
          limits: [],
          spendSummary: { todayUsd: 0, thisWeekUsd: 0, thisMonthUsd: 0, totalTokensToday: 0 },
          status: "healthy",
        },
        spendTrends: [],
        unconfigured: true,
        degraded: true,
      });
    }
  } catch (outerErr) {
    console.error(`[keyQuota:api] Unhandled error: ${outerErr?.message ?? outerErr}`);
    return NextResponse.json({ error: "Failed to fetch key quota" }, { status: 500 });
  }
}

// PUT /api/keys/[id]/quota - Update quota limits for key
export async function PUT(request, { params }) {
  try {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const validated = validateApiKeyQuotaPayload(body);
    if (!validated.ok || !validated.value) {
      return NextResponse.json(
        { error: validated.error || "Invalid quota limits payload" },
        { status: 400 }
      );
    }

    const db = await getAdapter();
    const hash = hashApiKey(key.key);
    const nowIso = new Date().toISOString();

    const updatedLimits = [];

    db.transaction(() => {
      // Remove previous limits for this key
      db.run(
        `DELETE FROM api_key_quota_limits WHERE api_key = ? OR api_key = ? OR api_key = ?`,
        [key.key, hash, key.id]
      );

      // Insert new limits
      for (const item of validated.value.limits) {
        const limitId = item.id || uuidv4();
        const action = item.action || "reject";
        db.run(
          `INSERT INTO api_key_quota_limits (id, api_key, window_type, limit_value, action, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [limitId, hash, item.windowType, item.limitValue, action, nowIso, nowIso]
        );

        updatedLimits.push({
          id: limitId,
          windowType: item.windowType,
          limitValue: item.limitValue,
          action,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    });

    const maskedKey = maskApiKey(key.key);

    return NextResponse.json({
      keyId: key.id,
      keyName: key.name,
      keyMasked: maskedKey,
      limits: updatedLimits,
    });
  } catch (error) {
    console.error(`[keyQuota:api] Error updating quota: ${error?.message ?? error}`);
    return NextResponse.json({ error: "Failed to update quota limits" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation, normalizeMemberCooldownMs, isValidMemberCooldown, clearComboCooldowns, isComboCooldownDisabled } from "open-sse/services/combo.js";
import { normalizeProxyHealthSettings } from "@/lib/network/proxyHealthPolicy.js";
import { normalizeProxyFailoverSettings } from "@/lib/network/proxyFailover.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // Proxy health is validated and stored normalized; invalid values are
    // rejected rather than silently clamped.
    if (Object.prototype.hasOwnProperty.call(body, "proxyHealth")) {
      const { ok, value, errors } = normalizeProxyHealthSettings(body.proxyHealth);
      if (!ok) return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
      body.proxyHealth = value;
    }

    if (Object.prototype.hasOwnProperty.call(body, "proxyFailover")) {
      const { ok, value, errors } = normalizeProxyFailoverSettings(body.proxyFailover);
      if (!ok) return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
      body.proxyFailover = value;
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "comboStrategies")) {
      if (body.comboStrategies !== null && typeof body.comboStrategies === "object" && !Array.isArray(body.comboStrategies)) {
        for (const [comboName, strat] of Object.entries(body.comboStrategies)) {
          if (strat !== null && typeof strat === "object" && !Array.isArray(strat)) {
            if (strat.disableCooldown !== undefined && typeof strat.disableCooldown !== "boolean") {
              return NextResponse.json(
                { error: `Invalid disableCooldown for combo "${comboName}". Must be a boolean.` },
                { status: 400 }
              );
            }
            if (strat.memberCooldownMs !== undefined && strat.memberCooldownMs !== null && strat.memberCooldownMs !== "") {
              if (!isValidMemberCooldown(strat.memberCooldownMs)) {
                return NextResponse.json(
                  { error: `Invalid memberCooldownMs for combo "${comboName}". Must be "disabled", 10s..24h (integer ms), or preset (1m, 5m, 1h).` },
                  { status: 400 }
                );
              }
            }
          } else if (strat !== null && strat !== undefined) {
            return NextResponse.json(
              { error: `Invalid strategy for combo "${comboName}". Must be an object.` },
              { status: 400 }
            );
          }
        }
      } else if (body.comboStrategies !== null && body.comboStrategies !== undefined) {
        return NextResponse.json({ error: "comboStrategies must be an object" }, { status: 400 });
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
      if (body.comboStrategies && typeof body.comboStrategies === "object") {
        for (const [comboName, strat] of Object.entries(body.comboStrategies)) {
          if (strat && isComboCooldownDisabled(strat)) {
            clearComboCooldowns(comboName);
          }
        }
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

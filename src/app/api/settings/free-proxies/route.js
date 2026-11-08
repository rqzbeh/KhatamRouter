// Based on OmniRoute (MIT License): https://github.com/cheaper-inference/OmniRoute/tree/2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac
/**
 * Settings Free Proxies API Route
 *
 * GET: Returns the current free proxy policy and known source identifiers.
 *      Never performs outbound feed fetches or network requests.
 * PUT: Updates the free proxy policy. Requires explicit risk acknowledgment
 *      (acknowledgedRisk: true) to enable any source. Rejects unknown sources.
 *      Persists under the dedicated 'freeProxySources' key without race risk.
 */

import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import {
  DEFAULT_FREE_PROXY_POLICY,
  KNOWN_SOURCES,
  validatePolicyUpdate,
} from "@/lib/freeProxyProviders/index.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const policy = settings?.freeProxySources || DEFAULT_FREE_PROXY_POLICY;
    const syncStats = settings?.freeProxySyncStats || {};

    return NextResponse.json(
      {
        policy,
        sources: KNOWN_SOURCES,
        lastSyncAt: syncStats.lastSyncAt || null,
        lastSyncStats: syncStats.lastSyncStats || null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to load free proxy policy" },
      { status: 500 }
    );
  }
}

export async function PUT(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    const currentPolicy = settings?.freeProxySources || DEFAULT_FREE_PROXY_POLICY;

    const validation = validatePolicyUpdate(currentPolicy, body);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors.join("; ") },
        { status: 400 }
      );
    }

    // Persist only the policy under freeProxySources key
    await updateSettings({ freeProxySources: validation.policy });

    return NextResponse.json({
      success: true,
      policy: validation.policy,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to update free proxy policy" },
      { status: 500 }
    );
  }
}

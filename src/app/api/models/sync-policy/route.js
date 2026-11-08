import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/dashboardGuard";
import {
  getSyncPolicy,
  setSyncPolicy,
  getKnownProviderIds,
  PolicyValidationError,
} from "@/lib/models/providerSync.js";

export const dynamic = "force-dynamic";

async function isAuthorized(request) {
  try {
    const nextReq = request instanceof NextRequest ? request : new NextRequest(request);
    return await isAuthenticated(nextReq);
  } catch {
    return false;
  }
}

/**
 * GET /api/models/sync-policy
 * Returns current auto model sync policy with flat fields, policy object, and known providers.
 */
export async function GET(request) {
  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let policy;
    let knownIds;

    try {
      [policy, knownIds] = await Promise.all([
        getSyncPolicy(),
        getKnownProviderIds(),
      ]);
    } catch (dbErr) {
      console.error("Storage error loading sync policy or providers:", dbErr?.message || dbErr);
      return NextResponse.json(
        { error: "Service unavailable: unable to load provider nodes from storage" },
        { status: 503 }
      );
    }

    return NextResponse.json({
      globalDefault: policy.globalDefault,
      providers: policy.providers,
      intervalMs: policy.intervalMs,
      policy,
      knownProviders: Array.from(knownIds).sort(),
    });
  } catch (error) {
    console.error("Error reading model sync policy:", error?.message || error);
    return NextResponse.json(
      { error: "Failed to read model sync policy" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/models/sync-policy
 * Updates auto model sync policy with strict schema validation.
 * Separates validation errors (400) from storage errors (503).
 */
export async function PUT(request) {
  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    let knownIds;
    try {
      knownIds = await getKnownProviderIds();
    } catch (dbErr) {
      console.error("Storage error resolving known provider ids:", dbErr?.message || dbErr);
      return NextResponse.json(
        { error: "Service unavailable: unable to verify provider nodes from storage" },
        { status: 503 }
      );
    }

    let updated;
    try {
      updated = await setSyncPolicy(body, { knownIds, merge: true });
    } catch (err) {
      if (err instanceof PolicyValidationError || err?.name === "PolicyValidationError" || err instanceof TypeError) {
        return NextResponse.json(
          { error: err?.message || "Invalid policy configuration" },
          { status: 400 }
        );
      }
      console.error("Storage error updating model sync policy:", err?.message || err);
      return NextResponse.json(
        { error: "Service unavailable: failed to persist policy to storage" },
        { status: 503 }
      );
    }

    return NextResponse.json({
      success: true,
      globalDefault: updated.globalDefault,
      providers: updated.providers,
      intervalMs: updated.intervalMs,
      policy: updated,
    });
  } catch (error) {
    console.error("Error updating model sync policy:", error?.message || error);
    return NextResponse.json(
      { error: "Failed to update model sync policy" },
      { status: 500 }
    );
  }
}

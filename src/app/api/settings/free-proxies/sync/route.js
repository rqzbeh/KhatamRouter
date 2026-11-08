// Based on OmniRoute (MIT License): https://github.com/cheaper-inference/OmniRoute/tree/2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac
/**
 * Settings Free Proxies Sync API Route
 *
 * POST: Triggers a bounded feed ingestion cycle for enabled free proxy sources.
 *       Enforces explicit policy risk acknowledgment, streaming limits, DNS guards,
 *       and acquires an immediate SQLite lease to reject concurrent syncs (409 Conflict).
 */

import { NextResponse } from "next/server";
import {
  KNOWN_SOURCES,
  acquireFreeProxySyncLease,
  releaseFreeProxySyncLease,
  runFreeProxySync,
} from "@/lib/freeProxyProviders/index.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let leaseId = null;
  try {
    let body = {};
    try {
      const text = await request.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400 }
      );
    }

    if (body.sources !== undefined) {
      if (!Array.isArray(body.sources)) {
        return NextResponse.json(
          { error: "sources must be an array of source identifiers" },
          { status: 400 }
        );
      }
      for (const s of body.sources) {
        if (!KNOWN_SOURCES.includes(s)) {
          return NextResponse.json(
            { error: `Unknown source '${s}'. Allowed: ${KNOWN_SOURCES.join(", ")}` },
            { status: 400 }
          );
        }
      }
    }

    // Acquire mutual exclusion sync lease
    const leaseResult = await acquireFreeProxySyncLease();
    if (!leaseResult.acquired) {
      return NextResponse.json(
        { error: "A free proxy sync is already in progress. Please retry after it completes." },
        { status: 409 }
      );
    }
    leaseId = leaseResult.leaseId;

    const result = await runFreeProxySync({
      sources: body.sources || null,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error || "Sync aborted",
          added: result.added || 0,
          updated: result.updated || 0,
          skipped: result.skipped || 0,
          failures: result.failures || 0,
          total: result.total || 0,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      failures: result.failures,
      total: result.total,
      message: result.message || undefined,
    });
  } catch {
    return NextResponse.json(
      { error: "Free proxy sync encountered a server error" },
      { status: 500 }
    );
  } finally {
    if (leaseId) {
      await releaseFreeProxySyncLease(leaseId);
    }
  }
}

import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { rotate } from "@/lib/network/psiphon/psiphonManager.js";
import {
  ensureSidecar,
  stopSidecar,
  OpencodeSidecarUnavailableError,
} from "@/lib/network/opencode2api/sidecarManager.js";

// POST /api/proxy-pools/[id]/rotate - Manually rotate psiphon tunnel or opencode2api sidecar
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    if (proxyPool.type === "opencode2api") {
      await stopSidecar(id);
      const result = await ensureSidecar(proxyPool);
      return NextResponse.json({
        generation: result.generation,
        proxyUrl: result.proxyUrl,
      });
    }

    if (proxyPool.type === "psiphon") {
      const result = await rotate(id, { reason: "manual" });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Proxy pool is not a psiphon pool or opencode2api pool" }, { status: 400 });
  } catch (error) {
    console.log("Error rotating proxy pool:", error);
    const status = (error instanceof OpencodeSidecarUnavailableError || error?.name === "OpencodeSidecarUnavailableError" || error?.status)
      ? (error?.status || 503)
      : 500;
    return NextResponse.json({ error: error?.message || "Failed to rotate proxy pool" }, { status });
  }
}

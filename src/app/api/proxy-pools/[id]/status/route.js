import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { getStatus as getPsiphonStatus } from "@/lib/network/psiphon/psiphonManager.js";
import { getStatus as getSidecarStatus } from "@/lib/network/opencode2api/sidecarManager.js";

// GET /api/proxy-pools/[id]/status - Get proxy pool status (psiphon or opencode2api)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    if (proxyPool.type === "opencode2api") {
      const status = getSidecarStatus(id);
      return NextResponse.json({ status });
    }

    if (proxyPool.type === "psiphon") {
      const status = getPsiphonStatus(id);
      return NextResponse.json({ status });
    }

    return NextResponse.json({ error: "Proxy pool is not a psiphon pool or opencode2api pool" }, { status: 400 });
  } catch (error) {
    console.log("Error fetching proxy pool status:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool status" }, { status: 500 });
  }
}

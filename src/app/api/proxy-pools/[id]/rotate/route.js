import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { rotate } from "@/lib/network/psiphon/psiphonManager.js";

// POST /api/proxy-pools/[id]/rotate - Manually rotate psiphon tunnel
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    if (proxyPool.type !== "psiphon") {
      return NextResponse.json({ error: "Proxy pool is not a psiphon pool" }, { status: 400 });
    }

    const result = await rotate(id, { reason: "manual" });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error rotating psiphon tunnel:", error);
    const status = error?.status || 500;
    return NextResponse.json({ error: error?.message || "Failed to rotate psiphon tunnel" }, { status });
  }
}

import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { getStatus } from "@/lib/network/psiphon/psiphonManager.js";

// GET /api/proxy-pools/[id]/status - Get psiphon tunnel status
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    if (proxyPool.type !== "psiphon") {
      return NextResponse.json({ error: "Proxy pool is not a psiphon pool" }, { status: 400 });
    }

    const status = getStatus(id);
    return NextResponse.json({ status });
  } catch (error) {
    console.log("Error fetching psiphon status:", error);
    return NextResponse.json({ error: "Failed to fetch psiphon status" }, { status: 500 });
  }
}

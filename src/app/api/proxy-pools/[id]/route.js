import { NextResponse } from "next/server";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProxyPool,
} from "@/models";
import { stopTunnel } from "@/lib/network/psiphon/psiphonManager.js";
import { VALID_PROXY_TYPES, MANAGED_PSIPHON_URL, normalizePsiphonOptions } from "../types.js";

function normalizeProxyPoolUpdate(body = {}, existing = {}) {
  const updates = {};
  const effectiveType = body?.type !== undefined
    ? (VALID_PROXY_TYPES.includes(body.type) ? body.type : "http")
    : (existing?.type || "http");

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return { error: "Name is required" };
    }
    updates.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
    let proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    if (effectiveType === "psiphon" && !proxyUrl) {
      proxyUrl = MANAGED_PSIPHON_URL;
    } else if (!proxyUrl) {
      return { error: "Proxy URL is required" };
    }
    updates.proxyUrl = proxyUrl;
  }

  if (Object.prototype.hasOwnProperty.call(body, "noProxy")) {
    updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  }

  if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "strictProxy")) {
    updates.strictProxy = effectiveType === "psiphon" ? true : body?.strictProxy === true;
  } else if (effectiveType === "psiphon") {
    updates.strictProxy = true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    updates.type = effectiveType;
  }

  if (Object.prototype.hasOwnProperty.call(body, "psiphon")) {
    if (effectiveType === "psiphon") {
      const psiphonResult = normalizePsiphonOptions(body.psiphon);
      if (!psiphonResult.valid) {
        return { error: psiphonResult.error };
      }
      updates.psiphon = psiphonResult.psiphon;
    }
  }

  return { updates };
}

function countBoundConnections(connections = [], proxyPoolId) {
  return connections.filter((connection) => connection?.providerSpecificData?.proxyPoolId === proxyPoolId).length;
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    return NextResponse.json({ proxyPool });
  } catch (error) {
    console.log("Error fetching proxy pool:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 });
  }
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const normalized = normalizeProxyPoolUpdate(body, existing);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    // Stop tunnel if deactivating or switching away from psiphon
    const isPsiphon = existing.type === "psiphon";
    const willBeInactive = normalized.updates.isActive === false;
    const willChangeType = normalized.updates.type && normalized.updates.type !== "psiphon";

    if (isPsiphon && (willBeInactive || willChangeType)) {
      await stopTunnel(id);
    }

    const updated = await updateProxyPool(id, normalized.updates);
    return NextResponse.json({ proxyPool: updated });
  } catch (error) {
    console.log("Error updating proxy pool:", error);
    return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 });
  }
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const connections = await getProviderConnections();
    const boundConnectionCount = countBoundConnections(connections, id);

    if (boundConnectionCount > 0) {
      return NextResponse.json(
        {
          error: "Proxy pool is currently in use",
          boundConnectionCount,
        },
        { status: 409 }
      );
    }

    // Stop tunnel if psiphon
    if (existing.type === "psiphon") {
      await stopTunnel(id);
    }

    await deleteProxyPool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}

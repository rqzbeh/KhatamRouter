import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  updateProviderConnection,
} from "@/models";
import { validateConnectionLimitOverrides } from "open-sse/services/rateLimitManager/overrides.js";
import { isAuthenticated } from "@/dashboardGuard";

interface RouteParams {
  params: Promise<{ id: string }> | { id: string };
}

async function resolveId(paramsObj: RouteParams["params"]): Promise<string> {
  const resolved = await paramsObj;
  return resolved.id;
}

function ensureRequestWithCookies(request: any) {
  if (request.cookies && typeof request.cookies.get === "function") {
    return request;
  }
  const cookieHeader = request.headers?.get?.("cookie") || "";
  const cookieMap = new Map<string, string>();
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const idx = pair.indexOf("=");
      if (idx !== -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        cookieMap.set(key, decodeURIComponent(val));
      }
    }
  }

  return new Proxy(request, {
    get(target, prop, receiver) {
      if (prop === "cookies") {
        return {
          get: (name: string) => {
            const val = cookieMap.get(name);
            return val !== undefined ? { name, value: val } : undefined;
          },
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * GET /api/providers/[id]/limits
 * Fetch current rate_limit_overrides_json for a connection.
 * Requires dashboard session authentication. Never leaks API keys/credentials.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const guardedRequest = ensureRequestWithCookies(request);
    if (!(await isAuthenticated(guardedRequest))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = await resolveId(params);
    if (!id) {
      return NextResponse.json({ error: "Connection ID is required" }, { status: 400 });
    }

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      connectionId: id,
      limits: connection.rate_limit_overrides_json || {},
    });
  } catch (error) {
    console.error("Error fetching connection limits:", error);
    return NextResponse.json({ error: "Failed to fetch connection limits" }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id]/limits
 * Validates and updates rate_limit_overrides_json for a connection.
 * Requires dashboard session authentication. Never leaks API keys/credentials.
 */
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const guardedRequest = ensureRequestWithCookies(request);
    if (!(await isAuthenticated(guardedRequest))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = await resolveId(params);
    if (!id) {
      return NextResponse.json({ error: "Connection ID is required" }, { status: 400 });
    }

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const limitsInput =
      body && typeof body === "object" && !Array.isArray(body) && "limits" in body
        ? body.limits
        : body;

    const validation = validateConnectionLimitOverrides(limitsInput);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: "Invalid connection limit overrides",
          errors: validation.errors,
        },
        { status: 400 }
      );
    }

    const updated: any = await updateProviderConnection(id, {
      rate_limit_overrides_json: validation.value,
    });

    if (!updated) {
      return NextResponse.json({ error: "Failed to update connection limits" }, { status: 500 });
    }

    return NextResponse.json({
      connectionId: id,
      limits: updated.rate_limit_overrides_json || {},
    });
  } catch (error) {
    console.error("Error updating connection limits:", error);
    return NextResponse.json({ error: "Failed to update connection limits" }, { status: 500 });
  }
}

/**
 * DELETE /api/providers/[id]/limits
 * Resets rate_limit_overrides_json to null for a connection.
 * Requires dashboard session authentication.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const guardedRequest = ensureRequestWithCookies(request);
    if (!(await isAuthenticated(guardedRequest))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = await resolveId(params);
    if (!id) {
      return NextResponse.json({ error: "Connection ID is required" }, { status: 400 });
    }

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const updated = await updateProviderConnection(id, {
      rate_limit_overrides_json: null,
    });

    return NextResponse.json({
      connectionId: id,
      limits: {},
      message: "Connection limits reset successfully",
    });
  } catch (error) {
    console.error("Error resetting connection limits:", error);
    return NextResponse.json({ error: "Failed to reset connection limits" }, { status: 500 });
  }
}

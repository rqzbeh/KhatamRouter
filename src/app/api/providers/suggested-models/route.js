import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { assertGatewayUrlAllowed, fetchGateway, sanitizeGatewayError } from "@/lib/network/gatewayTrust.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  // Pre-validate URL against SSRF and internal addresses before proceeding
  try {
    await assertGatewayUrlAllowed(url, { isSelfHosted: false });
  } catch (err) {
    return NextResponse.json({ error: "URL not allowed: internal or blocked address" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    const res = await fetchGateway(url, {
      signal: AbortSignal.timeout(8000),
    }, { isSelfHosted: false });
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Object-shaped catalogs (minimax-code's {providers:[…]}) ride in as a
    // single-element array so every filter keeps an array input contract.
    const data = filter(Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}

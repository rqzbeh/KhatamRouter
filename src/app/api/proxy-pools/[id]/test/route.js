import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";
import { ensureTunnel } from "@/lib/network/psiphon/psiphonManager.js";
import { probeLatency } from "@/lib/network/psiphon/probe.js";

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    if (proxyPool.type === "psiphon") {
      const startedAt = Date.now();
      try {
        const tunnel = await ensureTunnel(proxyPool);
        const probeRes = await probeLatency(tunnel.proxyUrl);
        const ok = probeRes.ok;
        const latency = probeRes.latency !== Infinity ? probeRes.latency : Math.max(1, Date.now() - startedAt);
        const now = new Date().toISOString();

        await updateProxyPool(id, {
          testStatus: ok ? "active" : "error",
          lastTestedAt: now,
          lastError: ok ? null : (probeRes.error || "Proxy connectivity probe failed"),
          isActive: ok,
        });

        return NextResponse.json({
          ok,
          status: ok ? 200 : (probeRes.status || 500),
          statusText: ok ? "OK" : null,
          error: ok ? null : (probeRes.error || "Probe failed"),
          elapsedMs: latency,
          testedAt: now,
          region: tunnel.region || null,
          latency,
          exitIp: tunnel.exitIp || null,
        });
      } catch (err) {
        const now = new Date().toISOString();
        const errorMessage = err?.message || String(err);
        await updateProxyPool(id, {
          testStatus: "error",
          lastTestedAt: now,
          lastError: errorMessage,
          isActive: false,
        });
        return NextResponse.json({
          ok: false,
          status: err?.status || 500,
          error: errorMessage,
          elapsedMs: Date.now() - startedAt,
          testedAt: now,
          region: null,
          latency: null,
          exitIp: null,
        });
      }
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}

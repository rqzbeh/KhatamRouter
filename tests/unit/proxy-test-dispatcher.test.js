/**
 * Regression: a dead proxy must fail a pool test.
 *
 * `testProxyUrl` used to import bare `undici`, which under Bun resolves to a
 * native fetch stub that accepts `dispatcher` and ignores it. Every health
 * test therefore passed by going out on the host socket — a free proxy that
 * could not open a CONNECT tunnel reported "active", and a request routed
 * through it then died in proxyFetch. The unit under test is fixed at
 * `src/lib/network/proxyTest.js` via `undiciRuntime.loadRealUndici()`.
 */

import { describe, it, expect } from "vitest";
import { testProxyUrl } from "@/lib/network/proxyTest.js";
import {
  loadRealUndici,
  fetchHonorsDispatcher,
  __resetRealUndiciForTests,
} from "@/lib/network/undiciRuntime.js";

describe("proxyTest honors the proxy dispatcher", () => {
  it("resolves a fetch that honors dispatcher (not the Bun native stub)", async () => {
    __resetRealUndiciForTests();
    const real = await loadRealUndici();
    expect(typeof real.fetch).toBe("function");
    expect(typeof real.ProxyAgent).toBe("function");
    expect(fetchHonorsDispatcher(real.fetch)).toBe(true);
    __resetRealUndiciForTests();
  });

  it("fails a proxy that cannot open a tunnel", async () => {
    const result = await testProxyUrl({
      proxyUrl: "http://127.0.0.1:1",
      testUrl: "https://example.com/",
      timeoutMs: 4000,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  }, 20000);

  it("rejects a syntactically invalid proxy URL before dialing", async () => {
    const result = await testProxyUrl({ proxyUrl: "not a url" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});
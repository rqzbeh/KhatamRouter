import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let storedSettings = {
  requireApiKey: false,
  providerStrategies: {
    opencode: { rotateStrategy: "round-robin" },
  },
  proxyHealth: {
    enabled: true,
    cooldownMs: 300000,
    probeEnabled: false,
    probeIntervalMs: 300000,
    statuses: [403, 429, 451, 502, 503, 504],
    maxRetries: 0,
  },
  proxyFailover: {
    enabled: false,
    mode: "none",
    maxRetries: 0,
    strategy: "round-robin",
  },
};

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ ...storedSettings }),
  updateSettings: async (patch) => {
    storedSettings = { ...storedSettings, ...patch };
    return { ...storedSettings };
  },
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");
const { default: NoAuthProxyCard } = await import("../../src/shared/components/NoAuthProxyCard.js");

function makePatchReq(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  storedSettings = {
    requireApiKey: false,
    providerStrategies: {
      opencode: { rotateStrategy: "round-robin" },
    },
    proxyHealth: {
      enabled: true,
      cooldownMs: 300000,
      probeEnabled: false,
      probeIntervalMs: 300000,
      statuses: [403, 429, 451, 502, 503, 504],
      maxRetries: 0,
    },
    proxyFailover: {
      enabled: false,
      mode: "none",
      maxRetries: 0,
      strategy: "round-robin",
    },
  };
});

describe("Settings API: Proxy Failover Save/Reopen & Strict Validation", () => {
  it("persists none, custom (1, 5, 10, 20), and all modes across save and GET reopen", async () => {
    // 1. Save custom 5
    const res1 = await PATCH(makePatchReq({ proxyFailover: { enabled: true, mode: "custom", maxRetries: 5 } }));
    expect(res1.status).toBe(200);
    const get1 = await (await GET()).json();
    expect(get1.proxyFailover).toMatchObject({ enabled: true, mode: "custom", maxRetries: 5 });

    // 2. Save custom 10
    const res2 = await PATCH(makePatchReq({ proxyFailover: { enabled: true, mode: "custom", maxRetries: 10 } }));
    expect(res2.status).toBe(200);
    const get2 = await (await GET()).json();
    expect(get2.proxyFailover).toMatchObject({ enabled: true, mode: "custom", maxRetries: 10 });

    // 3. Save custom 1 and 20
    const res3 = await PATCH(makePatchReq({ proxyFailover: { mode: "custom", maxRetries: 1 } }));
    expect(res3.status).toBe(200);
    expect((await (await GET()).json()).proxyFailover.maxRetries).toBe(1);

    const res4 = await PATCH(makePatchReq({ proxyFailover: { mode: "custom", maxRetries: 20 } }));
    expect(res4.status).toBe(200);
    expect((await (await GET()).json()).proxyFailover.maxRetries).toBe(20);

    // 4. Save all
    const resAll = await PATCH(makePatchReq({ proxyFailover: { enabled: true, mode: "all", maxRetries: "all" } }));
    expect(resAll.status).toBe(200);
    const getAll = await (await GET()).json();
    expect(getAll.proxyFailover).toMatchObject({ enabled: true, mode: "all", maxRetries: "all" });

    // 5. Save none
    const resNone = await PATCH(makePatchReq({ proxyFailover: { enabled: false, mode: "none", maxRetries: 0 } }));
    expect(resNone.status).toBe(200);
    const getNone = await (await GET()).json();
    expect(getNone.proxyFailover).toMatchObject({ enabled: false, mode: "none", maxRetries: 0 });
  });

  it.each([
    [{ proxyFailover: { maxRetries: -1 } }],
    [{ proxyFailover: { maxRetries: 3.5 } }],
    [{ proxyFailover: { maxRetries: "5" } }],
    [{ proxyFailover: { maxRetries: "off" } }],
    [{ proxyFailover: { maxRetries: "2.5" } }],
    [{ proxyFailover: { maxRetries: "abc" } }],
    [{ proxyFailover: { mode: "custom" } }],
    [{ proxyFailover: { mode: "infinite" } }],
    [{ proxyFailover: { enabled: true, maxRetries: 0 } }],
  ])("rejects invalid payload %j with 400", async (payload) => {
    const res = await PATCH(makePatchReq(payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("validates combo memberCooldownMs using isValidMemberCooldown including disabled", async () => {
    const validRes = await PATCH(makePatchReq({ comboStrategies: { mycombo: { memberCooldownMs: "disabled" } } }));
    expect(validRes.status).toBe(200);

    const badRes = await PATCH(makePatchReq({ comboStrategies: { mycombo: { memberCooldownMs: "bad-value" } } }));
    expect(badRes.status).toBe(400);
    const errBody = await badRes.json();
    expect(errBody.error).toContain("disabled");
  });
});

describe("UI: NoAuthProxyCard Failover Modes", () => {
  it("renders none/custom/all failover mode selector and custom integer input when rotation active", async () => {
    const origFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method || "GET", body: opts?.body });
      if (url === "/api/proxy-pools") {
        return new Response(
          JSON.stringify({
            proxyPools: [
              { id: "p1", name: "Pool 1", isActive: true },
              { id: "p2", name: "Pool 2", isActive: true },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === "/api/settings" && (!opts || opts.method !== "PATCH")) {
        return new Response(JSON.stringify(storedSettings), { status: 200 });
      }
      if (url === "/api/settings" && opts?.method === "PATCH") {
        const parsed = JSON.parse(opts.body);
        storedSettings = { ...storedSettings, ...parsed };
        return new Response(JSON.stringify(storedSettings), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    try {
      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(NoAuthProxyCard, { providerId: "opencode" }));
      });
      await act(async () => {});

      const modeSelect = renderer.root.findByProps({ id: "proxy-failover-mode" });
      expect(modeSelect.props.value).toBe("none");

      // Switch to custom mode
      await act(async () => {
        await modeSelect.props.onChange({ target: { value: "custom" } });
      });

      const customInput = renderer.root.findByProps({ id: "proxy-failover-custom" });
      expect(customInput.props.value).toBe("5");

      // Update custom integer to 7
      await act(async () => {
        await customInput.props.onChange({ target: { value: "7" } });
      });

      expect(storedSettings.proxyFailover).toMatchObject({ enabled: true, mode: "custom", maxRetries: 7 });

      // Switch to all mode
      await act(async () => {
        await modeSelect.props.onChange({ target: { value: "all" } });
      });
      expect(storedSettings.proxyFailover).toMatchObject({ enabled: true, mode: "all", maxRetries: "all" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

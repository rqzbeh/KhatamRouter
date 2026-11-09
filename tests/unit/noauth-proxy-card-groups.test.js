import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import ReactTestRenderer from "react-test-renderer";
import NoAuthProxyCard from "@/shared/components/NoAuthProxyCard.js";

const { act } = ReactTestRenderer;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("NoAuthProxyCard Optgroup Grouping & Managed Actions", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("1. Rendered card contains an <optgroup> labelled exactly '1proxy (free feed)' holding the two free:oneproxy pools, and the psiphon/opencode2api/WARP groups in that relative order above 'Manual / relay pools'", async () => {
    const fixturePools = [
      { id: "pool-manual", name: "Manual Pool 1", type: "http", isActive: true },
      {
        id: "pool-op1",
        name: "1proxy Alpha",
        provenance: { source: "free:oneproxy" },
        isActive: true,
      },
      {
        id: "pool-op2",
        name: "1proxy Beta",
        provenance: { source: "free:oneproxy" },
        isActive: true,
      },
      { id: "pool-psi", name: "Psiphon Pool", type: "psiphon", isActive: true },
      { id: "pool-warp", name: "WARP Pool", type: "opencode2api", isActive: true },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/api/proxy-pools")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: fixturePools }),
        });
      }
      if (u.endsWith("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "none", proxyPoolId: "__none__" },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    const optgroups = renderer.root.findAllByType("optgroup");
    const labels = optgroups.map((g) => g.props.label);

    expect(labels).toContain("1proxy (free feed)");

    const oneproxyGroup = optgroups.find((g) => g.props.label === "1proxy (free feed)");
    expect(oneproxyGroup).toBeDefined();

    const oneproxyOptions = oneproxyGroup.findAllByType("option");
    expect(oneproxyOptions).toHaveLength(2);
    expect(oneproxyOptions.map((o) => o.props.value)).toEqual(["pool-op1", "pool-op2"]);

    const idxPsiphon = labels.indexOf("Psiphon rotating tunnel");
    const idxWarp = labels.indexOf("WARP rotating egress (opencode2api)");
    const idxOneproxy = labels.indexOf("1proxy (free feed)");
    const idxManual = labels.indexOf("Manual / relay pools");

    expect(idxPsiphon).toBeGreaterThanOrEqual(0);
    expect(idxWarp).toBeGreaterThan(idxPsiphon);
    expect(idxManual).toBeGreaterThan(idxWarp);
    expect(idxManual).toBeGreaterThan(idxOneproxy);
  });

  it("2. A pool with isActive: false is labelled with the ' — inactive' suffix; an active one is not", async () => {
    const fixturePools = [
      {
        id: "pool-active",
        name: "Active Oneproxy Pool",
        provenance: { source: "free:oneproxy" },
        isActive: true,
      },
      {
        id: "pool-inactive",
        name: "Inactive Oneproxy Pool",
        provenance: { source: "free:oneproxy" },
        isActive: false,
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/api/proxy-pools")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: fixturePools }),
        });
      }
      if (u.endsWith("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "none" },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    const options = renderer.root.findAllByType("option");
    const activeOption = options.find((o) => o.props.value === "pool-active");
    const inactiveOption = options.find((o) => o.props.value === "pool-inactive");

    expect(activeOption).toBeDefined();
    expect(inactiveOption).toBeDefined();

    const activeText = Array.isArray(activeOption.props.children)
      ? activeOption.props.children.join("")
      : String(activeOption.props.children);
    const inactiveText = Array.isArray(inactiveOption.props.children)
      ? inactiveOption.props.children.join("")
      : String(inactiveOption.props.children);

    expect(activeText).toBe("Active Oneproxy Pool");
    expect(activeText.endsWith(" — inactive")).toBe(false);

    expect(inactiveText).toBe("Inactive Oneproxy Pool — inactive");
    expect(inactiveText.endsWith(" — inactive")).toBe(true);
  });

  it("3. With zero WARP pools, the opencode2api group still exists and contains a single option with value '__create_warp__'", async () => {
    const fixturePools = [
      {
        id: "pool-op1",
        name: "1proxy Pool",
        provenance: { source: "free:oneproxy" },
        isActive: true,
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/api/proxy-pools")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: fixturePools }),
        });
      }
      if (u.endsWith("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "none" },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    const optgroups = renderer.root.findAllByType("optgroup");
    const warpGroup = optgroups.find(
      (g) => g.props.label === "WARP rotating egress (opencode2api)"
    );
    expect(warpGroup).toBeDefined();

    const options = warpGroup.findAllByType("option");
    expect(options).toHaveLength(1);
    expect(options[0].props.value).toBe("__create_warp__");
  });

  it("4. Picking that '__create_warp__' option (invoke the select's onChange inside act) POSTs /api/proxy-pools with {name:'WARP (managed)',type:'opencode2api'}, then calls /api/proxy-pools/{newId}/test, then PUTs /api/settings — assert the fetch call URLs/methods in order", async () => {
    const initialPools = [];
    const createdPool = {
      id: "warp-new-123",
      name: "WARP (managed)",
      type: "opencode2api",
      isActive: true,
    };
    const calls = [];

    globalThis.fetch = vi.fn().mockImplementation((url, opts = {}) => {
      const method = opts.method || "GET";
      const u = String(url);
      calls.push({
        url: u,
        method,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });

      if (u.endsWith("/api/proxy-pools") && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: calls.length > 2 ? [createdPool] : initialPools }),
        });
      }
      if (u.endsWith("/api/settings") && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "none" },
            },
          }),
        });
      }
      if (u.endsWith("/api/proxy-pools") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPool: createdPool }),
        });
      }
      if (u.endsWith(`/api/proxy-pools/${createdPool.id}/test`) && (method === "PUT" || method === "POST")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, message: "connected" }),
        });
      }
      if (u.endsWith("/api/settings") && (method === "PATCH" || method === "PUT")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    // Clear mount calls tracking to focus on the change action
    calls.length = 0;

    const [poolSelect] = renderer.root.findAllByType("select");
    await act(async () => {
      await poolSelect.props.onChange({ target: { value: "__create_warp__" } });
    });

    // Verify calls in order:
    // 1. POST /api/proxy-pools { name: "WARP (managed)", type: "opencode2api" }
    // 2. PUT /api/proxy-pools/warp-new-123/test
    // 3. GET /api/proxy-pools (refetch)
    // 4. GET /api/settings (inside save)
    // 5. PATCH (or PUT) /api/settings (inside save)
    expect(calls.length).toBeGreaterThanOrEqual(5);

    const postCreate = calls[0];
    expect(postCreate.method).toBe("POST");
    expect(postCreate.url).toBe("/api/proxy-pools");
    expect(postCreate.body).toEqual({
      name: "WARP (managed)",
      type: "opencode2api",
    });

    const testCall = calls[1];
    expect(testCall.method).toBe("PUT");
    expect(testCall.url).toBe(`/api/proxy-pools/${createdPool.id}/test`);

    const refetchPools = calls[2];
    expect(refetchPools.method).toBe("GET");
    expect(refetchPools.url).toBe("/api/proxy-pools");

    const getSettings = calls[3];
    expect(getSettings.method).toBe("GET");
    expect(getSettings.url).toBe("/api/settings");

    const saveSettings = calls[4];
    expect(["PUT", "PATCH"]).toContain(saveSettings.method);
    expect(saveSettings.url).toBe("/api/settings");
    expect(saveSettings.body).toEqual({
      providerStrategies: {
        opencode: { proxyPoolId: createdPool.id },
      },
    });
  });

  it("5. Picking an inactive pool fires a PUT to /api/proxy-pools/{id} with {isActive:true}", async () => {
    const inactivePool = {
      id: "pool-inactive-99",
      name: "Inactive Pool",
      type: "http",
      isActive: false,
    };
    const calls = [];

    globalThis.fetch = vi.fn().mockImplementation((url, opts = {}) => {
      const method = opts.method || "GET";
      const u = String(url);
      calls.push({
        url: u,
        method,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });

      if (u.endsWith("/api/proxy-pools") && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: [inactivePool] }),
        });
      }
      if (u.endsWith("/api/settings") && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "none" },
            },
          }),
        });
      }
      if (u.endsWith(`/api/proxy-pools/${inactivePool.id}`) && (method === "PUT" || method === "PATCH")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, proxyPool: { ...inactivePool, isActive: true } }),
        });
      }
      if (u.endsWith("/api/settings") && (method === "PATCH" || method === "PUT")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    calls.length = 0;

    const [poolSelect] = renderer.root.findAllByType("select");
    await act(async () => {
      await poolSelect.props.onChange({ target: { value: inactivePool.id } });
    });

    const putActivation = calls.find(
      (c) =>
        c.url.endsWith(`/api/proxy-pools/${inactivePool.id}`) &&
        c.method === "PUT"
    );
    expect(putActivation).toBeDefined();
    expect(putActivation.body).toEqual({ isActive: true });
  });

  it("6. With rotation strategy saved as 'round-robin', the select is rendered disabled", async () => {
    const fixturePools = [
      { id: "pool-1", name: "Pool 1", type: "http", isActive: true },
      { id: "pool-2", name: "Pool 2", type: "http", isActive: true },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/api/proxy-pools")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ proxyPools: fixturePools }),
        });
      }
      if (u.endsWith("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providerStrategies: {
              opencode: { rotateStrategy: "round-robin", proxyPoolId: "pool-1" },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(NoAuthProxyCard, { providerId: "opencode" })
      );
    });

    const selects = renderer.root.findAllByType("select");
    // The pool selector is the first select in the component
    const poolSelect = selects[0];
    expect(poolSelect).toBeDefined();
    expect(poolSelect.props.disabled).toBe(true);
  });
});

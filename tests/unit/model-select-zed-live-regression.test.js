import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import ReactTestRenderer, { act } from "react-test-renderer";
import ModelSelectModal, { groupModelsByProvider, useLiveProviderModels } from "@/shared/components/ModelSelectModal.js";

// Ensure React act() is enabled for tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveProviderModels lifecycle & error handling", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function HookTester({ isOpen, connectionIds, label, onResult }) {
    const result = useLiveProviderModels(isOpen, connectionIds, label);
    onResult(result);
    return null;
  }

  it("synchronously clears state on open generation without leaking previous cached models on reopen", async () => {
    let currentResult;
    let resolveFetch;
    globalThis.fetch = () => new Promise((resolve) => {
      resolveFetch = resolve;
    });

    let renderer;
    // 1. Initial render: isOpen: false
    act(() => {
      renderer = ReactTestRenderer.create(
        React.createElement(HookTester, {
          isOpen: false,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });
    expect(currentResult.status).toBe("empty");
    expect(currentResult.models).toHaveLength(0);

    // 2. Open modal (Generation 1): should be loading immediately
    act(() => {
      renderer.update(
        React.createElement(HookTester, {
          isOpen: true,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });
    expect(currentResult.status).toBe("loading");
    expect(currentResult.models).toHaveLength(0);

    // Resolve fetch for Generation 1
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ models: [{ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }] }),
      });
    });
    expect(currentResult.status).toBe("ready");
    expect(currentResult.models).toHaveLength(1);
    expect(currentResult.models[0].id).toBe("claude-3-7-sonnet");

    // 3. Close modal
    act(() => {
      renderer.update(
        React.createElement(HookTester, {
          isOpen: false,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });
    expect(currentResult.status).toBe("empty");
    expect(currentResult.models).toHaveLength(0);

    // 4. Reopen modal with the SAME connectionIds (Generation 2):
    // Must synchronously return loading with 0 models, NOT previous cached models!
    let resolveSecondFetch;
    globalThis.fetch = () => new Promise((resolve) => {
      resolveSecondFetch = resolve;
    });

    act(() => {
      renderer.update(
        React.createElement(HookTester, {
          isOpen: true,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });
    // Strict requirement: synchronously clean state on generation
    expect(currentResult.status).toBe("loading");
    expect(currentResult.models).toHaveLength(0);

    // Complete second fetch
    await act(async () => {
      resolveSecondFetch({
        ok: true,
        json: async () => ({ models: [{ id: "gpt-4o", name: "GPT-4o" }] }),
      });
    });
    expect(currentResult.status).toBe("ready");
    expect(currentResult.models).toHaveLength(1);
    expect(currentResult.models[0].id).toBe("gpt-4o");
  });

  it("treats 200 with warning and models:[] as error rather than hiding discovery failure as empty", async () => {
    let currentResult;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        models: [],
        warning: "Failed to fetch Zed models: 500 error",
      }),
    });

    await act(async () => {
      ReactTestRenderer.create(
        React.createElement(HookTester, {
          isOpen: true,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });

    expect(currentResult.status).toBe("error");
    expect(currentResult.models).toHaveLength(0);
    expect(currentResult.hasWarning).toBe(true);
    expect(currentResult.warning).toContain("Unable to discover models");
  });

  it("treats malformed or non-array models response as error", async () => {
    let currentResult;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        models: "invalid-string-not-an-array",
      }),
    });

    await act(async () => {
      ReactTestRenderer.create(
        React.createElement(HookTester, {
          isOpen: true,
          connectionIds: ["zed_1"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });

    expect(currentResult.status).toBe("error");
    expect(currentResult.models).toHaveLength(0);
  });

  it("retains successful models with generic warning on partial failures across multiple connections", async () => {
    let currentResult;
    globalThis.fetch = async (url) => {
      if (String(url).includes("conn_good")) {
        return {
          ok: true,
          json: async () => ({ models: [{ id: "model-good", name: "Good Model" }] }),
        };
      }
      return {
        ok: false,
        status: 500,
      };
    };

    await act(async () => {
      ReactTestRenderer.create(
        React.createElement(HookTester, {
          isOpen: true,
          connectionIds: ["conn_good", "conn_bad"],
          label: "Zed",
          onResult: (r) => { currentResult = r; },
        })
      );
    });

    expect(currentResult.status).toBe("ready");
    expect(currentResult.models).toHaveLength(1);
    expect(currentResult.models[0].id).toBe("model-good");
    expect(currentResult.hasWarning).toBe(true);
    expect(currentResult.warning).toContain("Partial model discovery");
  });
});

describe("ModelSelectModal component lifecycle rendering", () => {
  let originalFetch;
  let originalDocument;
  let originalWindow;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;

    globalThis.document = {
      body: { style: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  it("renders non-button status placeholder when connected live provider has 0 models", async () => {
    // Mock /api/providers and models route
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/providers/") && u.includes("/models")) {
        return {
          ok: true,
          json: async () => ({ models: [], warning: "Discovery warning" }),
        };
      }
      if (u.includes("/api/providers")) {
        return {
          ok: true,
          json: async () => ({
            connections: [{ id: "conn_zed_1", provider: "zed", isActive: true }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    let renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(ModelSelectModal, {
          isOpen: true,
          onClose: () => {},
          onSelect: () => {},
          activeProviders: [{ id: "conn_zed_1", provider: "zed", isActive: true }],
        })
      );
    });

    // Check rendered tree
    const root = renderer.root;
    const textNodes = root.findAll((el) => typeof el.children?.[0] === "string");
    const zedHeader = textNodes.find((el) => el.children[0] === "Zed");
    expect(zedHeader).toBeDefined();

    // Verify non-button status display exists
    const statusBox = textNodes.find((el) =>
      typeof el.children[0] === "string" && el.children[0].includes("Unable to discover models")
    );
    expect(statusBox).toBeDefined();
    // Verify it is NOT a button
    expect(statusBox.type).not.toBe("button");
  });
});

describe("groupModelsByProvider: Zed and passthrough live catalog regression", () => {
  const zedConnection = { id: "conn_zed_1", provider: "zed", isActive: true };
  const mockZedLiveModels = [
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    { id: "gpt-4o", name: "GPT-4o" },
  ];

  it("reproduces and fixes missing Zed in model selector when live models are present", () => {
    const groups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: mockZedLiveModels,
      },
    });

    expect(groups.zed).toBeDefined();
    expect(groups.zed.name).toBe("Zed");
    expect(groups.zed.alias).toBe("zd");
    expect(groups.zed.models).toHaveLength(2);
    expect(groups.zed.liveStatus).toBe("ready");
    expect(groups.zed.models[0]).toEqual({
      id: "claude-3-7-sonnet",
      name: "Claude 3.7 Sonnet",
      value: "zd/claude-3-7-sonnet",
      kind: null,
    });
    expect(groups.zed.models[1]).toEqual({
      id: "gpt-4o",
      name: "GPT-4o",
      value: "zd/gpt-4o",
      kind: null,
    });
  });

  it("retains connected Zed provider card with zero selectable models during loading, empty, and error states", () => {
    // 1. Loading state
    const loadingGroups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: { models: [], status: "loading" },
      },
    });
    expect(loadingGroups.zed).toBeDefined();
    expect(loadingGroups.zed.name).toBe("Zed");
    expect(loadingGroups.zed.models).toHaveLength(0);
    expect(loadingGroups.zed.liveStatus).toBe("loading");

    // 2. Empty state
    const emptyGroups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: { models: [], status: "empty" },
      },
    });
    expect(emptyGroups.zed).toBeDefined();
    expect(emptyGroups.zed.name).toBe("Zed");
    expect(emptyGroups.zed.models).toHaveLength(0);
    expect(emptyGroups.zed.liveStatus).toBe("empty");

    // 3. Error state with warning
    const errorGroups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: { models: [], status: "error", warning: "Discovery failure" },
      },
    });
    expect(errorGroups.zed).toBeDefined();
    expect(errorGroups.zed.models).toHaveLength(0);
    expect(errorGroups.zed.liveStatus).toBe("error");
    expect(errorGroups.zed.liveWarning).toBe("Discovery failure");
  });

  it("distinguishes all-disabled models from upstream empty/error states", () => {
    const groups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: mockZedLiveModels,
      },
      disabledModels: {
        zed: ["claude-3-7-sonnet", "gpt-4o"],
      },
    });

    expect(groups.zed).toBeUndefined();
  });

  it("filters out partially disabled models for Zed using providerId or alias key", () => {
    const groups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      liveModelsByProvider: {
        zed: mockZedLiveModels,
      },
      disabledModels: {
        zd: ["claude-3-7-sonnet"],
      },
    });

    expect(groups.zed).toBeDefined();
    expect(groups.zed.models).toHaveLength(1);
    expect(groups.zed.models[0].id).toBe("gpt-4o");
  });

  it("excludes inactive Zed connection even if live models are provided", () => {
    const groups = groupModelsByProvider({
      filteredActiveProviders: [],
      deactivatedProviderIds: new Set(["zed"]),
      liveModelsByProvider: {
        zed: mockZedLiveModels,
      },
    });

    expect(groups.zed).toBeUndefined();
  });

  it("deduplicates custom models with same ID so custom model takes precedence without duplicate entries", () => {
    const customModels = [
      {
        id: "claude-3-7-sonnet",
        name: "Custom Claude 3.7",
        providerAlias: "zd",
      },
    ];

    const groups = groupModelsByProvider({
      filteredActiveProviders: [zedConnection],
      customModels,
      liveModelsByProvider: {
        zed: mockZedLiveModels,
      },
    });

    expect(groups.zed).toBeDefined();
    expect(groups.zed.models).toHaveLength(2);
    const customEntry = groups.zed.models.find((m) => m.id === "claude-3-7-sonnet");
    expect(customEntry).toBeDefined();
    expect(customEntry.name).toBe("Custom Claude 3.7");
    expect(customEntry.isCustom).toBe(true);
    expect(customEntry.value).toBe("zd/claude-3-7-sonnet");

    const values = groups.zed.models.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("generalizes to Cline as a second live passthrough provider (passthroughModels: true)", () => {
    const clineConnection = { id: "conn_cline_1", provider: "cline", isActive: true };
    const liveClineModels = [
      { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet (Live)" },
    ];

    const groupsWithLive = groupModelsByProvider({
      filteredActiveProviders: [clineConnection],
      liveModelsByProvider: {
        cline: liveClineModels,
      },
    });
    expect(groupsWithLive.cline).toBeDefined();
    expect(groupsWithLive.cline.models.some((m) => m.id === "anthropic/claude-3.7-sonnet")).toBe(true);

    const groupsWithFallback = groupModelsByProvider({
      filteredActiveProviders: [clineConnection],
      liveModelsByProvider: {
        cline: { models: [], status: "empty" },
      },
    });
    expect(groupsWithFallback.cline).toBeDefined();
    expect(groupsWithFallback.cline.models.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves ordinary live provider behavior (Cursor, passthroughModels: false)", () => {
    const cursorConnection = { id: "conn_cursor_1", provider: "cursor", isActive: true };
    const liveCursorModels = [
      { id: "cursor-fast-model", name: "Cursor Fast Model" },
    ];

    const groups = groupModelsByProvider({
      filteredActiveProviders: [cursorConnection],
      liveModelsByProvider: {
        cursor: liveCursorModels,
      },
    });
    expect(groups.cursor).toBeDefined();
    expect(groups.cursor.models.some((m) => m.id === "cursor-fast-model")).toBe(true);

    const cursorLoading = groupModelsByProvider({
      filteredActiveProviders: [cursorConnection],
      liveModelsByProvider: {
        cursor: { models: [], status: "loading" },
      },
    });
    expect(cursorLoading.cursor).toBeDefined();
  });

  it("preserves custom OpenAI-compatible gateway control provider behavior", () => {
    const customNode = {
      id: "openai-compatible-mygateway",
      name: "My Local Gateway",
      baseUrl: "http://127.0.0.1:11434/v1",
      prefix: "ollama",
    };
    const customConn = {
      id: "conn_custom_1",
      provider: "openai-compatible-mygateway",
      isActive: true,
      name: "My Local Gateway",
      providerSpecificData: { prefix: "ollama" },
    };

    const groups = groupModelsByProvider({
      filteredActiveProviders: [customConn],
      effectiveConnections: [customConn],
      providerNodes: [customNode],
      modelAliases: {
        "mistral-7b": "openai-compatible-mygateway/mistral-7b",
      },
    });

    expect(groups["openai-compatible-mygateway"]).toBeDefined();
    expect(groups["openai-compatible-mygateway"].alias).toBe("ollama");
    expect(groups["openai-compatible-mygateway"].models[0]).toEqual({
      id: "mistral-7b",
      name: "mistral-7b",
      value: "ollama/mistral-7b",
    });
  });
});

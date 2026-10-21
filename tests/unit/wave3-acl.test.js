import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
    { id: "c2", name: "Fast", models: ["openai/model-a"] },
    { id: "c3", name: "other", models: ["openai/model-c"] },
  ],
  nodes: [
    { id: "openai-compatible-chat-n1", type: "openai-compatible", prefix: "mock", name: "Mock Node" },
    {
      id: "openai-compatible-chat-8b5e9123-1234-4321-8765-abcdef123456",
      type: "openai-compatible",
      prefix: "localai",
      name: "UUID Node",
    },
  ],
  aliases: {
    fast: "openai/model-a",
    bee: "openai/model-b",
  },
  keys: {},
  settings: { requireApiKey: false },
}));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => fx.aliases,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async (filter = {}) =>
    fx.nodes.filter((n) => !filter.type || n.type === filter.type),
  getCombos: async () => fx.combos,
  getSettings: async () => fx.settings,
  getCustomModels: async () => [],
  getProviderConnections: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (k) => fx.keys[k] || null,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  maskKey: (k) => k,
}));

// Import target modules
const internalTrust = await import("../../src/sse/services/internalTrust.js");
const allowedModels = await import("../../src/sse/services/allowedModels.js");
const keyAccess = await import("../../src/sse/services/keyAccess.js");
const modelService = await import("../../src/sse/services/model.js");

describe("Wave 3 — Internal Trust Service", () => {
  let validToken;

  beforeEach(async () => {
    internalTrust.resetInternalTrustCache();
    validToken = await getConsistentMachineId("9r-cli-auth");
  });

  it("valid machine token passes timing-safe comparison", async () => {
    expect(validToken).toMatch(/^[0-9a-f]{16}$/i);
    expect(await internalTrust.verifyInternalToken(validToken)).toBe(true);
    // Case-insensitivity test
    expect(await internalTrust.verifyInternalToken(validToken.toUpperCase())).toBe(true);
  });

  it("wrong token with correct 16-hex length fails closed", async () => {
    const wrongToken = validToken[0] === "a" ? `b${validToken.slice(1)}` : `a${validToken.slice(1)}`;
    expect(wrongToken.length).toBe(16);
    expect(await internalTrust.verifyInternalToken(wrongToken)).toBe(false);
  });

  it("wrong-length tokens fail closed without throwing", async () => {
    // Shorter lengths (must not throw in crypto.timingSafeEqual)
    expect(await internalTrust.verifyInternalToken("")).toBe(false);
    expect(await internalTrust.verifyInternalToken("a")).toBe(false);
    expect(await internalTrust.verifyInternalToken(validToken.slice(0, 15))).toBe(false);
    // Longer lengths
    expect(await internalTrust.verifyInternalToken(`${validToken}0`)).toBe(false);
    expect(await internalTrust.verifyInternalToken(`${validToken}${validToken}`)).toBe(false);
    expect(await internalTrust.verifyInternalToken("0123456789abcdef0123456789abcdef")).toBe(false);
  });

  it("malformed hex strings fail closed without throwing", async () => {
    expect(await internalTrust.verifyInternalToken("zzzzzzzzzzzzzzzz")).toBe(false);
    expect(await internalTrust.verifyInternalToken("123456789012345g")).toBe(false);
    expect(await internalTrust.verifyInternalToken("                ")).toBe(false);
    expect(await internalTrust.verifyInternalToken(null)).toBe(false);
    expect(await internalTrust.verifyInternalToken(undefined)).toBe(false);
    expect(await internalTrust.verifyInternalToken(1234567890123456)).toBe(false);
    expect(await internalTrust.verifyInternalToken({})).toBe(false);
  });

  it("memoizes expected token across multiple calls", async () => {
    const t1 = await internalTrust.getExpectedInternalToken();
    const t2 = await internalTrust.getExpectedInternalToken();
    expect(t1).toBe(validToken);
    expect(t1).toBe(t2);
  });

  it("isTrustedInternalRequest correctly reads headers and validates", async () => {
    // Web Request with valid header
    const validReq = new Request("http://localhost/v1/chat/completions", {
      headers: { "x-9r-cli-token": validToken },
    });
    expect(await internalTrust.isTrustedInternalRequest(validReq)).toBe(true);

    // Uppercase header name
    const upperReq = new Request("http://localhost/v1/chat/completions", {
      headers: { "X-9R-CLI-TOKEN": validToken },
    });
    expect(await internalTrust.isTrustedInternalRequest(upperReq)).toBe(true);

    // Invalid token header
    const badReq = new Request("http://localhost/v1/chat/completions", {
      headers: { "x-9r-cli-token": "wrong-token" },
    });
    expect(await internalTrust.isTrustedInternalRequest(badReq)).toBe(false);

    // Missing header
    const noReq = new Request("http://localhost/v1/chat/completions");
    expect(await internalTrust.isTrustedInternalRequest(noReq)).toBe(false);

    // Plain object headers
    expect(await internalTrust.isTrustedInternalRequest({ headers: { "x-9r-cli-token": validToken } })).toBe(true);
    expect(await internalTrust.isTrustedInternalRequest(null)).toBe(false);
  });
});

describe("Wave 3 — Tri-State ACL: isKindAllowed", () => {
  it("null or undefined allows all service kinds (wildcard)", () => {
    for (const kind of ["llm", "stt", "tts", "embedding", "image", "webSearch", "webFetch"]) {
      expect(allowedModels.isKindAllowed(null, kind)).toBe(true);
      expect(allowedModels.isKindAllowed(undefined, kind)).toBe(true);
      expect(allowedModels.isKindAllowed({ allowedKinds: null }, kind)).toBe(true);
    }
  });

  it("empty array denies all service kinds (fail-closed)", () => {
    for (const kind of ["llm", "stt", "tts", "embedding", "image", "webSearch", "webFetch"]) {
      expect(allowedModels.isKindAllowed([], kind)).toBe(false);
      expect(allowedModels.isKindAllowed("[]", kind)).toBe(false);
      expect(allowedModels.isKindAllowed({ allowedKinds: [] }, kind)).toBe(false);
    }
  });

  it("explicit whitelist permits only listed kinds (case-insensitive)", () => {
    const acl = ["llm", "stt"];
    expect(allowedModels.isKindAllowed(acl, "llm")).toBe(true);
    expect(allowedModels.isKindAllowed(acl, "LLM")).toBe(true);
    expect(allowedModels.isKindAllowed(acl, "stt")).toBe(true);
    expect(allowedModels.isKindAllowed(acl, "STT")).toBe(true);
    expect(allowedModels.isKindAllowed(acl, "tts")).toBe(false);
    expect(allowedModels.isKindAllowed(acl, "image")).toBe(false);
    expect(allowedModels.isKindAllowed(acl, "webSearch")).toBe(false);
  });

  it("malformed kind rules fail closed to deny all", () => {
    expect(allowedModels.isKindAllowed("invalid-json", "llm")).toBe(false);
    expect(allowedModels.isKindAllowed(12345, "llm")).toBe(false);
    expect(allowedModels.isKindAllowed({}, "llm")).toBe(false);
    expect(allowedModels.isKindAllowed(["llm"], null)).toBe(false);
    expect(allowedModels.isKindAllowed(["llm"], "")).toBe(false);
  });
});

describe("Wave 3 — Tri-State ACL: isComboAllowed", () => {
  it("null or undefined allows all combos (wildcard)", () => {
    expect(allowedModels.isComboAllowed(null, "Main")).toBe(true);
    expect(allowedModels.isComboAllowed(undefined, "Fast")).toBe(true);
    expect(allowedModels.isComboAllowed({ allowedCombos: null }, "other")).toBe(true);
  });

  it("empty array denies all combos", () => {
    expect(allowedModels.isComboAllowed([], "Main")).toBe(false);
    expect(allowedModels.isComboAllowed("[]", "Fast")).toBe(false);
    expect(allowedModels.isComboAllowed({ allowedCombos: [] }, "Main")).toBe(false);
  });

  it("whitelist permits only listed combos (case-insensitive)", () => {
    const acl = ["Main", "Fast"];
    expect(allowedModels.isComboAllowed(acl, "Main")).toBe(true);
    expect(allowedModels.isComboAllowed(acl, "main")).toBe(true);
    expect(allowedModels.isComboAllowed(acl, "FAST")).toBe(true);
    expect(allowedModels.isComboAllowed(acl, "other")).toBe(false);
    expect(allowedModels.isComboAllowed(acl, "unknown")).toBe(false);
  });

  it("malformed combo inputs fail closed", () => {
    expect(allowedModels.isComboAllowed("bad-json", "Main")).toBe(false);
    expect(allowedModels.isComboAllowed(["Main"], "")).toBe(false);
    expect(allowedModels.isComboAllowed(["Main"], null)).toBe(false);
  });
});

describe("Wave 3 — Tri-State ACL: isProviderAllowed & Compatible Node Prefix Resolution", () => {
  beforeEach(() => {
    allowedModels.resetAllowedModelsCache();
  });

  it("null or undefined allows all providers (wildcard)", async () => {
    expect(await allowedModels.isProviderAllowed(null, "openai")).toBe(true);
    expect(await allowedModels.isProviderAllowed(undefined, "anthropic")).toBe(true);
    expect(await allowedModels.isProviderAllowed({ allowedProviders: null }, "xai")).toBe(true);
  });

  it("empty array denies all providers", async () => {
    expect(await allowedModels.isProviderAllowed([], "openai")).toBe(false);
    expect(await allowedModels.isProviderAllowed("[]", "anthropic")).toBe(false);
    expect(await allowedModels.isProviderAllowed({ allowedProviders: [] }, "openai")).toBe(false);
  });

  it("whitelist permits only listed providers", async () => {
    const acl = ["openai", "anthropic"];
    expect(await allowedModels.isProviderAllowed(acl, "openai")).toBe(true);
    expect(await allowedModels.isProviderAllowed(acl, "OPENAI")).toBe(true);
    expect(await allowedModels.isProviderAllowed(acl, "anthropic")).toBe(true);
    expect(await allowedModels.isProviderAllowed(acl, "xai")).toBe(false);
    expect(await allowedModels.isProviderAllowed(acl, "gemini")).toBe(false);
  });

  it("resolves provider aliases bidirectionally (cx <-> codex)", async () => {
    expect(await allowedModels.isProviderAllowed(["codex"], "cx")).toBe(true);
    expect(await allowedModels.isProviderAllowed(["cx"], "codex")).toBe(true);
    expect(await allowedModels.isProviderAllowed(["codex"], "openai")).toBe(false);
  });

  it("resolves provider-node-prefix for compatible nodes", async () => {
    // Node in fx.nodes: id="openai-compatible-chat-n1", prefix="mock"
    // 1. Whitelist names node prefix "mock" -> allows full node id
    expect(await allowedModels.isProviderAllowed(["mock"], "openai-compatible-chat-n1")).toBe(true);
    expect(await allowedModels.isProviderAllowed(["mock"], "mock")).toBe(true);

    // 2. Whitelist names full node id -> allows prefix
    expect(await allowedModels.isProviderAllowed(["openai-compatible-chat-n1"], "mock")).toBe(true);
  });

  it("resolves UUID-suffixed compatible nodes to their base prefix", async () => {
    const uuidNodeId = "openai-compatible-chat-8b5e9123-1234-4321-8765-abcdef123456";

    // Whitelist specifies base prefix "openai-compatible-chat"
    expect(await allowedModels.isProviderAllowed(["openai-compatible-chat"], uuidNodeId)).toBe(true);

    // Whitelist specifies generic "openai-compatible"
    expect(await allowedModels.isProviderAllowed(["openai-compatible"], uuidNodeId)).toBe(true);

    // Whitelist specifies node prefix "localai"
    expect(await allowedModels.isProviderAllowed(["localai"], uuidNodeId)).toBe(true);

    // Whitelist specifies another compatible type -> denied
    expect(await allowedModels.isProviderAllowed(["anthropic-compatible"], uuidNodeId)).toBe(false);
  });
});

describe("Wave 3 — Tri-State ACL: isModelAllowed & 30s Resolution Cache", () => {
  beforeEach(() => {
    allowedModels.resetAllowedModelsCache();
  });

  it("null or undefined allows all models (wildcard)", async () => {
    expect(await allowedModels.isModelAllowed(null, "openai/gpt-4o")).toBe(true);
    expect(await allowedModels.isModelAllowed(undefined, "anthropic/claude-3-5-sonnet")).toBe(true);
  });

  it("empty array denies all models (fail-closed)", async () => {
    expect(await allowedModels.isModelAllowed([], "openai/gpt-4o")).toBe(false);
    expect(await allowedModels.isModelAllowed("[]", "openai/gpt-4o")).toBe(false);
  });

  it("whitelist permits only exact listed models (case-insensitive)", async () => {
    const acl = ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"];
    expect(await allowedModels.isModelAllowed(acl, "openai/gpt-4o")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "OPENAI/GPT-4O")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "anthropic/claude-3-5-sonnet")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "openai/gpt-4o-mini")).toBe(false);
    expect(await allowedModels.isModelAllowed(acl, "openai/gpt-4")).toBe(false);
  });

  it("resolves model aliases before matching", async () => {
    // fx.aliases: fast -> openai/model-a, bee -> openai/model-b
    const acl = ["fast"]; // contains alias pointing to openai/model-a
    expect(await allowedModels.isModelAllowed(acl, "openai/model-a")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "fast")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "openai/model-b")).toBe(false);
  });

  it("resolves provider aliases in model strings (cx/gpt-5 <-> codex/gpt-5)", async () => {
    const acl = ["cx/gpt-5"];
    expect(await allowedModels.isModelAllowed(acl, "codex/gpt-5")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "cx/gpt-5")).toBe(true);
    expect(await allowedModels.isModelAllowed(acl, "openai/gpt-5")).toBe(false);
  });

  it("utilizes 30s cache across subsequent lookups", async () => {
    // fx.aliases: fast -> openai/model-a
    const acl = ["fast"];
    const spy = vi.spyOn(modelService, "getModelInfo");
    spy.mockClear();

    // First lookup resolves alias "fast" and populates the 30s cache
    expect(await allowedModels.isModelAllowed(acl, "openai/model-a")).toBe(true);
    const initialCalls = spy.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    // Second lookup should leverage cache
    expect(await allowedModels.isModelAllowed(acl, "openai/model-a")).toBe(true);
    expect(spy.mock.calls.length).toBe(initialCalls);

    // Resetting cache causes re-resolution on next check
    allowedModels.resetAllowedModelsCache();
    expect(await allowedModels.isModelAllowed(acl, "openai/model-a")).toBe(true);
    expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);

    spy.mockRestore();
  });
});

describe("Wave 3 — Enforcement Pipeline & Short-Circuit Ordering", () => {
  let validToken;

  beforeEach(async () => {
    internalTrust.resetInternalTrustCache();
    allowedModels.resetAllowedModelsCache();
    validToken = await getConsistentMachineId("9r-cli-auth");
    fx.keys = {};
  });

  it("Step 1: valid internal trust token bypasses all checks even with empty ACL", async () => {
    const keyRecord = {
      id: "k-locked",
      name: "Locked Key",
      isActive: false, // inactive!
      allowedKinds: [], // empty!
      allowedProviders: [], // empty!
      allowedCombos: [], // empty!
      allowedModels: [], // empty!
    };

    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { "x-9r-cli-token": validToken },
    });

    const denied = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "openai/gpt-4o",
      keyRecord,
    });

    expect(denied).toBeNull(); // BYPASS ALL GATES!
  });

  it("Step 2: inactive API key returns 401 Unauthorized", async () => {
    const keyRecord = {
      id: "k-inactive",
      isActive: false,
      allowedKinds: null,
    };
    const req = new Request("http://localhost/v1/chat/completions");

    const res = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "openai/gpt-4o",
      keyRecord,
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("Step 3: denied kind returns 403 and SHORT-CIRCUITS before provider lookup", async () => {
    const keyRecord = {
      id: "k-stt-only",
      isActive: true,
      allowedKinds: ["stt"], // only stt allowed
      allowedProviders: ["openai"],
      allowedModels: ["openai/gpt-4o"],
    };

    const spyModelInfo = vi.spyOn(modelService, "getModelInfo");
    spyModelInfo.mockClear();

    const req = new Request("http://localhost/v1/chat/completions");
    const res = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm", // requesting LLM
      modelStr: "openai/gpt-4o",
      keyRecord,
    });

    // 1. Assert 403 Forbidden with exact error shape
    expect(res).not.toBeNull();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("kind_not_allowed");
    expect(body.error.message).toBe('This API key is not allowed to use service kind "llm"');

    // 2. CRITICAL: Assert short-circuit occurred (getModelInfo was NOT called)
    expect(spyModelInfo).not.toHaveBeenCalled();

    spyModelInfo.mockRestore();
  });

  it("Step 4a: denied combo returns 403 combo_not_allowed", async () => {
    const keyRecord = {
      id: "k-combo-fast",
      isActive: true,
      allowedKinds: ["llm"],
      allowedCombos: ["Fast"], // Main is not allowed
    };

    const req = new Request("http://localhost/v1/chat/completions");
    const res = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "Main",
      keyRecord,
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("combo_not_allowed");
    expect(body.error.message).toBe('This API key is not allowed to use combo "Main"');
  });

  it("Step 4b: denied provider returns 403 provider_not_allowed", async () => {
    const keyRecord = {
      id: "k-anthropic-only",
      isActive: true,
      allowedKinds: ["llm"],
      allowedProviders: ["anthropic"], // openai is denied
      allowedModels: null,
    };

    const req = new Request("http://localhost/v1/chat/completions");
    const res = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "openai/gpt-4o",
      keyRecord,
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("provider_not_allowed");
    expect(body.error.message).toBe('This API key is not allowed to use provider "openai"');
  });

  it("Step 5: denied model returns 404 model_not_found (prevents model enumeration)", async () => {
    const keyRecord = {
      id: "k-gpt4o-only",
      isActive: true,
      allowedKinds: ["llm"],
      allowedProviders: ["openai"],
      allowedModels: ["openai/gpt-4o"], // gpt-4o-mini is denied
    };

    const req = new Request("http://localhost/v1/chat/completions");
    const res = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "openai/gpt-4o-mini",
      keyRecord,
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(404); // 404, NOT 403!
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toBe('The model "openai/gpt-4o-mini" does not exist or you do not have access to it.');
  });

  it("All gates pass when key permissions permit the target", async () => {
    const keyRecord = {
      id: "k-full-access",
      isActive: true,
      allowedKinds: ["llm"],
      allowedProviders: ["openai"],
      allowedCombos: ["Main"],
      allowedModels: ["openai/gpt-4o"],
    };

    const req = new Request("http://localhost/v1/chat/completions");

    // Permitted combo
    const comboRes = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "Main",
      keyRecord,
    });
    expect(comboRes).toBeNull();

    // Permitted model
    const modelRes = await allowedModels.enforceUnifiedAcl({
      request: req,
      kind: "llm",
      modelStr: "openai/gpt-4o",
      keyRecord,
    });
    expect(modelRes).toBeNull();
  });
});

describe("Wave 3 — Catalogue Filtering (/v1/models)", () => {
  const catalogFixture = [
    { id: "Main", owned_by: "combo", kind: "llm" },
    { id: "Fast", owned_by: "combo", kind: "llm" },
    { id: "openai/gpt-4o", owned_by: "openai", kind: "llm" },
    { id: "openai/model-b", owned_by: "openai", kind: "llm" },
    { id: "openai/whisper-1", owned_by: "openai", kind: "stt" },
    { id: "tavily/search", owned_by: "tavily", kind: "webSearch" },
  ];

  it("unrestricted key sees all catalog entries", async () => {
    const ctx = null; // Unrestricted
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    expect(filtered).toEqual(catalogFixture);
  });

  it("restricts catalog by allowedKinds", async () => {
    const ctx = {
      acl: {
        allowedKinds: ["llm"],
        allowedProviders: null,
        allowedCombos: null,
        allowedModels: null,
      },
    };
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    const ids = filtered.map((m) => m.id);
    expect(ids).toContain("Main");
    expect(ids).toContain("Fast");
    expect(ids).toContain("openai/gpt-4o");
    expect(ids).not.toContain("openai/whisper-1"); // stt excluded
    expect(ids).not.toContain("tavily/search"); // webSearch excluded
  });

  it("restricts catalog by allowedProviders", async () => {
    const ctx = {
      acl: {
        allowedKinds: null,
        allowedProviders: ["openai"],
        allowedCombos: null,
        allowedModels: null,
      },
    };
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    const ids = filtered.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o");
    expect(ids).toContain("openai/model-b");
    expect(ids).not.toContain("tavily/search");
  });

  it("restricts catalog by allowedCombos", async () => {
    const ctx = {
      acl: {
        allowedKinds: null,
        allowedProviders: [],
        allowedCombos: ["Main"],
        allowedModels: [],
      },
    };
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    const ids = filtered.map((m) => m.id);
    expect(ids).toEqual(["Main"]);
  });

  it("restricts catalog by allowedModels", async () => {
    const ctx = {
      acl: {
        allowedKinds: null,
        allowedProviders: null,
        allowedCombos: [],
        allowedModels: ["openai/gpt-4o"],
      },
    };
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    const ids = filtered.map((m) => m.id);
    expect(ids).toEqual(["openai/gpt-4o"]);
  });

  it("empty allowedKinds strips entire catalog", async () => {
    const ctx = {
      acl: {
        allowedKinds: [],
        allowedProviders: null,
        allowedCombos: null,
        allowedModels: null,
      },
    };
    const filtered = await keyAccess.filterModelsListForKey(ctx, catalogFixture);
    expect(filtered).toEqual([]);
  });
});

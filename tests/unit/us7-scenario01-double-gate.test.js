import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
  ],
  keys: {},
}));

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    return a?.startsWith("Bearer ") ? a.slice(7) : request.headers.get("x-api-key");
  },
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function post(url, body, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("US7 Scenario 1: Double-Gate ACL Rejection Fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.keys = {};
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "Primary OpenAI",
      provider: "openai",
      apiKey: "sk-upstream",
    });
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
  });

  it("admits keys using Wave 3 tri-state ACL without legacy enforceKeyAccess re-rejecting them", async () => {
    // API key with Wave 3 tri-state ACL restricting to model-a
    fx.keys["sk-wave3-valid"] = {
      id: "key-w3-1",
      name: "Wave 3 Restriced Key",
      isActive: true,
      allowedKinds: ["llm"],
      allowedCombos: null,
      allowedProviders: ["openai"],
      allowedModels: ["openai/model-a"],
      access: { restricted: false, allow: [] },
    };

    const req = post(
      "/v1/chat/completions",
      { model: "openai/model-a", stream: true, messages: [{ role: "user", content: "hello" }] },
      "sk-wave3-valid"
    );

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("still rejects keys whose tri-state ACL genuinely disallows the model", async () => {
    fx.keys["sk-wave3-denied"] = {
      id: "key-w3-2",
      name: "Wave 3 Denied Key",
      isActive: true,
      allowedKinds: ["llm"],
      allowedCombos: null,
      allowedProviders: ["openai"],
      allowedModels: ["openai/model-b"],
      access: { restricted: false, allow: [] },
    };

    const req = post(
      "/v1/chat/completions",
      { model: "openai/model-a", stream: true, messages: [{ role: "user", content: "hello" }] },
      "sk-wave3-denied"
    );

    const res = await handleChat(req);
    expect(res.status).toBe(404); // unified ACL returns 404 for model_not_allowed
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});

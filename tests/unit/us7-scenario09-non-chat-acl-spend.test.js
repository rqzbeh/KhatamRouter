import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  keys: {},
}));

const mocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(async () => ({ success: true, response: new Response("{}", { status: 200 }) })),
  getProviderCredentials: vi.fn(async () => ({ connectionId: "c1", provider: "openai", apiKey: "sk-upstream" })),
  handleImageCore: vi.fn(async () => ({ success: true, response: new Response("{}", { status: 200 }) })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
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
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.handleEmbeddingsCore }));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");

function post(url, body, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("US7 Scenario 9: Non-Chat Endpoints Unified ACL and Spend Enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.keys = {};
  });

  it("rejects inactive/revoked API keys on embeddings endpoint", async () => {
    fx.keys["sk-revoked-key"] = {
      id: "key-revoked",
      key: "sk-revoked-key",
      isActive: false, // Revoked/inactive key
    };

    const req = post("/v1/embeddings", { model: "openai/text-embedding-3-small", input: "test" }, "sk-revoked-key");
    const res = await handleEmbeddings(req);

    expect(res.status).toBe(401);
  });

  it("rejects key restricted to LLM when calling embeddings (kind_not_allowed)", async () => {
    fx.keys["sk-llm-only"] = {
      id: "key-llm-only",
      key: "sk-llm-only",
      isActive: true,
      allowedKinds: ["llm"], // Disallows "embedding"
      allowedModels: null,
      allowedProviders: null,
      allowedCombos: null,
    };

    const req = post("/v1/embeddings", { model: "openai/text-embedding-3-small", input: "test" }, "sk-llm-only");
    const res = await handleEmbeddings(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("kind_not_allowed");
  });

  it("rejects inactive/revoked API keys on image generation endpoint", async () => {
    fx.keys["sk-revoked-image"] = {
      id: "key-revoked-img",
      key: "sk-revoked-image",
      isActive: false,
    };

    const req = post("/v1/images/generations", { model: "openai/dall-e-3", prompt: "a cat" }, "sk-revoked-image");
    const res = await handleImageGeneration(req);

    expect(res.status).toBe(401);
  });

  it("rejects key restricted to LLM when calling image generation (kind_not_allowed)", async () => {
    fx.keys["sk-llm-only-img"] = {
      id: "key-llm-img",
      key: "sk-llm-only-img",
      isActive: true,
      allowedKinds: ["llm"], // Disallows "image"
      allowedModels: null,
      allowedProviders: null,
      allowedCombos: null,
    };

    const req = post("/v1/images/generations", { model: "openai/dall-e-3", prompt: "a cat" }, "sk-llm-only-img");
    const res = await handleImageGeneration(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("kind_not_allowed");
  });
});

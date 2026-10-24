import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeRedis } from "./helpers/redisMock.js";
import { setRedisClient, closeRedisClient } from "@/lib/redis/client.js";
import { resetIdempotencyStore } from "@/lib/idempotency/idempotencyStore.js";

const fx = vi.hoisted(() => ({
  keys: {},
  upstreamCalls: 0,
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
  getProviderCredentials: vi.fn(async () => ({ connectionId: "c1", provider: "openai", apiKey: "sk-upstream" })),
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

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async () => {
    fx.upstreamCalls++;
    return {
      success: true,
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-${fx.upstreamCalls}`,
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hello idempotency" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function post(url, body, key, idempotencyKey) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("US7 Scenario 12: Idempotency Real Request-Path Wiring (G11)", () => {
  let fakeRedis;

  beforeEach(() => {
    FakeRedis.clearAll();
    resetIdempotencyStore();
    fakeRedis = new FakeRedis();
    setRedisClient(fakeRedis);
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";
    fx.upstreamCalls = 0;
    fx.keys = {};
  });

  afterEach(() => {
    closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("caches first non-streaming request and replays on identical second request with 0 upstream calls", async () => {
    const apiKey = "sk-idemp-test-key";
    const idempotencyKey = "uuid-idemp-1";
    const body = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello idempotency" }],
      stream: false,
    };

    // First request (miss)
    const req1 = post("/v1/chat/completions", body, apiKey, idempotencyKey);
    const res1 = await handleChat(req1);
    expect(res1.status).toBe(200);
    expect(fx.upstreamCalls).toBe(1);
    expect(res1.headers.get("Idempotency-Replayed")).toBeNull();

    const data1 = await res1.json();
    expect(data1.choices[0].message.content).toBe("hello idempotency");

    // Second request with same idempotency key and same body (hit)
    const req2 = post("/v1/chat/completions", body, apiKey, idempotencyKey);
    const res2 = await handleChat(req2);
    expect(res2.status).toBe(200);
    expect(fx.upstreamCalls).toBe(1); // ZERO additional upstream calls!
    expect(res2.headers.get("Idempotency-Replayed")).toBe("true");

    const data2 = await res2.json();
    expect(data2.choices[0].message.content).toBe("hello idempotency");
  });

  it("returns HTTP 422 on payload conflict with same Idempotency-Key", async () => {
    const apiKey = "sk-idemp-test-key";
    const idempotencyKey = "uuid-idemp-conflict";
    const body1 = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "payload A" }],
      stream: false,
    };
    const body2 = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "payload B" }],
      stream: false,
    };

    const req1 = post("/v1/chat/completions", body1, apiKey, idempotencyKey);
    const res1 = await handleChat(req1);
    expect(res1.status).toBe(200);
    expect(fx.upstreamCalls).toBe(1);

    // Second request with same key but DIFFERENT body -> 422
    const req2 = post("/v1/chat/completions", body2, apiKey, idempotencyKey);
    const res2 = await handleChat(req2);
    expect(res2.status).toBe(422);
    expect(fx.upstreamCalls).toBe(1);
  });
});

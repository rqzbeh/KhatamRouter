import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing systemoneRouter
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn((provider, creds) => Promise.resolve(creds)),
}));

vi.mock("open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: vi.fn(),
}));

import { getModelInfo } from "@/sse/services/model.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import { resolveSmartChoice } from "@/sse/services/systemoneRouter.js";

describe("src/sse/services/systemoneRouter: resolveSmartChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null if models array has 1 or fewer models", async () => {
    const res = await resolveSmartChoice({
      body: { messages: [{ role: "user", content: "Hi" }] },
      models: ["only-one-model"],
    });
    expect(res).toBeNull();
  });

  it("returns null if prompt state cannot be extracted", async () => {
    const res = await resolveSmartChoice({
      body: {},
      models: ["model-a", "model-b"],
    });
    expect(res).toBeNull();
  });

  it("evaluates System One in-process and returns parsed routing answer", async () => {
    getModelInfo.mockResolvedValueOnce({
      provider: "opencode",
      model: "jev-1.13-free",
    });

    getProviderCredentials.mockResolvedValueOnce({
      apiKey: "test-api-key",
      connectionName: "default",
    });

    handleSystemoneCore.mockResolvedValueOnce({
      success: true,
      response: new Response(
        JSON.stringify({
          answers: {
            route: {
              choice: "model-b",
              confidence: 0.88,
              probabilities: { "model-b": 0.88, "model-a": 0.12 },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    });

    const result = await resolveSmartChoice({
      body: { messages: [{ role: "user", content: "Write a high-performance Rust service" }] },
      models: ["model-a", "model-b"],
      routerModel: "oc/jev-1.13-free",
    });

    expect(result).toEqual({
      choice: "model-b",
      confidence: 0.88,
      probabilities: { "model-b": 0.88, "model-a": 0.12 },
    });
  });

  it("fails open (returns null) when credentials are unavailable", async () => {
    getModelInfo.mockResolvedValueOnce({
      provider: "opencode",
      model: "jev-1.13-free",
    });

    getProviderCredentials.mockResolvedValueOnce(null);

    const result = await resolveSmartChoice({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["model-a", "model-b"],
    });

    expect(result).toBeNull();
  });

  it("fails open (returns null) when upstream returns non-success", async () => {
    getModelInfo.mockResolvedValueOnce({
      provider: "opencode",
      model: "jev-1.13-free",
    });

    getProviderCredentials.mockResolvedValueOnce({ apiKey: "key" });

    handleSystemoneCore.mockResolvedValueOnce({
      success: false,
      status: 500,
    });

    const result = await resolveSmartChoice({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["model-a", "model-b"],
    });

    expect(result).toBeNull();
  });

  it("fails open (returns null) when router evaluation times out", async () => {
    getModelInfo.mockResolvedValueOnce({
      provider: "opencode",
      model: "jev-1.13-free",
    });

    getProviderCredentials.mockResolvedValueOnce({ apiKey: "key" });

    // Simulate hanging promise longer than timeoutMs
    handleSystemoneCore.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 200))
    );

    const result = await resolveSmartChoice({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["model-a", "model-b"],
      timeoutMs: 50,
    });

    expect(result).toBeNull();
  });
});

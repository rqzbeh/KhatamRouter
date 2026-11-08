import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock models and connections for route handlers
const {
  getProviderConnectionByIdMock,
  getProviderNodeByIdMock,
} = vi.hoisted(() => ({
  getProviderConnectionByIdMock: vi.fn(),
  getProviderNodeByIdMock: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: getProviderConnectionByIdMock,
  getProviderNodeById: getProviderNodeByIdMock,
}));

// Route handlers
const { GET: suggestedModelsGET } = await import("@/app/api/providers/suggested-models/route.js");
const { GET: providerModelsGET } = await import("@/app/api/providers/[id]/models/route.js");
const { POST: providerNodesPOST } = await import("@/app/api/provider-nodes/route.js");
const { POST: validateNodePOST } = await import("@/app/api/provider-nodes/validate/route.js");
const { POST: validateProviderPOST } = await import("@/app/api/providers/validate/route.js");

describe("GET /api/providers/suggested-models SSRF protection", () => {
  it("rejects private/internal target URLs", async () => {
    const req = new Request("http://localhost:20128/api/providers/suggested-models?url=http://127.0.0.1:8000/models&type=ollama");
    const res = await suggestedModelsGET(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/blocked|internal|not allowed/i);
  });

  it("rejects cloud metadata target URL", async () => {
    const req = new Request("http://localhost:20128/api/providers/suggested-models?url=http://169.254.169.254/latest/meta-data/&type=ollama");
    const res = await suggestedModelsGET(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/blocked|internal|not allowed|metadata/i);
  });
});

describe("GET /api/providers/[id]/models SSRF protection", () => {
  beforeEach(() => {
    getProviderConnectionByIdMock.mockReset();
    getProviderNodeByIdMock.mockReset();
  });

  it("rejects private baseUrl on OpenAI-compatible provider when node is not self-hosted", async () => {
    getProviderConnectionByIdMock.mockResolvedValue({
      id: "conn-1",
      provider: "openai-compatible-chat-node1",
      apiKey: "sk-secret-12345",
      providerSpecificData: {
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    });
    getProviderNodeByIdMock.mockResolvedValue({
      id: "openai-compatible-chat-node1",
      isSelfHosted: false,
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    const req = new Request("http://localhost:20128/api/providers/conn-1/models");
    const res = await providerModelsGET(req, { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/blocked|internal|not allowed/i);
  });

  it("rejects self-hosted gateway model discovery when request arrives via reverse proxy", async () => {
    getProviderConnectionByIdMock.mockResolvedValue({
      id: "conn-2",
      provider: "openai-compatible-chat-node2",
      apiKey: "sk-secret-12345",
      providerSpecificData: {
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    });
    getProviderNodeByIdMock.mockResolvedValue({
      id: "openai-compatible-chat-node2",
      isSelfHosted: true,
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    const req = new Request("http://localhost:20128/api/providers/conn-2/models", {
      headers: {
        "x-9r-via-proxy": "true",
      },
    });
    const res = await providerModelsGET(req, { params: Promise.resolve({ id: "conn-2" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/proxied|proxy|not permitted|not allowed|blocked/i);
  });

  it("does not leak apiKey into error response when discovery fails", async () => {
    const sensitiveKey = "sk-super-secret-key-that-must-not-leak-99999";
    getProviderConnectionByIdMock.mockResolvedValue({
      id: "conn-3",
      provider: "openai-compatible-chat-node3",
      apiKey: sensitiveKey,
      providerSpecificData: {
        baseUrl: "https://nonexistent-gateway-domain-xyz.test/v1",
      },
    });
    getProviderNodeByIdMock.mockResolvedValue({
      id: "openai-compatible-chat-node3",
      isSelfHosted: false,
      baseUrl: "https://nonexistent-gateway-domain-xyz.test/v1",
    });

    const req = new Request("http://localhost:20128/api/providers/conn-3/models");
    const res = await providerModelsGET(req, { params: Promise.resolve({ id: "conn-3" }) });
    const text = await res.text();
    expect(text).not.toContain(sensitiveKey);
  });
});

describe("POST /api/provider-nodes and validate route-level security", () => {
  it("rejects creating private baseUrl node when isSelfHosted is false", async () => {
    const req = new Request("http://localhost:20128/api/provider-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Private Node",
        prefix: "tpn",
        apiType: "chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        isSelfHosted: false,
      }),
    });
    const res = await providerNodesPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/internal|blocked|invalid base url/i);
  });

  it("rejects creating self-hosted node when request arrives via reverse proxy", async () => {
    const req = new Request("http://localhost:20128/api/provider-nodes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-9r-via-proxy": "1",
      },
      body: JSON.stringify({
        name: "Test Proxied Node",
        prefix: "tpn",
        apiType: "chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        isSelfHosted: true,
      }),
    });
    const res = await providerNodesPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/proxied|not permitted/i);
  });

  it("rejects allowInsecureTls when isSelfHosted is false", async () => {
    const req = new Request("http://localhost:20128/api/provider-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Insecure Public",
        prefix: "tip",
        apiType: "chat",
        baseUrl: "https://api.openai.com/v1",
        isSelfHosted: false,
        allowInsecureTls: true,
      }),
    });
    const res = await providerNodesPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only allowed for self-hosted/i);
  });

  it("rejects validating private baseUrl when isSelfHosted is false or missing", async () => {
    const req = new Request("http://localhost:20128/api/provider-nodes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "test-key",
      }),
    });
    const res = await validateNodePOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/url not allowed/i);
  });
});

describe("POST /api/providers/validate SSRF and proxy fail-closed protection", () => {
  it("rejects validating private node when isSelfHosted is false or request is proxied", async () => {
    getProviderNodeByIdMock.mockResolvedValue({
      id: "openai-compatible-chat-private",
      baseUrl: "http://127.0.0.1:11434/v1",
      isSelfHosted: false,
    });

    const req = new Request("http://localhost:20128/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-chat-private",
        apiKey: "test-key",
      }),
    });
    const res = await validateProviderPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gateway url not allowed/i);
  });

  it("fails closed when proxy/relay egress is configured for custom gateway validation", async () => {
    getProviderNodeByIdMock.mockResolvedValue({
      id: "openai-compatible-chat-relay",
      baseUrl: "https://api.openai.com/v1",
      isSelfHosted: false,
    });

    const req = new Request("http://localhost:20128/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-chat-relay",
        apiKey: "test-key",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:8888",
        },
      }),
    });
    const res = await validateProviderPOST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/configured proxy egress cannot be honored/i);
  });
});

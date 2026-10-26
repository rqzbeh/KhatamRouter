import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEmbeddingAdapter } from "../../open-sse/handlers/embeddingProviders/index.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { resolveOllamaEmbeddingHost } from "../../open-sse/handlers/embeddingProviders/ollamaLocal.js";
import { AI_PROVIDERS, getProvidersByKind } from "../../src/shared/constants/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import ollamaLocalRegistry from "../../open-sse/providers/registry/ollama-local.js";
import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";
import * as localDb from "@/lib/localDb";

const VALID_EMBEDDING_RESPONSE = {
  object: "list",
  data: [
    {
      object: "embedding",
      index: 0,
      embedding: [0.1, 0.2, 0.3],
    },
  ],
  model: "nomic-embed-text",
  usage: { prompt_tokens: 4, total_tokens: 4 },
};

function makeProviderResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeOptions(overrides = {}) {
  return {
    body: { model: "nomic-embed-text", input: "Hello world" },
    modelInfo: { provider: "ollama-local", model: "nomic-embed-text" },
    credentials: {},
    ...overrides,
  };
}

describe("Ollama Local Embeddings Integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("wires ollama-local into media-providers embedding (serviceKind, adapter, config, models)", () => {
    const provider = AI_PROVIDERS["ollama-local"];
    expect(provider).toBeDefined();
    expect(provider.serviceKinds).toContain("embedding");
    expect(provider.serviceKinds).toContain("llm");
    expect(provider.serviceKinds).toContain("systemone");

    expect(provider.embeddingConfig).toBeDefined();
    expect(provider.embeddingConfig.baseUrl).toBe("http://localhost:11434/v1/embeddings");
    expect(provider.embeddingConfig.path).toBe("/v1/embeddings");

    const adapter = getEmbeddingAdapter("ollama-local");
    expect(adapter).toBeTruthy();
    expect(typeof adapter.buildUrl).toBe("function");
    expect(typeof adapter.buildHeaders).toBe("function");
    expect(typeof adapter.buildBody).toBe("function");

    const embeddingProviders = getProvidersByKind("embedding");
    expect(embeddingProviders.some((p) => p.id === "ollama-local")).toBe(true);

    const embeddingModels = (PROVIDER_MODELS["ollama-local"] || ollamaLocalRegistry.models).filter(
      (m) => m.kind === "embedding"
    );
    expect(embeddingModels.length).toBeGreaterThanOrEqual(14);

    const modelIds = new Set(embeddingModels.map((m) => m.id));
    expect(modelIds.has("nomic-embed-text")).toBe(true);
    expect(modelIds.has("nomic-embed-text-v2-moe")).toBe(true);
    expect(modelIds.has("qwen3-embedding")).toBe(true);
    expect(modelIds.has("qwen3-embedding:8b")).toBe(true);
    expect(modelIds.has("bge-m3")).toBe(true);
    expect(modelIds.has("bge-large")).toBe(true);
    expect(modelIds.has("mxbai-embed-large")).toBe(true);
    expect(modelIds.has("embeddinggemma")).toBe(true);
    expect(modelIds.has("embeddinggemma-2")).toBe(true);
    expect(modelIds.has("all-minilm")).toBe(true);
    expect(modelIds.has("snowflake-arctic-embed")).toBe(true);
    expect(modelIds.has("snowflake-arctic-embed2")).toBe(true);
    expect(modelIds.has("granite-embedding")).toBe(true);
    expect(modelIds.has("paraphrase-multilingual")).toBe(true);
    expect(modelIds.has("laya")).toBe(true);
  });

  it("routes embeddings to default host http://localhost:11434/v1/embeddings", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeProviderResponse(VALID_EMBEDDING_RESPONSE));

    const result = await handleEmbeddingsCore(makeOptions());

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: "Hello world", encoding_format: "float" }),
      })
    );
  });

  it("normalizes custom host URLs cleanly (handles trailing slashes, /v1, and /v1/embeddings)", async () => {
    const adapter = getEmbeddingAdapter("ollama-local");

    expect(adapter.buildUrl("nomic-embed-text", {})).toBe("http://localhost:11434/v1/embeddings");
    expect(adapter.buildUrl("nomic-embed-text", { providerSpecificData: { baseUrl: "http://192.168.1.100:11434" } }))
      .toBe("http://192.168.1.100:11434/v1/embeddings");
    expect(adapter.buildUrl("nomic-embed-text", { providerSpecificData: { baseUrl: "http://192.168.1.100:11434///" } }))
      .toBe("http://192.168.1.100:11434/v1/embeddings");
    expect(adapter.buildUrl("nomic-embed-text", { providerSpecificData: { baseUrl: "http://192.168.1.100:11434/v1" } }))
      .toBe("http://192.168.1.100:11434/v1/embeddings");
    expect(adapter.buildUrl("nomic-embed-text", { providerSpecificData: { baseUrl: "http://192.168.1.100:11434/v1/embeddings" } }))
      .toBe("http://192.168.1.100:11434/v1/embeddings");
  });

  it("attaches Authorization header when apiKey is supplied for authenticated proxies", async () => {
    const adapter = getEmbeddingAdapter("ollama-local");

    expect(adapter.buildHeaders({})).toEqual({ "Content-Type": "application/json" });
    expect(adapter.buildHeaders({ apiKey: "ollama-secret" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ollama-secret",
    });
  });

  it("handles dimensions parameter properly when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeProviderResponse(VALID_EMBEDDING_RESPONSE));

    await handleEmbeddingsCore(makeOptions({
      body: { model: "nomic-embed-text", input: "Hello world", dimensions: 512 },
    }));

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.dimensions).toBe(512);
  });

  describe("Security Hardening: Scheme, Credentials, and Timeouts", () => {
    it("rejects non-http/https URL schemes in baseUrl", () => {
      expect(() => {
        resolveOllamaEmbeddingHost({ providerSpecificData: { baseUrl: "ftp://attacker.com/v1" } });
      }).toThrow(/Invalid base URL protocol "ftp:". Only http: and https: are allowed/);

      expect(() => {
        resolveOllamaEmbeddingHost({ providerSpecificData: { baseUrl: "file:///etc/shadow" } });
      }).toThrow(/Invalid base URL protocol "file:". Only http: and https: are allowed/);

      expect(() => {
        resolveOllamaEmbeddingHost({ providerSpecificData: { baseUrl: "javascript:alert(1)" } });
      }).toThrow(/Invalid base URL protocol "javascript:". Only http: and https: are allowed/);
    });

    it("rejects baseUrl containing embedded credentials", () => {
      expect(() => {
        resolveOllamaEmbeddingHost({ providerSpecificData: { baseUrl: "http://admin:secret@127.0.0.1:11434" } });
      }).toThrow(/Base URL must not contain credentials/);

      expect(() => {
        resolveOllamaEmbeddingHost({ providerSpecificData: { baseUrl: "https://user@192.168.1.1:11434" } });
      }).toThrow(/Base URL must not contain credentials/);
    });

    it("ensures base URL comes ONLY from credentials.providerSpecificData.baseUrl, never from body", () => {
      const adapter = getEmbeddingAdapter("ollama-local");

      // Body contains hostile baseUrl, but credentials has no baseUrl -> default localhost is used
      const url = adapter.buildUrl("nomic-embed-text", {}, { input: "test", baseUrl: "http://attacker.com" });
      expect(url).toBe("http://localhost:11434/v1/embeddings");

      // Valid admin configured baseUrl in providerSpecificData
      const adminUrl = adapter.buildUrl("nomic-embed-text", {
        providerSpecificData: { baseUrl: "http://internal-ollama:11434" },
      });
      expect(adminUrl).toBe("http://internal-ollama:11434/v1/embeddings");
    });

    it("attaches AbortSignal.timeout to the fetch call and handles hanging fetch", async () => {
      const timeoutErr = new Error("The operation timed out");
      timeoutErr.name = "TimeoutError";
      vi.mocked(fetch).mockRejectedValueOnce(timeoutErr);

      const result = await handleEmbeddingsCore(makeOptions());

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect(init.signal).toBeDefined();
      expect(init.signal instanceof AbortSignal).toBe(true);
    });
  });

  describe("Authentication Gate on handleEmbeddings", () => {
    it("rejects unauthenticated request when requireApiKey is true", async () => {
      vi.spyOn(localDb, "getSettings").mockResolvedValueOnce({ requireApiKey: true });

      const req = new Request("http://localhost:20128/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "ollama-local/nomic-embed-text",
          input: "test embedding text",
        }),
      });

      const res = await handleEmbeddings(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Missing API key");
    });

    it("rejects invalid API key when requireApiKey is true", async () => {
      vi.spyOn(localDb, "getSettings").mockResolvedValueOnce({ requireApiKey: true });

      const req = new Request("http://localhost:20128/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer bad-key",
        },
        body: JSON.stringify({
          model: "ollama-local/nomic-embed-text",
          input: "test embedding text",
        }),
      });

      const res = await handleEmbeddings(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid API key");
    });
  });
});

// Regression: Cline declared only static models and no modelsFetcher, so the
// dashboard model list never auto-populated after OAuth connect. Its public
// catalogue endpoint (https://api.cline.bot/api/v1/models) answers without any
// credentials, so the resolver needs no token and cannot spend quota.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn() }));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: (url, options) => globalThis.fetch(url, options),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

const CLINE_MODELS_URL = "https://api.cline.bot/api/v1/models";

const catalogueFixture = {
  object: "list",
  data: [
    { id: "meituan/longcat-2.0", object: "model", created: 1791933050, owned_by: "meituan" },
    { id: "z-ai/glm-5.3-flash", object: "model", created: 1791930537, owned_by: "z-ai" },
    { id: "anthropic/claude-opus-4.7", object: "model", created: 1791912025, owned_by: "anthropic" },
  ],
};

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("cline provider declaration", () => {
  it("declares public modelsFetcher and passthroughModels", async () => {
    const cline = (await import("../../open-sse/providers/registry/cline.js")).default;
    expect(cline.modelsFetcher).toEqual({
      url: CLINE_MODELS_URL,
      type: "openai",
    });
    expect(cline.passthroughModels).toBe(true);
  });
});

describe("GET /api/providers/[id]/models for cline", () => {
  const getModels = async () => {
    vi.resetModules();
    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(new Request("http://localhost/api/providers/conn-cline/models"), {
      params: Promise.resolve({ id: "conn-cline" }),
    });
    return { status: response.status, body: await response.json() };
  };

  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => catalogueFixture,
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-cline",
      provider: "cline",
      accessToken: "cline-access-token",
    });
  });

  it("returns the public catalogue verbatim", async () => {
    const { status, body } = await getModels();
    const ids = body.models.map((m) => m.id);

    expect(status).toBe(200);
    expect(ids).toContain("meituan/longcat-2.0");
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("anthropic/claude-opus-4.7");
  });

  it("fetches without an Authorization header", async () => {
    await getModels();

    expect(fetchMock).toHaveBeenCalledWith(
      CLINE_MODELS_URL,
      expect.objectContaining({ method: "GET" })
    );
    const headers = fetchMock.mock.calls[0][1]?.headers || {};
    expect(JSON.stringify(headers)).not.toMatch(/Authorization/i);
  });

  it("falls back to the static 8 models when the endpoint returns non-200", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream error",
    });

    const { status, body } = await getModels();

    expect(status).toBe(200);
    expect(body.models).toHaveLength(8);
    expect(body.models.map((m) => m.id)).toContain("anthropic/claude-opus-4.7");
    expect(body.warning).toMatch(/Failed to fetch Cline models/);
  });

  it("falls back to the static 8 models when the fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const { status, body } = await getModels();

    expect(status).toBe(200);
    expect(body.models).toHaveLength(8);
    expect(body.models.map((m) => m.id)).toContain("anthropic/claude-opus-4.7");
    expect(body.warning).toMatch(/Failed to fetch Cline models/);
  });
});

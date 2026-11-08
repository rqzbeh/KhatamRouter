import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProxyPoolById: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderNodeById: mocks.getProviderNodeById,
  getProxyPoolById: mocks.getProxyPoolById,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.clearAllMocks();
  mocks.proxyAwareFetch.mockImplementation(async (url, options) => {
    return globalThis.fetch(url, options);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe("Spec 017: Provider Listing Completeness & Discovery", () => {
  // --------------------------------------------------------------------------
  // 1. OpenAI / NVIDIA / Built-in OpenAI-style listingShape
  // --------------------------------------------------------------------------
  describe("OpenAI & NVIDIA listingShape discovery", () => {
    it("OpenAI: unpaginated response yields complete: true and unpaginated_authoritative provenance", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-1",
        provider: "openai",
        apiKey: "sk-openai-test-key-12345",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-4o", object: "model" },
              { id: "gpt-4o-mini", object: "model" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-1/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-1");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("unpaginated_authoritative");
      expect(body.models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    });

    it("NVIDIA: unpaginated response yields complete: true and preserves model objects", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-nv-1",
        provider: "nvidia",
        apiKey: "nvapi-test-key-9999",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "meta/llama-3.1-70b-instruct", object: "model" },
              { id: "nvidia/llama-3.1-nemotron-70b-instruct", object: "model" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-nv-1/models");
      const { body, status } = await resolveProviderModels(req, "conn-nv-1");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("unpaginated_authoritative");
      expect(body.models.length).toBe(2);
      expect(body.models[0].id).toBe("meta/llama-3.1-70b-instruct");
    });

    it("OpenAI: response with has_more: true yields complete: false with pagination warning", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-paged",
        provider: "openai",
        apiKey: "sk-openai-test-key",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }],
            has_more: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-paged/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-paged");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("partial_pagination_signal");
      expect(body.warning).toMatch(/pagination/i);
    });

    it("OpenAI: response with numeric page/total_pages or next cursor yields complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-cursor",
        provider: "openai",
        apiKey: "sk-openai-test-key",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }],
            next_cursor: "cur_12345",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-cursor/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-cursor");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("partial_pagination_signal");
    });

    it("OpenAI: unrecognized schema shape yields complete: false, explicit warning, and empty models (no false empty without warning)", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-bad-shape",
        provider: "openai",
        apiKey: "sk-openai-test-key",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            unexpected_root: { foo: "bar" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-bad-shape/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-bad-shape");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("unrecognized_shape");
      expect(body.models).toEqual([]);
      expect(body.warning).toMatch(/recognized models array/i);
    });

    it("OpenAI: raw invalid records are preserved (not dropped) to allow importer to suppress pruning safely", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-invalid-record",
        provider: "openai",
        apiKey: "sk-openai-test-key",
      });

      const malformedItem = { arbitrary: "malformed-no-id" };
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "valid-1", object: "model" },
              malformedItem,
              null,
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-invalid-record/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-invalid-record");

      expect(status).toBe(200);
      // Raw invalid record must not be filtered out
      expect(body.models.length).toBe(3);
      expect(body.models).toContainEqual(malformedItem);
      expect(body.models).toContain(null);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Official Gemini Pagination Runner
  // --------------------------------------------------------------------------
  describe("Official Gemini pagination runner", () => {
    it("Gemini: multi-page pagination consumes nextPageToken through fixed URL with URLSearchParams and succeeds", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-gemini-1",
        provider: "gemini",
        apiKey: "AIzaSyTestGeminiKey123",
      });

      const requestedUrls = [];
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        requestedUrls.push(String(url));
        if (requestedUrls.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [
                  { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro" },
                ],
                nextPageToken: "token_page_2",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                { name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const req = new Request("http://localhost:20128/api/providers/conn-gemini-1/models");
      const { body, status } = await resolveProviderModels(req, "conn-gemini-1");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("exhausted_token_pages");
      expect(body.models.length).toBe(2);
      expect(body.models.map((m) => m.name)).toEqual(["models/gemini-1.5-pro", "models/gemini-1.5-flash"]);

      // Verify request URLs used fixed config base and pageToken param
      expect(requestedUrls[0]).toContain("https://generativelanguage.googleapis.com/v1beta/models");
      expect(requestedUrls[0]).toContain("pageSize=1000");
      expect(requestedUrls[1]).toContain("pageToken=token_page_2");
    });

    it("Gemini: cycle detection terminates pagination, retains collected models, and sets complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-gemini-cycle",
        provider: "gemini",
        apiKey: "AIzaSyTestGeminiKey123",
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [{ name: `models/model-${callCount}` }],
              nextPageToken: "repeating_cycle_token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const req = new Request("http://localhost:20128/api/providers/conn-gemini-cycle/models");
      const { body, status } = await resolveProviderModels(req, "conn-gemini-cycle");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("partial_token_pages");
      expect(body.warning).toMatch(/cycle detected/i);
      expect(body.models.length).toBe(2); // Page 1 and page 2 collected before cycle break
    });

    it("Gemini: mid-chain error retains previously collected models and sets complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-gemini-mid-err",
        provider: "gemini",
        apiKey: "AIzaSyTestGeminiKey123",
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ name: "models/gemini-pro" }],
                nextPageToken: "token-p2",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      });

      const req = new Request("http://localhost:20128/api/providers/conn-gemini-mid-err/models");
      const { body, status } = await resolveProviderModels(req, "conn-gemini-mid-err");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.models.length).toBe(1);
      expect(body.models[0].name).toBe("models/gemini-pro");
      expect(body.warning).toMatch(/HTTP 500/i);
    });

    it("Gemini: never leaks API keys in warning or error strings", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      const sensitiveGeminiKey = "AIzaSySecretGeminiKeyShouldNeverBeLeaked";
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-gemini-leak-test",
        provider: "gemini",
        apiKey: sensitiveGeminiKey,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error(`Failed connection with key=${sensitiveGeminiKey}`));

      const req = new Request("http://localhost:20128/api/providers/conn-gemini-leak-test/models");
      const { body, status } = await resolveProviderModels(req, "conn-gemini-leak-test");

      expect(status).toBe(500);
      const str = JSON.stringify(body);
      expect(str).not.toContain(sensitiveGeminiKey);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Native Anthropic / Claude Pagination Runner
  // --------------------------------------------------------------------------
  describe("Native Anthropic / Claude pagination runner", () => {
    it("Anthropic: multi-page chain consumes has_more and last_id, yielding complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-anthropic-1",
        provider: "anthropic",
        apiKey: "sk-ant-api03-test-token",
      });

      const requestedUrls = [];
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        requestedUrls.push(String(url));
        if (requestedUrls.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [{ id: "claude-3-opus-20240229" }],
                has_more: true,
                last_id: "cursor-page-2",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: "claude-3-5-sonnet-20241022" }],
              has_more: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const req = new Request("http://localhost:20128/api/providers/conn-anthropic-1/models");
      const { body, status } = await resolveProviderModels(req, "conn-anthropic-1");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("exhausted_cursor_chain");
      expect(body.models.length).toBe(2);
      expect(requestedUrls[1]).toContain("after_id=cursor-page-2");
    });

    it("Anthropic: cursor repeat cycle detection stops pagination with complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-anthropic-cycle",
        provider: "anthropic",
        apiKey: "sk-ant-api03-test-token",
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: `claude-model-${callCount}` }],
              has_more: true,
              last_id: "repeated-cursor-id",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const req = new Request("http://localhost:20128/api/providers/conn-anthropic-cycle/models");
      const { body, status } = await resolveProviderModels(req, "conn-anthropic-cycle");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.warning).toMatch(/cycle detected/i);
      expect(body.models.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Cloudflare Discovery (cloudflare-ai / cf)
  // --------------------------------------------------------------------------
  describe("Cloudflare Discovery", () => {
    it("Cloudflare: missing or invalid accountId returns actionable 400 without secrets", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-bad-account",
        provider: "cloudflare-ai",
        apiKey: "cf-secret-token-12345",
        providerSpecificData: {
          accountId: "../../invalid/path",
        },
      });

      const req = new Request("http://localhost:20128/api/providers/conn-cf-bad-account/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-bad-account");

      expect(status).toBe(400);
      expect(body.error).toMatch(/valid accountId/i);
      expect(JSON.stringify(body)).not.toContain("cf-secret-token-12345");
    });

    it("Cloudflare: connection with unsupported proxy type returns fail-closed 503", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-proxy-unsupported",
        provider: "cloudflare-ai",
        apiKey: "cf-secret-token-12345",
        providerSpecificData: {
          accountId: "abc123def456",
          connectionProxyEnabled: true,
          proxyPool: {
            type: "unsupported_foreign_proxy",
            proxyUrl: "foreign://127.0.0.1:9090",
          },
        },
      });

      const req = new Request("http://localhost:20128/api/providers/conn-cf-proxy-unsupported/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-proxy-unsupported");

      expect(status).toBe(503);
      expect(body.error).toMatch(/unsupported.*proxy.*fail-closed/i);
    });

    it("Cloudflare: connection with supported proxy routes through proxyAwareFetch", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-proxy-supported",
        provider: "cloudflare-ai",
        apiKey: "cf-secret-token-12345",
        providerSpecificData: {
          accountId: "023e105f4ecef8ad9ca31a8372d0c353",
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://my-proxy:8080",
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "model-1", name: "@cf/meta/llama-3.1-8b-instruct" }],
            result_info: { page: 1, total_pages: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-cf-proxy-supported/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-proxy-supported");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.models.length).toBe(1);
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        expect.stringContaining("accounts/023e105f4ecef8ad9ca31a8372d0c353/ai/models/search"),
        expect.anything(),
        expect.objectContaining({
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://my-proxy:8080",
        })
      );
    });

    it("Cloudflare: multi-page numeric pagination succeeds, normalizes task to kinds, preserves metadata, complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-valid",
        provider: "cloudflare-ai",
        apiKey: "cf-secret-token-12345",
        providerSpecificData: {
          accountId: "023e105f4ecef8ad9ca31a8372d0c353",
        },
      });

      const requestedUrls = [];
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        requestedUrls.push(String(url));
        if (requestedUrls.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                result: [
                  {
                    id: "787c800b-c8c2-411a-8bb7-d1a21e6be31d",
                    name: "@cf/meta/llama-3.1-8b-instruct",
                    description: "Fast Llama model",
                    task: { name: "Text Generation" },
                  },
                ],
                result_info: {
                  page: 1,
                  per_page: 100,
                  total_pages: 2,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: [
                {
                  id: "999c800b-c8c2-411a-8bb7-d1a21e6be999",
                  name: "@cf/black-forest-labs/flux-1-schnell",
                  description: "Flux image generation",
                  task: { name: "Text-to-Image" },
                },
              ],
              result_info: {
                page: 2,
                per_page: 100,
                total_pages: 2,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const req = new Request("http://localhost:20128/api/providers/conn-cf-valid/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-valid");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("exhausted_numeric_pages");
      expect(body.models.length).toBe(2);

      const m1 = body.models[0];
      expect(m1.id).toBe("@cf/meta/llama-3.1-8b-instruct"); // name preserved over internal UUID
      expect(m1.upstreamModelId).toBe("787c800b-c8c2-411a-8bb7-d1a21e6be31d");
      expect(m1.kind).toBe("llm");
      expect(m1.type).toBe("llm");
      expect(m1.raw).toBeDefined();

      const m2 = body.models[1];
      expect(m2.id).toBe("@cf/black-forest-labs/flux-1-schnell");
      expect(m2.kind).toBe("image");
      expect(m2.type).toBe("image");

      expect(requestedUrls[0]).toContain("accounts/023e105f4ecef8ad9ca31a8372d0c353/ai/models/search?page=1");
      expect(requestedUrls[1]).toContain("accounts/023e105f4ecef8ad9ca31a8372d0c353/ai/models/search?page=2");
    });

    it("Cloudflare: mid-chain error retains page 1 models with complete: false and warning", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-mid-err",
        provider: "cloudflare-ai",
        apiKey: "cf-token",
        providerSpecificData: {
          accountId: "abc123def456",
        },
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                result: [{ id: "model-1", name: "@cf/test/model-1" }],
                result_info: { page: 1, total_pages: 3 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      });

      const req = new Request("http://localhost:20128/api/providers/conn-cf-mid-err/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-mid-err");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.models.length).toBe(1);
      expect(body.models[0].name).toBe("@cf/test/model-1");
      expect(body.warning).toMatch(/HTTP 503/i);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Fallback for Providers without Listing Config
  // --------------------------------------------------------------------------
  describe("Static Fallback for unconfigured providers", () => {
    it("Unconfigured provider with static catalog (e.g. blackbox) falls back to static catalog with complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-blackbox-static",
        provider: "blackbox",
        apiKey: "some-key",
      });

      const req = new Request("http://localhost:20128/api/providers/conn-blackbox-static/models");
      const { body, status } = await resolveProviderModels(req, "conn-blackbox-static");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("static_catalog_fallback");
      expect(body.warning).toMatch(/static catalog/i);
      expect(body.models.length).toBeGreaterThan(0);
    });

    it("Completely unknown provider with no static models returns 400 unsupported error", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-unknown-provider",
        provider: "nonexistent-provider-xyz-12345",
        apiKey: "some-key",
      });

      const req = new Request("http://localhost:20128/api/providers/conn-unknown-provider/models");
      const { body, status } = await resolveProviderModels(req, "conn-unknown-provider");

      expect(status).toBe(400);
      expect(body.error).toMatch(/does not support models listing/i);
    });
  });

  // --------------------------------------------------------------------------
  // 6. OAuth & Custom Resolvers
  // --------------------------------------------------------------------------
  describe("OAuth & Custom resolvers completeness contract", () => {
    it("Antigravity: valid CodeAssist models dictionary proves complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-ag-complete",
        provider: "antigravity",
        accessToken: "ya29.test-oauth-token",
        refreshToken: "refresh-token",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: {
              "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash Tiered" },
              "gemini-4-argon": { displayName: "Gemini 4 Argon" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-ag-complete/models");
      const { body, status } = await resolveProviderModels(req, "conn-ag-complete");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.completenessProvenance).toBe("proven_custom_resolver");
      expect(body.models.length).toBe(2);
    });

    it("Codex: custom resolver cannot infer complete merely because models non-empty; returns complete: false", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-codex-unproven",
        provider: "codex",
        accessToken: "test-codex-token",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [{ slug: "gpt-4o", display_name: "GPT-4o" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-codex-unproven/models");
      const { body, status } = await resolveProviderModels(req, "conn-codex-unproven");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("unverified_custom_resolver");
    });

    it("Antigravity: raw dictionary with malformed/non-object entry suppresses complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-ag-malformed",
        provider: "antigravity",
        accessToken: "ya29.test-oauth-token",
        refreshToken: "refresh-token",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: {
              "valid-model": { displayName: "Valid Model" },
              "": { displayName: "Bad Model with Empty Key" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-ag-malformed/models");
      const { body, status } = await resolveProviderModels(req, "conn-ag-malformed");

      expect(status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.completenessProvenance).toBe("unverified_custom_resolver");
    });
  });

  // --------------------------------------------------------------------------
  // 7. Cloudflare Task Mapping & Malformed Record Contract
  // --------------------------------------------------------------------------
  describe("Cloudflare Task Mapping & Malformed Record Contract", () => {
    it("Cloudflare: image-to-text maps to vision LLM (not imagegen), stt/tts mapped, unknown preserved", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-cf-tasks",
        provider: "cloudflare-ai",
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-acc-123" },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [
              { id: "cf-v1", name: "@cf/meta/llama-vision", task: { name: "Image-to-Text" } },
              { id: "cf-stt", name: "@cf/openai/whisper", task: { name: "Automatic Speech Recognition" } },
              { id: "cf-tts", name: "@cf/fastspeech", task: { name: "Text-to-Speech" } },
              { id: "cf-emb", name: "@cf/baai/bge-base-en", task: { name: "Text Embeddings" } },
              { id: "cf-unknown", name: "@cf/custom/custom-sensor", task: { name: "Custom Sensor Processing" } },
              { id: "cf-imagegen", name: "@cf/stabilityai/sdxl", task: { name: "Text-to-Image" } },
            ],
            result_info: { page: 1, total_pages: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-cf-tasks/models");
      const { body, status } = await resolveProviderModels(req, "conn-cf-tasks");

      expect(status).toBe(200);
      expect(body.models.length).toBe(6);

      const vision = body.models.find((m) => m.id === "@cf/meta/llama-vision");
      expect(vision.kind).toBe("llm");
      expect(vision.type).toBe("llm");
      expect(vision.supportsVision).toBe(true);

      const stt = body.models.find((m) => m.id === "@cf/openai/whisper");
      expect(stt.kind).toBe("stt");
      expect(stt.type).toBe("stt");

      const tts = body.models.find((m) => m.id === "@cf/fastspeech");
      expect(tts.kind).toBe("tts");
      expect(tts.type).toBe("tts");

      const emb = body.models.find((m) => m.id === "@cf/baai/bge-base-en");
      expect(emb.kind).toBe("embedding");
      expect(emb.type).toBe("embedding");

      const unknown = body.models.find((m) => m.id === "@cf/custom/custom-sensor");
      expect(unknown.kind).toBeUndefined();
      expect(unknown.type).toBeUndefined();

      const imagegen = body.models.find((m) => m.id === "@cf/stabilityai/sdxl");
      expect(imagegen.kind).toBe("image");
      expect(imagegen.type).toBe("image");
    });

    it("Cloudflare: malformed raw item without non-empty id or name does not get synthesized id", async () => {
      const { mapCloudflareModelRow } = await import("@/lib/models/listingCompleteness.js");
      const malformed = { id: "", name: "   ", task: "Text Generation" };
      const normalized = mapCloudflareModelRow(malformed);
      expect(normalized.id).toBeFalsy();
      expect(normalized.raw).toBe(malformed);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Proxy-Aware Discovery & Fail-Closed Guard
  // --------------------------------------------------------------------------
  describe("Proxy-Aware Discovery & Fail-Closed Guard", () => {
    it("proxied OpenAI connection lists models via proxy and is complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-proxied-ok",
        provider: "openai",
        apiKey: "sk-test",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://proxy.internal:8080",
        },
      });

      // globalThis.fetch is mocked to simulate the upstream response received via proxy
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-proxied-ok/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-proxied-ok");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.models.length).toBe(2);
      expect(body.models[0].id).toBe("gpt-4o");
    });

    it("unsupported proxy type fails closed with 503", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-unsupported-proxy",
        provider: "openai",
        apiKey: "sk-test",
        providerSpecificData: {
          connectionProxyEnabled: true,
          proxyPool: {
            type: "unsupported_foreign_proxy",
            proxyUrl: "foreign://127.0.0.1:9090",
          },
        },
      });

      const req = new Request("http://localhost:20128/api/providers/conn-openai-unsupported-proxy/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-unsupported-proxy");

      expect(status).toBe(503);
      expect(body.error).toMatch(/unsupported.*proxy.*fail-closed/i);
    });

    it("no direct fetch when proxy configured: missing proxy target fails closed with 503", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-nv-missing-proxy-target",
        provider: "nvidia",
        apiKey: "nv-test",
        providerSpecificData: {
          strictProxy: true,
          connectionProxyEnabled: true,
          connectionProxyUrl: "", // missing target!
        },
      });

      const directFetchSpy = vi.fn();
      globalThis.fetch = directFetchSpy;

      const req = new Request("http://localhost:20128/api/providers/conn-nv-missing-proxy-target/models");
      const { body, status } = await resolveProviderModels(req, "conn-nv-missing-proxy-target");

      expect(status).toBe(503);
      expect(body.error).toMatch(/missing proxy URL.*fail-closed/i);
      // Ensure direct unproxied fetch was NEVER called!
      expect(directFetchSpy).not.toHaveBeenCalled();
    });

    it("unproxied connection unchanged: direct fetch succeeds and returns complete: true", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-openai-direct",
        provider: "openai",
        apiKey: "sk-test",
        providerSpecificData: {},
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const req = new Request("http://localhost:20128/api/providers/conn-openai-direct/models");
      const { body, status } = await resolveProviderModels(req, "conn-openai-direct");

      expect(status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.models.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Caller AbortSignal & Deadline Cancellation
  // --------------------------------------------------------------------------
  describe("Caller AbortSignal & Deadline Cancellation", () => {
    it("Caller signal abortion immediately cancels discovery and returns safe error or partial", async () => {
      const { resolveProviderModels } = await import("@/app/api/providers/[id]/models/route.js");
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-gemini-abort",
        provider: "gemini",
        apiKey: "AIzaSyKey",
      });

      const controller = new AbortController();
      controller.abort();

      const req = new Request("http://localhost:20128/api/providers/conn-gemini-abort/models");
      const { status } = await resolveProviderModels(req, "conn-gemini-abort", { signal: controller.signal });

      expect(status).toBe(500);
    });
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { convertOpenAIContentToParts } from "../../open-sse/translator/formats/gemini.js";
import codexAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import jina from "../../open-sse/providers/registry/jina-reader.js";
import tavily from "../../open-sse/providers/registry/tavily.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media-019 security & risk paths", () => {
  describe("Gemini remote image MIME injection & SSRF safety", () => {
    it("safely confines inferred MIME type to fixed whitelist despite malicious URLs", () => {
      const maliciousUrls = [
        "https://evil.com/exploit.jpg\r\nInjected-Header: evil",
        "https://evil.com/path.php?fake=.jpg",
        "https://evil.com/photo.unknown",
        "not-a-valid-url",
        "javascript:alert(1)",
        "https://evil.com/test.webp#fragment",
        "https://evil.com/test.gif?query=1&b=.png",
        "https://evil.com/payload.bmp",
      ];

      for (const url of maliciousUrls) {
        const parts = convertOpenAIContentToParts([{ type: "image_url", image_url: { url } }]);
        if (parts.length > 0 && parts[0].fileData) {
          const mime = parts[0].fileData.mimeType;
          // Must strictly be one of the known safe concrete image MIME types
          expect(["image/jpeg", "image/webp", "image/gif", "image/bmp", "image/png"]).toContain(mime);
          expect(mime).not.toContain("\r");
          expect(mime).not.toContain("\n");
        }
      }
    });

    it("falls back safely to default PNG MIME for non-matching or query-only URLs", () => {
      const url = "https://example.com/api/render?format=custom";
      const parts = convertOpenAIContentToParts([{ type: "image_url", image_url: { url } }]);
      expect(parts[0].fileData.mimeType).toBe("image/png");
    });
  });

  describe("Fetch format injection & account fallback protection", () => {
    it("rejects attempt to inject newlines or exploit header values in format", async () => {
      const maliciousFormat = "markdown\r\nX-Injected: evil";
      const result = await handleFetchCore({
        url: "https://example.com",
        provider: "jina-reader",
        format: maliciousFormat,
        providerConfig: jina.fetchConfig,
        credentials: { apiKey: "secret-key" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).not.toContain(maliciousFormat);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("does not leak secret credentials in unsupported format errors", async () => {
      const result = await handleFetchCore({
        url: "https://example.com",
        provider: "tavily",
        format: "unsupported_fmt",
        providerConfig: tavily.fetchConfig,
        credentials: { apiKey: "super-secret-tavily-api-key" },
      });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain("super-secret-tavily-api-key");
    });
  });

  describe("Codex image error framing, credential protection & abort semantics", () => {
    it("cancels upstream reader when stream is aborted or throws", async () => {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.failed\ndata: {\"error\":{\"message\":\"fail\"}}\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      });

      const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });

      await expect(codexAdapter.parseResponse(response, {
        log: null,
        streamToClient: false,
        requestBody: { input: [] },
      })).rejects.toThrow("fail");

      expect(cancelled).toBe(true);
    });

    it("bounds upstream assistant text error message to 300 chars to avoid memory exhaustion", async () => {
      const veryLongText = "A".repeat(2000);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: response.output_item.done\ndata: {"item":{"type":"message","content":[{"type":"text","text":"${veryLongText}"}]}}\n\n`
          ));
          controller.close();
        },
      });

      const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });

      await expect(codexAdapter.parseResponse(response, {
        log: null,
        streamToClient: false,
        requestBody: { input: [] },
      })).rejects.toThrow(/Codex returned text instead of an image: "A{300}"/);
    });

    it("does not leak OAuth accessToken or chatgptAccountId into error messages", async () => {
      const secretToken = "secret-oauth-token-12345";
      const secretAccount = "account-secret-99999";

      fetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      const result = await handleImageGenerationCore({
        modelInfo: { provider: "codex", model: "gpt-image-2.5" },
        body: { prompt: "cat" },
        credentials: {
          accessToken: secretToken,
          providerSpecificData: { chatgptAccountId: secretAccount },
        },
        log: null,
      });

      expect(result.success).toBe(false);
      const errorText = await result.response.text();
      expect(errorText).not.toContain(secretToken);
      expect(errorText).not.toContain(secretAccount);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import geminiAdapter, { resolveImageInput } from "../../open-sse/handlers/imageProviders/gemini.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import * as imageProviders from "../../open-sse/handlers/imageProviders/index.js";

const require = createRequire(import.meta.url);
const originalFetch = global.fetch;

// 1x1 transparent PNG base64 (>100 chars padded)
const VALID_BASE64_PAYLOAD = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".padEnd(120, "A");
const VALID_DATA_URI_PNG = `data:image/png;base64,${VALID_BASE64_PAYLOAD}`;
const VALID_DATA_URI_JPEG = `data:image/jpeg;base64,${VALID_BASE64_PAYLOAD}`;

describe("Gemini reference image inputs", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("resolveImageInput unit tests", () => {
    it("parses valid data URI with mimeType and base64 data", () => {
      const result = resolveImageInput(VALID_DATA_URI_PNG);
      expect(result).not.toBeNull();
      expect(result.inlineData).toBeDefined();
      expect(result.inlineData.mimeType).toBe("image/png");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("parses jpeg data URI correctly", () => {
      const result = resolveImageInput(VALID_DATA_URI_JPEG);
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/jpeg");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("parses raw base64 string (>100 chars) assuming image/png", () => {
      const result = resolveImageInput(VALID_BASE64_PAYLOAD);
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/png");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("supports reference object with url field containing data URI", () => {
      const result = resolveImageInput({ url: VALID_DATA_URI_PNG });
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/png");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("supports reference object with image_url.url field", () => {
      const result = resolveImageInput({ image_url: { url: VALID_DATA_URI_JPEG } });
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/jpeg");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("supports reference object with b64_json field", () => {
      const result = resolveImageInput({ b64_json: VALID_BASE64_PAYLOAD });
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/png");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });

    it("supports reference object with inlineData structure", () => {
      const result = resolveImageInput({
        inlineData: { mimeType: "image/webp", data: VALID_BASE64_PAYLOAD },
      });
      expect(result).not.toBeNull();
      expect(result.inlineData.mimeType).toBe("image/webp");
      expect(result.inlineData.data).toBe(VALID_BASE64_PAYLOAD);
    });
  });

  describe("SSRF and malformed input rejection", () => {
    it("rejects http and https URLs without fetching (SSRF defense)", () => {
      expect(resolveImageInput("http://example.com/test.png")).toBeNull();
      expect(resolveImageInput("https://169.254.169.254/latest/meta-data/")).toBeNull();
      expect(resolveImageInput("http://localhost:20128/api/secret")).toBeNull();
      expect(resolveImageInput({ url: "https://evil.com/ssrf" })).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects file and ftp schemes", () => {
      expect(resolveImageInput("file:///etc/passwd")).toBeNull();
      expect(resolveImageInput("ftp://ftp.example.com/file.png")).toBeNull();
      expect(resolveImageInput("//example.com/image.png")).toBeNull();
    });

    it("rejects non-image data URIs", () => {
      expect(resolveImageInput("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
      expect(resolveImageInput("data:application/json;base64,e30=")).toBeNull();
    });

    it("rejects malformed base64 containing non-base64 characters", () => {
      const invalidChars = "a".repeat(110) + "<script>alert(1)</script>";
      expect(resolveImageInput(invalidChars)).toBeNull();
      expect(resolveImageInput(`data:image/png;base64,${invalidChars}`)).toBeNull();
    });

    it("rejects strings shorter than 100 characters for raw base64", () => {
      expect(resolveImageInput("shortstring")).toBeNull();
      expect(resolveImageInput("a".repeat(99))).toBeNull();
    });

    it("rejects oversized inputs (>25MB)", () => {
      const oversized = "a".repeat(26 * 1024 * 1024);
      expect(resolveImageInput(oversized)).toBeNull();
    });

    it("gracefully handles invalid types and empty inputs", () => {
      expect(resolveImageInput(null)).toBeNull();
      expect(resolveImageInput(undefined)).toBeNull();
      expect(resolveImageInput("")).toBeNull();
      expect(resolveImageInput(12345)).toBeNull();
      expect(resolveImageInput(true)).toBeNull();
      expect(resolveImageInput({})).toBeNull();
      expect(resolveImageInput([])).toBeNull();
    });
  });

  describe("geminiAdapter.buildBody", () => {
    it("includes only text prompt when no reference image is provided", () => {
      const body = geminiAdapter.buildBody("gemini-2.5-flash-image", { prompt: "A watercolor flower" });
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].parts).toHaveLength(1);
      expect(body.contents[0].parts[0]).toEqual({ text: "A watercolor flower" });
      expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
    });

    it("prepends inlineData when body.image is a valid data URI", () => {
      const body = geminiAdapter.buildBody("gemini-2.5-flash-image", {
        prompt: "Make it cinematic",
        image: VALID_DATA_URI_PNG,
      });
      expect(body.contents[0].parts).toHaveLength(2);
      expect(body.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: VALID_BASE64_PAYLOAD },
      });
      expect(body.contents[0].parts[1]).toEqual({ text: "Make it cinematic" });
    });

    it("prepends inlineData when body.images array has a valid reference image", () => {
      const body = geminiAdapter.buildBody("gemini-2.5-flash-image", {
        prompt: "Edit this painting",
        images: [VALID_DATA_URI_JPEG],
      });
      expect(body.contents[0].parts).toHaveLength(2);
      expect(body.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "image/jpeg", data: VALID_BASE64_PAYLOAD },
      });
      expect(body.contents[0].parts[1]).toEqual({ text: "Edit this painting" });
    });

    it("ignores remote URL in body.image and sends prompt only", () => {
      const body = geminiAdapter.buildBody("gemini-2.5-flash-image", {
        prompt: "A beautiful landscape",
        image: "https://malicious.domain/payload.png",
      });
      expect(body.contents[0].parts).toHaveLength(1);
      expect(body.contents[0].parts[0]).toEqual({ text: "A beautiful landscape" });
    });
  });

  describe("Integration with handleImageGenerationCore", () => {
    it("sends reference image payload to Gemini upstream API", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Rendered scene" },
                    { inlineData: { data: "outputbase64image" } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const result = await handleImageGenerationCore({
        body: {
          prompt: "Enhance lighting",
          image: VALID_DATA_URI_PNG,
        },
        modelInfo: { provider: "gemini", model: "gemini-2.5-flash-image" },
        credentials: { apiKey: "test-gemini-key" },
        log: null,
      });

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const [fetchUrl, fetchOptions] = global.fetch.mock.calls[0];
      expect(fetchUrl).toContain("generativelanguage.googleapis.com");
      expect(fetchUrl).toContain("key=test-gemini-key");

      const sentBody = JSON.parse(fetchOptions.body);
      expect(sentBody.contents[0].parts[0].inlineData.data).toBe(VALID_BASE64_PAYLOAD);
      expect(sentBody.contents[0].parts[1].text).toBe("Enhance lighting");

      const responseJson = await result.response.json();
      expect(responseJson.data[0].b64_json).toBe("outputbase64image");
    });

    it("propagates error.status and resetsAtMs from executor failures", async () => {
      const mockAdapter = {
        useExecutor: true,
        executeViaExecutor: vi.fn().mockImplementation(async () => {
          const err = new Error("Rate limit exceeded");
          err.status = 429;
          err.resetsAtMs = 1799999999000;
          throw err;
        }),
      };

      vi.spyOn(imageProviders, "getImageAdapter").mockReturnValueOnce(mockAdapter);

      const result = await handleImageGenerationCore({
        body: { prompt: "Test prompt" },
        modelInfo: { provider: "test-prov", model: "test-model" },
        credentials: { apiKey: "test-key" },
        log: null,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(429);
      expect(result.resetsAtMs).toBe(1799999999000);
      expect(result.error).toContain("Rate limit exceeded");
    });
  });
});

describe("MITM directory creation", () => {
  it("creates MITM directory safely and idempotently on paths import", () => {
    const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-test-"));
    const oldDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempBaseDir;

    try {
      const pathsModulePath = require.resolve("../../src/mitm/paths.js");
      delete require.cache[pathsModulePath];

      const { DATA_DIR, MITM_DIR } = require("../../src/mitm/paths.js");

      expect(DATA_DIR).toBe(tempBaseDir);
      expect(MITM_DIR).toBe(path.join(tempBaseDir, "mitm"));
      expect(fs.existsSync(MITM_DIR)).toBe(true);

      // Re-requiring paths when directory already exists must succeed idempotently
      delete require.cache[pathsModulePath];
      const reloaded = require("../../src/mitm/paths.js");
      expect(reloaded.MITM_DIR).toBe(MITM_DIR);
      expect(fs.existsSync(reloaded.MITM_DIR)).toBe(true);
    } finally {
      if (oldDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = oldDataDir;
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

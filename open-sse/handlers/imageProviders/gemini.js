// Google Gemini adapter (Nano Banana models)
import { nowSec } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["gemini"]?.imageConfig?.baseUrl;

// Upper limit on base64 string length (~25 MB) to prevent memory exhaustion / DoS
const MAX_IMAGE_STRING_LENGTH = 25 * 1024 * 1024;

/**
 * Extract candidate string from supported reference input forms:
 * - String: direct data URI, raw base64, or URL (later checked)
 * - Object: { url }, { image_url: { url } }, { b64_json }, { data }, or { inlineData: { mimeType, data } }
 */
function extractImageString(input) {
  if (!input) return null;
  if (typeof input === "string") return input.trim();
  if (typeof input === "object") {
    if (input.inlineData && typeof input.inlineData.data === "string") {
      const mime = typeof input.inlineData.mimeType === "string" ? input.inlineData.mimeType : "image/png";
      return `data:${mime};base64,${input.inlineData.data.trim()}`;
    }
    if (typeof input.b64_json === "string") return input.b64_json.trim();
    if (typeof input.url === "string") return input.url.trim();
    if (input.image_url && typeof input.image_url.url === "string") return input.image_url.url.trim();
    if (typeof input.data === "string") return input.data.trim();
  }
  return null;
}

/**
 * Resolve reference image input into Gemini inlineData part.
 * SSRF protection: remote URLs are strictly rejected — never fetched.
 * Validates mime type and base64 character set, and enforces size ceiling.
 */
function resolveImageInput(input) {
  const raw = extractImageString(input);
  if (!raw || typeof raw !== "string" || raw.length > MAX_IMAGE_STRING_LENGTH) return null;

  // SSRF defense: never fetch client-provided URLs
  if (/^(https?|ftp|file):/i.test(raw) || raw.startsWith("//")) {
    return null;
  }

  // data:image/<type>;base64,<data> format
  const dataUriMatch = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1].toLowerCase();
    const data = dataUriMatch[2].replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/=]+$/.test(data)) {
      return { inlineData: { mimeType, data } };
    }
    return null;
  }

  // Raw base64 string (>100 chars, valid base64 charset)
  if (/^[A-Za-z0-9+/]/.test(raw) && raw.length > 100) {
    const cleaned = raw.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
      return { inlineData: { mimeType: "image/png", data: cleaned } };
    }
  }

  return null;
}

export { resolveImageInput };

const adapter = {
  buildUrl: (model, creds) => {
    const apiKey = creds?.apiKey || creds?.accessToken;
    const modelId = model.replace(/^models\//, "");
    return `${BASE_URL}/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  },
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: (_model, body) => {
    const parts = [{ text: body.prompt }];
    const imageInput = body.image || (Array.isArray(body.images) && body.images[0]);
    if (imageInput) {
      const inlineData = resolveImageInput(imageInput);
      if (inlineData) parts.unshift(inlineData);
    }
    return {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };
  },
  normalize: (responseBody, prompt) => {
    const parts = responseBody.candidates?.[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({ b64_json: p.inlineData.data }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};

export default adapter;

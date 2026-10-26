import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ollamaLocal, { resolveOllamaTtsHost } from "../../open-sse/handlers/ttsProviders/ollamaLocal.js";
import { responseToBase64, MAX_AUDIO_BYTES } from "../../open-sse/handlers/ttsProviders/_base.js";
import ollamaLocalRegistry from "../../open-sse/providers/registry/ollama-local.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { handleTts } from "../../src/sse/handlers/tts.js";
import * as localDb from "@/lib/localDb";

const originalFetch = global.fetch;

function mockOllamaAudioResponse(format = "audio/wav") {
  global.fetch.mockResolvedValueOnce(
    new Response(
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...new Array(100).fill(0)]),
      { status: 200, headers: { "Content-Type": format } }
    )
  );
}

describe("Ollama Local TTS Adapter", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts to /v1/audio/speech with model, input, voice, and response_format", async () => {
    mockOllamaAudioResponse();

    const result = await ollamaLocal.synthesize("Hello from Ollama Phonon", "phonon/Zoey", null, "json");

    expect(result.format).toBe("wav");
    expect(result.base64).toEqual(expect.any(String));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = global.fetch.mock.calls[0];
    expect(callUrl).toBe("http://localhost:11434/v1/audio/speech");
    expect(callInit.method).toBe("POST");
    expect(callInit.signal).toBeDefined();

    const sent = JSON.parse(callInit.body);
    expect(sent.model).toBe("phonon");
    expect(sent.voice).toBe("Zoey");
    expect(sent.input).toBe("Hello from Ollama Phonon");
    // Ollama upstream only accepts wav/pcm; format is normalized to wav
    expect(sent.response_format).toBe("wav");
  });

  it("uses default voice when only model is provided", async () => {
    mockOllamaAudioResponse();

    await ollamaLocal.synthesize("Testing default voice", "phonon", null, "mp3");

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("phonon");
    expect(sent.voice).toBe("default");
    expect(sent.response_format).toBe("wav");
  });

  it("maps standalone voice name to phonon model when phonon prefix is omitted", async () => {
    mockOllamaAudioResponse();

    await ollamaLocal.synthesize("Testing standalone voice", "Zoey", null, "wav");

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("phonon:multilingual");
    expect(sent.voice).toBe("Zoey");
    expect(sent.response_format).toBe("wav");
  });

  it("resolves custom baseUrl from credentials and forwards apiKey as Bearer token", async () => {
    mockOllamaAudioResponse();

    await ollamaLocal.synthesize("Remote Ollama instance", "phonon/Easton", {
      providerSpecificData: {
        baseUrl: "http://192.168.1.100:11434",
      },
      apiKey: "custom-token",
    }, "wav");

    expect(global.fetch.mock.calls[0][0]).toBe("http://192.168.1.100:11434/v1/audio/speech");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer custom-token");

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.voice).toBe("Easton");
  });

  it("does not forward Authorization header when apiKey is absent", async () => {
    mockOllamaAudioResponse();

    await ollamaLocal.synthesize("No auth", "phonon", {
      providerSpecificData: { baseUrl: "http://localhost:11434" },
    }, "wav");

    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("handles connection failure with informative error message", async () => {
    const error = new Error("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    global.fetch.mockRejectedValueOnce(error);

    await expect(
      ollamaLocal.synthesize("Should fail gracefully", "phonon", null)
    ).rejects.toThrow("Cannot connect to Ollama at http://localhost:11434. Please ensure Ollama is running");
  });

  it("handles 404 by querying /api/tags and retrying with alternative installed model", async () => {
    // 1st call fails 404
    global.fetch.mockResolvedValueOnce(new Response("model not found", { status: 404 }));
    // 2nd call: /api/tags
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "phonon:40m-multilingual" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    // 3rd call: retry with phonon:40m-multilingual succeeds
    mockOllamaAudioResponse();

    const res = await ollamaLocal.synthesize("Fallback test", "phonon:de", null, "wav");
    expect(res.format).toBe("wav");
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // Verify tag discovery had timeout signal
    const tagCall = global.fetch.mock.calls[1];
    expect(tagCall[0]).toBe("http://localhost:11434/api/tags");
    expect(tagCall[1].signal).toBeDefined();

    // Verify retry call used alternative model
    const retryCall = global.fetch.mock.calls[2];
    expect(retryCall[0]).toBe("http://localhost:11434/v1/audio/speech");
    const retryBody = JSON.parse(retryCall[1].body);
    expect(retryBody.model).toBe("phonon:40m-multilingual");
  });

  it("handles 400 voice not found by retrying with default voice", async () => {
    // 1st call: 400 with voice not found
    global.fetch.mockResolvedValueOnce(new Response("voice 'UnknownVoice' not found", { status: 400 }));
    // 2nd call: retry with voice "default" succeeds
    mockOllamaAudioResponse();

    const res = await ollamaLocal.synthesize("Voice fallback test", "phonon/UnknownVoice", null, "wav");
    expect(res.format).toBe("wav");
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const retryCall = global.fetch.mock.calls[1];
    const retryBody = JSON.parse(retryCall[1].body);
    expect(retryBody.voice).toBe("default");
  });

  describe("Hardening & Security", () => {
    it("attaches AbortSignal.timeout to every fetch call", async () => {
      mockOllamaAudioResponse();

      await ollamaLocal.synthesize("Testing timeout signal", "phonon", null, "wav");

      const [, callInit] = global.fetch.mock.calls[0];
      expect(callInit.signal).toBeDefined();
      expect(callInit.signal instanceof AbortSignal).toBe(true);
    });

    it("rejects hanging fetch when signal aborts with TimeoutError", async () => {
      const timeoutErr = new Error("The operation timed out");
      timeoutErr.name = "TimeoutError";
      global.fetch.mockRejectedValueOnce(timeoutErr);

      await expect(
        ollamaLocal.synthesize("Hanging fetch", "phonon", null)
      ).rejects.toThrow("Timeout waiting for Ollama at http://localhost:11434");
    });

    it("rejects non-http/https URL schemes in baseUrl", () => {
      expect(() => {
        resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "ftp://attacker.com/v1" } });
      }).toThrow(/Invalid base URL protocol "ftp:". Only http: and https: are allowed/);

      expect(() => {
        resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "file:///etc/passwd" } });
      }).toThrow(/Invalid base URL protocol "file:". Only http: and https: are allowed/);

      expect(() => {
        resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "gopher://evil.host" } });
      }).toThrow(/Invalid base URL protocol "gopher:". Only http: and https: are allowed/);
    });

    it("rejects baseUrl containing embedded credentials", () => {
      expect(() => {
        resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "http://admin:secret@127.0.0.1:11434" } });
      }).toThrow(/Base URL must not contain credentials/);

      expect(() => {
        resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "https://user@remote-ollama.internal" } });
      }).toThrow(/Base URL must not contain credentials/);
    });

    it("ensures base URL comes ONLY from credentials.providerSpecificData.baseUrl or default", () => {
      // Missing credentials → default localhost
      expect(resolveOllamaTtsHost(null)).toBe("http://localhost:11434");
      expect(resolveOllamaTtsHost({})).toBe("http://localhost:11434");
      expect(resolveOllamaTtsHost({ providerSpecificData: {} })).toBe("http://localhost:11434");

      // Valid admin baseUrl
      expect(resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "http://10.0.0.5:11434" } }))
        .toBe("http://10.0.0.5:11434");

      // Strips trailing /v1 and /v1/audio/speech suffixes
      expect(resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "http://10.0.0.5:11434/v1/audio/speech" } }))
        .toBe("http://10.0.0.5:11434");
      expect(resolveOllamaTtsHost({ providerSpecificData: { baseUrl: "http://10.0.0.5:11434/v1" } }))
        .toBe("http://10.0.0.5:11434");
    });
  });

  describe("responseToBase64 byte cap and format validation", () => {
    it("recognizes PCM format in content-type", async () => {
      const res = new Response(new Uint8Array(200).fill(1), {
        status: 200,
        headers: { "Content-Type": "audio/pcm" },
      });
      const parsed = await responseToBase64(res, "wav");
      expect(parsed.format).toBe("pcm");
      expect(parsed.base64).toEqual(expect.any(String));
    });

    it("rejects audio exceeding 50 MiB via Content-Length header", async () => {
      const res = new Response(new Uint8Array(200), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(MAX_AUDIO_BYTES + 1024),
        },
      });

      await expect(responseToBase64(res)).rejects.toThrow(/exceeds maximum allowed size/);
    });

    it("rejects audio exceeding 50 MiB in buffer", async () => {
      // Mock an oversized arrayBuffer
      const fakeRes = {
        headers: new Headers({ "Content-Type": "audio/wav" }),
        arrayBuffer: vi.fn().mockResolvedValueOnce({ byteLength: MAX_AUDIO_BYTES + 1 }),
      };

      await expect(responseToBase64(fakeRes)).rejects.toThrow(/exceeds maximum allowed size/);
    });

    it("rejects empty audio (< 100 bytes)", async () => {
      const res = new Response(new Uint8Array(50), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });

      await expect(responseToBase64(res)).rejects.toThrow("Upstream returned empty audio");
    });
  });

  describe("Registry Configuration", () => {
    it("declares serviceKind tts and ttsConfig in ollama-local registry", () => {
      expect(ollamaLocalRegistry).toBeDefined();
      expect(ollamaLocalRegistry.serviceKinds).toContain("tts");
      expect(ollamaLocalRegistry.ttsConfig).toEqual({
        baseUrl: "http://localhost:11434/v1/audio/speech",
        path: "/v1/audio/speech",
        defaultModel: "phonon",
        authType: "apikey",
        format: "openai",
      });

      const phononModels = (PROVIDER_MODELS["ollama-local"] || []).filter((m) => m.kind === "tts");
      expect(phononModels.length).toBe(15);
      expect(phononModels.map((m) => m.id)).toContain("phonon");
      expect(phononModels.map((m) => m.id)).toContain("phonon:latest");
      expect(phononModels.map((m) => m.id)).toContain("phonon:multilingual");
      expect(phononModels.map((m) => m.id)).toContain("phonon:en");
    });
  });

  describe("Authentication and ACL gate on handleTts", () => {
    it("rejects unauthenticated request when requireApiKey is true", async () => {
      vi.spyOn(localDb, "getSettings").mockResolvedValueOnce({ requireApiKey: true });

      const req = new Request("http://localhost:20128/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "ollama-local/phonon",
          input: "Should be blocked by auth",
        }),
      });

      const res = await handleTts(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Missing API key");
    });

    it("rejects request with invalid API key when requireApiKey is true", async () => {
      vi.spyOn(localDb, "getSettings").mockResolvedValueOnce({ requireApiKey: true });

      const req = new Request("http://localhost:20128/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer invalid-test-key",
        },
        body: JSON.stringify({
          model: "ollama-local/phonon",
          input: "Should be blocked by auth",
        }),
      });

      const res = await handleTts(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid API key");
    });
  });
});

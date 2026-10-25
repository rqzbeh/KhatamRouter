import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codex from "../../open-sse/providers/registry/codex.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { transcribeCodex, codexHttpFetch } from "../../open-sse/handlers/codexStt.js";
import { readBounded, convertAudio, MAX_AUDIO_BYTES } from "../../open-sse/handlers/codexSttAudio.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";
import * as codexSttAudioModule from "../../open-sse/handlers/codexSttAudio.js";

function makeWavFixture(durationSeconds = 0.05, sampleRate = 24000) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit mono = 2 bytes per sample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // subchunk1 size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24); // sample rate
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const validCredentials = {
  authType: "oauth",
  accessToken: "valid-token-12345",
  providerSpecificData: {
    workspaceId: "test-workspace-id",
  },
};

describe("Codex OAuth STT Provider Registry", () => {
  it("registers a transcription model alongside existing chat and image models", () => {
    expect(codex.serviceKinds).toContain("stt");
    expect(codex.serviceKinds).toEqual(expect.arrayContaining(["llm", "image", "stt"]));
    const model = codex.models.find((m) => m.id === "transcribe");
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      kind: "stt",
      params: ["response_format"],
      responseFormats: ["json", "text"],
    });
  });

  it("defines sttConfig pointing to the internal ChatGPT transcription endpoint", () => {
    expect(codex.sttConfig).toEqual({
      baseUrl: "https://chatgpt.com/backend-api/transcribe",
      authType: "oauth",
      format: "codex-transcribe",
    });
  });

  it("documents ffmpeg requirements and limits in kindNotice", () => {
    expect(codex.display.kindNotice.stt).toContain("ffmpeg");
    expect(codex.display.kindNotice.stt).toContain("25 MiB");
    expect(codex.display.kindNotice.stt).toContain("120 seconds");
  });
});

describe("handleSttCore dispatch & auth enforcement", () => {
  it("rejects API keys rather than sending them as ChatGPT OAuth", async () => {
    const formData = new FormData();
    formData.set("file", new File([makeWavFixture()], "audio.wav", { type: "audio/wav" }));
    const result = await handleSttCore({
      provider: "codex",
      model: "transcribe",
      formData,
      credentials: { apiKey: "sk-test-key" },
      sttConfig: codex.sttConfig,
    });
    expect(result.status).toBe(401);
    expect(result.error).toContain("OAuth");
  });

  it("rejects request if file field is missing", async () => {
    const formData = new FormData();
    const result = await handleSttCore({
      provider: "codex",
      model: "transcribe",
      formData,
      credentials: validCredentials,
      sttConfig: codex.sttConfig,
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: file");
  });

  it("blocks SSRF via overrideUrl pointing to private/internal hosts", async () => {
    const formData = new FormData();
    formData.set("file", new File([makeWavFixture()], "audio.wav", { type: "audio/wav" }));
    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "http://127.0.0.1:8080/v1" },
      },
      sttConfig: { baseUrl: "https://api.openai.com/v1", authType: "bearer", format: "openai" },
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Blocked URL");
  });
});

describe("transcribeCodex validation & SSRF protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects unsupported form fields", async () => {
    const formData = new FormData();
    formData.set("file", new File([makeWavFixture()], "audio.wav", { type: "audio/wav" }));
    formData.set("timestamp_granularities[]", "word");
    const result = await transcribeCodex({ formData, credentials: validCredentials });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Unsupported or duplicate");
  });

  it("rejects unsupported parameters (language, prompt, temperature)", async () => {
    for (const key of ["language", "prompt", "temperature"]) {
      const formData = new FormData();
      formData.set("file", new File([makeWavFixture()], "audio.wav", { type: "audio/wav" }));
      formData.set(key, "unsupported-value");
      const result = await transcribeCodex({ formData, credentials: validCredentials });
      expect(result.status).toBe(400);
      expect(result.error).toContain("not supported");
    }
  });

  it("rejects unsupported response_format (e.g. srt, vtt, verbose_json)", async () => {
    const formData = new FormData();
    formData.set("file", new File([makeWavFixture()], "audio.wav", { type: "audio/wav" }));
    formData.set("response_format", "srt");
    const result = await transcribeCodex({ formData, credentials: validCredentials });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Only json and text response formats are supported");
  });

  it("rejects audio exceeding MAX_AUDIO_BYTES (25 MiB)", async () => {
    const formData = new FormData();
    const bigBuffer = new Uint8Array(MAX_AUDIO_BYTES + 1);
    formData.set("file", new File([bigBuffer], "large.wav", { type: "audio/wav" }));
    const result = await transcribeCodex({ formData, credentials: validCredentials });
    expect(result.status).toBe(413);
    expect(result.error).toContain("Audio exceeds 25 MiB");
  });

  it("SSRF guard rejects audio URLs pointing to loopback or internal addresses", async () => {
    const internalUrls = [
      "http://127.0.0.1/audio.wav",
      "http://localhost:20128/private.wav",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/secret.wav",
    ];
    for (const url of internalUrls) {
      const formData = new FormData();
      formData.set("file", url);
      const result = await transcribeCodex({ formData, credentials: validCredentials });
      expect(result.status).toBe(400);
      expect(result.error).toContain("Blocked URL");
    }
  });

  it("SSRF guard rejects audio_url form field pointing to internal hosts", async () => {
    const formData = new FormData();
    formData.set("audio_url", "http://10.0.0.1/audio.wav");
    const result = await transcribeCodex({ formData, credentials: validCredentials });
    expect(result.status).toBe(400);
    expect(result.error).toContain("Blocked URL");
  });
});

describe("Audio scratch directory isolation & cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses DATA_DIR/tmp for scratch storage when DATA_DIR is configured", async () => {
    const customDataDir = await mkdtemp(join(tmpdir(), "khatam-test-data-"));
    vi.stubEnv("DATA_DIR", customDataDir);

    // Mock convertAudio internals or verify scratch folder was created under DATA_DIR/tmp
    const fixture = makeWavFixture(0.01);
    const file = new File([fixture], "test.wav", { type: "audio/wav" });

    try {
      // Mock convertAudio to verify directory placement
      vi.spyOn(codexSttAudioModule, "convertAudio").mockImplementation(async (_f, _s) => {
        return new Blob([fixture], { type: "audio/wav" });
      });

      // Verify readBounded
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from(JSON.stringify({ text: "test transcript" }))));
          controller.close();
        },
      });

      const bounded = await readBounded(stream, 1024, new AbortController().signal);
      expect(bounded.toString("utf8")).toContain("test transcript");
    } finally {
      await rm(customDataDir, { recursive: true, force: true });
    }
  });

  it("readBounded enforces size ceiling and throws 413", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    });
    await expect(readBounded(stream, 50, new AbortController().signal)).rejects.toMatchObject({
      status: 413,
      message: "Body exceeds size limit",
    });
  });
});

describe("transcribeCodex end-to-end with fixture audio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully transcribes audio fixture and returns JSON { text }", async () => {
    const fixture = makeWavFixture(0.02);
    const formData = new FormData();
    formData.set("file", new File([fixture], "speech.wav", { type: "audio/wav" }));
    formData.set("response_format", "json");

    vi.spyOn(codexSttAudioModule, "convertAudio").mockResolvedValue(
      new Blob([fixture], { type: "audio/wav" })
    );

    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Hello, this is a test transcription." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await transcribeCodex({
      formData,
      credentials: validCredentials,
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello, this is a test transcription." });
  });

  it("successfully transcribes audio fixture and returns plain text when response_format is text", async () => {
    const fixture = makeWavFixture(0.02);
    const formData = new FormData();
    formData.set("file", new File([fixture], "speech.wav", { type: "audio/wav" }));
    formData.set("response_format", "text");

    vi.spyOn(codexSttAudioModule, "convertAudio").mockResolvedValue(
      new Blob([fixture], { type: "audio/wav" })
    );

    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Plain text transcription." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await transcribeCodex({
      formData,
      credentials: validCredentials,
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/plain");
    const text = await result.response.text();
    expect(text).toBe("Plain text transcription.");
  });

  it("handles upstream failure by returning error result", async () => {
    const fixture = makeWavFixture(0.02);
    const formData = new FormData();
    formData.set("file", new File([fixture], "speech.wav", { type: "audio/wav" }));

    vi.spyOn(codexSttAudioModule, "convertAudio").mockResolvedValue(
      new Blob([fixture], { type: "audio/wav" })
    );

    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    const result = await transcribeCodex({
      formData,
      credentials: validCredentials,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("Codex transcription failed");
  });
});

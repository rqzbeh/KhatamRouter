import { getApiKeys } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { unwrapClineEnvelope } from "open-sse/shared/clineEnvelope.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { DEFAULT_PROBE_TIMEOUT_MS } from "@/lib/models/modelTestBatch.js";

const CLI_TOKEN_SALT = "9r-cli-auth";

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    const activeKeys = keys.filter((k) => k.isActive !== false);
    apiKey = (activeKeys.find((k) => !k.access?.restricted) || activeKeys[0])?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

function extractHeaders(res) {
  const retryAfter = res?.headers?.get?.("retry-after");
  if (retryAfter && typeof retryAfter === "string") {
    return { "retry-after": retryAfter.trim().slice(0, 128) };
  }
  return {};
}

function extractCodeAndType(parsed) {
  const out = {};
  if (typeof parsed?.error?.code === "string") out.code = parsed.error.code.slice(0, 128);
  else if (typeof parsed?.code === "string") out.code = parsed.code.slice(0, 128);

  if (typeof parsed?.error?.type === "string") out.type = parsed.error.type.slice(0, 128);
  else if (typeof parsed?.type === "string") out.type = parsed.type.slice(0, 128);

  return out;
}

async function readResponseTextBounded(res, signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (!res) return { text: "", timedOut: false, aborted: false };

  // Fallback when res.body is not a ReadableStream with getReader (e.g. legacy test mocks)
  if (!res.body || typeof res.body.getReader !== "function") {
    let fbTimer = null;
    let fbOnAbort = null;
    try {
      const textPromise = Promise.resolve()
        .then(() => (typeof res.text === "function" ? res.text() : ""))
        .catch(() => "");
      const fbTimeout = new Promise((resolve) => {
        fbTimer = setTimeout(() => {
          try { Promise.resolve(res.body?.cancel?.()).catch(() => {}); } catch {}
          resolve({ timedOut: true, aborted: false });
        }, timeoutMs);
      });
      const fbAbort = new Promise((resolve) => {
        if (signal?.aborted) {
          try { Promise.resolve(res.body?.cancel?.()).catch(() => {}); } catch {}
          resolve({ timedOut: false, aborted: true });
          return;
        }
        if (signal) {
          fbOnAbort = () => {
            try { Promise.resolve(res.body?.cancel?.()).catch(() => {}); } catch {}
            resolve({ timedOut: false, aborted: true });
          };
          signal.addEventListener("abort", fbOnAbort, { once: true });
        }
      });
      const outcome = await Promise.race([textPromise, fbTimeout, fbAbort]);
      if (outcome && typeof outcome === "object" && (outcome.timedOut || outcome.aborted)) {
        return { text: "", timedOut: outcome.timedOut === true, aborted: outcome.aborted === true };
      }
      return { text: typeof outcome === "string" ? outcome : "", timedOut: false, aborted: false };
    } finally {
      if (fbTimer !== null) clearTimeout(fbTimer);
      if (signal && fbOnAbort) signal.removeEventListener("abort", fbOnAbort);
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;
  let aborted = false;
  let timer = null;
  let onAbort = null;
  let isDone = false;

  const cancelReader = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancelReader();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  const abortPromise = new Promise((resolve) => {
    if (signal?.aborted) {
      aborted = true;
      cancelReader();
      resolve({ aborted: true });
      return;
    }
    if (signal) {
      onAbort = () => {
        aborted = true;
        cancelReader();
        resolve({ aborted: true });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    while (!isDone && !timedOut && !aborted) {
      const readPromise = reader.read().catch(() => ({ done: true, value: undefined }));
      const outcome = await Promise.race([readPromise, timeoutPromise, abortPromise]);

      if (outcome.timedOut || outcome.aborted) {
        break;
      }

      if (outcome.done) {
        isDone = true;
        break;
      }

      if (outcome.value) {
        buffer += decoder.decode(outcome.value, { stream: true });
        if (buffer.length > 256 * 1024) {
          cancelReader();
          break;
        }
      }
    }
    buffer += decoder.decode();
  } catch {
    cancelReader();
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
    try {
      reader.releaseLock();
    } catch {}
  }

  if (timedOut || aborted) {
    return { text: "", timedOut, aborted };
  }

  return { text: buffer, timedOut: false, aborted: false };
}

async function fetchWithSignalGuard(url, init, signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  let timer = null;
  let onAbort = null;
  let guardSettled = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Fetch connection timed out");
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });

  const abortPromise = new Promise((_, reject) => {
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    if (signal) {
      onAbort = () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  const fetchPromise = Promise.resolve()
    .then(() => fetch(url, init))
    .then((res) => {
      if (guardSettled) {
        // Late-resolved fetch response: cancel body stream immediately so socket/resources are not leaked
        try {
          Promise.resolve(res?.body?.cancel?.()).catch(() => {});
        } catch {}
      }
      return res;
    });
  fetchPromise.catch(() => {});

  try {
    return await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
  } finally {
    guardSettled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  }
}

export async function pingModelByKind(
  model,
  kind,
  baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`,
  options = {}
) {
  let targetUrl = baseUrl;
  let opts = options;
  if (typeof baseUrl === "object" && baseUrl !== null) {
    opts = baseUrl;
    targetUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
  }

  const callerSignal = opts?.signal;
  const timeoutMs = typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  const headers = await getInternalHeaders();
  const start = Date.now();

  try {
    if (kind === "embedding") {
      const res = await fetchWithSignalGuard(
        `${targetUrl}/api/v1/embeddings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: "test" }),
          signal: combinedSignal,
        },
        combinedSignal,
        timeoutMs
      );
      const latencyMs = Date.now() - start;
      const { text: rawText, timedOut: readTimedOut, aborted: readAborted } = await readResponseTextBounded(
        res,
        combinedSignal,
        timeoutMs
      );
      if (readTimedOut || readAborted) {
        return {
          ok: false,
          latencyMs,
          status: 0,
          error: "Request timed out or aborted reading response",
          code: "timeout",
        };
      }
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      const resHeaders = extractHeaders(res);
      const codeType = extractCodeAndType(parsed);

      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.error || rawText;
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
          status: res.status,
          headers: resHeaders,
          ...codeType,
        };
      }
      const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
      if (!hasEmbedding) {
        return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data", headers: resHeaders };
      }
      return { ok: true, latencyMs, error: null, status: res.status, headers: resHeaders };
    }

    if (kind === "image") {
      const res = await fetchWithSignalGuard(
        `${targetUrl}/api/v1/images/generations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model, prompt: "test" }),
          signal: combinedSignal,
        },
        combinedSignal,
        timeoutMs
      );
      const latencyMs = Date.now() - start;
      const { text: rawText, timedOut: readTimedOut, aborted: readAborted } = await readResponseTextBounded(
        res,
        combinedSignal,
        timeoutMs
      );
      if (readTimedOut || readAborted) {
        return {
          ok: false,
          latencyMs,
          status: 0,
          error: "Request timed out or aborted reading response",
          code: "timeout",
        };
      }
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      const resHeaders = extractHeaders(res);
      const codeType = extractCodeAndType(parsed);

      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
          status: res.status,
          headers: resHeaders,
          ...codeType,
        };
      }

      const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
      if (!hasImages) {
        return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model", headers: resHeaders };
      }
      return { ok: true, latencyMs, error: null, status: res.status, headers: resHeaders };
    }

    if (kind === "stt") {
      const form = new FormData();
      const sampleAudio = createSilentWavFile();
      form.append("file", sampleAudio, "test.wav");
      form.append("model", model);

      const res = await fetchWithSignalGuard(
        `${targetUrl}/api/v1/audio/transcriptions`,
        {
          method: "POST",
          headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
          body: form,
          signal: combinedSignal,
        },
        combinedSignal,
        timeoutMs
      );
      const latencyMs = Date.now() - start;
      const { text: rawText, timedOut: readTimedOut, aborted: readAborted } = await readResponseTextBounded(
        res,
        combinedSignal,
        timeoutMs
      );
      if (readTimedOut || readAborted) {
        return {
          ok: false,
          latencyMs,
          status: 0,
          error: "Request timed out or aborted reading response",
          code: "timeout",
        };
      }
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      const resHeaders = extractHeaders(res);
      const codeType = extractCodeAndType(parsed);

      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
          status: res.status,
          headers: resHeaders,
          ...codeType,
        };
      }

      const text = typeof parsed?.text === "string" ? parsed.text : "";
      if (!text.trim()) {
        return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model", headers: resHeaders };
      }
      return { ok: true, latencyMs, error: null, status: res.status, headers: resHeaders };
    }

    if (kind === "systemone") {
      const res = await fetchWithSignalGuard(
        `${targetUrl}/api/v1/systemone`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            state: "Customer: I was charged twice for my order this morning.",
            questions: {
              probe: { type: "noul", instructions: "Is the customer reporting a billing problem?" },
            },
          }),
          signal: combinedSignal,
        },
        combinedSignal,
        timeoutMs
      );
      const latencyMs = Date.now() - start;
      const { text: rawText, timedOut: readTimedOut, aborted: readAborted } = await readResponseTextBounded(
        res,
        combinedSignal,
        timeoutMs
      );
      if (readTimedOut || readAborted) {
        return {
          ok: false,
          latencyMs,
          status: 0,
          error: "Request timed out or aborted reading response",
          code: "timeout",
        };
      }
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      const resHeaders = extractHeaders(res);
      const codeType = extractCodeAndType(parsed);

      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
          status: res.status,
          headers: resHeaders,
          ...codeType,
        };
      }

      const hasAnswers = parsed?.answers && typeof parsed.answers === "object" && Object.keys(parsed.answers).length > 0;
      if (!hasAnswers) {
        return { ok: false, latencyMs, status: res.status, error: "Provider returned no answers for this model", headers: resHeaders };
      }
      return { ok: true, latencyMs, error: null, status: res.status, headers: resHeaders };
    }

    const res = await fetchWithSignalGuard(
      `${targetUrl}/api/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: combinedSignal,
      },
      combinedSignal,
      timeoutMs
    );
    const latencyMs = Date.now() - start;

    const { text: rawText, timedOut: readTimedOut, aborted: readAborted } = await readResponseTextBounded(
      res,
      combinedSignal,
      timeoutMs
    );
    if (readTimedOut || readAborted) {
      return {
        ok: false,
        latencyMs,
        status: 0,
        error: "Request timed out or aborted reading response",
        code: "timeout",
      };
    }
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    const providerId = resolveProviderId(String(model).split("/")[0]);
    parsed = unwrapClineEnvelope(parsed, providerId);

    const resHeaders = extractHeaders(res);
    const codeType = extractCodeAndType(parsed);

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`,
        status: res.status,
        headers: resHeaders,
        ...codeType,
      };
    }

    const providerStatus = parsed?.status;
    const providerMsg = parsed?.msg || parsed?.message;
    const hasProviderErrorStatus = providerStatus !== undefined
      && providerStatus !== null
      && String(providerStatus) !== "200"
      && String(providerStatus) !== "0";
    if (hasProviderErrorStatus && providerMsg) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
        headers: resHeaders,
        ...codeType,
      };
    }

    if (parsed?.error) {
      const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: String(providerError).slice(0, 240),
        headers: resHeaders,
        ...codeType,
      };
    }

    const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    const firstChoice = parsed?.choices?.[0] || {};
    const hasReasoning =
      firstChoice.message?.reasoning ||
      firstChoice.message?.reasoning_content ||
      firstChoice.message?.thinking ||
      firstChoice.message?.thinking_content;
    const contentEmpty = !String(firstChoice.message?.content || "").trim();
    if (hasChoices && firstChoice.finish_reason === "length" && contentEmpty && hasReasoning) {
      return { ok: true, latencyMs, error: null, status: res.status, note: "reasoning-only response (length-limited)", headers: resHeaders };
    }

    if (!hasChoices) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: "Provider returned no completion choices for this model",
        headers: resHeaders,
      };
    }

    return { ok: true, latencyMs, error: null, status: res.status, headers: resHeaders };
  } catch (err) {
    const isAbort = err?.name === "AbortError" || callerSignal?.aborted;
    const isTimeout = err?.name === "TimeoutError" || /timed?\s*out/i.test(err?.message);
    const isAbortOrTimeout = isAbort || isTimeout;
    return {
      ok: false,
      latencyMs: Date.now() - start,
      status: isAbortOrTimeout ? 0 : 500,
      error: isAbortOrTimeout ? "Request timed out or aborted" : `Request failed: ${err?.message || err}`,
      code: isAbortOrTimeout ? "timeout" : "network_error",
    };
  }
}

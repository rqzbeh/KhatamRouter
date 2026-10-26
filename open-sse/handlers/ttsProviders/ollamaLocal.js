import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { responseToBase64, throwUpstreamError } from "./_base.js";

const DEFAULT_MODEL = "phonon:multilingual";
const DEFAULT_VOICE = "default";
const DEFAULT_HOST = "http://localhost:11434";
const SYNTHESIS_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = FETCH_CONNECT_TIMEOUT_MS || 10000;

/**
 * Validates and normalizes Ollama base URL.
 * Accepts only http: and https: protocols, and rejects URLs with embedded credentials.
 * The base URL comes ONLY from credentials.providerSpecificData.baseUrl or default.
 *
 * @param {object} credentials
 * @returns {string} Sanitized host with trailing slashes and /v1 paths stripped
 */
export function resolveOllamaTtsHost(credentials) {
  const rawHost = credentials?.providerSpecificData?.baseUrl?.trim() || DEFAULT_HOST;
  let parsed;
  try {
    parsed = new URL(rawHost);
  } catch {
    throw new Error(`Invalid Ollama base URL: ${rawHost}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid base URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL must not contain credentials");
  }

  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return base
    .replace(/\/+$/, "")
    .replace(/\/v1\/audio\/speech$/, "")
    .replace(/\/v1$/, "");
}

const adapter = {
  async synthesize(text, model, credentials, responseFormat = "mp3") {
    const host = resolveOllamaTtsHost(credentials);

    let ttsModel = DEFAULT_MODEL;
    let voice = DEFAULT_VOICE;

    if (model) {
      const parts = String(model).split("/").filter(Boolean);
      if (parts.length >= 2) {
        ttsModel = parts[0];
        voice = parts.slice(1).join("/");
      } else if (parts.length === 1) {
        const val = parts[0];
        if (val.startsWith("phonon")) {
          ttsModel = val;
          voice = DEFAULT_VOICE;
        } else {
          // If val does not start with phonon, treat it as a voice name with default model
          ttsModel = DEFAULT_MODEL;
          voice = val;
        }
      }
    }

    // Ollama /v1/audio/speech natively supports "wav" or "pcm".
    // If client requested "mp3" or "json" (or unspecified), request "wav" from Ollama.
    const upstreamFormat = (responseFormat === "pcm") ? "pcm" : "wav";

    const payload = {
      model: ttsModel,
      input: text,
      voice,
      response_format: upstreamFormat,
    };

    const headers = {
      "Content-Type": "application/json",
    };
    if (credentials?.apiKey) {
      headers["Authorization"] = `Bearer ${credentials.apiKey}`;
    }

    let res;
    try {
      res = await fetch(`${host}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      });

      // If requested phonon model 404s, discover installed phonon tags or fallback
      if (!res.ok && res.status === 404 && ttsModel.startsWith("phonon")) {
        let altModel = null;
        try {
          const tagsRes = await fetch(`${host}/api/tags`, {
            signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
          }).catch(() => null);
          if (tagsRes && tagsRes.ok) {
            const data = await tagsRes.json().catch(() => ({}));
            const installedModels = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
            const found = installedModels.find((m) => m.startsWith("phonon") && m !== ttsModel);
            if (found) altModel = found;
          }
        } catch {}

        if (!altModel) {
          altModel = ttsModel === "phonon" ? "phonon:multilingual" : ttsModel === "phonon:multilingual" ? "phonon:latest" : null;
        }

        if (altModel) {
          const retryModelRes = await fetch(`${host}/v1/audio/speech`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...payload, model: altModel }),
            signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
          });
          if (retryModelRes.ok) {
            return responseToBase64(retryModelRes, responseFormat || "wav");
          }
          // If altModel gave a 400 (e.g. voice mismatch), continue to voice fallback below
          res = retryModelRes;
          ttsModel = altModel;
        }
      }

      // If requested voice is not supported by this checkpoint, fallback to "default" voice
      if (!res.ok && res.status === 400 && voice !== DEFAULT_VOICE) {
        const errText = await res.clone().text().catch(() => "");
        if (errText.includes("voice") && errText.includes("not found")) {
          const retryVoiceRes = await fetch(`${host}/v1/audio/speech`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...payload, model: ttsModel, voice: DEFAULT_VOICE }),
            signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
          });
          if (retryVoiceRes.ok) {
            return responseToBase64(retryVoiceRes, responseFormat || "wav");
          }
        }
      }
    } catch (err) {
      if (err.name === "TimeoutError" || err.cause?.name === "TimeoutError") {
        throw new Error(`Timeout waiting for Ollama at ${host}`);
      }
      if (err.cause?.code === "ECONNREFUSED" || err.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
        throw new Error(`Cannot connect to Ollama at ${host}. Please ensure Ollama is running (e.g. 'ollama serve').`);
      }
      throw err;
    }

    if (!res.ok) {
      await throwUpstreamError(res);
    }

    return responseToBase64(res, responseFormat || "wav");
  },
};

export default adapter;

import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";

const DEFAULT_HOST = "http://localhost:11434";
const CONNECT_TIMEOUT_MS = FETCH_CONNECT_TIMEOUT_MS || 10000;

/**
 * Validates and normalizes Ollama embedding base URL.
 * Accepts only http: and https: protocols, and rejects URLs with embedded credentials.
 * The base URL must come ONLY from creds.providerSpecificData.baseUrl or default http://localhost:11434,
 * never from request body or context.
 *
 * @param {object} creds
 * @returns {string} Sanitized host with trailing slashes, /v1, and /v1/embeddings stripped
 */
export function resolveOllamaEmbeddingHost(creds) {
  const rawBaseUrl = creds?.providerSpecificData?.baseUrl;
  const rawHost = (rawBaseUrl && typeof rawBaseUrl === "string" && rawBaseUrl.trim()) || DEFAULT_HOST;

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
    .replace(/\/v1\/embeddings$/, "")
    .replace(/\/v1$/, "");
}

const adapter = {
  timeoutMs: CONNECT_TIMEOUT_MS,
  buildUrl: (_model, creds) => {
    const host = resolveOllamaEmbeddingHost(creds);
    return `${host}/v1/embeddings`;
  },
  buildHeaders: (creds) => {
    const headers = {
      "Content-Type": "application/json",
    };
    if (creds?.apiKey) {
      headers["Authorization"] = `Bearer ${creds.apiKey}`;
    }
    return headers;
  },
  buildBody: (model, { input, encoding_format, dimensions }) => {
    const body = { model, input };
    if (encoding_format) body.encoding_format = encoding_format;
    if (dimensions != null && dimensions !== "") {
      const dim = Number(dimensions);
      if (Number.isFinite(dim) && dim > 0) body.dimensions = dim;
    }
    return body;
  },
  normalize: (responseBody) => responseBody,
};

export default adapter;

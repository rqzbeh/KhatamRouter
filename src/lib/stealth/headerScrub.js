/**
 * Reverse-Proxy Header Scrubbing & Encoding Normalization (Wave 5)
 *
 * Removes proxy tracing, reverse-proxy indicators, and browser/Electron fingerprints
 * that reveal requests originated through third-party infrastructure.
 *
 * All functions are pure, non-mutating, and default-OFF unless activated by:
 *   - STEALTH_ALL=1
 *   - STEALTH_HEADER_SCRUB=1 (or STEALTH_SCRUB=1)
 *   - CLI_COMPAT_ALL=1
 *   - CLI_COMPAT_<PROVIDER>=1
 */

/** Proxy tracing headers indicating reverse proxy or forwarding layers. */
export const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "forwarded",
  "via",
];

/** Browser and Chromium fingerprints added by Electron or browser clients. */
export const BROWSER_HEADERS = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-full-version",
  "sec-ch-ua-platform-version",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-dest",
  "sec-fetch-user",
  "priority",
];

/** Stainless SDK metadata headers (client-identifying for non-Claude providers). */
export const STAINLESS_HEADERS = [
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-stainless-retry-count",
  "x-stainless-helper-method",
];

/** Client-identity and referer headers always stripped from outbound requests. */
export const CLIENT_IDENTITY_HEADERS = [
  "x-title",
  "http-referer",
  "referer",
];

const INTERNAL_HEADER_PREFIXES = ["x-khatam-", "x-omniroute-", "x-9router-"];

/** Standard Node.js CLI accept-encoding. */
export const NODE_ACCEPT_ENCODING = "gzip, deflate, br";

/**
 * Check if header scrubbing is enabled for the provider or globally.
 * Default is FALSE (default-off).
 *
 * @param {string} [provider]
 * @returns {boolean}
 */
export function isHeaderScrubEnabled(provider) {
  if (typeof process === "undefined" || !process.env) return false;
  if (
    process.env.STEALTH_ALL === "1" ||
    process.env.STEALTH_HEADER_SCRUB === "1" ||
    process.env.STEALTH_SCRUB === "1" ||
    process.env.CLI_COMPAT_ALL === "1"
  ) {
    return true;
  }
  if (!provider || typeof provider !== "string") return false;

  const key = provider.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const envKey = `CLI_COMPAT_${key.toUpperCase()}`;
  return process.env[envKey] === "1" || process.env[envKey] === "true";
}

/**
 * Remove headers that reveal proxy infrastructure or client fingerprint mismatches.
 *
 * @param {Record<string, string>} headers - Input HTTP headers
 * @param {object} [options]
 * @param {string} [options.provider] - Provider identifier
 * @param {boolean} [options.preserveStainless] - Preserve Stainless SDK headers (e.g. for Claude)
 * @param {boolean} [options.normalizeEncoding] - Normalize Accept-Encoding to standard Node values (default: true)
 * @param {boolean} [options.deferAuthorization] - Place Authorization header at end (Antigravity wire format)
 * @param {boolean} [options.force] - Force scrub regardless of env flags (useful for explicit calls)
 * @returns {Record<string, string>} Scrubbed headers object
 */
export function scrubHeaders(headers, options = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;

  const enabled = options.force || isHeaderScrubEnabled(options.provider);
  if (!enabled) {
    return headers;
  }

  const cleaned = {};
  let authorizationEntry = null;
  const preserveStainless = options.preserveStainless ?? (options.provider === "claude");
  const normalizeEncoding = options.normalizeEncoding !== false;

  const removeSet = new Set([...PROXY_HEADERS, ...BROWSER_HEADERS, ...CLIENT_IDENTITY_HEADERS]);
  if (!preserveStainless) {
    for (const h of STAINLESS_HEADERS) removeSet.add(h);
  }

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Skip internal gateway headers
    if (INTERNAL_HEADER_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) {
      continue;
    }

    // Skip banned headers
    if (removeSet.has(lowerKey)) {
      continue;
    }

    // Handle Authorization deferral
    if (lowerKey === "authorization" && options.deferAuthorization) {
      authorizationEntry = [key, value];
      continue;
    }

    // Handle Accept-Encoding normalization
    if (lowerKey === "accept-encoding" && normalizeEncoding) {
      cleaned[key] = NODE_ACCEPT_ENCODING;
      continue;
    }

    cleaned[key] = value;
  }

  // Ensure Accept-Encoding is present when normalizing encoding
  if (normalizeEncoding && !Object.keys(cleaned).some((k) => k.toLowerCase() === "accept-encoding")) {
    cleaned["Accept-Encoding"] = NODE_ACCEPT_ENCODING;
  }

  if (authorizationEntry) {
    cleaned[authorizationEntry[0]] = authorizationEntry[1];
  }

  return cleaned;
}

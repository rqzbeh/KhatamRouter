/**
 * Pure function to classify whether an upstream response/error warrants rotating
 * a Psiphon tunnel (burn signal).
 *
 * Rotation triggers (FR-014-06):
 * - 429 (rate-limited / quota)
 * - 403 containing "FreeTierError" or "FreeUsageLimit"
 * - 502 / 503 caused by transport/proxy failure (connect timeout, ECONNRESET, ETIMEDOUT, ECONNREFUSED, Proxy)
 *
 * Negative cases (must return false):
 * - 400, 401, 404, other 403, success (status < 400), non-transport 502/503.
 *
 * @param {object} params
 * @param {number} [params.status]
 * @param {Error|string} [params.error]
 * @param {string|object} [params.body]
 * @returns {boolean}
 */
function extractErrorText(error, body) {
  const parts = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    if (error.message) parts.push(error.message);
    if (error.code) parts.push(error.code);
    if (error.cause) {
      if (typeof error.cause === "string") {
        parts.push(error.cause);
      } else if (typeof error.cause === "object") {
        if (error.cause.message) parts.push(error.cause.message);
        if (error.cause.code) parts.push(error.cause.code);
      }
    }
  }

  if (typeof body === "string") {
    parts.push(body);
  } else if (body && typeof body === "object") {
    try {
      parts.push(JSON.stringify(body));
    } catch {}
  }

  return parts.join(" ");
}

export function shouldRotateOn({ status, error, body } = {}) {
  const statusCode = typeof status === "number" ? status : parseInt(status, 10);

  if (statusCode === 429) {
    return true;
  }

  const errorText = extractErrorText(error, body);

  if (statusCode === 403) {
    return errorText.includes("FreeTierError") || errorText.includes("FreeUsageLimit");
  }

  if (statusCode === 502 || statusCode === 503) {
    const transportMarkers = [
      "connect timeout",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "Proxy",
      "proxy",
      "UND_ERR_CONNECT_TIMEOUT",
      "fetch connect timeout",
    ];
    return transportMarkers.some((marker) => errorText.includes(marker));
  }

  // Network transport failure without status (e.g. fetch exception thrown)
  if (!statusCode && errorText) {
    const transportMarkers = [
      "connect timeout",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "Proxy",
      "UND_ERR_CONNECT_TIMEOUT",
    ];
    return transportMarkers.some((marker) => errorText.includes(marker));
  }

  return false;
}

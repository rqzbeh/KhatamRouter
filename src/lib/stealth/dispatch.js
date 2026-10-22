/**
 * Stealth Dispatch Helper (Wave 5)
 *
 * Coordinates header scrubbing and CLI fingerprint ordering for outgoing requests.
 * Default-OFF: returns inputs untouched when no stealth flags are set.
 */

import { isCliCompatEnabled, applyFingerprint } from "./cliFingerprints.js";
import { isHeaderScrubEnabled, scrubHeaders } from "./headerScrub.js";

/**
 * Check if any dispatch-time stealth processing is active for the provider.
 *
 * @param {string} [provider]
 * @returns {boolean}
 */
export function isStealthEnabled(provider) {
  return isCliCompatEnabled(provider) || isHeaderScrubEnabled(provider);
}

/**
 * Apply header scrubbing and CLI fingerprint ordering before dispatch.
 *
 * @param {string} provider
 * @param {Record<string, string>} headers
 * @param {unknown} body
 * @returns {{ headers: Record<string, string>; bodyString: string }}
 */
export function applyStealthToDispatch(provider, headers, body) {
  let activeHeaders = headers;
  let bodyStr;

  if (isHeaderScrubEnabled(provider)) {
    activeHeaders = scrubHeaders(activeHeaders, { provider });
  }

  if (isCliCompatEnabled(provider)) {
    const fp = applyFingerprint(provider, activeHeaders, body);
    activeHeaders = fp.headers;
    bodyStr = fp.bodyString;
  } else {
    bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  }

  return { headers: activeHeaders, bodyString: bodyStr };
}

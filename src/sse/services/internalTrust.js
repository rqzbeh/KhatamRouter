import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const CLI_TOKEN_HEADER = "x-9r-cli-token";
export const CLI_TOKEN_SALT = "9r-cli-auth";
const HEX_16_REGEX = /^[0-9a-f]{16}$/i;

let cachedExpectedToken = null;

/**
 * Retrieve the expected 16-hex internal CLI token derived from machine id.
 * Result is memoized in memory to avoid repeated disk reads or hashing on hot proxy paths.
 * @returns {Promise<string>} 16-character hexadecimal token
 */
export async function getExpectedInternalToken() {
  if (!cachedExpectedToken) {
    cachedExpectedToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  }
  return cachedExpectedToken;
}

/**
 * Reset internal memoized expected token cache (for testing isolation).
 */
export function resetInternalTrustCache() {
  cachedExpectedToken = null;
}

/**
 * Verify a candidate token against the expected machine token using constant-time comparison.
 * Strictly fails closed on any malformed input, length mismatch, or exception.
 *
 * @param {unknown} candidateToken - The token string to verify
 * @returns {Promise<boolean>} True if valid, false otherwise
 */
export async function verifyInternalToken(candidateToken) {
  try {
    if (typeof candidateToken !== "string") {
      return false;
    }
    const token = candidateToken.trim();
    if (token.length !== 16 || !HEX_16_REGEX.test(token)) {
      return false;
    }

    const expected = await getExpectedInternalToken();
    if (typeof expected !== "string" || expected.length !== 16 || !HEX_16_REGEX.test(expected)) {
      return false;
    }

    const bufCandidate = Buffer.from(token.toLowerCase(), "utf8");
    const bufExpected = Buffer.from(expected.toLowerCase(), "utf8");

    // CRITICAL: length check before timingSafeEqual to avoid RangeError
    if (bufCandidate.length !== bufExpected.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufCandidate, bufExpected);
  } catch {
    // FAIL CLOSED on any unexpected error
    return false;
  }
}

/**
 * Extract x-9r-cli-token from incoming request and verify against expected token.
 *
 * @param {Request|object} req - Web Request or request-like object
 * @returns {Promise<boolean>} True if trusted internal request, false otherwise
 */
export async function isTrustedInternalRequest(req) {
  try {
    if (!req) return false;

    let token = null;
    if (typeof req.headers?.get === "function") {
      token = req.headers.get(CLI_TOKEN_HEADER) || req.headers.get(CLI_TOKEN_HEADER.toUpperCase());
    } else if (req.headers && typeof req.headers === "object") {
      token = req.headers[CLI_TOKEN_HEADER] || req.headers[CLI_TOKEN_HEADER.toUpperCase()] || null;
    }

    if (!token) return false;
    return await verifyInternalToken(token);
  } catch {
    return false;
  }
}

// Alias for spec compatibility
export const isInternalTrusted = isTrustedInternalRequest;

/**
 * Secret masking utilities for CLI output.
 * Ensures API keys, tokens, and credentials are never printed in plaintext.
 */

const SENSITIVE_KEY_REGEX = /^(api_?key|token|auth_?token|secret|password|authorization|private_?key|credential)/i;
const API_KEY_VALUE_REGEX = /^sk-[a-zA-Z0-9_\-\.]{8,}$/;

/**
 * Mask an API key: keeps the prefix (up to 6 chars) and suffix (last 4 chars),
 * separated by an ellipsis (…), or returns "****" for short/invalid keys.
 */
export function maskKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 12) {
    return "****";
  }
  const prefix = key.slice(0, 6);
  const suffix = key.slice(-4);
  return `${prefix}…${suffix}`;
}

/**
 * Recursively masks sensitive fields in objects, arrays, and strings.
 */
export function maskSecrets<T = unknown>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (API_KEY_VALUE_REGEX.test(value)) {
      return maskKey(value) as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item)) as unknown as T;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k) && typeof v === "string") {
        result[k] = maskKey(v);
      } else {
        result[k] = maskSecrets(v);
      }
    }
    return result as unknown as T;
  }

  return value;
}

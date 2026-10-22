/**
 * Canonical CLI Fingerprints (Wave 5)
 *
 * Defines per-provider fingerprints that control the exact ordering of HTTP headers
 * and JSON request body fields to match native developer tooling (Claude Code,
 * OpenAI Codex, GitHub Copilot, Google Antigravity, Cursor).
 *
 * All functions are pure, non-mutating, and default-OFF unless activated by:
 *   - STEALTH_ALL=1
 *   - STEALTH_FINGERPRINTS=1
 *   - CLI_COMPAT_ALL=1
 *   - CLI_COMPAT_<PROVIDER>=1 (e.g. CLI_COMPAT_CLAUDE=1)
 */

export const CLI_FINGERPRINTS = {
  codex: {
    headerOrder: [
      "Host",
      "Content-Type",
      "Authorization",
      "Accept",
      "User-Agent",
      "Accept-Encoding",
    ],
    bodyFieldOrder: [
      "model",
      "stream",
      "input",
      "instructions",
      "store",
      "reasoning",
      "prompt_cache_key",
      "tools",
      "tool_choice",
      "include",
      "service_tier",
      "client_metadata",
      "parallel_tool_calls",
      "metadata",
    ],
  },
  claude: {
    headerOrder: [
      "Accept",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "X-Stainless-Arch",
      "X-Stainless-Lang",
      "X-Stainless-OS",
      "X-Stainless-Package-Version",
      "X-Stainless-Retry-Count",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "X-Stainless-Timeout",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "anthropic-version",
      "x-app",
      "x-client-request-id",
      "Connection",
      "Host",
      "Accept-Encoding",
      "Content-Length",
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "metadata",
      "max_tokens",
      "temperature",
      "thinking",
      "context_management",
      "output_config",
      "stream",
    ],
  },
  "claude-code-compatible": {
    headerOrder: [
      "Host",
      "Content-Type",
      "Authorization",
      "anthropic-version",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "x-app",
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "X-Stainless-Retry-Count",
      "X-Stainless-Timeout",
      "X-Stainless-Lang",
      "X-Stainless-Package-Version",
      "X-Stainless-OS",
      "X-Stainless-Arch",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "Accept",
      "accept-encoding",
      "Connection",
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "metadata",
      "max_tokens",
      "thinking",
      "output_config",
      "stream",
    ],
  },
  github: {
    headerOrder: [
      "Host",
      "Authorization",
      "X-Request-Id",
      "Vscode-Sessionid",
      "Vscode-Machineid",
      "Editor-Version",
      "Editor-Plugin-Version",
      "Copilot-Integration-Id",
      "Openai-Organization",
      "Openai-Intent",
      "Content-Type",
      "User-Agent",
      "Accept",
      "Accept-Encoding",
    ],
    bodyFieldOrder: [
      "messages",
      "model",
      "temperature",
      "top_p",
      "max_tokens",
      "n",
      "stream",
      "intent",
      "intent_threshold",
      "intent_content",
    ],
    userAgent: "GitHubCopilotChat/0.24.0",
  },
  antigravity: {
    headerOrder: [
      "Accept",
      "Accept-Encoding",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "x-goog-api-client",
      "x-client-name",
      "x-client-version",
      "x-machine-id",
      "x-vscode-sessionid",
      "Host",
      "Connection",
    ],
    bodyFieldOrder: [
      "project",
      "requestId",
      "request",
      "model",
      "userAgent",
      "requestType",
      "enabledCreditTypes",
    ],
    userAgent: "Antigravity/1.104.0 (darwin; arm64)",
  },
  cursor: {
    headerOrder: [
      "Host",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "connect-accept-encoding",
      "connect-protocol-version",
      "x-amzn-trace-id",
      "x-client-key",
      "x-cursor-checksum",
      "x-cursor-client-version",
      "x-cursor-user-agent",
      "x-cursor-config-version",
      "x-cursor-timezone",
      "x-ghost-mode",
      "x-request-id",
      "x-session-id",
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "stream",
    ],
  },
};

/** Known internal markers stripped from request bodies. */
export const INTERNAL_BODY_FIELDS = [
  "_claudeCodeRequiresLowercaseToolNames",
  "_nativeCodexPassthrough",
  "_nativeXaiResponsesPassthrough",
  "_nativeOpenAICompatibleResponsesPassthrough",
  "_toolNameMap",
  "_customToolNames",
];

const INTERNAL_PREFIXES = ["_khatam", "_omniroute", "_9router"];

/**
 * Check if CLI compatibility mode is enabled.
 * Default is FALSE (default-off).
 *
 * @param {string} [provider]
 * @returns {boolean}
 */
export function isCliCompatEnabled(provider) {
  if (typeof process === "undefined" || !process.env) return false;
  if (
    process.env.STEALTH_ALL === "1" ||
    process.env.STEALTH_FINGERPRINTS === "1" ||
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
 * Normalize provider identifier to fingerprint key.
 *
 * @param {string} provider
 * @returns {string}
 */
export function normalizeFingerprintProvider(provider) {
  if (!provider || typeof provider !== "string") return "";
  const lower = provider.trim().toLowerCase();
  if (lower === "copilot" || lower === "github-copilot") return "github";
  if (lower === "claude-code" || lower.startsWith("claude-code-")) return "claude-code-compatible";
  return lower;
}

/**
 * Reorder object keys according to a target order list.
 * Unlisted keys are appended at the end in their original relative sequence.
 * Non-mutating: returns a new object.
 *
 * @template T
 * @param {T} obj
 * @param {string[]} fieldOrder
 * @returns {T}
 */
export function orderFields(obj, fieldOrder) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) return { ...obj };

  const record = obj;
  const result = {};
  const remaining = new Set(Object.keys(record));

  for (const key of fieldOrder) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      result[key] = record[key];
      remaining.delete(key);
    }
  }

  for (const key of remaining) {
    result[key] = record[key];
  }

  return result;
}

/**
 * Reorder HTTP headers according to a fingerprint list.
 * Header name lookup is case-insensitive. Canonical casing from headerOrder is used
 * for matched keys. Unlisted headers preserve their original casing and are appended
 * in original relative sequence.
 * Non-mutating: returns a new object.
 *
 * @param {Record<string, string>} headers
 * @param {string[]} headerOrder
 * @returns {Record<string, string>}
 */
export function orderHeaders(headers, headerOrder) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;
  if (!Array.isArray(headerOrder) || headerOrder.length === 0) return { ...headers };

  const result = {};
  // Case-insensitive lookup map: lower -> [originalKey, value]
  const headerMap = new Map();
  for (const [key, value] of Object.entries(headers)) {
    headerMap.set(key.toLowerCase(), [key, value]);
  }

  // 1. Add headers in specified order
  for (const targetKey of headerOrder) {
    const lower = targetKey.toLowerCase();
    const entry = headerMap.get(lower);
    if (entry) {
      result[targetKey] = entry[1];
      headerMap.delete(lower);
    }
  }

  // 2. Append unlisted headers in original casing
  for (const [, [originalKey, value]] of headerMap) {
    result[originalKey] = value;
  }

  return result;
}

/**
 * Strip internal engine markers from a request body.
 * Non-mutating: returns a shallow/deep clone without markers.
 *
 * @param {unknown} body
 * @returns {unknown}
 */
export function stripInternalBodyFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const result = { ...body };

  for (const field of INTERNAL_BODY_FIELDS) {
    delete result[field];
  }

  for (const key of Object.keys(result)) {
    if (INTERNAL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete result[key];
    }
  }

  return result;
}

/**
 * Apply CLI fingerprinting to headers and request body.
 * If CLI compat is not enabled for the provider, returns original headers and stringified body.
 *
 * @param {string} provider
 * @param {Record<string, string>} headers
 * @param {unknown} body
 * @param {{ force?: boolean }} [options]
 * @returns {{ headers: Record<string, string>; bodyString: string }}
 */
export function applyFingerprint(provider, headers, body, options = {}) {
  const enabled = options.force || isCliCompatEnabled(provider);
  if (!enabled) {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    return { headers, bodyString: rawBody };
  }

  const cleanedBody = stripInternalBodyFields(body);
  const normalizedKey = normalizeFingerprintProvider(provider);
  const fingerprint = CLI_FINGERPRINTS[normalizedKey] || CLI_FINGERPRINTS[provider];

  if (!fingerprint) {
    return {
      headers: headers ? { ...headers } : {},
      bodyString: JSON.stringify(cleanedBody),
    };
  }

  const nextHeaders = { ...headers };

  // Apply user-agent override if declared in fingerprint and not already supplied
  if (fingerprint.userAgent && !nextHeaders["User-Agent"] && !nextHeaders["user-agent"]) {
    nextHeaders["User-Agent"] =
      typeof fingerprint.userAgent === "function" ? fingerprint.userAgent() : fingerprint.userAgent;
  }

  // Apply extra headers
  if (fingerprint.extraHeaders) {
    Object.assign(nextHeaders, fingerprint.extraHeaders);
  }

  const orderedHeaders = orderHeaders(nextHeaders, fingerprint.headerOrder);
  const orderedBody =
    cleanedBody && typeof cleanedBody === "object" && !Array.isArray(cleanedBody)
      ? orderFields(cleanedBody, fingerprint.bodyFieldOrder)
      : cleanedBody;

  return {
    headers: orderedHeaders,
    bodyString: JSON.stringify(orderedBody),
  };
}

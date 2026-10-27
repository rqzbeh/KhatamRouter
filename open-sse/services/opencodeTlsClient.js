// TLS-impersonating HTTP client for opencode.ai's free tier under Bun.
//
// The free gate keys on the TLS ClientHello, not on headers: a request that
// passes from the OpenCode CLI is refused with 429 FreeUsageLimitError when the
// same body/headers ride Node's OpenSSL fingerprint, and passes again once the
// cipher list matches. Measured 2026-10-26 on one process, one egress IP, three
// transports: node fetch/https/http2 all 429, Bun's BoringSSL fetch 200.
// JA4's cipher hash identifies the list (Bun: 5b57614c22b0), so the match is on
// the cipher-list hash and nothing else — reordering the same list still passes.
//
// wreq-js is an optional dependency; when absent or failing to build a session,
// opencodeDirectFetch logs a single warning and fails open to native Bun fetch.

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
export const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

let sessionPromise = null;
let fallbackWarnLogged = false;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

/** Check if url belongs to opencode.ai or its subdomains over https. */
export function isOpencodeHost(url) {
  try {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    // A non-empty label must precede ".opencode.ai" (rejects "https://.opencode.ai").
    return host === "opencode.ai" || (host.endsWith(".opencode.ai") && host.length > ".opencode.ai".length);
  } catch {
    return false;
  }
}

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wreq = await import("wreq-js");
      const createSession = wreq.createSession || wreq.default?.createSession;
      if (typeof createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return createSession({
        emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Drop the cached session so the next call builds a fresh one. */
export function resetOpencodeTlsSession() {
  const pending = sessionPromise;
  sessionPromise = null;
  pending?.then((session) => session?.close?.()).catch(() => {});
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 *
 * Streaming is preserved: the response body is handed over as the live
 * ReadableStream, never buffered.
 *
 * Foreign hosts (outside https://opencode.ai or https://*.opencode.ai) are refused.
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs } = {}) {
  if (!isOpencodeHost(url)) {
    throw new Error(`opencodeTlsFetch refused: host is not opencode.ai or *.opencode.ai over https (${url})`);
  }

  let session;
  try {
    session = await loadSession();
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    // Never follow redirects: wreq would replay the Authorization header to an
    // off-host Location. API endpoints do not redirect, so a 3xx is surfaced as-is.
    redirect: "manual",
  };
  // wreq's timeout is a TOTAL deadline that also cuts a live SSE stream, so it is
  // only set when a caller asks for one; BaseExecutor's connect timer and the
  // abort signal bound the request otherwise.
  if (timeoutMs) options.timeout = timeoutMs;
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  // The session is shared by every OpenCode request: drop any Set-Cookie it just
  // stored so one conversation's cookie is never replayed on another's request.
  session.clearCookies?.()?.catch?.(() => {});
  const headers = new Headers();
  if (res.headers && typeof res.headers.forEach === "function") {
    res.headers.forEach((value, key) => {
      headers.append(key, value);
    });
  } else if (res.headers && typeof res.headers === "object") {
    for (const [key, value] of Object.entries(res.headers)) {
      if (value != null) headers.set(key, String(value));
    }
  }

  const body = [204, 205, 304].includes(res.status) ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * DirectFetch wrapper with REAL fail-open semantics:
 * - Module missing or session creation failure: logs ONE console.warn and delegates
 *   to native Bun fetch so outbound requests still proceed.
 * - Request-level errors (network, timeout, abort) propagate unchanged without retrying
 *   natively (preventing accidental duplicate billable requests).
 */
export async function opencodeDirectFetch(url, options = {}) {
  try {
    return await opencodeTlsFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    }, {
      signal: options.signal,
      timeoutMs: options.timeout,
    });
  } catch (error) {
    if (error instanceof OpencodeTlsUnavailableError) {
      if (!fallbackWarnLogged) {
        fallbackWarnLogged = true;
        console.warn("[OpenCode TLS] wreq-js unavailable; falling back to native Bun fetch");
      }
      const { directFetch: _df, ...restOptions } = options;
      return await globalThis.fetch(url, restOptions);
    }
    // Request-level errors propagate unchanged
    throw error;
  }
}

export const __test__ = {
  OPENCODE_CIPHER_LIST,
  resetWarnLogged: () => { fallbackWarnLogged = false; },
};

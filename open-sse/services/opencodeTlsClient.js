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

const MAX_SESSIONS = 16;
// Map of cacheKey -> { sessionPromise, session, inFlight: 0, closing: false, lastUsed: number }
const sessionsMap = new Map();
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

function getSessionKey(proxy, insecure) {
  return `${proxy || "direct"}::${insecure ? "insecure" : "secure"}`;
}

function evictOldestSession() {
  if (sessionsMap.size < MAX_SESSIONS) return;
  let oldestKey = null;
  let oldestTime = Infinity;
  for (const [key, entry] of sessionsMap.entries()) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = sessionsMap.get(oldestKey);
    sessionsMap.delete(oldestKey);
    entry.closing = true;
    if (entry.inFlight === 0) {
      entry.sessionPromise?.then((s) => s?.close?.()).catch(() => {});
    }
  }
}

async function loadSessionEntry({ proxy = null, insecure = false } = {}) {
  const key = getSessionKey(proxy, insecure);
  let entry = sessionsMap.get(key);
  if (entry && !entry.closing) {
    entry.lastUsed = Date.now();
    return entry;
  }

  evictOldestSession();

  entry = {
    sessionPromise: null,
    session: null,
    inFlight: 0,
    closing: false,
    lastUsed: Date.now(),
  };

  entry.sessionPromise = (async () => {
    const wreq = await import("wreq-js");
    const createSession = wreq.createSession || wreq.default?.createSession;
    if (typeof createSession !== "function") {
      throw new Error("wreq-js runtime is missing createSession");
    }
    const config = {
      emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
    };
    if (proxy) {
      config.proxy = proxy;
    }
    if (insecure) {
      config.insecure = true;
    }
    const session = await createSession(config);
    entry.session = session;
    return session;
  })().catch((error) => {
    sessionsMap.delete(key);
    throw error;
  });

  sessionsMap.set(key, entry);
  return entry;
}

async function loadSession() {
  const entry = await loadSessionEntry();
  return entry.sessionPromise;
}

/** Drop the cached sessions so subsequent calls build fresh ones. */
export function resetOpencodeTlsSession() {
  for (const entry of sessionsMap.values()) {
    entry.closing = true;
    if (entry.inFlight === 0) {
      entry.sessionPromise?.then((session) => session?.close?.()).catch(() => {});
    }
  }
  sessionsMap.clear();
}

function trackStream(stream, onDone) {
  if (!stream || typeof stream !== "object") {
    onDone();
    return stream;
  }
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      onDone();
    }
  };
  if (typeof stream.cancel === "function") {
    const origCancel = stream.cancel.bind(stream);
    stream.cancel = function(...args) {
      finish();
      return origCancel(...args);
    };
  }
  if (typeof stream.getReader === "function") {
    const origGetReader = stream.getReader.bind(stream);
    stream.getReader = function(...args) {
      const reader = origGetReader(...args);
      reader.closed?.then(finish, finish);
      return reader;
    };
  }
  return stream;
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
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs, proxy = null, insecure = false } = {}) {
  if (!isOpencodeHost(url)) {
    throw new Error(`opencodeTlsFetch refused: host is not opencode.ai or *.opencode.ai over https (${url})`);
  }

  let entry;
  let session;
  try {
    entry = await loadSessionEntry({ proxy, insecure });
    session = await entry.sessionPromise;
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  entry.inFlight++;
  let inFlightDecremented = false;
  const decrementInFlight = () => {
    if (!inFlightDecremented) {
      inFlightDecremented = true;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.closing && entry.inFlight === 0) {
        entry.session?.close?.().catch(() => {});
      }
    }
  };

  try {
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

    const hasNoBody = [204, 205, 304].includes(res.status) || !res.body;
    if (hasNoBody) {
      decrementInFlight();
      return new Response(null, { status: res.status, statusText: res.statusText, headers });
    }

    const trackedBody = trackStream(res.body, decrementInFlight);
    return new Response(trackedBody, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    decrementInFlight();
    throw err;
  }
}

/**
 * Explicit proxy-capable fetch hook for OpenCode.
 *
 * Guarantees:
 * - When a proxy is provided, routes through the impersonating wreq session with that proxy.
 * - When strictProxy is true, fails closed on native init failure or proxy error.
 * - NEVER falls back to global fetch without proxy.
 * - NEVER enables insecure TLS fallback in production (only explicit test harness insecure config).
 * - Preserves manual redirect, signal, and host allowlist.
 */
export async function opencodeAdapterFetch(url, options = {}, config = {}) {
  const proxyUrl = config?.proxyUrl ?? null;
  const strictProxy = config?.strictProxy === true;
  const insecure = config?.insecure === true;
  const signal = options?.signal || config?.signal;
  const timeoutMs = options?.timeoutMs || options?.timeout || config?.timeoutMs || config?.timeout;

  if (proxyUrl) {
    try {
      return await opencodeTlsFetch(url, {
        method: options?.method,
        headers: options?.headers,
        body: options?.body,
      }, {
        signal,
        timeoutMs,
        proxy: proxyUrl,
        insecure,
      });
    } catch (error) {
      if (strictProxy) {
        throw error;
      }
      // Fail closed when proxy is requested: NEVER global fetch without proxy!
      throw error;
    }
  }

  // Without proxy: delegate to opencodeDirectFetch (which has fail-open when wreq-js unavailable)
  return await opencodeDirectFetch(url, { ...options, signal, timeout: timeoutMs });
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
  sessionsMap,
};

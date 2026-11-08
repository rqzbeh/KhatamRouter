import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { Readable } from "node:stream";
import { isLocalRequest } from "@/dashboardGuard";

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB limit

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    val = val * 256 + octet;
  }
  return val >>> 0;
}

const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT
  [ipv4ToInt("127.0.0.0"), 8],   // Loopback
  [ipv4ToInt("169.254.0.0"), 16], // Link-local / Cloud Metadata (169.254.169.254)
  [ipv4ToInt("172.16.0.0"), 12], // RFC1918
  [ipv4ToInt("192.168.0.0"), 16], // RFC1918
  [ipv4ToInt("192.0.0.0"), 24],   // IETF protocol assignments
  [ipv4ToInt("192.0.2.0"), 24],   // TEST-NET-1
  [ipv4ToInt("198.18.0.0"), 15],  // Benchmarking
  [ipv4ToInt("198.51.100.0"), 24], // TEST-NET-2
  [ipv4ToInt("203.0.113.0"), 24], // TEST-NET-3
  [ipv4ToInt("224.0.0.0"), 4],    // Multicast
  [ipv4ToInt("240.0.0.0"), 4],    // Reserved and broadcast
];

function isMetadataIpv4(ip) {
  return (ip & 0xffff0000) === (ipv4ToInt("169.254.0.0") & 0xffff0000);
}

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();
  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (host.endsWith("::")) {
      // compression
    } else if (host.endsWith(":")) {
      host = host.slice(0, -1);
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isMetadataIpv6(groups) {
  if (!groups) return false;
  // link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // IPv4-mapped metadata
  const isZero = (n) => groups[n] === 0;
  const low32 = ((groups[6] << 16) | groups[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && groups[5] === 0xffff && isMetadataIpv4(low32)) {
    return true;
  }
  return false;
}

function isBlockedIpv6Groups(g) {
  if (!g) return false;
  const isZero = (n) => g[n] === 0;
  // loopback ::1
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true;
  // unspecified ::
  if (g.every((x) => x === 0)) return true;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // unique local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // IPv4-mapped
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return isBlockedIpv4Int(low32);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return isBlockedIpv4Int(low32);
  if ([0, 1, 2, 3, 4, 5].every(isZero) && low32 !== 0 && low32 !== 1) return isBlockedIpv4Int(low32);
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".lan"];

function normalizeHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.+$/, "");
}

/**
 * Checks whether an IP or literal host is cloud metadata.
 * Cloud metadata is strictly forbidden under ALL configurations.
 */
export function isCloudMetadata(host) {
  const norm = normalizeHostname(host);
  if (norm === "169.254.169.254") return true;
  const ip = ipv4ToInt(norm);
  if (ip !== null && isMetadataIpv4(ip)) return true;
  if (norm.includes(":")) {
    const groups = parseIPv6ToGroups(norm.replace(/^\[|\]$/g, ""));
    if (groups && isMetadataIpv6(groups)) return true;
  }
  return false;
}

/**
 * Normalizes any header input (Headers instance, Array of pairs, or plain object)
 * into a standard plain object with string values.
 */
export function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k) out[k] = String(v ?? "");
    }
  } else if (typeof headers.entries === "function") {
    for (const [k, v] of headers.entries()) {
      out[k] = v;
    }
  } else if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null) {
        out[k] = String(v);
      }
    }
  }
  return out;
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = String(noProxyValue || "").trim();
  if (!noProxy) return false;
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

export function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return null;
  }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy || null;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || null;
}

export function getEffectiveProxyEgress(targetUrl, { proxyPolicy = null, isSelfHosted = false } = {}) {
  // 1. Connection-level proxy / relay policy (configured explicitly on provider/connection)
  if (proxyPolicy && typeof proxyPolicy === "object") {
    if (
      proxyPolicy.connectionProxyEnabled === true ||
      proxyPolicy.strictProxy === true ||
      Boolean(proxyPolicy.connectionProxyUrl) ||
      Boolean(proxyPolicy.proxyPoolId) ||
      Boolean(proxyPolicy.psiphonPoolId) ||
      Boolean(proxyPolicy.vercelRelayUrl)
    ) {
      return {
        type: "connection",
        policy: proxyPolicy,
      };
    }
  }

  // 2. Process environment proxy for remote egress (self-hosted local gateways do not route through outbound internet proxy)
  if (!isSelfHosted) {
    const envProxy = getEnvProxyUrl(targetUrl);
    if (envProxy) {
      return {
        type: "environment",
        proxyUrl: envProxy,
      };
    }
  }

  return null;
}

/**
 * Evaluates whether a self-hosted declaration is authorized.
 * On interactive HTTP requests: requires trusted local origin (no proxy headers).
 * When isBackground === true: authorized based on the persisted node flag, pinned to node.baseUrl.
 */
export function isGatewaySelfHostedAllowed({ request, isSelfHosted, baseUrl }) {
  if (!isSelfHosted) return false;
  if (!baseUrl) return false;
  if (request) {
    return isLocalRequest(request);
  }
  return true;
}

/**
 * Validates a target URL against SSRF, DNS rebinding, protocol constraints,
 * userinfo injection, and exact authorized origin rules.
 */
export async function assertGatewayUrlAllowed(rawUrl, {
  isSelfHosted = false,
  authorizedOrigin = null,
  trustedHost = null,
} = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Reject unsupported protocols (only http: and https:)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL: unsupported protocol ${parsed.protocol}`);
  }

  // Reject embedded userinfo (credentials in URL)
  if (parsed.username || parsed.password) {
    throw new Error("Blocked URL: userinfo in URL is prohibited");
  }

  const hostname = normalizeHostname(parsed.hostname);

  // Cloud metadata is unconditionally blocked under all circumstances
  if (isCloudMetadata(hostname)) {
    throw new Error("Blocked URL: cloud metadata address is prohibited");
  }

  const bracketless = hostname.replace(/^\[|\]$/g, "");
  const isLiteralV4 = ipv4ToInt(bracketless) !== null;
  const isLiteralV6 = bracketless.includes(":");
  const isLiteralIp = isLiteralV4 || isLiteralV6;

  // Determine if literal host is internal
  let isInternalLiteral = false;
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    isInternalLiteral = true;
  } else if (isLiteralV4) {
    isInternalLiteral = isBlockedIpv4(bracketless);
  } else if (isLiteralV6) {
    const groups = parseIPv6ToGroups(bracketless);
    isInternalLiteral = isBlockedIpv6Groups(groups);
  }

  // Determine effective authorized origin
  let effectiveAuthOrigin = authorizedOrigin;
  if (!effectiveAuthOrigin && trustedHost) {
    try {
      effectiveAuthOrigin = trustedHost.includes("://")
        ? new URL(trustedHost).origin
        : new URL(`${parsed.protocol}//${trustedHost}`).origin;
    } catch {
      effectiveAuthOrigin = null;
    }
  }

  const currentOrigin = parsed.origin;

  if (isSelfHosted) {
    // Exact authorized origin check: scheme, host, and port must match exactly
    if (effectiveAuthOrigin && currentOrigin === effectiveAuthOrigin) {
      // Pinned authorized origin: allowed if not cloud metadata
      return;
    }

    // Target does not match the pinned authorized origin!
    // It MUST be validated strictly as a public URL (cannot pivot to undeclared private targets)
    if (isInternalLiteral) {
      throw new Error("Blocked URL: target origin mismatch for self-hosted gateway");
    }
  } else if (isInternalLiteral) {
    throw new Error("Blocked URL: internal or private host");
  }

  // If not a literal IP, pre-validate via DNS resolution
  if (!isLiteralIp) {
    let addresses;
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
      return;
    }
    for (const { address, family } of addresses) {
      if (isCloudMetadata(address)) {
        throw new Error("Blocked URL: hostname resolves to cloud metadata");
      }
      const isInternal = family === 4
        ? isBlockedIpv4(address)
        : isBlockedIpv6Groups(parseIPv6ToGroups(address));
      if (isInternal) {
        throw new Error("Blocked URL: hostname resolves to an internal host");
      }
    }
  }
}

/**
 * Creates a connect-time lookup function that pins socket connection
 * to the validated IP, preventing DNS rebinding TOCTOU attacks.
 * No ambient wildcard suffixes (.local, .lan) are trusted.
 */
export function createConnectLookup({
  isSelfHosted = false,
  authorizedOrigin = null,
} = {}) {
  let authHostname = null;
  if (authorizedOrigin) {
    try {
      authHostname = normalizeHostname(new URL(authorizedOrigin).hostname);
    } catch {
      authHostname = null;
    }
  }

  return function connectLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    const norm = normalizeHostname(hostname);

    if (isCloudMetadata(norm)) {
      return callback(new Error("Blocked URL: connect-time cloud metadata blocked"));
    }

    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses || addresses.length === 0) {
        return callback(new Error(`ENOTFOUND: no addresses found for ${hostname}`));
      }

      for (const { address, family } of addresses) {
        if (isCloudMetadata(address)) {
          return callback(new Error("Blocked URL: connect-time DNS resolves to cloud metadata"));
        }

        const isInternal = family === 4
          ? isBlockedIpv4(address)
          : isBlockedIpv6Groups(parseIPv6ToGroups(address));

        if (isInternal) {
          // Internal address is ONLY permitted if isSelfHosted is true AND hostname matches the exact authorized hostname
          const isAllowedSelfHosted = isSelfHosted && authHostname && norm === authHostname;

          if (!isAllowedSelfHosted) {
            return callback(new Error("Blocked URL: connect-time DNS rebinding detected to internal host"));
          }
        }
      }

      if (options?.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

const defaultStrictAgent = new https.Agent({
  rejectUnauthorized: true,
  keepAlive: false,
});

const defaultInsecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
});

/**
 * Returns a scoped https.Agent for TLS verification.
 * Relaxation is strictly prohibited unless isSelfHosted is true.
 * Reuses bounded keep-alive agents to avoid socket descriptor leaks.
 */
export function createScopedTlsAgent({ isSelfHosted = false, allowInsecureTls = false } = {}) {
  if (allowInsecureTls && !isSelfHosted) {
    throw new Error("Insecure TLS relaxation is only allowed for self-hosted gateways");
  }
  return allowInsecureTls ? defaultInsecureAgent : defaultStrictAgent;
}

/**
 * Sanitizes credentials from error messages and logs.
 * Returns a fresh Error instance without raw stack/cause leaks.
 */
export function sanitizeGatewayError(error, secrets = []) {
  if (!error) return new Error("Unknown network error");
  let message = typeof error === "string" ? error : error.message || String(error);

  for (const secret of secrets) {
    if (secret && typeof secret === "string" && secret.length > 4) {
      message = message.split(secret).join("[REDACTED]");
    }
  }

  message = message.replace(/(?:Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, "Bearer [REDACTED]");
  message = message.replace(/(?:sk-[A-Za-z0-9_\-]{8,})/gi, "[REDACTED]");

  const cleanErr = new Error(message);
  if (error && typeof error === "object" && error.code) {
    cleanErr.code = error.code;
  }
  return cleanErr;
}

/**
 * Performs a guarded fetch with connect-time DNS pinning,
 * bounded redirect following, exact-origin TLS scoping,
 * header normalization, and credential/body cross-origin stripping.
 */
export async function fetchGateway(url, init = {}, {
  isSelfHosted = false,
  allowInsecureTls = false,
  authorizedOrigin = null,
  trustedHost = null,
  maxRedirects = 5,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  proxyPolicy = null,
} = {}) {
  // Fail-closed check for configured proxy / relay egress
  const egress = getEffectiveProxyEgress(url, { proxyPolicy, isSelfHosted });
  if (egress) {
    const err = new Error("Configured proxy egress cannot be honored for guarded gateway fetch (fail-closed)");
    err.status = 503;
    throw err;
  }

  let currentUrl = url;
  const initialParsed = new URL(url);

  // Compute effective authorized origin: scheme + host (including port)
  let effectiveAuthOrigin = authorizedOrigin;
  if (!effectiveAuthOrigin) {
    if (trustedHost) {
      try {
        effectiveAuthOrigin = trustedHost.includes("://")
          ? new URL(trustedHost).origin
          : new URL(`${initialParsed.protocol}//${trustedHost}`).origin;
      } catch {
        effectiveAuthOrigin = initialParsed.origin;
      }
    } else {
      effectiveAuthOrigin = initialParsed.origin;
    }
  }

  // Normalize headers from Headers instance, Array, or Object
  let currentHeaders = normalizeHeaders(init.headers);
  const initialMethod = (init.method || "GET").toUpperCase();
  let currentMethod = initialMethod;
  let hasBody = Boolean(init.body);

  for (let hop = 0; ; hop++) {
    const parsed = new URL(currentUrl);
    const isHttps = parsed.protocol === "https:";
    const currentOrigin = parsed.origin;

    // Validate current URL before request
    await assertGatewayUrlAllowed(currentUrl, {
      isSelfHosted,
      authorizedOrigin: effectiveAuthOrigin,
    });

    const connectLookup = createConnectLookup({
      isSelfHosted,
      authorizedOrigin: effectiveAuthOrigin,
    });

    // Insecure TLS is ONLY permitted for the exact authorized origin on self-hosted gateways
    const isExactOrigin = effectiveAuthOrigin && currentOrigin === effectiveAuthOrigin;
    const scopedAllowInsecure = Boolean(isSelfHosted && allowInsecureTls && isExactOrigin);

    const agent = isHttps
      ? createScopedTlsAgent({ isSelfHosted, allowInsecureTls: scopedAllowInsecure })
      : undefined;

    const res = await new Promise((resolve, reject) => {
      const client = isHttps ? https : http;
      const req = client.request(parsed, {
        method: currentMethod,
        headers: currentHeaders,
        agent,
        lookup: connectLookup,
        signal: init.signal,
      }, (incoming) => {
        resolve(incoming);
      });

      req.on("error", (err) => {
        reject(sanitizeGatewayError(err));
      });

      if (hasBody && (currentMethod === "POST" || currentMethod === "PUT" || currentMethod === "PATCH")) {
        req.write(init.body);
      }
      req.end();
    });

    const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
    const location = isRedirect ? res.headers["location"] : null;

    if (!location) {
      // Response size bounding: wrap incoming stream with byte counting, backpressure & abort propagation
      let bytesRead = 0;
      const limitedStream = new Readable({
        read() {
          res.resume();
        },
      });

      res.on("data", (chunk) => {
        bytesRead += chunk.length;
        if (bytesRead > maxResponseBytes) {
          res.destroy(new Error("Response body exceeded maximum allowed limit"));
          limitedStream.destroy(new Error("Response body exceeded maximum allowed limit"));
          return;
        }
        const canContinue = limitedStream.push(chunk);
        if (!canContinue) {
          res.pause();
        }
      });

      res.on("end", () => {
        limitedStream.push(null);
      });

      res.on("error", (err) => {
        limitedStream.destroy(err);
      });

      if (init.signal) {
        if (init.signal.aborted) {
          res.destroy(init.signal.reason || new Error("aborted"));
          limitedStream.destroy(init.signal.reason || new Error("aborted"));
        } else {
          init.signal.addEventListener("abort", () => {
            res.destroy(init.signal.reason || new Error("aborted"));
            limitedStream.destroy(init.signal.reason || new Error("aborted"));
          }, { once: true });
        }
      }

      const bodyStream = Readable.toWeb(limitedStream);
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) {
          v.forEach((val) => responseHeaders.append(k, val));
        } else if (v !== undefined) {
          responseHeaders.set(k, v);
        }
      }

      return new Response(bodyStream, {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: responseHeaders,
      });
    }

    if (hop >= maxRedirects) {
      res.destroy();
      throw new Error("Blocked URL: too many redirects");
    }

    // Resolve next URL relative to current
    const nextUrl = new URL(location, currentUrl).toString();
    const nextParsed = new URL(nextUrl);

    // Cross-origin redirect security:
    if (nextParsed.origin !== parsed.origin) {
      // 1. Reject cross-origin redirect if request has a body (safest: never forward bodies across origins)
      if (hasBody && (currentMethod === "POST" || currentMethod === "PUT" || currentMethod === "PATCH")) {
        res.destroy();
        throw new Error("Blocked URL: cross-origin redirect with request body is prohibited");
      }

      // 2. Scrub credentials on cross-origin redirects
      const cleaned = {};
      for (const [k, v] of Object.entries(currentHeaders)) {
        const lower = k.toLowerCase();
        if (
          lower !== "authorization" &&
          lower !== "x-api-key" &&
          lower !== "api-key" &&
          lower !== "cookie" &&
          lower !== "proxy-authorization"
        ) {
          cleaned[k] = v;
        }
      }
      currentHeaders = cleaned;
    }

    // If 303 or 302/301 from POST, convert to GET without body (standard HTTP redirect)
    if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      hasBody = false;
    }

    res.resume();
    currentUrl = nextUrl;
  }
}

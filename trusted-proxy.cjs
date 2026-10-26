"use strict";

const net = require("node:net");

/**
 * Converts a dotted-quad IPv4 string into an unsigned 32-bit integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToNum(ip) {
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/**
 * Converts an IPv6 address string into a 128-bit BigInt.
 * Safely strips outer brackets and expands embedded IPv4 suffixes (::ffff:127.0.0.1).
 * @param {string} ip
 * @returns {bigint}
 */
function ipv6ToBigInt(ip) {
  let cleaned = ip.trim();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    cleaned = cleaned.slice(1, -1);
  }

  // Handle embedded IPv4 dot notation in IPv6 (e.g., ::ffff:192.168.1.1)
  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = cleaned.slice(lastColon + 1);
    if (tail.includes(".")) {
      const parts = tail.split(".").map(Number);
      if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
        const hi = ((parts[0] << 8) | parts[1]).toString(16);
        const lo = ((parts[2] << 8) | parts[3]).toString(16);
        cleaned = cleaned.slice(0, lastColon) + ":" + hi + ":" + lo;
      }
    }
  }

  const parts = cleaned.split("::");
  let groups = [];
  if (parts.length === 1) {
    groups = parts[0].split(":");
  } else if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    groups = [...left, ...Array(missing).fill("0"), ...right];
  }

  let res = 0n;
  for (const g of groups) {
    res = (res << 16n) | BigInt(parseInt(g || "0", 16));
  }
  return res;
}

/**
 * Safely extracts a syntactically valid IP address from a header value,
 * stripping surrounding whitespace, brackets, and port numbers.
 *
 * Supported formats:
 * - "203.0.113.195" -> "203.0.113.195"
 * - "203.0.113.195:8080" -> "203.0.113.195"
 * - "2001:db8::1" -> "2001:db8::1"
 * - "[2001:db8::1]" -> "2001:db8::1"
 * - "[2001:db8::1]:443" -> "2001:db8::1"
 * - "::ffff:192.168.1.1" -> "::ffff:192.168.1.1"
 *
 * Returns null if the candidate is not a syntactically valid IP.
 * @param {string} candidate
 * @returns {string|null}
 */
function extractIp(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const str = candidate.trim();
  if (!str) return null;

  // Bracketed IPv6, optionally followed by :port
  if (str.startsWith("[")) {
    const closeBracket = str.indexOf("]");
    if (closeBracket !== -1) {
      const inner = str.slice(1, closeBracket);
      if (net.isIPv6(inner)) {
        return inner;
      }
    }
    return null;
  }

  // Contains colons
  if (str.includes(":")) {
    const colonCount = (str.match(/:/g) || []).length;
    // Exactly one colon indicates IPv4 with port: 1.2.3.4:8080
    if (colonCount === 1) {
      const [ipPart] = str.split(":");
      if (net.isIPv4(ipPart)) {
        return ipPart;
      }
      return null;
    }
    // Multiple colons indicate bare IPv6 without port
    if (net.isIPv6(str)) {
      return str;
    }
    return null;
  }

  // Plain IPv4 without colon
  if (net.isIPv4(str)) {
    return str;
  }

  return null;
}

/**
 * Parses comma-separated CIDR entries from TRUSTED_PROXY_CIDRS environment variable.
 * Invalid entries are logged once and ignored so the configuration is strictly more
 * restrictive, never less (never widen trust).
 *
 * /0 handling:
 * 0.0.0.0/0 and ::/0 are explicitly REJECTED and logged because trusting all peers
 * defeats proxy trust control.
 *
 * @param {string|undefined|null} envValue
 * @param {function} [logError=console.error]
 * @returns {Array<object>}
 */
function parseTrustedProxyCidrs(envValue, logError = console.error) {
  if (envValue === undefined || envValue === null) {
    return [];
  }
  if (typeof envValue !== "string") {
    logError("[trusted-proxy] TRUSTED_PROXY_CIDRS must be a string");
    return [];
  }
  if (envValue.trim() === "") {
    return [];
  }

  const segments = envValue.split(",");
  const parsed = [];

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      logError("[trusted-proxy] Ignoring empty CIDR segment in TRUSTED_PROXY_CIDRS");
      continue;
    }

    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1 || slashIndex !== trimmed.lastIndexOf("/")) {
      logError(`[trusted-proxy] Ignoring malformed entry '${trimmed}': expected <ip>/<prefix> CIDR notation`);
      continue;
    }

    let ipStr = trimmed.slice(0, slashIndex).trim();
    if (ipStr.startsWith("[") && ipStr.endsWith("]")) {
      ipStr = ipStr.slice(1, -1);
    }
    const prefixStr = trimmed.slice(slashIndex + 1).trim();

    if (!/^\d+$/.test(prefixStr)) {
      logError(`[trusted-proxy] Ignoring malformed entry '${trimmed}': prefix must be an unsigned integer`);
      continue;
    }

    const prefix = parseInt(prefixStr, 10);

    // Strictest choice for /0: reject and log
    if (prefix === 0) {
      logError(`[trusted-proxy] Rejecting /0 CIDR entry '${trimmed}': 0.0.0.0/0 and ::/0 are not permitted as they defeat proxy trust control`);
      continue;
    }

    const ipType = net.isIP(ipStr);
    if (ipType === 4) {
      if (prefix < 1 || prefix > 32) {
        logError(`[trusted-proxy] Ignoring malformed IPv4 CIDR entry '${trimmed}': prefix /${prefix} must be between 1 and 32`);
        continue;
      }
      const mask = prefix === 32 ? 0xffffffff : ((0xffffffff << (32 - prefix)) >>> 0);
      const baseNum = ipv4ToNum(ipStr);
      parsed.push({
        type: 4,
        base: (baseNum & mask) >>> 0,
        mask: mask >>> 0,
        raw: trimmed,
      });
    } else if (ipType === 6) {
      if (prefix < 1 || prefix > 128) {
        logError(`[trusted-proxy] Ignoring malformed IPv6 CIDR entry '${trimmed}': prefix /${prefix} must be between 1 and 128`);
        continue;
      }
      const mask = prefix === 128
        ? (1n << 128n) - 1n
        : (((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n));
      const baseBig = ipv6ToBigInt(ipStr);
      parsed.push({
        type: 6,
        base: baseBig & mask,
        mask,
        raw: trimmed,
      });
    } else {
      logError(`[trusted-proxy] Ignoring malformed CIDR entry '${trimmed}': '${ipStr}' is not a valid IP address`);
      continue;
    }
  }

  return parsed;
}

/**
 * Checks whether a given TCP peer socket IP is a trusted proxy.
 *
 * Trust rules:
 * 1. Loopback peers (127.0.0.1, ::1, ::ffff:127.0.0.1) are always trusted.
 * 2. If TRUSTED_PROXY_CIDRS parsed list is non-empty, peers matching any CIDR are trusted.
 * 3. IPv4-mapped IPv6 peers (::ffff:a.b.c.d) match their IPv4 CIDR.
 * 4. IPv6 CIDRs use 128-bit prefix math.
 * 5. If TRUSTED_PROXY_NEGATIVE_CONTROL === '1', returns true for all peers (mutation oracle test).
 *
 * @param {string|undefined|null} socketIp
 * @param {Array<object>} parsed
 * @returns {boolean}
 */
function isTrustedProxyPeer(socketIp, parsed) {
  // Mutation testing hook for negative-control-proxy verification:
  // Disables CIDR scoping to verify that spoof test cases actively discriminate.
  if (process.env.TRUSTED_PROXY_NEGATIVE_CONTROL === "1") {
    return true;
  }

  if (!socketIp || typeof socketIp !== "string") {
    return false;
  }

  let ip = socketIp.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  const lower = ip.toLowerCase();
  // Master loopback addresses
  if (lower === "127.0.0.1" || lower === "::1" || lower === "::ffff:127.0.0.1") {
    return true;
  }

  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const ipType = net.isIP(ip);
  if (ipType === 4) {
    const num = ipv4ToNum(ip);
    for (const cidr of parsed) {
      if (cidr.type === 4 && ((num & cidr.mask) >>> 0) === cidr.base) {
        return true;
      }
    }
  } else if (ipType === 6) {
    const big = ipv6ToBigInt(ip);
    // Detect IPv4-mapped IPv6: ::ffff:a.b.c.d
    const isMapped = (big >> 32n) === 0xffffn;
    const ipv4Part = isMapped ? Number(big & 0xffffffffn) >>> 0 : null;

    for (const cidr of parsed) {
      if (cidr.type === 4 && isMapped) {
        if (((ipv4Part & cidr.mask) >>> 0) === cidr.base) {
          return true;
        }
      } else if (cidr.type === 6) {
        if ((big & cidr.mask) === cidr.base) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Resolves the effective client IP address from socket address and forwarding headers.
 *
 * Security semantics:
 * - A peer outside every CIDR cannot influence the effective client IP via X-Forwarded-For
 *   or X-Real-IP (spoof negative control).
 * - Leftmost-XFF is only honoured when the peer is trusted and the value is a syntactically
 *   valid IP (otherwise fall back to the socket IP; strip port/brackets safely).
 * - Note on chained proxies: The nginx LB overwrites X-Forwarded-For with $remote_addr
 *   (single value), so the leftmost value is the real client. In an environment with
 *   chained proxies, an attacker-controlled leftmost value is only possible if an
 *   intermediate trusted hop appends instead of overwriting.
 *
 * @param {object} params
 * @param {string} params.socketIp
 * @param {string} [params.xff]
 * @param {string} [params.xRealIp]
 * @param {Array<object>} params.parsed
 * @returns {string}
 */
function resolveClientIp({ socketIp = "", xff, xRealIp, parsed }) {
  const isTrusted = isTrustedProxyPeer(socketIp, parsed);
  if (!isTrusted) {
    return socketIp || "";
  }

  let candidate = "";
  if (xRealIp && typeof xRealIp === "string" && xRealIp.trim()) {
    candidate = xRealIp.trim();
  } else if (xff && typeof xff === "string" && xff.trim()) {
    candidate = xff.split(",")[0].trim();
  }

  const extracted = extractIp(candidate);
  if (extracted) {
    return extracted;
  }

  return socketIp || "";
}

module.exports = {
  ipv4ToNum,
  ipv6ToBigInt,
  extractIp,
  parseTrustedProxyCidrs,
  isTrustedProxyPeer,
  resolveClientIp,
};

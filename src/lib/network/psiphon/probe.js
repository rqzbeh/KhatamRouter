import * as undiciPkg from "undici";

// ponytail: under Bun, undici export can be a C++ stub where ProxyAgent lacks dispatch; fallback to npm undici
const realUndici = undiciPkg.fetch?.toString?.().includes("[native code]")
  ? (await import("undici/index.js").catch(() => undiciPkg))
  : undiciPkg;

export const ProxyAgent = realUndici.ProxyAgent;
export const undiciFetch = realUndici.fetch;

const DEFAULT_PROBE_URL = "http://cp.cloudflare.com/generate_204";
const DEFAULT_IP_URL = "http://cp.cloudflare.com/cdn-cgi/trace";

function isValidIpv4(ip) {
  if (!ip || typeof ip !== "string") return false;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const num = Number(p);
    return Number.isInteger(num) && num >= 0 && num <= 255 && String(num) === p;
  });
}

function isValidIpv6(ip) {
  if (!ip || typeof ip !== "string") return false;
  // Standard or compressed IPv6 pattern
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
  return ipv6Regex.test(ip);
}

function extractIp(text) {
  if (!text || typeof text !== "string") return null;

  // Match ip=... line if present (Cloudflare cdn-cgi/trace format)
  const traceMatch = text.match(/^ip=([^\r\n]+)/m);
  if (traceMatch) {
    const candidate = traceMatch[1].trim();
    if (isValidIpv4(candidate) || isValidIpv6(candidate)) return candidate;
  }

  // Try JSON { "ip": "..." }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.ip === "string") {
      const candidate = parsed.ip.trim();
      if (isValidIpv4(candidate) || isValidIpv6(candidate)) return candidate;
    }
  } catch {}

  // Match IPv4 anywhere in text
  const ipv4Matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  if (ipv4Matches) {
    for (const match of ipv4Matches) {
      if (isValidIpv4(match)) return match;
    }
  }

  // Match IPv6 anywhere in text
  const ipv6Match = text.match(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/);
  if (ipv6Match && isValidIpv6(ipv6Match[0])) {
    return ipv6Match[0];
  }

  // If no valid IP matched, fail closed and return null (never leak raw HTML/error body)
  return null;
}

/**
 * Probes HTTP proxy latency using generate_204.
 * @param {string} proxyUrl - e.g. "http://127.0.0.1:12345"
 * @param {string} [probeUrl]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, latency: number, status?: number, error?: string }>}
 */
export async function probeLatency(proxyUrl, probeUrl, timeoutMs = 10000) {
  const targetUrl = probeUrl || process.env.PSIPHON_PROBE_URL || DEFAULT_PROBE_URL;
  const dispatcher = new ProxyAgent({ uri: proxyUrl });
  const start = performance.now();
  try {
    const res = await undiciFetch(targetUrl, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Math.max(1, Math.round(performance.now() - start));
    const isSuccess = res.ok || res.status === 204;
    return { ok: isSuccess, latency, status: res.status };
  } catch (err) {
    return { ok: false, latency: Infinity, error: err.message };
  } finally {
    try {
      await dispatcher.close();
    } catch {}
  }
}

/**
 * Probes the external exit IP via the HTTP proxy.
 * @param {string} proxyUrl - e.g. "http://127.0.0.1:12345"
 * @param {string} [ipUrl]
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function probeExitIp(proxyUrl, ipUrl, timeoutMs = 10000) {
  const targetUrl = ipUrl || process.env.PSIPHON_IP_URL || DEFAULT_IP_URL;
  const dispatcher = new ProxyAgent({ uri: proxyUrl });
  try {
    const res = await undiciFetch(targetUrl, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Exit IP probe returned status ${res.status}`);
    }
    const text = await res.text();
    return extractIp(text);
  } catch (err) {
    return null;
  } finally {
    try {
      await dispatcher.close();
    } catch {}
  }
}

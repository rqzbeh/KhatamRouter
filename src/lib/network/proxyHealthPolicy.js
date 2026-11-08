// Proxy health policy: when a request through a proxy pool fails in a way that
// points at the proxy (rate limit, region block, transport failure), take that
// pool out of the provider's rotation for a configurable time, then let it back
// in. Pure functions only; the caller records state in proxyPoolFitness.
//
// What this never does:
//   - classify client or credential errors (400/401/422) as proxy faults
//   - shorten an upstream Retry-After
//   - include a proxy URL or credentials in a reason string

export const COOLDOWN_PRESETS_MS = Object.freeze({ "1m": 60_000, "5m": 300_000, "1h": 3_600_000 });

export const PROXY_HEALTH_LIMITS = Object.freeze({
  minCooldownMs: 10_000,
  maxCooldownMs: 86_400_000,
  minProbeIntervalMs: 30_000,
  maxProbeIntervalMs: 86_400_000,
});

export const DEFAULT_PROXY_HEALTH = Object.freeze({
  enabled: false,
  cooldownMs: 300_000,
  probeEnabled: false,
  probeIntervalMs: 300_000,
  statuses: Object.freeze([403, 429, 451, 502, 503, 504]),
});

const MAX_STATUSES = 20;
const MAX_RETRY_AFTER_MS = 7 * 24 * 3_600_000;
const ERROR_SCAN_CHARS = 2048;

// Client and credential errors are the caller's fault, not the proxy's, so
// they never take a pool out of rotation no matter what the body says.
const NEVER_PROXY_FAULT = new Set([400, 401, 404, 409, 410, 422]);

const TRANSPORT_PATTERN = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|connect timeout|socket hang up|proxy (?:error|connect|tunnel)/i;

// Narrow explicit transport evidence for 403: truly CONNECT/tunnel fault,
// never user text or error strings merely mentioning "proxy".
const PROXY_TUNNEL_PATTERN = /(?:proxy|connect) tunnel (?:failed|error)|tunneling socket could not be established|failed to establish (?:a )?proxy tunnel|(?:proxy|tunnel) connect(?:ion)? failed|http connect failed/i;

// Explicit regional access refusal. Words like "region", "country" or "geo"
// alone are insufficient: only explicit phrases indicating regional access
// is unavailable or unsupported qualify.
const REGION_BLOCKED_PATTERN = /\b(?:not available|unavailable|not supported|blocked)\s+in\s+(?:your|this)\s+(?:region|country|territory|location)\b|\bunsupported\s+(?:location|region|country|territory)\b|\b(?:location|region|country|territory)\s+(?:is\s+)?not\s+supported\b/i;

// Explicit source-IP denial phrases. Requires word boundary around IP token
// so words like "membership" are never misclassified.
const IP_BLOCKED_PATTERN = /\b(?:requests?\s+from\s+(?:this|your)\s+)?\bip(?:\s+address)?\s+(?:is|are|has\s+been)\s+blocked\b|\bip(?:\s+address)?\s+is\s+not\s+allowed\b/i;

function defaults() {
  return { ...DEFAULT_PROXY_HEALTH, statuses: [...DEFAULT_PROXY_HEALTH.statuses] };
}

function toDuration(value) {
  if (typeof value === "string" && value in COOLDOWN_PRESETS_MS) return COOLDOWN_PRESETS_MS[value];
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value;
}

function validDuration(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate stored or submitted settings. Never clamps silently: an invalid
 * field is reported and left at its default.
 */
export function normalizeProxyHealthSettings(raw) {
  const value = defaults();
  const errors = [];
  if (raw === undefined || raw === null) return { ok: true, value, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, value, errors: ["settings must be an object"] };
  }

  for (const key of ["enabled", "probeEnabled"]) {
    if (!(key in raw)) continue;
    if (typeof raw[key] === "boolean") value[key] = raw[key];
    else errors.push(`${key} must be true or false`);
  }

  const durations = [
    ["cooldownMs", PROXY_HEALTH_LIMITS.minCooldownMs, PROXY_HEALTH_LIMITS.maxCooldownMs],
    ["probeIntervalMs", PROXY_HEALTH_LIMITS.minProbeIntervalMs, PROXY_HEALTH_LIMITS.maxProbeIntervalMs],
  ];
  for (const [key, min, max] of durations) {
    if (!(key in raw)) continue;
    const v = toDuration(raw[key]);
    if (validDuration(v, min, max)) value[key] = v;
    else errors.push(`${key} must be one of 1m, 5m, 1h or a whole number of milliseconds between ${min} and ${max}`);
  }

  if ("statuses" in raw) {
    const list = raw.statuses;
    const valid = Array.isArray(list)
      && list.length <= MAX_STATUSES
      && list.every((s) => Number.isInteger(s) && s >= 400 && s <= 599 && !NEVER_PROXY_FAULT.has(s));
    if (valid) value.statuses = [...new Set(list)].sort((a, b) => a - b);
    else errors.push(`statuses must be up to ${MAX_STATUSES} HTTP status codes from 400-599, excluding 400, 401, 404, 409, 410 and 422`);
  }

  return { ok: errors.length === 0, value, errors };
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (typeof headers === "object") {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? headers[key] : null;
  }
  return null;
}

/** Retry-After as milliseconds, or null when absent or not trustworthy. */
export function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  if (!v) return null;
  let ms = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) {
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0 || ms > MAX_RETRY_AFTER_MS) return null;
  return ms;
}

function kindFor(status, text, listed = true) {
  if (status === 403) {
    if (listed && REGION_BLOCKED_PATTERN.test(text)) return "region_blocked";
    if (listed && IP_BLOCKED_PATTERN.test(text)) return "egress_blocked";
    if (PROXY_TUNNEL_PATTERN.test(text)) return "transport";
    return null;
  }
  if (status === 429) return listed ? "rate_limit" : null;
  if (status === 451) return listed ? "region_blocked" : null;
  if (status === 502 || status === 503 || status === 504) {
    return (listed || TRANSPORT_PATTERN.test(text)) ? "transport" : null;
  }
  if (TRANSPORT_PATTERN.test(text) || PROXY_TUNNEL_PATTERN.test(text)) return "transport";
  if (listed) return "other";
  return null;
}

const REASONS = Object.freeze({
  rate_limit: "rate limited through this proxy",
  region_blocked: "provider blocked this proxy's region",
  egress_blocked: "provider blocked this proxy's IP",
  transport: "proxy transport failure",
  other: "proxy failure",
});

/**
 * Decide whether a failed request should take its proxy pool out of rotation.
 * @returns {null | { scope: string, durationMs: number, kind: string, reason: string }}
 */
export function classifyProxyFailure({
  status,
  errorText = "",
  headers = null,
  providerId,
  settings,
  now = Date.now(),
  clientAborted = false,
}) {
  if (clientAborted) return null;
  if (typeof providerId !== "string" || !providerId.trim()) return null;

  const normalized = normalizeProxyHealthSettings(settings);
  const policy = normalized.ok ? normalized.value : { ...normalized.value, enabled: false };
  if (!policy.enabled) return null;
  if (NEVER_PROXY_FAULT.has(status)) return null;

  const text = typeof errorText === "string" ? errorText.slice(0, ERROR_SCAN_CHARS) : "";
  const listed = Number.isInteger(status) && policy.statuses.includes(status);
  const kind = kindFor(status, text, listed);
  if (!kind) return null;

  const retryAfterMs = parseRetryAfterMs(readHeader(headers, "retry-after"), now);
  let durationMs = Math.max(policy.cooldownMs, retryAfterMs ?? 0);
  if (durationMs > PROXY_HEALTH_LIMITS.maxCooldownMs) durationMs = PROXY_HEALTH_LIMITS.maxCooldownMs;

  return { scope: `${providerId.trim()}::*`, durationMs, kind, reason: REASONS[kind] };
}

/** Delay before the next background probe of a cooled pool, with backoff. */
export function nextProbeDelayMs(settings, consecutiveFailures = 0) {
  const { value } = normalizeProxyHealthSettings(settings);
  const failures = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 0;
  const delay = value.probeIntervalMs * 2 ** Math.min(failures, 4);
  return Math.min(delay, PROXY_HEALTH_LIMITS.maxProbeIntervalMs);
}

/**
 * Pools a provider may use right now. Cooled pools are skipped; if every pool
 * is cooling, all are returned so the request still has somewhere to go.
 * Transport-level strict-proxy rules still apply downstream.
 */
export function selectEligiblePools(poolIds, isFit) {
  const list = Array.isArray(poolIds) ? poolIds : [];
  const fit = list.filter((id) => isFit(id));
  return fit.length ? fit : list;
}

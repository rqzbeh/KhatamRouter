import { describe, expect, it } from "vitest";
import {
  COOLDOWN_PRESETS_MS,
  DEFAULT_PROXY_HEALTH,
  PROXY_HEALTH_LIMITS,
  classifyProxyFailure,
  nextProbeDelayMs,
  normalizeProxyHealthSettings,
  parseRetryAfterMs,
  selectEligiblePools,
} from "@/lib/network/proxyHealthPolicy.js";

const on = (over = {}) => ({ enabled: true, cooldownMs: 300_000, ...over });
const now = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("normalizeProxyHealthSettings", () => {
  it("returns a fresh default copy for missing settings", () => {
    const a = normalizeProxyHealthSettings(undefined).value;
    a.statuses.push(999);
    expect(normalizeProxyHealthSettings(null).value.statuses).toEqual([...DEFAULT_PROXY_HEALTH.statuses]);
  });

  it.each([["1m", 60_000], ["5m", 300_000], ["1h", 3_600_000]])("accepts preset %s", (preset, ms) => {
    const r = normalizeProxyHealthSettings({ cooldownMs: preset, probeIntervalMs: preset === "1m" ? 60_000 : preset });
    expect(r.ok).toBe(true);
    expect(r.value.cooldownMs).toBe(ms);
  });

  it.each([
    [{ enabled: "false" }, "enabled"],
    [{ enabled: 0 }, "enabled"],
    [{ cooldownMs: NaN }, "cooldownMs"],
    [{ cooldownMs: 1.5 }, "cooldownMs"],
    [{ cooldownMs: 1000 }, "cooldownMs"], // below minimum
    [{ cooldownMs: 9e9 }, "cooldownMs"],
    [{ cooldownMs: "2m" }, "cooldownMs"],
    [{ probeIntervalMs: 5 }, "probeIntervalMs"],
    [{ statuses: [429, 401] }, "statuses"], // 401 is never a proxy fault
    [{ statuses: "429" }, "statuses"],
    [{ statuses: [700] }, "statuses"],
  ])("rejects %j without clamping", (raw, field) => {
    const r = normalizeProxyHealthSettings(raw);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain(field);
    expect(r.value[field]).toEqual(normalizeProxyHealthSettings(undefined).value[field]);
  });

  it("rejects non-object settings", () => {
    expect(normalizeProxyHealthSettings("on").ok).toBe(false);
    expect(normalizeProxyHealthSettings([1]).ok).toBe(false);
  });

  it("drops unknown keys, dedupes and sorts statuses, and does not mutate input", () => {
    const raw = { enabled: true, statuses: [503, 429, 503], evil: "x" };
    const frozen = JSON.stringify(raw);
    const r = normalizeProxyHealthSettings(raw);
    expect(r.value.statuses).toEqual([429, 503]);
    expect("evil" in r.value).toBe(false);
    expect(JSON.stringify(raw)).toBe(frozen);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads integer seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  });
  it.each(["", "-5", "1e25", "Infinity", "abc", "999999999"])("ignores %j", (v) => {
    expect(parseRetryAfterMs(v, now)).toBeNull();
  });
  it("ignores a date in the past and non-strings", () => {
    expect(parseRetryAfterMs(new Date(now - 1000).toUTCString(), now)).toBeNull();
    expect(parseRetryAfterMs(120, now)).toBeNull();
  });
});

describe("classifyProxyFailure", () => {
  it("cools a pool on 429 for the configured time, scoped to the provider", () => {
    expect(classifyProxyFailure({ status: 429, providerId: "opencode", settings: on(), now })).toEqual({
      scope: "opencode::*", durationMs: 300_000, kind: "rate_limit", reason: "rate limited through this proxy",
    });
  });

  it("uses a longer Retry-After but never a shorter one", () => {
    const longer = classifyProxyFailure({ status: 429, providerId: "p", settings: on(), now, headers: { "Retry-After": "3600" } });
    expect(longer.durationMs).toBe(3_600_000);
    const shorter = classifyProxyFailure({ status: 429, providerId: "p", settings: on(), now, headers: new Headers({ "retry-after": "10" }) });
    expect(shorter.durationMs).toBe(300_000);
  });

  it("caps an extreme cooldown at the maximum", () => {
    const r = classifyProxyFailure({ status: 429, providerId: "p", settings: on({ cooldownMs: PROXY_HEALTH_LIMITS.maxCooldownMs }), now, headers: { "retry-after": "500000" } });
    expect(r.durationMs).toBe(PROXY_HEALTH_LIMITS.maxCooldownMs);
  });

  it("tells a region or egress block from an unproven 403", () => {
    expect(classifyProxyFailure({ status: 403, errorText: "This model is not available in your region", providerId: "p", settings: on(), now }).kind).toBe("region_blocked");
    expect(classifyProxyFailure({ status: 451, providerId: "p", settings: on(), now }).kind).toBe("region_blocked");
    expect(classifyProxyFailure({ status: 403, errorText: "Requests from this IP address are blocked", providerId: "p", settings: on(), now }).kind).toBe("egress_blocked");
    expect(classifyProxyFailure({ status: 403, errorText: "forbidden", providerId: "p", settings: on(), now })).toBeNull();
  });

  it.each([
    ["anthropic", "API key does not have access to this model"],
    ["openai", "Account is suspended"],
    ["gemini", "Request blocked by content policy"],
    ["mistral", "Missing required geo metadata in request parameters"],
    ["groq", "You cannot change the country on this account"],
    ["bedrock", "Forbidden"],
    ["openrouter", "proxy error: invalid model argument in prompt"],
    ["stripe", "Membership blocked due to missing payment"],
    ["billing", "This subscription is blocked"],
  ])("does not cool a proxy on account, policy or generic 403 across provider scopes: %s / %s", (providerId, message) => {
    expect(classifyProxyFailure({ status: 403, errorText: message, providerId, settings: on(), now })).toBeNull();
  });

  it.each([
    ["anthropic", "This service is not available in your region", "region_blocked"],
    ["openai", "Access denied: unsupported location", "region_blocked"],
    ["gemini", "Requests from this IP address are blocked", "egress_blocked"],
  ])("classifies explicit egress denial consistently across provider scopes: %s", (providerId, errorText, expectedKind) => {
    const verdict = classifyProxyFailure({ status: 403, errorText, providerId, settings: on(), now });
    expect(verdict?.scope).toBe(`${providerId}::*`);
    expect(verdict?.kind).toBe(expectedKind);
    expect(verdict?.reason).not.toContain(errorText);
  });

  it.each([
    "tunneling socket could not be established",
    "proxy connect failed with status 403",
    "HTTP CONNECT failed: 403",
    "proxy tunnel failed",
  ])("accepts explicit CONNECT/tunnel transport faults on 403: %s", (message) => {
    const verdict = classifyProxyFailure({ status: 403, errorText: message, providerId: "anthropic", settings: on(), now });
    expect(verdict?.kind).toBe("transport");
    expect(verdict?.scope).toBe("anthropic::*");
  });

  it("treats transport failures as proxy faults even on unlisted statuses", () => {
    expect(classifyProxyFailure({ status: 500, errorText: "connect ECONNREFUSED 10.0.0.1:8080", providerId: "p", settings: on(), now }).kind).toBe("transport");
  });

  it.each([400, 401, 404, 409, 410, 422])("never blames the proxy for a %s, even with transport-looking text", (status) => {
    expect(classifyProxyFailure({ status, errorText: "proxy error ECONNRESET", providerId: "p", settings: on(), now })).toBeNull();
  });

  it("does nothing when disabled, aborted, unlisted, unscoped or misconfigured", () => {
    expect(classifyProxyFailure({ status: 429, providerId: "p", settings: { enabled: false }, now })).toBeNull();
    expect(classifyProxyFailure({ status: 429, providerId: "p", settings: undefined, now })).toBeNull();
    expect(classifyProxyFailure({ status: 429, providerId: "p", settings: on(), now, clientAborted: true })).toBeNull();
    expect(classifyProxyFailure({ status: 500, errorText: "internal", providerId: "p", settings: on(), now })).toBeNull();
    expect(classifyProxyFailure({ status: 429, providerId: "", settings: on(), now })).toBeNull();
    expect(classifyProxyFailure({ status: 429, providerId: "p", settings: on({ cooldownMs: "bogus" }), now })).toBeNull();
  });

  it("never echoes the proxy URL, credentials or upstream text in the reason", () => {
    const r = classifyProxyFailure({ status: 502, errorText: "proxy error via http://user:pass@10.0.0.1:8080 token=abc", providerId: "p", settings: on(), now });
    expect(JSON.stringify(r)).not.toMatch(/user:pass|10\.0\.0\.1|token=abc/);
  });
});

describe("nextProbeDelayMs and selectEligiblePools", () => {
  it("backs off exponentially and caps", () => {
    const s = { probeIntervalMs: 60_000 };
    expect(nextProbeDelayMs(s, 0)).toBe(60_000);
    expect(nextProbeDelayMs(s, 2)).toBe(240_000);
    expect(nextProbeDelayMs(s, 99)).toBe(960_000);
    expect(nextProbeDelayMs(s, -3)).toBe(60_000);
    expect(nextProbeDelayMs({ probeIntervalMs: PROXY_HEALTH_LIMITS.maxProbeIntervalMs }, 4)).toBe(PROXY_HEALTH_LIMITS.maxProbeIntervalMs);
  });

  it("skips cooled pools for both round-robin and random selection", () => {
    expect(selectEligiblePools(["a", "b", "c"], (id) => id !== "b")).toEqual(["a", "c"]);
  });

  it("leaves unaffected pools in rotation when one pool is cooled in a provider scope", () => {
    const pools = ["pool-1", "pool-2", "pool-3"];
    // Fitness predicate simulates pool-1 cooled under provider-a, unaffected under provider-b
    const isFitProviderA = (id) => id !== "pool-1";
    const isFitProviderB = () => true;

    expect(selectEligiblePools(pools, isFitProviderA)).toEqual(["pool-2", "pool-3"]);
    expect(selectEligiblePools(pools, isFitProviderB)).toEqual(["pool-1", "pool-2", "pool-3"]);
  });

  it("falls back to every pool when all are cooling instead of going direct", () => {
    expect(selectEligiblePools(["a", "b"], () => false)).toEqual(["a", "b"]);
    expect(selectEligiblePools([], () => true)).toEqual([]);
  });

  it("exposes the 1m / 5m / 1h presets", () => {
    expect(COOLDOWN_PRESETS_MS).toEqual({ "1m": 60_000, "5m": 300_000, "1h": 3_600_000 });
  });
});

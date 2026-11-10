import { pickProxyPoolId } from "@/lib/network/connectionProxy.js";
import {
  NEVER_PROXY_FAULT,
  TRANSPORT_PATTERN,
  PROXY_TUNNEL_PATTERN,
  REGION_BLOCKED_PATTERN,
  IP_BLOCKED_PATTERN,
} from "@/lib/network/proxyHealthPolicy.js";
import { isPoolFit } from "open-sse/services/proxyPoolFitness.js";
import {
  looksLikeQuotaExhausted,
  looksLikeTerminalQuotaExhaustion,
  isPolicyRefusal,
} from "@/lib/resilience/failureClassification.js";

/**
 * Bounded Proxy Failover Configuration and Pure Routing Logic (Spec 021).
 *
 * Canonical modes:
 *  - "none": default unchanged (0 additional retries)
 *  - "custom": positive integer additional retries (1..1000)
 *  - "all": try each distinct eligible available proxy in configured rotation set once
 */

export const FAILOVER_MODES = Object.freeze(["none", "custom", "all"]);
export const MAX_CUSTOM_RETRIES_CEILING = 1000;
export const DEFAULT_FAILOVER_ATTEMPT_TIMEOUT_MS = 30_000;
export const DEFAULT_FAILOVER_DEADLINE_MS = 120_000;
export const MIN_FAILOVER_TIMEOUT_MS = 100;
export const MAX_FAILOVER_TIMEOUT_MS = 600_000;
export const RESPONSE_DISPOSE_TIMEOUT_MS = 200;

export const DEFAULT_PROXY_FAILOVER = Object.freeze({
  enabled: false,
  mode: "none",
  maxRetries: 0,
  strategy: "round-robin",
  attemptTimeoutMs: DEFAULT_FAILOVER_ATTEMPT_TIMEOUT_MS,
  requestDeadlineMs: DEFAULT_FAILOVER_DEADLINE_MS,
});

const ACCOUNT_EXHAUSTION_PATTERNS = [
  /\b(?:account|org|organization|workspace|project|team|user|plan|subscription)\b.{0,120}\b(?:quota|limit|cap|exhaust|exceed|bill|payment|tier)/i,
  /\b(?:daily|monthly|hourly|rolling\s+24)\b.{0,120}\b(?:quota|limit|allowance|allocation|cap)/i,
  /\b(?:tpm|tpd)\b.{0,120}\b(?:limit|exceed|quota)/i,
  /\btokens?\s+per\s+(?:minute|day)\b/i,
  /\brequests?\s+per\s+(?:month|billing)\b/i,
  /\bcredits?\b.{0,120}\b(?:exhaust|empty|zero|insufficient|low|run\s+out)/i,
];

/**
 * Validate and normalize canonical proxy failover settings.
 * Rejects loose string aliases, floats, negatives, and inconsistent states without silent clamping.
 */
export function normalizeProxyFailoverSettings(raw) {
  const value = { ...DEFAULT_PROXY_FAILOVER };
  const errors = [];

  if (raw === undefined || raw === null) {
    return { ok: true, value, errors };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, value, errors: ["proxyFailover must be an object"] };
  }

  let hasExplicitMode = false;
  if ("mode" in raw) {
    if (typeof raw.mode !== "string" || !FAILOVER_MODES.includes(raw.mode)) {
      errors.push("mode must be one of 'none', 'custom', or 'all'");
    } else {
      hasExplicitMode = true;
      value.mode = raw.mode;
    }
  }

  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") {
      errors.push("enabled must be a boolean");
    } else {
      value.enabled = raw.enabled;
    }
  }

  const customInput = "maxRetries" in raw ? raw.maxRetries : undefined;
  const hasCustomInput = customInput !== undefined;

  if (hasExplicitMode) {
    if (value.mode === "none") {
      if ("enabled" in raw && raw.enabled === true) {
        errors.push("enabled cannot be true when mode is 'none'");
      }
      if (hasCustomInput && customInput !== 0) {
        errors.push("maxRetries must be 0 when mode is 'none'");
      }
      value.enabled = false;
      value.maxRetries = 0;
    } else if (value.mode === "all") {
      if ("enabled" in raw && raw.enabled === false) {
        errors.push("enabled cannot be false when mode is 'all'");
      }
      if (hasCustomInput && customInput !== "all") {
        errors.push("maxRetries cannot be numeric when mode is 'all'");
      }
      value.enabled = true;
      value.maxRetries = "all";
    } else if (value.mode === "custom") {
      if ("enabled" in raw && raw.enabled === false) {
        errors.push("enabled cannot be false when mode is 'custom'");
      }
      if (typeof customInput !== "number" || !Number.isInteger(customInput) || customInput < 1 || customInput > MAX_CUSTOM_RETRIES_CEILING) {
        errors.push(`custom maxRetries must be an integer between 1 and ${MAX_CUSTOM_RETRIES_CEILING}`);
      } else {
        value.enabled = true;
        value.maxRetries = customInput;
      }
    }
  } else if (hasCustomInput) {
    if (customInput === 0) {
      if ("enabled" in raw && raw.enabled === true) {
        errors.push("enabled cannot be true when maxRetries is 0");
      }
      value.mode = "none";
      value.maxRetries = 0;
      value.enabled = false;
    } else if (customInput === "all") {
      value.mode = "all";
      value.maxRetries = "all";
      value.enabled = true;
    } else if (typeof customInput === "number" && Number.isInteger(customInput) && customInput >= 1 && customInput <= MAX_CUSTOM_RETRIES_CEILING) {
      value.mode = "custom";
      value.maxRetries = customInput;
      value.enabled = true;
    } else {
      errors.push(`maxRetries must be 0, 'all', or a positive integer between 1 and ${MAX_CUSTOM_RETRIES_CEILING}`);
    }
  } else if ("enabled" in raw && raw.enabled === true) {
    errors.push("mode or positive integer maxRetries is required when enabled is true");
  }

  if ("strategy" in raw) {
    if (raw.strategy === "round-robin" || raw.strategy === "random") {
      value.strategy = raw.strategy;
    } else {
      errors.push("strategy must be 'round-robin' or 'random'");
    }
  }

  for (const field of ["attemptTimeoutMs", "requestDeadlineMs"]) {
    if (field in raw && raw[field] !== undefined && raw[field] !== null) {
      const v = raw[field];
      if (typeof v === "number" && Number.isInteger(v) && v >= MIN_FAILOVER_TIMEOUT_MS && v <= MAX_FAILOVER_TIMEOUT_MS) {
        value[field] = v;
      } else {
        errors.push(`${field} must be an integer between ${MIN_FAILOVER_TIMEOUT_MS} and ${MAX_FAILOVER_TIMEOUT_MS}`);
      }
    }
  }

  return { ok: errors.length === 0, value, errors };
}

/**
 * Determine whether the failover policy permits another retry attempt.
 */
export function hasRemainingFailoverBudget(failoverConfig, retriesUsed) {
  if (!failoverConfig || !failoverConfig.enabled || failoverConfig.mode === "none") {
    return false;
  }
  if (failoverConfig.mode === "all") {
    return true;
  }
  if (failoverConfig.mode === "custom" && Number.isInteger(failoverConfig.maxRetries) && failoverConfig.maxRetries > 0) {
    return retriesUsed < failoverConfig.maxRetries;
  }
  return false;
}

/**
 * Classify whether an upstream error is eligible for proxy failover retry.
 * Shares pattern rules with proxyHealthPolicy.js (DRY).
 */
export function isProxyFailoverRetryable({ status, errorText = "", body = null }) {
  const code = Number(status);

  // Client errors (400, 401, 404, 409, 410, 422) + billing (402) are never proxy faults
  if (NEVER_PROXY_FAULT.has(code) || code === 402) {
    return false;
  }

  const text = typeof errorText === "string" ? errorText : JSON.stringify(errorText || "");
  const bodyText = typeof body === "string" ? body : JSON.stringify(body || "");
  const combinedText = `${text} ${bodyText}`;

  // Content-policy refusals are request-specific
  if (isPolicyRefusal(combinedText)) {
    return false;
  }

  // 403: must show explicit proxy/IP/tunnel/region evidence from shared policy patterns
  if (code === 403) {
    if (REGION_BLOCKED_PATTERN.test(combinedText)) return true;
    if (IP_BLOCKED_PATTERN.test(combinedText)) return true;
    if (PROXY_TUNNEL_PATTERN.test(combinedText)) return true;
    return false;
  }

  // 429: account quota/billing/daily/monthly exhaustion must NOT rotate
  if (code === 429) {
    if (looksLikeTerminalQuotaExhaustion(combinedText)) return false;
    if (looksLikeQuotaExhausted(combinedText)) return false;
    if (ACCOUNT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(combinedText))) return false;
    return true; // Generic rate limit (IP-level throttle, burst, RPM)
  }

  // 451: regional block
  if (code === 451) {
    return true;
  }

  // 502, 503, 504: gateway/proxy failures
  if (code === 502 || code === 503 || code === 504) {
    return true;
  }

  // Transport/socket/network exceptions
  if (TRANSPORT_PATTERN.test(combinedText) || PROXY_TUNNEL_PATTERN.test(combinedText)) {
    return true;
  }

  return false;
}

/**
 * Resolve the authorized rotation candidate set and strategy for a provider.
 * If rotation strategy is 'none', returns empty candidates to prevent crossing pool boundaries.
 */
export function resolveRotationCandidates({ providerId, credentials = null, settings = {}, allActivePools = [] }) {
  if (credentials?._proxyRotation) {
    const r = credentials._proxyRotation;
    if (r.strategy && r.strategy !== "none" && Array.isArray(r.candidatePoolIds) && r.candidatePoolIds.length > 0) {
      return { strategy: r.strategy, candidatePoolIds: r.candidatePoolIds };
    }
    return { strategy: r.strategy || "none", candidatePoolIds: [] };
  }

  const providerOverrides = (settings.providerStrategies || {})[providerId] || {};
  const connectionData = credentials?.providerSpecificData || {};

  const strategy = providerOverrides.rotateStrategy || connectionData.rotateStrategy || "none";
  if (strategy === "none") {
    return { strategy: "none", candidatePoolIds: [] };
  }

  let poolIds;
  if (Array.isArray(providerOverrides.proxyPoolIds) && providerOverrides.proxyPoolIds.length > 0) {
    poolIds = providerOverrides.proxyPoolIds;
  } else if (Array.isArray(connectionData.proxyPoolIds) && connectionData.proxyPoolIds.length > 0) {
    poolIds = connectionData.proxyPoolIds;
  } else {
    poolIds = allActivePools
      .filter((p) => p.proxyUrl || p.type === "psiphon" || p.data?.type === "psiphon" || p.type === "opencode2api")
      .map((p) => p.id);
  }

  return {
    strategy,
    candidatePoolIds: [...new Set(poolIds)],
  };
}

/**
 * Pick the next distinct, unattempted, active, fit proxy pool ID.
 * Re-checks both active eligibility (via activePoolIds if supplied) and cooldown fitness.
 */
export function pickNextDistinctPool({
  candidatePoolIds = [],
  attemptedPoolIds = new Set(),
  activePoolIds = null,
  strategy = "round-robin",
  providerId = "",
  isPoolFitFn = isPoolFit,
}) {
  const attemptedSet = attemptedPoolIds instanceof Set ? attemptedPoolIds : new Set(attemptedPoolIds);
  const eligible = candidatePoolIds.filter((id) => {
    if (attemptedSet.has(id)) return false;
    if (activePoolIds && !activePoolIds.has(id)) return false;
    return isPoolFitFn(id, `${providerId}::*`);
  });

  if (eligible.length === 0) {
    return null;
  }

  return pickProxyPoolId(eligible, strategy, providerId);
}

/**
 * Apply resolved proxy config to cloned providerSpecificData, clearing all stale
 * transport markers (e.g. psiphonPoolId, opencodeSidecarPoolId, vercelRelayUrl)
 * so cross-type failover transitions never inherit old proxy attributes.
 */
export function applyProxyConfigToPsd(existingPsd = {}, nextProxy = {}) {
  const clean = { ...(existingPsd || {}) };
  delete clean.connectionProxyEnabled;
  delete clean.connectionProxyUrl;
  delete clean.connectionNoProxy;
  delete clean.connectionProxyPoolId;
  delete clean.vercelRelayUrl;
  delete clean.psiphonPoolId;
  delete clean.psiphonGeneration;
  delete clean.psiphonUnavailable;
  delete clean.opencodeSidecarPoolId;
  delete clean.opencodeSidecarUrl;
  delete clean.opencodeSidecarKey;
  delete clean.opencodeSidecarGeneration;
  delete clean.opencodeSidecarUnavailable;

  return {
    ...clean,
    connectionProxyEnabled: nextProxy.connectionProxyEnabled === true,
    connectionProxyUrl: nextProxy.connectionProxyUrl || "",
    connectionNoProxy: nextProxy.connectionNoProxy || "",
    connectionProxyPoolId: nextProxy.proxyPoolId || null,
    vercelRelayUrl: nextProxy.vercelRelayUrl || "",
    strictProxy: true,
    psiphonPoolId: nextProxy.psiphonPoolId || null,
    psiphonGeneration: nextProxy.psiphonGeneration ?? null,
    psiphonUnavailable: nextProxy.psiphonUnavailable === true,
    opencodeSidecarPoolId: nextProxy.opencodeSidecarPoolId || null,
    opencodeSidecarUrl: nextProxy.opencodeSidecarUrl || "",
    opencodeSidecarKey: nextProxy.opencodeSidecarKey || "",
    opencodeSidecarGeneration: nextProxy.opencodeSidecarGeneration ?? null,
    opencodeSidecarUnavailable: nextProxy.opencodeSidecarUnavailable === true,
  };
}

/**
 * Clone credentials safely so per-request mutations never touch cached/singleton records.
 */
export function cloneCredentials(creds) {
  if (!creds || typeof creds !== "object") return creds;
  return {
    ...creds,
    providerSpecificData: creds.providerSpecificData ? { ...creds.providerSpecificData } : {},
  };
}

/**
 * Dispose an unconsumed intermediate Response body within a bounded timeout to avoid
 * hung socket cleanup blocking failover progress.
 */
export async function disposeResponse(response, timeoutMs = RESPONSE_DISPOSE_TIMEOUT_MS) {
  if (!response?.body || response.bodyUsed || typeof response.body.cancel !== "function") {
    return;
  }
  let timer = null;
  try {
    await Promise.race([
      response.body.cancel().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } catch {
    // Fail safe
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { validatePsiphonConfig } from "@/lib/network/psiphon/config.js";

export const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify", "psiphon"];

export const DEFAULT_PSIPHON_CONFIG = {
  regions: [],
  probeCandidates: 3,
  maxRequestsPerIp: 0,
  maxTokensPerIp: 0,
};

export const MANAGED_PSIPHON_URL = "psiphon://managed";

/**
 * Validates and normalizes psiphon configuration options.
 * @param {object} raw
 * @returns {{ valid: boolean, psiphon?: object, error?: string }}
 */
export function normalizePsiphonOptions(raw = {}) {
  const cfg = raw || {};
  const validation = validatePsiphonConfig(cfg);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }

  const normalized = {
    regions: Array.isArray(cfg.regions) ? cfg.regions : [],
    probeCandidates: Number.isInteger(cfg.probeCandidates) ? cfg.probeCandidates : 3,
    maxRequestsPerIp: Number.isInteger(cfg.maxRequestsPerIp) ? cfg.maxRequestsPerIp : 0,
    maxTokensPerIp: Number.isInteger(cfg.maxTokensPerIp) ? cfg.maxTokensPerIp : 0,
  };

  return { valid: true, psiphon: normalized };
}

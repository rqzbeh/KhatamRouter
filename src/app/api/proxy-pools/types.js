import { validatePsiphonConfig } from "@/lib/network/psiphon/config.js";
import {
  MANAGED_SIDECAR_URL,
  DEFAULT_SIDECAR_CONFIG,
  validateSidecarConfig,
  normalizeSidecarConfig,
} from "@/lib/network/opencode2api/config.js";

export const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify", "psiphon", "opencode2api"];

export const DEFAULT_PSIPHON_CONFIG = {
  regions: [],
  probeCandidates: 3,
  warmStandby: 2,
  maxRequestsPerIp: 0,
  maxTokensPerIp: 0,
};

export const MANAGED_PSIPHON_URL = "psiphon://managed";

export const MANAGED_OPENCODE2API_URL = MANAGED_SIDECAR_URL;
export const DEFAULT_OPENCODE2API_CONFIG = DEFAULT_SIDECAR_CONFIG;

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
    warmStandby: Number.isInteger(cfg.warmStandby) ? Math.max(0, Math.min(4, cfg.warmStandby)) : 2,
    maxRequestsPerIp: Number.isInteger(cfg.maxRequestsPerIp) ? cfg.maxRequestsPerIp : 0,
    maxTokensPerIp: Number.isInteger(cfg.maxTokensPerIp) ? cfg.maxTokensPerIp : 0,
  };

  return { valid: true, psiphon: normalized };
}

/**
 * Validates and normalizes opencode2api configuration options.
 * @param {object} raw
 * @returns {{ valid: boolean, opencode2api?: object, error?: string }}
 */
export function normalizeOpencode2apiOptions(raw = {}) {
  const cfg = raw || {};
  const validation = validateSidecarConfig(cfg);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }

  return { valid: true, opencode2api: normalizeSidecarConfig(cfg) };
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getDataDir } from "@/lib/dataDir.js";

const REGION_REGEX = /^[A-Z]{2}$/;

export class PsiphonUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PsiphonUnavailableError";
    this.status = 503;
  }
}

/**
 * Validates a single ISO alpha-2 uppercase region code.
 * @param {string} region
 * @returns {boolean}
 */
export function validateRegion(region) {
  return typeof region === "string" && REGION_REGEX.test(region);
}

/**
 * Validates an array of region codes.
 * Throws Error on invalid format or count > 50.
 * @param {string[]} regions
 * @returns {boolean}
 */
export function validateRegions(regions) {
  if (!Array.isArray(regions)) {
    throw new Error("regions must be an array");
  }
  if (regions.length > 50) {
    throw new Error("regions array exceeds maximum of 50");
  }
  const seen = new Set();
  for (const r of regions) {
    if (!validateRegion(r)) {
      throw new Error(`Invalid region code: ${r}. Expected 2-letter uppercase ISO alpha-2`);
    }
    if (seen.has(r)) {
      throw new Error(`Duplicate region code: ${r}`);
    }
    seen.add(r);
  }
  return true;
}

/**
 * Validates pool config options for type=psiphon.
 * @param {object} config
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePsiphonConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  if (config.regions !== undefined) {
    try {
      validateRegions(config.regions);
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
  if (config.probeCandidates !== undefined) {
    const pc = config.probeCandidates;
    if (!Number.isInteger(pc) || pc < 1 || pc > 5) {
      return { valid: false, error: "probeCandidates must be an integer between 1 and 5" };
    }
  }
  if (config.maxRequestsPerIp !== undefined) {
    const mr = config.maxRequestsPerIp;
    if (!Number.isInteger(mr) || mr < 0) {
      return { valid: false, error: "maxRequestsPerIp must be an integer >= 0" };
    }
  }
  if (config.maxTokensPerIp !== undefined) {
    const mt = config.maxTokensPerIp;
    if (!Number.isInteger(mt) || mt < 0) {
      return { valid: false, error: "maxTokensPerIp must be an integer >= 0" };
    }
  }
  return { valid: true };
}

export function getPsiphonBinPath() {
  if (process.env.PSIPHON_BIN) return process.env.PSIPHON_BIN;
  const dataDir = getDataDir();
  return path.join(dataDir, "bin", "ConsoleClient");
}

export function getPsiphonConfigPath() {
  if (process.env.PSIPHON_CONFIG_FILE) return process.env.PSIPHON_CONFIG_FILE;
  const dataDir = getDataDir();
  return path.join(dataDir, "psiphon", "client.config.json");
}

/**
 * Creates a temporary 0600 config file for a ConsoleClient child instance.
 * @param {object} params
 * @param {string} params.baseConfigFile
 * @param {string} params.dataRootDir
 * @param {string} [params.egressRegion]
 * @returns {string} Path to temporary config file
 */
export function createTempConfigFile({ baseConfigFile, dataRootDir, egressRegion }) {
  if (!fs.existsSync(baseConfigFile)) {
    throw new PsiphonUnavailableError(
      `Psiphon base config file missing: ${baseConfigFile}. Configure PSIPHON_CONFIG_FILE or provide client.config.json`
    );
  }

  let baseContent = {};
  try {
    const raw = fs.readFileSync(baseConfigFile, "utf-8");
    baseContent = JSON.parse(raw);
  } catch (err) {
    throw new PsiphonUnavailableError(`Invalid Psiphon base config JSON: ${err.message}`);
  }

  const merged = {
    ...baseContent,
    DataRootDirectory: dataRootDir,
    ListenInterface: "127.0.0.1",
    LocalHttpProxyPort: 0,
    DisableLocalSocksProxy: true,
    EmitDiagnosticNotices: true,
  };
  delete merged.LocalSocksProxyPort;

  if (egressRegion) {
    merged.EgressRegion = egressRegion;
  }

  const tmpName = `psiphon-cfg-${crypto.randomBytes(6).toString("hex")}.json`;
  const tmpPath = path.join(dataRootDir, tmpName);

  // ponytail: mode 0600 restricts temp config to current user
  fs.writeFileSync(tmpPath, JSON.stringify(merged), { mode: 0o600 });
  return tmpPath;
}

/**
 * Removes a temporary config file.
 * @param {string} filePath
 */
export function cleanTempConfigFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

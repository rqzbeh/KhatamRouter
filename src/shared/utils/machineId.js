import { machineIdSync } from 'node-machine-id';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '@/lib/dataDir';
import { publishSecretOnce } from './secretFile.js';

const MACHINE_ID_FILE = path.join(DATA_DIR, 'machine-id');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CLI_SECRET_FILE = path.join(AUTH_DIR, 'cli-secret');
const CLI_AUTH_SALT = '9r-cli-auth';
let cachedRawId = null;
let cachedCliSecret = null;

// Persist raw machine ID to file → guarantees CLI/server/middleware see same value
// even when machineIdSync fails or returns inconsistent values across runtimes.
export function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    if (cachedRawId) return cachedRawId;
  } catch {}
  let candidate;
  try {
    candidate = machineIdSync();
  } catch {
    candidate = crypto.randomUUID();
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    cachedRawId = publishSecretOnce(MACHINE_ID_FILE, candidate);
  } catch {
    cachedRawId = candidate;
  }
  return cachedRawId;
}

// Random secret persisted on first run → unpredictable CLI token even when machineId leaks.
export function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  const candidate = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    cachedCliSecret = publishSecretOnce(CLI_SECRET_FILE, candidate);
  } catch {
    cachedCliSecret = candidate;
  }
  return cachedCliSecret;
}

export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || 'endpoint-proxy-salt';
  const raw = loadRawMachineId();
  const extra = saltValue === CLI_AUTH_SALT ? loadCliSecret() : '';
  return crypto.createHash('sha256').update(raw + saltValue + extra).digest('hex').substring(0, 16);
}

export async function getRawMachineId() {
  return loadRawMachineId();
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}

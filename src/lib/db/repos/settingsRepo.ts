/**
 * Settings repository with 5000ms TTL in-memory cache and revision tracking.
 *
 * TypeScript twin of `settingsRepo.js`.
 */

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "../../redis/events.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

export const SETTINGS_CACHE_TTL_MS = 5000;

export interface CapacityAdapterConfig {
  enabled: boolean;
  roundRobin: boolean;
  models: string[];
}

export interface Settings {
  cloudEnabled: boolean;
  cloudUrl?: string;
  tunnelEnabled: boolean;
  tunnelUrl: string;
  tunnelProvider: string;
  tailscaleEnabled: boolean;
  tailscaleUrl: string;
  stickyRoundRobinLimit: number;
  providerStrategies: Record<string, unknown>;
  quotaVisibility: Record<string, unknown>;
  comboStrategy: string;
  comboStickyRoundRobinLimit: number;
  comboStrategies: Record<string, unknown>;
  capacityAdapter: {
    vision: CapacityAdapterConfig;
    pdf: CapacityAdapterConfig;
    audioInput: CapacityAdapterConfig;
    videoInput: CapacityAdapterConfig;
    [key: string]: CapacityAdapterConfig;
  };
  requireLogin: boolean;
  requireApiKey: boolean;
  tunnelDashboardAccess: boolean;
  authMode: string;
  ssoType: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcScopes: string;
  oidcLoginLabel: string;
  samlEntryPoint: string;
  samlIssuer: string;
  samlCert: string;
  samlLoginLabel: string;
  samlAttributeEmail: string;
  samlAttributeName: string;
  enableObservability: boolean;
  observabilityMaxRecords: number;
  observabilityBatchSize: number;
  observabilityFlushIntervalMs: number;
  observabilityMaxJsonSize: number;
  outboundProxyEnabled: boolean;
  outboundProxyUrl: string;
  outboundNoProxy: string;
  mitmRouterBaseUrl: string;
  dnsToolEnabled: Record<string, boolean>;
  rtkEnabled: boolean;
  headroomEnabled: boolean;
  headroomUrl: string;
  headroomCompressUserMessages: boolean;
  headroomTimeoutMs: number;
  cavemanEnabled: boolean;
  cavemanLevel: string;
  ponytailEnabled: boolean;
  ponytailLevel: string;
  loopGuardEnabled: boolean;
  pxpipeEnabled: boolean;
  pxpipeAutoInstall: boolean;
  pxpipeMinChars: number;
  pxpipeTimeoutMs: number;
  providerOverrides: Record<string, unknown>;
  password?: string | null;
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  loopGuardEnabled: false,
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  providerOverrides: {},
};

interface SettingsCacheState {
  data: Settings | null;
  expiresAt: number;
  revision: string | null;
}

let settingsCache: SettingsCacheState = {
  data: null,
  expiresAt: 0,
  revision: null,
};

export function invalidateSettingsCache(): void {
  settingsCache.data = null;
  settingsCache.expiresAt = 0;
  settingsCache.revision = null;
}

export function getCachedSettingsSnapshot(): SettingsCacheState {
  return { ...settingsCache };
}

try {
  subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, (payload: any) => {
    if (!payload || payload.scope === "settings" || payload.scope === "all") {
      invalidateSettingsCache();
    }
  });
} catch {
  // Safe fail-open if events bus cannot hook
}

async function readRaw(): Promise<Record<string, unknown>> {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? ((parseJson as any)(row.data, {}) || {}) : {};
}

export function mergeWithDefaults(raw?: Record<string, unknown> | null): Settings {
  const merged: any = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m: string) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged as Settings;
}

function bumpRevisionSync(db: any): number {
  db.run(
    `INSERT INTO _meta(key, value) VALUES('settings_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  );
  const row = db.get(`SELECT value FROM _meta WHERE key = 'settings_revision'`);
  return row && row.value !== undefined ? Number(row.value) : 1;
}

export async function bumpSettingsRevision(passedDb?: any): Promise<number> {
  const db = passedDb || (await getAdapter());
  let newRevision = 1;
  try {
    newRevision = bumpRevisionSync(db);
  } catch {
    // If _meta table is missing, don't crash
  }

  invalidateSettingsCache();

  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "settings",
      revision: newRevision,
      timestamp: Date.now(),
    });
  } catch {}

  return newRevision;
}

export async function getSettings() {
  const now = Date.now();
  // 1. In-memory cache hit within TTL — zero SQLite queries.
  if (settingsCache.data && now < settingsCache.expiresAt) {
    return settingsCache.data;
  }

  // 2. TTL expired (or cold cache): check settings_revision, then re-read the row.
  const db = await getAdapter();
  let currentRevision: string | null = null;
  try {
    const metaRow = db.get(`SELECT value FROM _meta WHERE key = 'settings_revision'`);
    if (metaRow && metaRow.value !== undefined && metaRow.value !== null) {
      currentRevision = String(metaRow.value);
    }
  } catch {
    // _meta query failed (e.g. table not ready) — treat as unknown revision
  }

  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const raw = row ? (((parseJson as any)(row.data, {}) || {}) as Record<string, unknown>) : {};
  const merged = mergeWithDefaults(raw);

  // Seed settings_revision on first read of a legacy database.
  if (currentRevision === null) {
    try {
      db.run(
        `INSERT INTO _meta(key, value) VALUES('settings_revision', '1') ON CONFLICT(key) DO NOTHING`
      );
      currentRevision = "1";
    } catch {}
  }

  settingsCache.data = merged;
  settingsCache.revision = currentRevision;
  settingsCache.expiresAt = now + SETTINGS_CACHE_TTL_MS;

  return merged;
}

export async function updateSettings(updates: Partial<Settings>): Promise<Settings> {
  const db = await getAdapter();
  let next: any;
  let newRevision = 1;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? (((parseJson as any)(row.data, {}) || {}) as Record<string, unknown>) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );

    try {
      newRevision = bumpRevisionSync(db);
    } catch {}
  });

  invalidateSettingsCache();

  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "settings",
      revision: newRevision,
      timestamp: Date.now(),
    });
  } catch {}

  return mergeWithDefaults(next);
}

export async function isCloudEnabled(): Promise<boolean> {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl(): Promise<string> {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings(): Promise<Record<string, unknown>> {
  return await readRaw();
}

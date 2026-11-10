// Based on OmniRoute (MIT License): https://github.com/cheaper-inference/OmniRoute/tree/2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac
/**
 * Free Proxy Providers Engine for KhatamRouter
 *
 * Provides bounded, opt-in free proxy feed ingestion from curated public feeds:
 * - oneproxy (ProxyScrape v4 JSON API, formerly 1proxy)
 * - proxifly (bulk JSON API via jsdelivr)
 * - iplocate (plain-text http/https lists)
 *
 * Security & Reliability Invariants:
 * 1. Strict Opt-In: Off by default. Requires explicit policy.acknowledgedRisk === true.
 * 2. Egress & DNS Guards: Feed endpoints are pinned to an exact allowlist. All feed
 *    fetches and candidate IPs pass assertGatewayUrlAllowed to prevent SSRF and private
 *    network traversal.
 * 3. Streaming Cap & Redirect Limits: 2 MiB hard streaming cap per feed with early chunk
 *    cancellation, 15-second timeout, max 3 manual redirects, no credential forwarding.
 * 4. Candidate Validation: Rejects SOCKS with explicit reason ("unsupported_socks_protocol"),
 *    rejects userinfo, query, path, and non-IP domain hostnames (preventing DNS rebinding).
 *    Only public IPv4 / literal IPv6 accepted. Keeps scheme exact for HTTP/HTTPS proxies.
 * 5. Bounded Import: Max 1000 records scanned per feed, max 50 pools created per sync.
 * 6. Ownership & Manual Preservation: Ownership strictly verifies server-written provenance
 *    (provenance.source starts with "free:" AND id === computed poolId). Never trusts
 *    id prefixes alone. Manual pools (even with fp_ prefix) are never overwritten.
 * 7. Crash-Safe Single-Write: Pool creation occurs in a single atomic SQL insert with
 *    provenance, preventing any window where an untagged pool can exist.
 * 8. Disjoint Key Concurrency: Policy (user PUT) and Sync Stats (background sync) persist
 *    under separate settings keys (freeProxySources vs freeProxySyncStats), preventing
 *    read-modify-write clobbering.
 * 9. SQLite Immediate Lease: Sync operations acquire a mutual exclusion lease using
 *    SQLite BEGIN IMMEDIATE, rejecting concurrent runs with 409 Conflict.
 */

import net from "node:net";
import { assertGatewayUrlAllowed } from "@/lib/network/gatewayTrust.js";
import { probeLatency } from "@/lib/network/psiphon/probe.js";
import { getAdapter } from "@/lib/db/driver.js";
import {
  updateProxyPool,
  getProxyPools,
  deleteProxyPool,
} from "@/lib/db/repos/proxyPoolsRepo.js";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";

// Canonical fixed feed URLs
export const FREE_PROXY_FEED_URLS = Object.freeze({
  oneproxy:
    "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=json",
  proxifly:
    "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json",
  iplocate:
    "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols",
});

// Allowed hostnames for external feed retrieval
export const ALLOWED_FEED_HOSTS = Object.freeze(
  new Set([
    "api.proxyscrape.com",
    "cdn.jsdelivr.net",
    "raw.githubusercontent.com",
  ])
);

export const KNOWN_SOURCES = Object.freeze(["oneproxy", "proxifly", "iplocate"]);

export const DEFAULT_FREE_PROXY_POLICY = Object.freeze({
  enabled: Object.freeze({
    oneproxy: false,
    proxifly: false,
    iplocate: false,
  }),
  acknowledgedRisk: false,
});

export const MAX_FEED_BYTES = 2 * 1024 * 1024; // 2 MiB streaming cap
export const FEED_TIMEOUT_MS = 15000; // 15 seconds
export const MAX_FEED_REDIRECTS = 3;
export const MAX_SCAN_RECORDS_PER_FEED = 1000;
export const MAX_POOLS_PER_SYNC = 50;
export const SYNC_LEASE_TTL_MS = 60000; // 60 seconds lease TTL

export const PROBE_CONCURRENCY = 8;
export const PROBE_TIMEOUT_MS = 6000;
export const DEFAULT_PROBE_URL = "https://opencode.ai/zen/v1/models";

export const PRUNE_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Probes candidate proxy connectivity using probeLatency against target upstream.
 * Returns true if ok, false otherwise. Never throws.
 */
export async function probeCandidate(
  candidate,
  {
    probeUrl = DEFAULT_PROBE_URL,
    timeoutMs = PROBE_TIMEOUT_MS,
  } = {}
) {
  try {
    const res = await probeLatency(
      candidate?.canonicalUrl,
      probeUrl,
      timeoutMs
    );
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/**
 * Determines if a proxy pool is eligible for pruning.
 * Only free-owned pools that are inactive, testStatus 'error', and older than 1 hour.
 */
export function isPoolPrunable(pool, now = Date.now()) {
  if (!pool || pool.isActive) return false;
  if (pool.testStatus !== "error") return false;

  const provSource = pool.provenance?.source || pool.data?.provenance?.source;
  if (typeof provSource !== "string" || !provSource.startsWith("free:")) {
    return false;
  }

  const poolUrl = pool.proxyUrl || pool.data?.proxyUrl;
  if (!poolUrl) return false;

  const expectedId = computeFreePoolId(poolUrl);
  if (pool.id !== expectedId) return false;

  const poolTime = new Date(pool.createdAt || pool.updatedAt || 0).getTime();
  if (!Number.isFinite(poolTime) || poolTime <= 0) return false;

  return now - poolTime > PRUNE_AGE_MS;
}

/**
 * Validates whether a policy update is well-formed and enforces risk acknowledgment.
 */
export function validatePolicyUpdate(currentPolicy, update = {}) {
  const current = currentPolicy || DEFAULT_FREE_PROXY_POLICY;
  const errors = [];

  if (typeof update !== "object" || update === null) {
    return { valid: false, errors: ["Update payload must be an object"] };
  }

  // Validate enabled sources map if provided
  const nextEnabled = { ...current.enabled };
  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "object" || update.enabled === null) {
      errors.push("enabled must be an object");
    } else {
      for (const [key, val] of Object.entries(update.enabled)) {
        if (!KNOWN_SOURCES.includes(key)) {
          errors.push(`Unknown free proxy source '${key}'. Allowed: ${KNOWN_SOURCES.join(", ")}`);
        } else if (typeof val !== "boolean") {
          errors.push(`Source '${key}' enabled state must be a boolean`);
        } else {
          nextEnabled[key] = val;
        }
      }
    }
  }

  const nextAcknowledgedRisk =
    update.acknowledgedRisk !== undefined
      ? Boolean(update.acknowledgedRisk)
      : Boolean(current.acknowledgedRisk);

  const hasAnyEnabled = Object.values(nextEnabled).some(Boolean);
  if (hasAnyEnabled && !nextAcknowledgedRisk) {
    errors.push(
      "Enabling free proxy sources requires explicit risk acknowledgment (acknowledgedRisk: true)"
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    policy: {
      ...current,
      enabled: nextEnabled,
      acknowledgedRisk: nextAcknowledgedRisk,
    },
  };
}

/**
 * Reads streaming body up to maxBytes, aborting early if limit is exceeded.
 */
export async function readBoundedStream(bodyStream, maxBytes = MAX_FEED_BYTES) {
  if (!bodyStream) return "";
  const reader = bodyStream.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("Streaming limit exceeded");
          throw new Error(`Feed response exceeded ${maxBytes} bytes streaming limit`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches feed URL with manual redirect handling, DNS SSRF guard, streaming cap, and timeout.
 */
export async function fetchFeedBounded(
  targetUrl,
  {
    timeoutMs = FEED_TIMEOUT_MS,
    maxBytes = MAX_FEED_BYTES,
    maxRedirects = MAX_FEED_REDIRECTS,
    customFetch = globalThis.fetch,
  } = {}
) {
  let currentUrl = targetUrl;
  let redirectsCount = 0;

  while (true) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`Invalid feed URL: ${currentUrl}`);
    }

    if (parsed.protocol !== "https:") {
      throw new Error(`Feed URL must use HTTPS protocol: ${currentUrl}`);
    }

    if (!ALLOWED_FEED_HOSTS.has(parsed.hostname)) {
      throw new Error(
        `Host '${parsed.hostname}' is not in the allowed free proxy feed allowlist`
      );
    }

    // SSRF / DNS rebinding guard: target must resolve to a valid public IP or pinned feed origin
    await assertGatewayUrlAllowed(currentUrl, {
      isSelfHosted: true,
      authorizedOrigin: parsed.origin,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await customFetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "KhatamRouter-FreeProxy/1.0",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects manually without forwarding credentials
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw new Error(`Exceeded maximum of ${maxRedirects} redirects`);
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Redirect status ${res.status} missing Location header`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Feed returned HTTP ${res.status}`);
    }

    // Check Content-Length preflight if present
    const cl = res.headers.get("content-length");
    if (cl && parseInt(cl, 10) > maxBytes) {
      throw new Error(`Feed Content-Length ${cl} exceeds maximum ${maxBytes} bytes`);
    }

    return await readBoundedStream(res.body, maxBytes);
  }
}

/**
 * Validates candidate proxy host, port, protocol, and public IP classification.
 * Keeps scheme exact for HTTP/HTTPS proxies. Explicitly reports unsupported protocols.
 */
export async function validateCandidateProxy({
  host,
  port,
  protocol = "http",
  countryCode,
  latencyMs,
  qualityScore,
}) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { valid: false, reason: "invalid_port" };
  }

  const normProto = String(protocol || "http").toLowerCase();
  if (normProto === "socks" || normProto === "socks4" || normProto === "socks5") {
    return { valid: false, reason: "unsupported_socks_protocol" };
  }
  if (normProto !== "http" && normProto !== "https") {
    return { valid: false, reason: "unsupported_protocol" };
  }

  if (typeof host !== "string" || !host.trim()) {
    return { valid: false, reason: "missing_host" };
  }

  const cleanHost = host.trim().replace(/^\[|\]$/g, "");
  const isV4 = net.isIPv4(cleanHost);
  const isV6 = net.isIPv6(cleanHost);

  // Strict: candidate must be an IP literal to prevent DNS rebinding
  if (!isV4 && !isV6) {
    return { valid: false, reason: "not_ip_literal" };
  }

  const candidateUrl = `${normProto}://${isV6 ? `[${cleanHost}]` : cleanHost}:${portNum}`;

  try {
    await assertGatewayUrlAllowed(candidateUrl, { isSelfHosted: false });
  } catch {
    return { valid: false, reason: "private_or_blocked_ip" };
  }

  return {
    valid: true,
    candidate: {
      host: cleanHost,
      port: portNum,
      type: "http",
      canonicalUrl: candidateUrl,
      scheme: normProto,
      countryCode: countryCode ? String(countryCode).slice(0, 2).toUpperCase() : null,
      latencyMs: Number.isFinite(Number(latencyMs)) ? Math.round(Number(latencyMs)) : null,
      qualityScore: Number.isFinite(Number(qualityScore)) ? Math.round(Number(qualityScore)) : null,
    },
  };
}

/**
 * Computes deterministic pool ID using Bun.CryptoHasher sha256 of canonical URL.
 */
export function computeFreePoolId(canonicalUrl) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalUrl);
  return `fp_${hasher.digest("hex").slice(0, 32)}`;
}

/**
 * Creates a free proxy pool in a SINGLE atomic database write with provenance.
 * Eliminates the partial-write crash vulnerability where an untagged pool is left behind.
 */
export async function createFreeProxyPool({
  id,
  name,
  proxyUrl,
  type = "http",
  // Imported pools are active on arrival: sync only creates a pool after the
  // candidate passed a live probe against the upstream, so there is no dead
  // weight to keep switched off.
  isActive = true,
  strictProxy = true,
  provenance,
}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const extra = {
    name,
    proxyUrl,
    noProxy: "",
    type,
    strictProxy: Boolean(strictProxy),
    lastTestedAt: null,
    lastError: null,
    provenance,
  };
  const dataJson = JSON.stringify(extra);

  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [id, isActive ? 1 : 0, "unknown", dataJson, now, now]
  );

  return {
    ...extra,
    data: extra,
    id,
    isActive: Boolean(isActive),
    testStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Acquires a synchronization lease using SQLite BEGIN IMMEDIATE.
 * Rejects concurrent runs (two clicks/workers) to prevent double creation.
 */
export async function acquireFreeProxySyncLease(leaseTtlMs = SYNC_LEASE_TTL_MS) {
  const db = await getAdapter();
  const now = Date.now();
  const expiresAt = now + leaseTtlMs;
  const leaseId = `lease_${Math.random().toString(36).slice(2)}_${now}`;

  let acquired = false;
  try {
    acquired = db.immediate(() => {
      const row = db.get(
        "SELECT value FROM kv WHERE scope = ? AND key = ?",
        ["leases", "free_proxy_sync"]
      );
      if (row) {
        try {
          const val = JSON.parse(row.value);
          if (val && typeof val.expiresAt === "number" && val.expiresAt > now) {
            return false;
          }
        } catch {}
      }
      db.run(
        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        ["leases", "free_proxy_sync", JSON.stringify({ holder: leaseId, expiresAt })]
      );
      return true;
    });
  } catch {
    acquired = false;
  }

  return { acquired, leaseId };
}

/**
 * Releases the synchronization lease if held by leaseId.
 */
export async function releaseFreeProxySyncLease(leaseId) {
  const db = await getAdapter();
  try {
    db.immediate(() => {
      const row = db.get(
        "SELECT value FROM kv WHERE scope = ? AND key = ?",
        ["leases", "free_proxy_sync"]
      );
      if (row) {
        try {
          const val = JSON.parse(row.value);
          if (val && val.holder === leaseId) {
            db.run(
              "DELETE FROM kv WHERE scope = ? AND key = ?",
              ["leases", "free_proxy_sync"]
            );
          }
        } catch {}
      }
    });
  } catch {}
}

/**
 * Extracts candidate proxies from oneproxy API payload (ProxyScrape v4 JSON format).
 */
export function parseOneproxyFeed(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
  const candidates = [];

  for (const item of list.slice(0, MAX_SCAN_RECORDS_PER_FEED)) {
    if (!item || !item.ip || !item.port) continue;
    if (item.alive === false) continue;

    candidates.push({
      host: item.ip,
      port: item.port,
      protocol: item.protocol || "http",
      countryCode: item.ip_data?.countryCode || item.country_code || null,
      latencyMs: item.timeout ?? item.latency_ms ?? null,
      qualityScore: item.uptime ?? item.quality_score ?? null,
    });
  }

  return candidates;
}

/**
 * Extracts candidate proxies from proxifly API payload.
 */
export function parseProxiflyFeed(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  let list = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (Array.isArray(parsed?.proxies)) {
    list = parsed.proxies;
  } else if (parsed && typeof parsed === "object" && parsed.ip) {
    list = [parsed];
  }

  const candidates = [];
  for (const item of list.slice(0, MAX_SCAN_RECORDS_PER_FEED)) {
    if (!item || !item.ip || !item.port) continue;
    candidates.push({
      host: item.ip,
      port: item.port,
      protocol: item.protocol || "http",
      countryCode: item.geolocation?.country || item.country,
      latencyMs: item.speed,
      qualityScore: item.quality_score ?? item.score,
    });
  }

  return candidates;
}

/**
 * Extracts candidate proxies from iplocate plain-text list (host:port per line).
 * Keeps scheme exact based on the source list protocol (http vs https).
 */
export function parseIplocateFeed(text, protocol = "http") {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const candidates = [];

  for (const line of lines.slice(0, MAX_SCAN_RECORDS_PER_FEED)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.lastIndexOf(":");
    if (sep <= 0) continue;

    const host = trimmed.slice(0, sep).trim();
    const port = Number(trimmed.slice(sep + 1).trim());
    if (!host || !port) continue;

    candidates.push({
      host,
      port,
      protocol,
      countryCode: null,
      latencyMs: null,
      qualityScore: null,
    });
  }

  return candidates;
}

/**
 * Executes a full sync cycle across enabled free proxy sources.
 */
export async function runFreeProxySync({
  sources = null,
  prune = true,
  probeUrl = DEFAULT_PROBE_URL,
  customFetch = globalThis.fetch,
} = {}) {
  const settings = await getSettings();
  const policy = settings?.freeProxySources || DEFAULT_FREE_PROXY_POLICY;

  const enabledSources = KNOWN_SOURCES.filter((s) => policy.enabled?.[s] === true);
  if (enabledSources.length === 0) {
    return {
      success: true,
      message: "No free proxy sources are enabled",
      added: 0,
      updated: 0,
      skipped: 0,
      failures: 0,
      pruned: 0,
      total: 0,
    };
  }

  if (!policy.acknowledgedRisk) {
    return {
      success: false,
      error: "Free proxy sync requires explicit policy risk acknowledgment",
      added: 0,
      updated: 0,
      skipped: 0,
      failures: 0,
      pruned: 0,
      total: 0,
    };
  }

  const targetSources = Array.isArray(sources) && sources.length > 0
    ? sources.filter((s) => enabledSources.includes(s))
    : enabledSources;

  if (targetSources.length === 0) {
    return {
      success: true,
      message: "No requested sources are currently enabled",
      added: 0,
      updated: 0,
      skipped: 0,
      failures: 0,
      pruned: 0,
      total: 0,
    };
  }

  const existingPools = await getProxyPools();
  let pruned = 0;
  const existingPoolMap = new Map();

  for (const p of existingPools) {
    if (prune && isPoolPrunable(p)) {
      try {
        await deleteProxyPool(p.id);
        pruned++;
        continue;
      } catch {
        // Keep in map if deletion failed
      }
    }
    if (p.id) existingPoolMap.set(p.id, p);
    if (p.proxyUrl) existingPoolMap.set(p.proxyUrl, p);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let failures = 0;
  let totalProcessed = 0;
  const seenCanonicalUrls = new Set();

  for (const source of targetSources) {
    if (totalProcessed >= MAX_POOLS_PER_SYNC) break;

    let rawCandidates = [];
    try {
      if (source === "oneproxy") {
        const text = await fetchFeedBounded(FREE_PROXY_FEED_URLS.oneproxy, { customFetch });
        rawCandidates = parseOneproxyFeed(text);
      } else if (source === "proxifly") {
        const text = await fetchFeedBounded(FREE_PROXY_FEED_URLS.proxifly, { customFetch });
        rawCandidates = parseProxiflyFeed(text);
      } else if (source === "iplocate") {
        // Fetch both http and https text lists, preserving exact schemes
        const httpText = await fetchFeedBounded(
          `${FREE_PROXY_FEED_URLS.iplocate}/http.txt`,
          { customFetch }
        ).catch(() => "");
        const httpsText = await fetchFeedBounded(
          `${FREE_PROXY_FEED_URLS.iplocate}/https.txt`,
          { customFetch }
        ).catch(() => "");
        rawCandidates = [
          ...parseIplocateFeed(httpText, "http"),
          ...parseIplocateFeed(httpsText, "https"),
        ];
      }
    } catch {
      failures++;
      continue;
    }

    let rawIdx = 0;
    let stopSource = false;

    async function probeWorker() {
      while (!stopSource && rawIdx < rawCandidates.length) {
        if (totalProcessed >= MAX_POOLS_PER_SYNC) {
          stopSource = true;
          break;
        }

        const raw = rawCandidates[rawIdx++];
        if (!raw) break;

        const val = await validateCandidateProxy(raw);
        if (!val.valid) {
          skipped++;
          continue;
        }

        const { candidate } = val;
        if (seenCanonicalUrls.has(candidate.canonicalUrl)) {
          skipped++;
          continue;
        }
        seenCanonicalUrls.add(candidate.canonicalUrl);

        const poolId = computeFreePoolId(candidate.canonicalUrl);
        const existing =
          existingPoolMap.get(poolId) || existingPoolMap.get(candidate.canonicalUrl);

        const now = new Date().toISOString();

        if (existing) {
          // Ownership invariant: must verify server-written provenance AND id match.
          // Never trust id prefix (e.g. fp_xxx) alone because user manual pools can set id.
          // Existing pools in the DB are NOT re-probed to keep re-sync cheap.
          const provSource =
            existing?.provenance?.source || existing?.data?.provenance?.source;
          const isFree =
            typeof provSource === "string" &&
            provSource.startsWith("free:") &&
            existing?.id === poolId;

          if (!isFree) {
            skipped++;
            continue;
          }

          const prevProvenance = existing.provenance || existing.data?.provenance || {};
          await updateProxyPool(existing.id, {
            updatedAt: now,
            // A feed cannot distinguish legacy defaults from an operator's explicit disable.
            isActive: existing.isActive,
            provenance: {
              ...prevProvenance,
              source: `free:${source}`,
              lastSeenAt: now,
              untrusted: true,
              countryCode: candidate.countryCode || prevProvenance.countryCode || null,
              latencyMs: candidate.latencyMs ?? prevProvenance.latencyMs ?? null,
              qualityScore: candidate.qualityScore ?? prevProvenance.qualityScore ?? null,
            },
          });
          updated++;
          totalProcessed++;

          if (totalProcessed >= MAX_POOLS_PER_SYNC) {
            stopSource = true;
            break;
          }
          continue;
        }

        // New candidate: probe connectivity before creating the pool
        const ok = await probeCandidate(candidate, { probeUrl });
        if (totalProcessed >= MAX_POOLS_PER_SYNC) {
          stopSource = true;
          break;
        }

        if (!ok) {
          skipped++;
          continue;
        }

        if (totalProcessed >= MAX_POOLS_PER_SYNC) {
          stopSource = true;
          break;
        }

        // Reserve the slot synchronously before async pool creation to prevent overshoot
        added++;
        totalProcessed++;
        if (totalProcessed >= MAX_POOLS_PER_SYNC) {
          stopSource = true;
        }

        // New free pool: atomic single-write with provenance. Active on arrival —
        // the probe above already proved it reaches the upstream.
        const newPool = await createFreeProxyPool({
          id: poolId,
          name: `[${source}] ${candidate.host}:${candidate.port}`,
          proxyUrl: candidate.canonicalUrl,
          type: "http",
          isActive: true,
          strictProxy: true,
          provenance: {
            source: `free:${source}`,
            lastSeenAt: now,
            untrusted: true,
            countryCode: candidate.countryCode,
            latencyMs: candidate.latencyMs,
            qualityScore: candidate.qualityScore,
          },
        });

        existingPoolMap.set(poolId, newPool);
        existingPoolMap.set(candidate.canonicalUrl, newPool);
      }
    }

    const workerCount = Math.min(PROBE_CONCURRENCY, rawCandidates.length);
    if (workerCount > 0) {
      await Promise.all(
        Array.from({ length: workerCount }, () => probeWorker())
      );
    }
  }

  const syncStats = {
    added,
    updated,
    skipped,
    failures,
    pruned,
    total: totalProcessed,
  };

  // Persist sync stats under a separate key to eliminate read-modify-write race with user policy PUTs
  await updateSettings({
    freeProxySyncStats: {
      lastSyncAt: new Date().toISOString(),
      lastSyncStats: syncStats,
    },
  });

  return {
    success: true,
    ...syncStats,
  };
}

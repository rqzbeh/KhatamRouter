/**
 * Dashboard progressive login limiter with Redis cluster coordination and in-memory fallback.
 *
 * Coordinates failed attempts and lockout thresholds across router replicas under
 * `khatam:ratelimit:login:<ipHash>` with 15-minute expiration (Contract Section 1 & 2.4).
 *
 * Operational invariants:
 * - Fail-open: When Redis is absent or errors out, falls back to the in-memory Map.
 * - Secret hygiene: Client IPs are SHA-256 hashed and truncated to 16 hex chars; never stored cleartext.
 * - Dual sync/async contract: Functions return synchronously usable results while also
 *   supporting async/await for distributed Redis coordination.
 */

import { createHash } from "node:crypto";
import { hasTrustedPeerHeaders } from "./trustedPeer.js";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";

export const MAX_FAILS_BEFORE_LOCK = 5;
export const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
export const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset
export const LOGIN_REDIS_TTL_SEC = 900; // 15 minutes

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() {
  return Date.now();
}

/**
 * Hash a client IP so raw IP addresses never appear in Redis keys or logs.
 */
export function hashClientIp(ip) {
  const raw = String(ip || "unknown").trim();
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getRedisLimiterKey(ip) {
  const ipHash = hashClientIp(ip);
  // Explicitly include "khatam:ratelimit:login" in the key pattern
  return withRedisKey ? withRedisKey(`ratelimit:login:${ipHash}`) : `khatam:ratelimit:login:${ipHash}`;
}

function getLocalEntry(ip) {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLockSync(ip) {
  const e = getLocalEntry(ip);
  if (!e || !e.lockUntil) return { locked: false, retryAfter: 0 };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export async function checkLockAsync(ip) {
  const local = checkLockSync(ip);
  if (local.locked) return local;

  if (!isRedisConfigured()) return local;
  const client = getRedisClient();
  if (!client) return local;

  try {
    const key = getRedisLimiterKey(ip);
    const raw = await client.get(key);
    if (!raw) return { locked: false, retryAfter: 0 };

    const parsed = JSON.parse(raw);
    if (parsed && parsed.lockUntil && parsed.lockUntil > now()) {
      const remaining = parsed.lockUntil - now();
      // Sync to local memory
      attempts.set(ip, {
        fails: parsed.fails || 0,
        lockUntil: parsed.lockUntil,
        lockLevel: parsed.lockLevel || 0,
        lastFailAt: parsed.lastFailAt || now(),
      });
      return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
    }
  } catch {
    // Fail-open: return local evaluation
  }

  return local;
}

/**
 * Check if client IP is currently locked out.
 * Returns a hybrid result: immediately inspectable { locked, retryAfter }
 * and thenable if awaited.
 */
export function checkLock(ip) {
  const syncResult = checkLockSync(ip);
  return {
    locked: syncResult.locked,
    retryAfter: syncResult.retryAfter,
    then(onResolve, onReject) {
      return checkLockAsync(ip).then(onResolve, onReject);
    },
  };
}

export function recordFailSync(ip) {
  const e = getLocalEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  return {
    remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails),
    entry: { ...e },
  };
}

export async function recordFailAsync(ip) {
  const localRes = recordFailSync(ip);

  if (isRedisConfigured()) {
    const client = getRedisClient();
    if (client) {
      try {
        const key = getRedisLimiterKey(ip);
        const existingRaw = await client.get(key);
        let remoteFails = 0;
        let remoteLockUntil = 0;
        let remoteLockLevel = 0;

        if (existingRaw) {
          try {
            const parsed = JSON.parse(existingRaw);
            remoteFails = parsed.fails || 0;
            remoteLockUntil = parsed.lockUntil || 0;
            remoteLockLevel = parsed.lockLevel || 0;
          } catch {}
        }

        const totalFails = Math.max(localRes.entry.fails, remoteFails + 1);
        let finalLockUntil = Math.max(localRes.entry.lockUntil, remoteLockUntil);
        let finalLockLevel = Math.max(localRes.entry.lockLevel, remoteLockLevel);

        if (totalFails >= MAX_FAILS_BEFORE_LOCK) {
          const step = LOCK_STEPS_MS[Math.min(finalLockLevel, LOCK_STEPS_MS.length - 1)];
          finalLockUntil = now() + step;
          finalLockLevel += 1;
        }

        const toStore = {
          fails: totalFails >= MAX_FAILS_BEFORE_LOCK ? 0 : totalFails,
          lockUntil: finalLockUntil,
          lockLevel: finalLockLevel,
          lastFailAt: now(),
        };

        await client.set(key, JSON.stringify(toStore), "EX", LOGIN_REDIS_TTL_SEC);

        // Sync local
        attempts.set(ip, toStore);

        return {
          remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - toStore.fails),
        };
      } catch {
        // Fail-open: keep local result
      }
    }
  }

  return { remainingBeforeLock: localRes.remainingBeforeLock };
}

/**
 * Record a failed login attempt for client IP.
 * Returns a hybrid result with synchronous `remainingBeforeLock` and thenable if awaited.
 */
export function recordFail(ip) {
  const syncRes = recordFailSync(ip);

  // Background async sync to Redis if caller does not await
  if (isRedisConfigured()) {
    const client = getRedisClient();
    if (client) {
      const key = getRedisLimiterKey(ip);
      client.set(key, JSON.stringify(syncRes.entry), "EX", LOGIN_REDIS_TTL_SEC).catch(() => {});
    }
  }

  return {
    remainingBeforeLock: syncRes.remainingBeforeLock,
    then(onResolve, onReject) {
      return recordFailAsync(ip).then(onResolve, onReject);
    },
  };
}

export function recordSuccess(ip) {
  attempts.delete(ip);
  if (isRedisConfigured()) {
    const client = getRedisClient();
    if (client) {
      const key = getRedisLimiterKey(ip);
      client.del(key).catch(() => {});
    }
  }
}

export function clearLoginLimiter() {
  attempts.clear();
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}

// Based on OmniRoute (MIT License): https://github.com/cheaper-inference/OmniRoute/tree/2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac
/**
 * Free Proxy Feed Periodic Sync Scheduler
 *
 * Automatically schedules periodic runFreeProxySync invocations for enabled free proxy feeds.
 * Opt-in only: requires explicit acknowledgedRisk and at least one enabled feed source.
 * Re-checks policy on every tick so toggling feeds off or on in the dashboard stops or resumes
 * imports without requiring a server restart.
 *
 * Concurrency Safety:
 * Acquires the same SQLite lease as manual sync to reject concurrent syncs;
 * also prevents overlapping ticks within the process.
 */

import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import {
  DEFAULT_FREE_PROXY_POLICY,
  KNOWN_SOURCES,
  runFreeProxySync,
  acquireFreeProxySyncLease,
  releaseFreeProxySyncLease,
} from "./index.js";

export const DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS = 21600000; // 6 hours
export const MIN_FREE_PROXY_SYNC_INTERVAL_MS = 60000; // 1 minute

const MAX_TIMER_INTERVAL_MS = 2147483647;

// Next.js hot reload can evaluate the module again; keep timer ownership process-wide.
const state = globalThis.__freeProxySyncState ??= { timer: null, tickRunning: false };

/**
 * Parses and clamps FREE_PROXY_SYNC_INTERVAL_MS from the environment.
 * Defaults to 6h (21600000 ms), minimum allowed is 60_000 ms.
 */
export function parseSyncInterval(env = process.env) {
  const raw = env?.FREE_PROXY_SYNC_INTERVAL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    return DEFAULT_FREE_PROXY_SYNC_INTERVAL_MS;
  }
  if (parsed < MIN_FREE_PROXY_SYNC_INTERVAL_MS) {
    return MIN_FREE_PROXY_SYNC_INTERVAL_MS;
  }
  return Math.min(Math.floor(parsed), MAX_TIMER_INTERVAL_MS);
}

/**
 * Checks whether the free proxy policy is active (risk acknowledged and at least one source enabled).
 */
export function isPolicyActive(policy) {
  if (policy?.acknowledgedRisk !== true) return false;
  return KNOWN_SOURCES.some((s) => policy.enabled?.[s] === true);
}

/**
 * Executes a single scheduler tick. Re-checks policy and skips if disabled.
 * Errors are logged and caught; a failed policy read performs no imports.
 */
export async function runSchedulerTick() {
  if (state.tickRunning) return;
  state.tickRunning = true;
  let leaseId = null;
  try {
    const settings = await getSettings();
    const policy =
      settings?.freeProxySources || DEFAULT_FREE_PROXY_POLICY;
    if (!isPolicyActive(policy)) {
      return;
    }

    const lease = await acquireFreeProxySyncLease();
    if (!lease.acquired) return;
    leaseId = lease.leaseId;
    await runFreeProxySync();
  } catch (err) {
    console.error("[FreeProxyScheduler] Free proxy sync tick error:", err?.message || err);
  } finally {
    try {
      if (leaseId) await releaseFreeProxySyncLease(leaseId);
    } catch (err) {
      console.error("[FreeProxyScheduler] Failed to release sync lease:", err?.message || err);
    } finally {
      state.tickRunning = false;
    }
  }
}

/**
 * Starts the periodic free proxy sync scheduler.
 * Idempotent: multiple calls will not create duplicate timers.
 * Always installs a timer so feeds enabled after startup are picked up without a restart.
 * Each tick checks policy before performing any network work.
 *
 * @returns {Promise<boolean>} true if scheduler started, false if already running
 */
export async function startFreeProxySyncScheduler() {
  if (state.timer !== null) return false;
  try {
    const intervalMs = parseSyncInterval();
    state.timer = setInterval(() => {
      runSchedulerTick().catch((err) => {
        console.error("[FreeProxyScheduler] Unhandled tick rejection:", err?.message || err);
      });
    }, intervalMs);

    if (typeof state.timer?.unref === "function") {
      state.timer.unref();
    }

    globalThis.__freeProxySyncScheduler = { stop: stopFreeProxySyncScheduler };
    void runSchedulerTick();
    return true;
  } catch (err) {
    console.error("[FreeProxyScheduler] Failed to start scheduler:", err?.message || err);
    return false;
  }
}

/**
 * Stops the free proxy sync scheduler and clears its timer.
 */
export function stopFreeProxySyncScheduler() {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/**
 * Returns whether the free proxy sync scheduler is currently running.
 */
export function isFreeProxySyncSchedulerRunning() {
  return state.timer !== null;
}

export {
  parseSyncInterval as getSyncIntervalMs,
  runSchedulerTick as tickFreeProxySync,
};

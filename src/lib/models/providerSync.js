import { getAdapter } from "../db/driver.js";
import {
  publishKhatamEvent,
  KHATAM_EVENTS,
} from "../redis/events.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderNodes } from "../db/repos/nodesRepo.js";

export class PolicyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

export const SYNC_POLICY_SCOPE = "modelSyncPolicy";
export const SYNC_POLICY_KEY = "policy";

export const MIN_SYNC_INTERVAL_MS = 3_600_000; // 1 hour
export const MAX_SYNC_INTERVAL_MS = 604_800_000; // 7 days
export const DEFAULT_SYNC_INTERVAL_MS = 86_400_000; // 24 hours

export const GLOBAL_POLICY_MODES = Object.freeze(["enabled", "disabled"]);
export const PROVIDER_POLICY_MODES = Object.freeze(["inherit", "enabled", "disabled"]);

export const DEFAULT_SYNC_POLICY = Object.freeze({
  globalDefault: "disabled",
  providers: Object.freeze({}),
  intervalMs: DEFAULT_SYNC_INTERVAL_MS,
});

export const GLOBAL_RUN_MAX_MS = 5 * 60 * 1000;
export const DEFAULT_PER_CONNECTION_TIMEOUT_MS = 30_000;
export const MAX_CONNECTIONS_PER_RUN = 100;
export const OP_TIMEOUT_MS = 10_000;

function sanitizeReason(err, res, aborted) {
  if (aborted) return "timed out or aborted";
  const msg = String(err?.message || "").toLowerCase();
  const status = res?.status || err?.status || err?.statusCode;
  if (status === 429 || msg.includes("429") || msg.includes("rate limit")) return "rate_limited_429";
  if (status === 401 || status === 403 || msg.includes("auth") || msg.includes("bearer") || msg.includes("unauthorized") || msg.includes("forbidden")) return "auth_failed";
  if (status >= 500) return `upstream_${status}`;
  if (status >= 400) return `client_error_${status}`;
  const code = String(err?.code || err?.name || "").toLowerCase();
  if (code.includes("abort") || code.includes("timeout") || msg.includes("timeout") || msg.includes("abort")) return "timed out or aborted";
  if (code.includes("econrefused") || code.includes("enotfound") || code.includes("fetch")) return "network_error";
  return err ? "sync_failed" : (res?.ok ? "ok" : "upstream_rejected");
}

function raceWithSignalAndTimeout(promiseFn, signal, timeoutMs, errorMsg = "Operation timed out") {
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      return reject(err);
    }

    if (signal) {
      onAbort = () => {
        cleanup();
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        const err = new Error(errorMsg);
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    Promise.resolve()
      .then(promiseFn)
      .then((val) => {
        cleanup();
        resolve(val);
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

export async function getKnownProviderIds(additionalNodes) {
  const ids = new Set(REGISTRY.map((r) => r.id));
  if (additionalNodes && Array.isArray(additionalNodes)) {
    for (const node of additionalNodes) {
      if (node && typeof node.id === "string") ids.add(node.id);
      else if (typeof node === "string") ids.add(node);
    }
  } else {
    // If DB fails, throw so caller can return 503 instead of rejecting valid custom nodes
    const nodes = await getProviderNodes();
    for (const node of nodes || []) {
      if (node?.id) ids.add(node.id);
    }
  }
  return ids;
}

export function normalizeSyncPolicy(input = {}, knownIds) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Policy must be a non-null object");
  }

  const allowedFields = new Set(["globalDefault", "providers", "intervalMs", "replace"]);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      throw new PolicyValidationError(`Unknown policy field: '${key}'`);
    }
  }

  if (input.replace !== undefined && typeof input.replace !== "boolean") {
    throw new TypeError("replace field must be a boolean");
  }

  const globalDefault = input.globalDefault !== undefined ? input.globalDefault : DEFAULT_SYNC_POLICY.globalDefault;
  if (!GLOBAL_POLICY_MODES.includes(globalDefault)) {
    throw new PolicyValidationError(`Invalid globalDefault: '${globalDefault}'. Must be one of: ${GLOBAL_POLICY_MODES.join(", ")}`);
  }

  const intervalMs = input.intervalMs !== undefined ? input.intervalMs : DEFAULT_SYNC_POLICY.intervalMs;
  if (
    typeof intervalMs !== "number" ||
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_SYNC_INTERVAL_MS ||
    intervalMs > MAX_SYNC_INTERVAL_MS
  ) {
    throw new PolicyValidationError(
      `Invalid intervalMs: must be an integer between ${MIN_SYNC_INTERVAL_MS} (1h) and ${MAX_SYNC_INTERVAL_MS} (7d)`
    );
  }

  const normalizedProviders = {};
  if (input.providers !== undefined) {
    if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers)) {
      throw new TypeError("Policy providers must be an object map");
    }

    const knownSet = knownIds ? (knownIds instanceof Set ? knownIds : new Set(knownIds)) : null;

    for (const [providerId, mode] of Object.entries(input.providers)) {
      if (knownSet && !knownSet.has(providerId)) {
        throw new PolicyValidationError(`Unknown provider id: '${providerId}'`);
      }
      if (!PROVIDER_POLICY_MODES.includes(mode)) {
        throw new PolicyValidationError(
          `Invalid policy mode '${mode}' for provider '${providerId}'. Must be one of: ${PROVIDER_POLICY_MODES.join(", ")}`
        );
      }
      normalizedProviders[providerId] = mode;
    }
  }

  return {
    globalDefault,
    providers: normalizedProviders,
    intervalMs,
  };
}

export function resolveProviderSyncEnabled(policy, providerId) {
  if (!policy || typeof policy !== "object" || !providerId) return false;
  const providerMode = policy.providers?.[providerId];
  if (providerMode === "enabled") return true;
  if (providerMode === "disabled") return false;
  if (providerMode === "inherit" || providerMode === undefined) {
    return policy.globalDefault === "enabled";
  }
  return false;
}

export async function getSyncPolicy({ db } = {}) {
  const adapter = db || (await getAdapter());
  const row = adapter.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [
    SYNC_POLICY_SCOPE,
    SYNC_POLICY_KEY,
  ]);
  if (!row || !row.value) {
    return {
      globalDefault: DEFAULT_SYNC_POLICY.globalDefault,
      providers: { ...DEFAULT_SYNC_POLICY.providers },
      intervalMs: DEFAULT_SYNC_INTERVAL_MS,
    };
  }

  try {
    const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return normalizeSyncPolicy(parsed);
  } catch {
    return {
      globalDefault: DEFAULT_SYNC_POLICY.globalDefault,
      providers: { ...DEFAULT_SYNC_POLICY.providers },
      intervalMs: DEFAULT_SYNC_INTERVAL_MS,
    };
  }
}

export async function setSyncPolicy(input, { db, knownIds, merge = true, replace = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Policy must be a non-null object");
  }
  if (input.providers !== undefined && (typeof input.providers !== "object" || input.providers === null || Array.isArray(input.providers))) {
    throw new TypeError("Policy providers must be an object map");
  }
  if (input.replace !== undefined && typeof input.replace !== "boolean") {
    throw new TypeError("replace field must be a boolean");
  }

  const adapter = db || (await getAdapter());

  // 1. Transaction strictly writes to SQLite
  const normalized = adapter.immediate(() => {
    let mergedInput = input;
    if (merge) {
      let existing = {};
      const row = adapter.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [
        SYNC_POLICY_SCOPE,
        SYNC_POLICY_KEY,
      ]);
      if (row && row.value) {
        try {
          existing = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        } catch {}
      }

      const shouldReplace = replace === true || input?.replace === true;
      const mergedProviders = shouldReplace
        ? (input?.providers !== undefined ? { ...input.providers } : (existing?.providers || {}))
        : {
            ...(existing?.providers || {}),
            ...(input?.providers || {}),
          };

      mergedInput = {
        globalDefault: input?.globalDefault !== undefined ? input.globalDefault : (existing?.globalDefault || DEFAULT_SYNC_POLICY.globalDefault),
        intervalMs: input?.intervalMs !== undefined ? input.intervalMs : (existing?.intervalMs || DEFAULT_SYNC_INTERVAL_MS),
        providers: mergedProviders,
      };

      for (const k of Object.keys(input || {})) {
        if (!["globalDefault", "intervalMs", "providers", "replace"].includes(k)) {
          mergedInput[k] = input[k];
        }
      }
    }

    const norm = normalizeSyncPolicy(mergedInput, knownIds);
    adapter.run(
      "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
      [SYNC_POLICY_SCOPE, SYNC_POLICY_KEY, JSON.stringify(norm)]
    );
    return norm;
  });

  // 2. Publish event strictly AFTER transaction commits
  try {
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "modelSyncPolicy",
      timestamp: Date.now(),
    });
  } catch {}

  return normalized;
}

export async function runProviderSyncOnce({
  policy,
  connections,
  importConnection,
  signal,
  perConnectionTimeoutMs = DEFAULT_PER_CONNECTION_TIMEOUT_MS,
  maxConnections = MAX_CONNECTIONS_PER_RUN,
  startCursor = 0,
}) {
  if (typeof importConnection !== "function") {
    throw new TypeError("importConnection function is required");
  }

  const rawList = typeof connections === "function" ? await connections() : connections;
  const allConnections = Array.isArray(rawList) ? rawList : (rawList?.connections || []);

  let skippedInactive = 0;
  let skippedDisabled = 0;
  const eligible = [];

  for (const conn of allConnections) {
    if (!conn) continue;
    if (conn.isActive === false || conn.isActive === 0) {
      skippedInactive++;
      continue;
    }
    if (!resolveProviderSyncEnabled(policy, conn.provider)) {
      skippedDisabled++;
      continue;
    }
    eligible.push(conn);
  }

  const cursor = Math.max(0, Number.isInteger(startCursor) ? startCursor : 0);
  const effectiveCursor = cursor < eligible.length ? cursor : 0;
  const reordered = eligible.slice(effectiveCursor).concat(eligible.slice(0, effectiveCursor));
  const batch = reordered.slice(0, maxConnections);
  const nextCursor = (effectiveCursor + batch.length) % (eligible.length || 1);
  const hasMore = eligible.length > batch.length;
  const remainingCount = Math.max(0, eligible.length - batch.length);
  const results = [];

  for (const conn of batch) {
    if (signal?.aborted) {
      return {
        ok: false,
        aborted: true,
        processed: results.length,
        skipped: { inactive: skippedInactive, policyDisabled: skippedDisabled },
        results,
        hasMore: true,
        remainingCount: eligible.length - results.length,
        nextCursor: (effectiveCursor + results.length) % (eligible.length || 1),
      };
    }

    const connCtrl = new AbortController();
    let isSuccess = false;
    let sanitizedError = null;
    let modelsCount = 0;
    let timedOutOrAborted = false;

    try {
      // Hard timeout raced against signal so parent abort cancels immediately
      const res = await raceWithSignalAndTimeout(
        () => importConnection(conn, { signal: connCtrl.signal }),
        signal,
        perConnectionTimeoutMs,
        "Connection sync timeout"
      );
      isSuccess = Boolean(res && res.ok === true);
      if (isSuccess) {
        modelsCount = Number.isInteger(res.modelsCount) ? res.modelsCount : (Array.isArray(res.models) ? res.models.length : 0);
      } else {
        sanitizedError = sanitizeReason(null, res, false);
      }
    } catch (err) {
      const isAbort = connCtrl.signal.aborted || signal?.aborted || err?.name === "AbortError" || err?.name === "TimeoutError";
      sanitizedError = sanitizeReason(err, null, isAbort);
      if (isAbort) timedOutOrAborted = true;
    } finally {
      connCtrl.abort();
    }

    results.push({
      connectionId: conn.id,
      provider: conn.provider,
      success: isSuccess,
      error: isSuccess ? undefined : sanitizedError,
      modelsCount: isSuccess ? modelsCount : undefined,
    });

    // On timeout or abort: STOP cycle immediately to prevent overlapping orphan execution
    if (timedOutOrAborted) {
      return {
        ok: false,
        aborted: true,
        processed: results.length,
        skipped: { inactive: skippedInactive, policyDisabled: skippedDisabled },
        results,
        hasMore: true,
        remainingCount: eligible.length - results.length,
        nextCursor: (effectiveCursor + results.length) % (eligible.length || 1),
      };
    }
  }

  return {
    ok: true,
    aborted: false,
    processed: results.length,
    skipped: { inactive: skippedInactive, policyDisabled: skippedDisabled },
    results,
    hasMore,
    remainingCount,
    nextCursor: hasMore ? nextCursor : 0,
  };
}

export function createProviderSyncScheduler({
  getPolicy = getSyncPolicy,
  listConnections,
  importConnection,
  clock = Date.now,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  },
  clearTimer = (id) => clearTimeout(id),
  role,
  globalRunMaxMs = GLOBAL_RUN_MAX_MS,
  perConnectionTimeoutMs = DEFAULT_PER_CONNECTION_TIMEOUT_MS,
  maxConnectionsPerRun = MAX_CONNECTIONS_PER_RUN,
  logger = console,
} = {}) {
  let activeTimer = null;
  let activeAbortController = null;
  let inFlight = false;
  let stopped = true;
  let resumeCursor = 0;
  let runGeneration = 0;
  let lastRunAt = null;
  let lastRunResult = null;

  const resolvedRole = (role !== undefined ? role : (process.env.KHATAM_WORKER_ROLE || "")).toLowerCase().trim();
  const isLeaderOrSolo = !resolvedRole || resolvedRole === "leader";

  async function executeCycle({ bypassStopped = false } = {}) {
    if (!isLeaderOrSolo) return { ok: false, reason: "follower-skip" };
    if (inFlight) return { ok: false, inFlight: true };
    if (stopped && !bypassStopped) return { ok: false, stopped: true };

    const cycleGen = runGeneration;
    inFlight = true;
    const cycleCtrl = new AbortController();
    activeAbortController = cycleCtrl;

    let policy;
    try {
      policy = await raceWithSignalAndTimeout(
        () => getPolicy(),
        cycleCtrl.signal,
        OP_TIMEOUT_MS,
        "Failed to fetch sync policy within timeout"
      );
    } catch (err) {
      const sanitized = sanitizeReason(err, null, cycleCtrl.signal.aborted);
      logger.error?.("[modelSyncScheduler] Failed to resolve sync policy:", sanitized);
      lastRunResult = { ok: false, error: sanitized };
      if (!stopped && cycleGen === runGeneration) scheduleNext(DEFAULT_SYNC_INTERVAL_MS);
      return lastRunResult;
    } finally {
      if (cycleCtrl.signal.aborted || (stopped && !bypassStopped) || cycleGen !== runGeneration) {
        if (activeAbortController === cycleCtrl) activeAbortController = null;
        inFlight = false;
      }
    }

    if (cycleCtrl.signal.aborted || (stopped && !bypassStopped) || cycleGen !== runGeneration) {
      return { ok: false, aborted: true };
    }

    const nextInterval = policy?.intervalMs || DEFAULT_SYNC_INTERVAL_MS;
    const hasEnabledSpecific = Object.values(policy?.providers || {}).some((v) => v === "enabled");
    const isGloballyEnabled = policy?.globalDefault === "enabled";

    if (!hasEnabledSpecific && !isGloballyEnabled) {
      resumeCursor = 0;
      if (activeAbortController === cycleCtrl) activeAbortController = null;
      inFlight = false;
      if (!stopped && cycleGen === runGeneration) scheduleNext(nextInterval);
      return { ok: true, skippedPolicyOff: true };
    }

    const globalTimeout = setTimer(() => cycleCtrl.abort(), globalRunMaxMs);

    try {
      if (typeof listConnections !== "function") throw new Error("listConnections function is not configured");
      if (typeof importConnection !== "function") throw new Error("importConnection function is not configured");

      const connections = await raceWithSignalAndTimeout(
        () => listConnections(),
        cycleCtrl.signal,
        OP_TIMEOUT_MS,
        "Failed to list connections within timeout"
      );

      const runSummary = await runProviderSyncOnce({
        policy,
        connections,
        importConnection,
        signal: cycleCtrl.signal,
        perConnectionTimeoutMs,
        maxConnections: maxConnectionsPerRun,
        startCursor: resumeCursor,
      });

      resumeCursor = runSummary.nextCursor || 0;
      lastRunAt = clock();
      lastRunResult = runSummary;
      return runSummary;
    } catch (err) {
      const sanitized = sanitizeReason(err, null, cycleCtrl.signal.aborted);
      logger.error?.("[modelSyncScheduler] Error during provider sync run:", sanitized);
      lastRunResult = { ok: false, error: sanitized };
      return lastRunResult;
    } finally {
      clearTimer(globalTimeout);
      if (activeAbortController === cycleCtrl) activeAbortController = null;
      inFlight = false;
      if (!stopped && cycleGen === runGeneration) {
        scheduleNext(nextInterval);
      }
    }
  }

  function scheduleNext(delayMs) {
    if (activeTimer) {
      clearTimer(activeTimer);
      activeTimer = null;
    }
    if (stopped) return;

    const myGen = runGeneration;
    activeTimer = setTimer(() => {
      activeTimer = null;
      if (stopped || myGen !== runGeneration) return;
      executeCycle().catch((err) => {
        logger.error?.("[modelSyncScheduler] Unhandled cycle error:", sanitizeReason(err));
      });
    }, Math.max(10, delayMs));
  }

  function start() {
    if (!isLeaderOrSolo) return { started: false, reason: "follower-skip" };
    if (!stopped) return { started: true, alreadyRunning: true };
    stopped = false;
    runGeneration++;
    scheduleNext(10);
    return { started: true };
  }

  function stop() {
    stopped = true;
    runGeneration++;
    if (activeTimer) {
      clearTimer(activeTimer);
      activeTimer = null;
    }
    if (activeAbortController) {
      activeAbortController.abort();
    }
  }

  return {
    start,
    stop,
    runNow: () => executeCycle({ bypassStopped: true }),
    getStatus() {
      return {
        running: !stopped,
        inFlight,
        isLeader: isLeaderOrSolo,
        role: resolvedRole || "solo",
        resumeCursor,
        lastRunAt,
        lastRunResult,
      };
    },
  };
}

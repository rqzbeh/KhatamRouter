import os from "node:os";
import nodeCluster from "node:cluster";

export const CLUSTER_EXIT_EVENT = "exit";
export const IPC_TYPES = Object.freeze(["ready", "drain", "config_reload", "in_flight"]);
export const ALLOWED_RELOAD_SCOPES = Object.freeze(["aliases", "combos", "nodes", "settings", "all"]);

export const DEFAULT_DRAIN_TIMEOUT_MS = 30000;
export const SUPERVISOR_DRAIN_GRACE_MS = 5000;
export const RAPID_CRASH_WINDOW_MS = 5000;
export const HEALTHY_RESET_MS = 30000;
export const BASE_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 10000;
export const CRASH_ALERT_THRESHOLD = 5;

/**
 * Host CPU scalar sizing formula: Math.max(1, nproc - 2)
 * Supports explicit KHATAM_WORKERS and WEB_CONCURRENCY overrides, clamped 1..64.
 */
export function sizeWorkers(nproc = os.cpus()?.length ?? 1, env = process.env) {
  const raw = env.KHATAM_WORKERS ?? env.WEB_CONCURRENCY;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "" && String(raw).trim() !== "auto") {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(1, parsed), 64);
    }
  }
  const cores = typeof nproc === "number" && nproc > 0 ? nproc : 1;
  return Math.max(1, cores - 2);
}

export const computeWorkerCount = sizeWorkers;

export function drainDeadlineMs(env = process.env) {
  const raw = env.KHATAM_DRAIN_TIMEOUT_MS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

export function supervisorKillMs(env = process.env) {
  return drainDeadlineMs(env) + SUPERVISOR_DRAIN_GRACE_MS;
}

/**
 * Crash restart policy:
 * - If uptime >= resetMs (30s), consecutive crashes reset to 0, delay is 0.
 * - If uptime < minCrashMs (5s), consecutive crashes increment and exponential backoff applies.
 * - Otherwise (5s <= uptime < 30s), consecutive crashes increment with immediate restart.
 */
export function restartPolicy(
  consecutiveCrashes,
  uptimeMs,
  { resetMs = HEALTHY_RESET_MS, minCrashMs = RAPID_CRASH_WINDOW_MS } = {},
) {
  const prior = consecutiveCrashes ?? 0;
  if (uptimeMs >= resetMs) {
    return { crashes: 0, delayMs: 0, alert: false };
  }
  if (uptimeMs >= minCrashMs) {
    // Mid window: neither rapid crash nor healthy run. Counter unchanged, immediate restart.
    return { crashes: prior, delayMs: 0, alert: prior >= CRASH_ALERT_THRESHOLD };
  }
  const crashes = prior + 1;
  const delayMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, crashes), MAX_BACKOFF_MS);
  return { crashes, delayMs, alert: crashes >= CRASH_ALERT_THRESHOLD };
}

/**
 * 1-indexed worker role assignment and migration environment.
 */
export function workerEnv(slotIndex) {
  return {
    KHATAM_WORKER_ROLE: slotIndex === 1 ? "leader" : "worker",
    KHATAM_MIGRATIONS_DONE: "1",
  };
}

/**
 * IPC router: relays config_reload to all other workers (skipping sender).
 */
export function routeIpcMessage(senderWorkerId, msg, activeWorkerIds = []) {
  if (!msg || typeof msg !== "object") return [];
  if (msg.type !== "config_reload") return [];
  if (!ALLOWED_RELOAD_SCOPES.includes(msg.scope)) return [];
  const senderNum = Number(senderWorkerId);
  return activeWorkerIds.filter((id) => Number(id) !== senderNum);
}

/**
 * Start the primary supervisor.
 */
export async function startSupervisor(options = {}) {
  const cluster = options.cluster ?? nodeCluster;
  const env = options.env ?? process.env;
  const nproc = options.nproc ?? (os.cpus()?.length ?? 1);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const log = options.log ?? (() => {});
  const runMigrations = options.runMigrations ?? null;
  const workerScript = options.workerScript ?? null;
  const enableSignals = options.signals !== false;

  const targetCount = sizeWorkers(nproc, env);
  if (targetCount <= 1) {
    return { mode: "single", targetCount: 1, bypassed: true };
  }

  if (typeof runMigrations === "function") {
    await runMigrations();
  }

  if (workerScript && typeof cluster.setupPrimary === "function") {
    cluster.setupPrimary({ exec: workerScript });
  }

  const slotMap = new Map(); // workerId -> { slotIndex, startedAt, consecutiveCrashes }
  let isDraining = false;
  let forceKillTimer = null;

  function activeIds() {
    return Object.keys(cluster.workers || {}).map((id) => Number(id));
  }

  function forkSlot(slotIndex, consecutiveCrashes = 0) {
    if (isDraining) return null;
    const wEnv = workerEnv(slotIndex);
    const worker = cluster.fork(wEnv);
    const startedAt = now();
    slotMap.set(worker.id, { slotIndex, startedAt, consecutiveCrashes });
    log({ event: "fork", slotIndex, workerId: worker.id, pid: worker.process?.pid, role: wEnv.KHATAM_WORKER_ROLE });
    return worker;
  }

  // Initial fork
  for (let slot = 1; slot <= targetCount; slot += 1) {
    forkSlot(slot, 0);
  }

  // Broker worker messages
  const onClusterMessage = (worker, msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      log({ event: "ready", workerId: worker.id, pid: worker.process?.pid });
      return;
    }
    if (msg.type === "config_reload") {
      const targets = routeIpcMessage(worker.id, msg, activeIds());
      for (const tid of targets) {
        const targetWorker = cluster.workers?.[tid];
        if (targetWorker && typeof targetWorker.send === "function") {
          targetWorker.send(msg);
        }
      }
    }
  };
  cluster.on("message", onClusterMessage);

  // Monitor worker exits
  const onClusterExit = (worker, code, signal) => {
    const meta = slotMap.get(worker.id) || { slotIndex: 1, startedAt: now(), consecutiveCrashes: 0 };
    slotMap.delete(worker.id);
    const uptime = Math.max(0, now() - meta.startedAt);
    log({
      event: "crash",
      slotIndex: meta.slotIndex,
      workerId: worker.id,
      pid: worker.process?.pid,
      code,
      signal,
      uptimeMs: uptime,
    });

    if (isDraining) {
      if (Object.keys(cluster.workers || {}).length === 0) {
        if (forceKillTimer) cancelSchedule(forceKillTimer);
        process.exit(0);
      }
      return;
    }

    const decision = restartPolicy(meta.consecutiveCrashes, uptime);
    if (decision.alert) {
      console.error(
        `[Supervisor] Worker slot ${meta.slotIndex} crashed ${decision.crashes} consecutive times in rapid succession. Throttling restarts.`,
      );
    }

    if (decision.delayMs > 0) {
      schedule(() => {
        if (!isDraining) forkSlot(meta.slotIndex, decision.crashes);
      }, decision.delayMs);
    } else {
      forkSlot(meta.slotIndex, decision.crashes);
    }
  };
  cluster.on(CLUSTER_EXIT_EVENT, onClusterExit);

  function shutdown() {
    if (isDraining) return;
    isDraining = true;
    log({ event: "drain", targetCount });
    const workers = cluster.workers || {};
    for (const id in workers) {
      const w = workers[id];
      if (w && typeof w.kill === "function") {
        try {
          w.kill("SIGTERM");
        } catch {
          // ignore already-closed worker handles
        }
      }
    }

    const killTimeout = supervisorKillMs(env);
    forceKillTimer = schedule(() => {
      const remaining = cluster.workers || {};
      for (const id in remaining) {
        try {
          remaining[id]?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      process.exit(0);
    }, killTimeout);
    if (typeof forceKillTimer?.unref === "function") forceKillTimer.unref();

    if (Object.keys(workers).length === 0) {
      if (forceKillTimer) cancelSchedule(forceKillTimer);
      process.exit(0);
    }
  }

  let sigtermListener = null;
  let sigintListener = null;
  if (enableSignals && typeof process.on === "function") {
    sigtermListener = () => shutdown();
    sigintListener = () => shutdown();
    process.on("SIGTERM", sigtermListener);
    process.on("SIGINT", sigintListener);
  }

  return {
    mode: "cluster",
    targetCount,
    shutdown,
    cleanup: () => {
      if (cluster.off) {
        cluster.off("message", onClusterMessage);
        cluster.off(CLUSTER_EXIT_EVENT, onClusterExit);
      } else if (cluster.removeListener) {
        cluster.removeListener("message", onClusterMessage);
        cluster.removeListener(CLUSTER_EXIT_EVENT, onClusterExit);
      }
      if (sigtermListener) process.removeListener?.("SIGTERM", sigtermListener);
      if (sigintListener) process.removeListener?.("SIGINT", sigintListener);
      if (forceKillTimer) cancelSchedule(forceKillTimer);
    },
  };
}

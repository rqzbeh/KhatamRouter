import { EventEmitter } from "node:events";
import { drainDeadlineMs, ALLOWED_RELOAD_SCOPES } from "./supervisor.js";

// In-process bus: sibling config_reload messages from the primary land here.
export const workerBus = new EventEmitter();

let inFlight = 0;

export function getInFlightCount() {
  return inFlight;
}

/**
 * Send a cache-invalidation notice to the primary broker. No-op outside a cluster worker
 * (no process.send) or for unknown scopes.
 */
export function notifyConfigReload(scope, proc = process) {
  if (!ALLOWED_RELOAD_SCOPES.includes(scope)) return false;
  if (typeof proc.send !== "function") return false;
  proc.send({ type: "config_reload", scope });
  return true;
}

/**
 * Wire in-flight tracking, IPC, and SIGTERM graceful drain onto an http.Server.
 * Exits the process with code 0 once in-flight requests settle or the drain deadline passes.
 */
export function setupWorkerLifecycle(server, { drainTimeoutMs = drainDeadlineMs(), proc = process, exit = (c) => proc.exit(c) } = {}) {
  const sockets = new Set();
  let draining = false;
  let deadlineTimer = null;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("request", (req, res) => {
    inFlight += 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
      if (draining) maybeExit();
    };
    res.once("finish", done);
    res.once("close", done);
  });

  function finish() {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    exit(0);
  }

  function maybeExit() {
    if (draining && inFlight === 0) finish();
  }

  function beginDrain() {
    if (draining) return;
    draining = true;
    try {
      server.close(() => maybeExit());
    } catch {
      /* ignore if not listening */
    }
    if (typeof server.closeIdleConnections === "function") {
      try { server.closeIdleConnections(); } catch { /* ignore */ }
    }
    maybeExit();
    if (!deadlineTimer && inFlight > 0) {
      deadlineTimer = setTimeout(() => {
        for (const s of sockets) {
          try { s.destroy(); } catch { /* ignore */ }
        }
        finish();
      }, drainTimeoutMs);
      if (typeof deadlineTimer?.unref === "function") deadlineTimer.unref();
    }
  }

  function onSignal(sig) {
    if (draining) {
      exit(sig === "SIGINT" ? 130 : 143);
      return;
    }
    beginDrain();
  }

  proc.on("SIGTERM", () => onSignal("SIGTERM"));
  proc.on("SIGINT", () => onSignal("SIGINT"));
  proc.on("disconnect", beginDrain);

  proc.on("message", (msg) => {
    if (msg && typeof msg === "object" && msg.type === "config_reload" && ALLOWED_RELOAD_SCOPES.includes(msg.scope)) {
      workerBus.emit("config_reload", msg.scope);
    }
  });

  server.once("listening", () => {
    if (typeof proc.send === "function") proc.send({ type: "ready" });
  });

  return { beginDrain, isDraining: () => draining };
}

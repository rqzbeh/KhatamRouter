const http = require("http");
const os = require("os");
const cluster = require("cluster");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { assertProductionSecrets } = require("./runtime-secrets.cjs");

assertProductionSecrets();

// ── Port resolution ─────────────────────────────────────────────────────────
// Server listens on PORT (defaulting to 20128). DASHBOARD_PORT is kept as a
// backward-compatible alias.
const DEFAULT_PORT = 20128;
const DEFAULT_DASHBOARD_PORT = DEFAULT_PORT;

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

// Legacy callers pass `--port` (e.g. `bun start` -> `custom-server.js --port 20127`).
// When present it names the listener port and outranks the environment,
// matching Next's own precedence (`argv --port` before `process.env.PORT`).
const portArgIndex = process.argv.indexOf("--port");
const cliPort = portArgIndex === -1 ? null : normalizePort(process.argv[portArgIndex + 1], null);

// The listener resolves --port -> PORT -> DASHBOARD_PORT -> 20128.
const PORT =
  cliPort ?? normalizePort(process.env.PORT || process.env.DASHBOARD_PORT, DEFAULT_PORT);
const DASHBOARD_PORT = PORT;

// Expose the resolved contract to the process tree. Next's standalone server.js
// binds process.env.PORT. Keep DASHBOARD_PORT as backward-compatible alias.
process.env.PORT = String(PORT);
process.env.DASHBOARD_PORT = String(PORT);

// Lifecycle owns SIGINT/SIGTERM. Stops Next's start-server cleanup from calling process.exit(143)
// before the worker drain (setupWorkerLifecycle) finishes. Child processes inherit it.
process.env.NEXT_MANUAL_SIG_HANDLE = "true";

const origCreate = http.createServer.bind(http);

// ── Vertical scale (KHATAM_WORKERS) ─────────────────────────────────────────
// Missing src/lib/cluster (published CLI standalone) means single-process only.
const CLUSTER_DIR = path.join(__dirname, "src", "lib", "cluster");
const clusterModules = fs.existsSync(path.join(CLUSTER_DIR, "supervisor.js"))
  ? {
      supervisor: require(path.join(CLUSTER_DIR, "supervisor.js")),
      worker: require(path.join(CLUSTER_DIR, "worker.js")),
    }
  : null;
const WORKER_COUNT = clusterModules ? clusterModules.supervisor.sizeWorkers(os.cpus().length, process.env) : 1;

const DEFAULT_DRAIN_TIMEOUT_MS = 30000;

function getDrainTimeoutMs(env = process.env) {
  if (clusterModules) return clusterModules.supervisor.drainDeadlineMs(env);
  const raw = env.KHATAM_DRAIN_TIMEOUT_MS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

// Set when the primary could not run migrations and serves single-process instead. It then
// owns the server, so the multi-worker primary guard below must not skip the drain setup.
let primaryFellBackToSingleProcess = false;

function isMultiWorkerPrimary() {
  if (!cluster.isPrimary || !clusterModules || primaryFellBackToSingleProcess) return false;
  return clusterModules.supervisor.sizeWorkers(os.cpus().length, process.env) > 1;
}

// Standalone fallback: when src/lib/cluster is missing from disk, this provides the
// same in-flight tracking, idle close, deadline and second-signal force-exit contract.
let standaloneInFlight = 0;
function setupSingleProcessFallback(server, { drainTimeoutMs = getDrainTimeoutMs(), proc = process, exit = (c) => proc.exit(c) } = {}) {
  const sockets = new Set();
  let draining = false;
  let deadlineTimer = null;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("request", (req, res) => {
    standaloneInFlight += 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      standaloneInFlight -= 1;
      if (draining && standaloneInFlight === 0) finish();
    };
    res.once("finish", done);
    res.once("close", done);
  });

  function finish() {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    exit(0);
  }

  function beginDrain() {
    if (draining) return;
    draining = true;
    try {
      server.close(() => {
        if (standaloneInFlight === 0) finish();
      });
    } catch {
      /* ignore if not listening */
    }
    if (typeof server.closeIdleConnections === "function") {
      try { server.closeIdleConnections(); } catch { /* ignore */ }
    }
    if (standaloneInFlight === 0) {
      finish();
    } else if (!deadlineTimer) {
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

  return { beginDrain, isDraining: () => draining };
}

// Worker 1 (or unset, single-process) owns the background daemons and token refresh.
function isLeaderRole() {
  const role = process.env.KHATAM_WORKER_ROLE;
  return !role || role === "leader";
}

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.KHATAMROUTER_PEER_TOKEN = PEER_TOKEN;
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN; // legacy 9router alias
process.env.VANSROUTER_PEER_TOKEN = PEER_TOKEN; // legacy VansRouter alias

// ── h2c chunked body parser (ported from VansRouter) ────────────────────────
const MAX_H2C_BODY_BYTES = 64 * 1024 * 1024;
const H2C_CRLF = Buffer.from("\r\n");
const H2C_CRLF_CRLF = Buffer.from("\r\n\r\n");

function parseChunkedBody(input, { maxBytes = MAX_H2C_BODY_BYTES } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const chunks = [];
  let offset = 0;
  let bodyBytes = 0;

  while (true) {
    const lineEnd = buffer.indexOf(H2C_CRLF, offset);
    if (lineEnd === -1) return null;
    const sizeToken = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeToken)) {
      throw new Error(`Invalid chunk size: ${sizeToken || "<empty>"}`);
    }
    const size = Number.parseInt(sizeToken, 16);
    if (!Number.isSafeInteger(size)) throw new Error(`Chunk size is too large: ${sizeToken}`);
    offset = lineEnd + H2C_CRLF.length;

    if (size === 0) {
      if (buffer.length >= offset + 2 && buffer.subarray(offset, offset + 2).equals(H2C_CRLF)) {
        return { body: Buffer.concat(chunks), end: offset + 2 };
      }
      const trailerEnd = buffer.indexOf(H2C_CRLF_CRLF, offset);
      if (trailerEnd === -1) return null;
      return { body: Buffer.concat(chunks), end: trailerEnd + H2C_CRLF_CRLF.length };
    }

    bodyBytes += size;
    if (bodyBytes > maxBytes) throw new Error(`Chunked body exceeds ${maxBytes} bytes`);
    if (buffer.length < offset + size + 2) return null;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (!buffer.subarray(offset, offset + 2).equals(H2C_CRLF)) {
      throw new Error("Chunk data is not terminated by CRLF");
    }
    offset += 2;
  }
}

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  // Pre-listen EADDRINUSE: exit 1 with a stable message. Any other error keeps the default
  // uncaught-throw behaviour when nothing else listens for it.
  server.prependListener("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      if (cluster.isWorker) {
        // Report to the supervisor, which stops respawning and exits 1 with the log line.
        if (typeof process.send === "function") {
          try { process.send({ type: "address_in_use", port: PORT }); } catch { /* ignore */ }
        }
        process.exit(98);
      }
      console.error(`[Server] Port ${PORT} already in use`);
      process.exit(1);
    }
    if (server.listenerCount("error") <= 1) throw err;
  });
  // Multi-worker primary never creates a server; its supervisor owns SIGTERM/SIGINT.
  // Workers and single-process both get drain; the standalone fallback covers missing cluster modules.
  if (!isMultiWorkerPrimary()) {
    const drainTimeoutMs = getDrainTimeoutMs();
    if (clusterModules) clusterModules.worker.setupWorkerLifecycle(server, { drainTimeoutMs });
    else setupSingleProcessFallback(server, { drainTimeoutMs });
  }
  server.once("listening", () => {
    if (isLeaderRole()) startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;

  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head = Buffer.alloc(0)] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLengthHeader = req.headers["content-length"];
    const transferEncodingHeader = req.headers["transfer-encoding"];
    const rejectRequest = (message) => {
      if (!socket.destroyed) {
        const body = Buffer.from(message);
        socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      }
    };

    // Request smuggling defense: a combined Content-Length + Transfer-Encoding
    // lets intermediaries disagree about where the body ends. Refuse it outright.
    if (contentLengthHeader !== undefined && transferEncodingHeader !== undefined) {
      rejectRequest("Content-Length and Transfer-Encoding cannot be combined\n");
      return true;
    }

    const transferEncoding = transferEncodingHeader === undefined
      ? null
      : String(transferEncodingHeader).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (transferEncoding && (transferEncoding.length !== 1 || transferEncoding[0] !== "chunked")) {
      rejectRequest("Unsupported h2c transfer encoding\n");
      return true;
    }

    let expectedLength = 0;
    if (contentLengthHeader !== undefined) {
      expectedLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
        rejectRequest("Invalid Content-Length\n");
        return true;
      }
    }
    if (expectedLength > MAX_H2C_BODY_BYTES || head.length > MAX_H2C_BODY_BYTES) {
      rejectRequest("h2c body is too large\n");
      return true;
    }

    const chunks = [head];
    let received = head.length;
    let settled = false;
    const serve = (body) => {
      if (settled) return;
      settled = true;
      socket.off("data", readBody);
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (body && body.length) replay.push(body);
      replay.push(null);

      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve()
        .then(() => wrapped(replay, res))
        .catch((error) => {
          console.error("Failed to downgrade h2c request", error);
          socket.destroy();
        });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.off("data", readBody);
      rejectRequest(`${error.message}\n`);
    };
    const tryComplete = () => {
      try {
        if (transferEncoding) {
          const result = parseChunkedBody(Buffer.concat(chunks, received));
          if (result) serve(result.body);
          return;
        }
        if (received >= expectedLength) {
          serve(Buffer.concat(chunks, received).subarray(0, expectedLength));
        }
      } catch (error) {
        fail(error);
      }
    };
    const readBody = (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_H2C_BODY_BYTES) {
        fail(new Error("h2c body is too large"));
        return;
      }
      tryComplete();
    };

    if (req.readable && !req.complete) {
      // Under Bun, http.IncomingMessage remains a readable stream delivering the body,
      // while socket delivers 0 data events after the upgrade event.
      req.on("data", (chunk) => {
        if (settled) return;
        chunks.push(chunk);
        received += chunk.length;
        if (received > MAX_H2C_BODY_BYTES) {
          fail(new Error("h2c body is too large"));
        }
      });
      req.on("end", () => {
        if (settled) return;
        if (!transferEncoding && received < expectedLength) {
          fail(new Error("h2c request ended before the body was complete"));
          return;
        }
        serve(Buffer.concat(chunks, received).subarray(0, expectedLength || undefined));
      });
      req.on("error", (error) => {
        if (!settled) fail(error);
      });
    } else {
      if (transferEncoding || received < expectedLength) {
        socket.on("data", readBody);
        socket.on("end", () => {
          if (!settled) fail(new Error("h2c request ended before the body was complete"));
        });
        socket.resume();
      }
      tryComplete();
    }

    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

// Next's standalone server.js, or `next start` from a repo checkout. Shared by the
// single-process path and every cluster worker so all of them run the same request stack.
function startNextServer() {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}

// Migrations run once in the primary, before any fork. Workers get KHATAM_MIGRATIONS_DONE=1
// and never issue DDL against the shared SQLite file. Returns false if the driver is not on disk.
async function runMigrationsOnce() {
  const driverPath = path.join(__dirname, "src", "lib", "db", "driver.js");
  if (!fs.existsSync(driverPath)) return false;
  const { getAdapter } = await import(pathToFileURL(driverPath).href);
  const adapter = await getAdapter();
  // Close so the primary holds no DB handle and does not run the WAL checkpoint timer.
  try { adapter.close?.(); } catch { /* ignore */ }
  return true;
}

// Secrets are generated once here, before any fork, so N cold-booting workers cannot each mint
// their own. Forked workers inherit the resolved values through process.env. Loaded like
// runMigrationsOnce: a module missing from the standalone copy is skipped, not an error.
async function resolveRuntimeSecretsOnce() {
  const authPath = path.join(__dirname, "src", "lib", "auth", "dashboardSession.js");
  const machinePath = path.join(__dirname, "src", "shared", "utils", "machineId.js");
  if (fs.existsSync(authPath) && !process.env.JWT_SECRET) {
    const { loadJwtSecret } = await import(pathToFileURL(authPath).href);
    process.env.JWT_SECRET = loadJwtSecret();
  }
  if (fs.existsSync(machinePath)) {
    const { loadRawMachineId, loadCliSecret } = await import(pathToFileURL(machinePath).href);
    loadRawMachineId();
    loadCliSecret();
  }
}

async function startPrimary(count) {
  let migrated;
  try {
    migrated = await runMigrationsOnce();
  } catch (error) {
    // Never fork workers onto a schema that failed to migrate.
    console.error(`[Cluster] Migrations failed, not starting workers: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
  if (!migrated) {
    // Forking with KHATAM_MIGRATIONS_DONE=1 without migrating would leave the schema absent.
    console.error(`[Cluster] KHATAM_WORKERS=${count} requested, but src/lib/db/driver.js is not on disk so migrations cannot run in the primary; running single-process`);
    primaryFellBackToSingleProcess = true;
    startNextServer();
    return;
  }
  try {
    await resolveRuntimeSecretsOnce();
  } catch (error) {
    // Fail closed: a worker that minted its own secret would split sessions across the pool.
    console.error(`[Cluster] Runtime secret resolution failed, not starting workers: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
  if (!process.env.REDIS_URL) {
    console.warn("[Cluster] REDIS_URL is not set: login lockout and rate limits are per worker (limits are effectively multiplied by the worker count)");
  }
  clusterModules.supervisor.startSupervisor({
    workerScript: __filename,
    log: clusterModules.supervisor.createClusterLogger(),
  }).catch((error) => {
    console.error(`[Cluster] Supervisor failed to start: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}

if (require.main === module) {
  if (cluster.isPrimary && clusterModules && WORKER_COUNT > 1) {
    // Primary never calls listen(); it only migrates, forks and brokers IPC.
    startPrimary(WORKER_COUNT);
  } else {
    if (cluster.isPrimary && !clusterModules && (process.env.KHATAM_WORKERS || process.env.WEB_CONCURRENCY)) {
      console.warn("[Cluster] src/lib/cluster modules are missing from disk; running single-process");
    }
    // Single-process (KHATAM_WORKERS=1, or 1 core) and every cluster worker.
    startNextServer();
  }
}

module.exports = {
  PORT,
  DASHBOARD_PORT,
  PEER_TOKEN,
  MAX_H2C_BODY_BYTES,
  parseChunkedBody,
  startBackgroundTokenRefreshFromCustomServer,
  resolveRuntimeSecretsOnce,
};

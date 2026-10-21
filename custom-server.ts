/**
 * KhatamRouter custom server — TypeScript entry (Bun-native).
 *
 * Behavioural mirror of ./custom-server.js. Both files must stay in sync:
 *  - Dual-port contract: Dashboard (control plane) on DASHBOARD_PORT || PORT ||
 *    20128, endpoint gateway (data plane) on ENDPOINT_PORT || 20129.
 *  - VansRouter-derived h2c hardening: chunked body parser with a 64 MiB cap,
 *    CRLF validation and Content-Length + Transfer-Encoding smuggling refusal.
 *  - Peer trust stamping: x-9r-real-ip / x-9r-peer-token are set from the real
 *    TCP socket and client-supplied forwarding headers are stripped, so
 *    downstream rate limiting cannot be keyed on attacker-controlled input.
 *  - 9router's startBackgroundTokenRefreshFromCustomServer() still runs after
 *    the listener comes up.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const { assertProductionSecrets } = require("./runtime-secrets.cjs") as {
  assertProductionSecrets: (env?: NodeJS.ProcessEnv) => void;
};

assertProductionSecrets();

// ── Dual-port resolution (Constitution Principle II) ────────────────────────
const DEFAULT_DASHBOARD_PORT = 20128;
const DEFAULT_ENDPOINT_PORT = 20129;

const portArgIndex = process.argv.indexOf("--port");
function normalizePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function normalizeOptionalPort(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

// Legacy callers pass `--port` (e.g. `npm start` -> `custom-server.js --port 20127`).
// When present it names the dashboard listener and outranks the environment,
// matching Next's own precedence (`argv --port` before `process.env.PORT`).
const cliPort = portArgIndex === -1 ? null : normalizeOptionalPort(process.argv[portArgIndex + 1]);

// The dashboard listener resolves --port -> DASHBOARD_PORT -> PORT -> 20128.
export const DASHBOARD_PORT =
  cliPort ?? normalizePort(process.env.DASHBOARD_PORT || process.env.PORT, DEFAULT_DASHBOARD_PORT);
export const ENDPOINT_PORT = normalizePort(process.env.ENDPOINT_PORT, DEFAULT_ENDPOINT_PORT);

// Expose the resolved contract to the process tree. Next's standalone server.js
// binds process.env.PORT, so pin it to the dashboard port; the Go gateway reads
// ENDPOINT_PORT directly.
process.env.DASHBOARD_PORT = String(DASHBOARD_PORT);
process.env.ENDPOINT_PORT = String(ENDPOINT_PORT);
process.env.PORT = String(DASHBOARD_PORT);

const origCreate = http.createServer.bind(http) as typeof http.createServer;

/** Per-process secret proving x-9r-real-ip was stamped below, not sent by the client. */
export const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.KHATAMROUTER_PEER_TOKEN = PEER_TOKEN;
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN; // legacy 9router alias
process.env.VANSROUTER_PEER_TOKEN = PEER_TOKEN; // legacy VansRouter alias

// ── h2c chunked body parser (ported from VansRouter) ────────────────────────
export const MAX_H2C_BODY_BYTES = 64 * 1024 * 1024;
const H2C_CRLF = Buffer.from("\r\n");
const H2C_CRLF_CRLF = Buffer.from("\r\n\r\n");

interface ChunkedBodyResult {
  body: Buffer;
  end: number;
}

export function parseChunkedBody(
  input: Buffer | string,
  { maxBytes = MAX_H2C_BODY_BYTES }: { maxBytes?: number } = {},
): ChunkedBodyResult | null {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const chunks: Buffer[] = [];
  let offset = 0;
  let bodyBytes = 0;

  while (true) {
    const lineEnd = buffer.indexOf(H2C_CRLF, offset);
    if (lineEnd === -1) return null;
    const sizeToken = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]!.trim();
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

export function startBackgroundTokenRefreshFromCustomServer(): void {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  const modPath = path.join(projectRoot, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m: any) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e instanceof Error ? e.message : e);
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
      // Expected in published standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e instanceof Error ? e.message : e);
      }
    });
}

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Wrap the Next standalone HTTP server: derive client IP from the TCP socket
 * (unspoofable) and strip client-supplied forwarding headers so downstream
 * rate-limiting keys on the real peer address instead of attacker-controlled XFF.
 */
const createServerWrapper = (...args: any[]): any => {
  const handler = args.find((a) => typeof a === "function") as RequestHandler | undefined;
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return (origCreate as any)(...args);

  const wrapped: RequestHandler = (req, res) => {
    const socketIp = req.socket?.remoteAddress ?? "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = Boolean(xff || xRealIp);
    const isLoopbackProxy =
      socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0]!.trim() : "");
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

  const server = (origCreate as any)(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;

  // h2c upgrades that the HTTP/1.1 server would otherwise close get downgraded.
  server.emit = function (event: string, ...eventArgs: any[]): boolean {
    const [req, socket, head = Buffer.alloc(0)] = eventArgs as [
      http.IncomingMessage,
      any,
      Buffer,
    ];
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLengthHeader = req.headers["content-length"];
    const transferEncodingHeader = req.headers["transfer-encoding"];
    const rejectRequest = (message: string) => {
      if (!socket.destroyed) {
        const body = Buffer.from(message);
        socket.end(
          `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
      }
    };

    // Request smuggling defense: a combined Content-Length + Transfer-Encoding
    // lets intermediaries disagree about where the body ends. Refuse it outright.
    if (contentLengthHeader !== undefined && transferEncodingHeader !== undefined) {
      rejectRequest("Content-Length and Transfer-Encoding cannot be combined\n");
      return true;
    }

    const transferEncoding =
      transferEncodingHeader === undefined
        ? null
        : String(transferEncodingHeader)
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
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

    const chunks: Buffer[] = [head];
    let received = head.length;
    let settled = false;

    const serve = (body?: Buffer) => {
      if (settled) return;
      settled = true;
      socket.off("data", readBody);
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        complete: true,
      });
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
    const fail = (error: Error) => {
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
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const readBody = (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_H2C_BODY_BYTES) {
        fail(new Error("h2c body is too large"));
        return;
      }
      tryComplete();
    };

    if (transferEncoding || received < expectedLength) {
      socket.on("data", readBody);
      socket.on("end", () => {
        if (!settled) fail(new Error("h2c request ended before the body was complete"));
      });
      socket.resume();
    }
    tryComplete();

    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

// Monkey-patch before any listener is created so every request is sanitized.
(http as unknown as { createServer: typeof http.createServer }).createServer =
  createServerWrapper as unknown as typeof http.createServer;

const isMain =
  Boolean((import.meta as unknown as { main?: boolean }).main) ||
  (process.argv[1] !== undefined &&
    pathToFileURL(process.argv[1]).href === import.meta.url);

if (isMain) {
  const standalone = path.join(projectRoot, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0]!, nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}

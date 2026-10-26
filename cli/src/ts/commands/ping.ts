import net from "node:net";
import http from "node:http";
import type { CliCommandResult, PingCommandOptions, PingResult } from "../types.ts";

/**
 * Checks TCP connectivity to the gateway port.
 */
export async function pingTcp(host: string, port: number, timeoutMs: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Checks HTTP endpoint responsiveness.
 */
export async function pingHttp(
  host: string,
  port: number,
  timeoutMs: number = 2000
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: "/api/health",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const latencyMs = Date.now() - start;
          const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
          resolve({ ok, latencyMs });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start });
    });

    req.on("error", () => {
      resolve({ ok: false, latencyMs: Date.now() - start });
    });

    req.end();
  });
}

/**
 * Executes the `ping` command.
 */
export async function pingCommand(
  options: PingCommandOptions = {}
): Promise<CliCommandResult<PingResult>> {
  const host = options.host || "127.0.0.1";
  const port = options.port || 20128;
  const timeoutMs = options.timeoutMs ?? 2000;
  const writeOut = options.stdout || console.log;
  const writeErr = options.stderr || console.error;

  const tcp = await pingTcp(host, port, timeoutMs);
  if (!tcp) {
    writeErr(`❌ TCP connection to ${host}:${port} failed`);
    return {
      exitCode: 1,
      message: "TCP connection failed",
      data: { tcp: false, http: false, latencyMs: -1 },
    };
  }

  const httpRes = await pingHttp(host, port, timeoutMs);
  const result: PingResult = {
    tcp: true,
    http: httpRes.ok,
    latencyMs: httpRes.latencyMs,
  };

  if (httpRes.ok) {
    writeOut(`✅ pong (${httpRes.latencyMs}ms) - KhatamRouter is responding at http://${host}:${port}`);
    return {
      exitCode: 0,
      message: "pong",
      data: result,
    };
  } else {
    writeErr(`❌ HTTP ping to http://${host}:${port}/api/health failed`);
    return {
      exitCode: 1,
      message: "HTTP ping failed",
      data: result,
    };
  }
}

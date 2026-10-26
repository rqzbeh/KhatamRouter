import http from "node:http";
import type { CliCommandResult, CliRuntimeStatus, StatusCommandOptions } from "../types.ts";
import { maskSecrets } from "../utils/mask.ts";

const pkg = { version: "0.5.104" };

/**
 * Queries local gateway /api/health and returns structured CliRuntimeStatus.
 */
export async function queryGatewayHealth(
  host: string,
  port: number,
  timeoutMs: number = 3000
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: "/api/health",
        method: "GET",
        timeout: timeoutMs,
        headers: { Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const data = body ? JSON.parse(body) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, data });
            } else {
              resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            }
          } catch (e: any) {
            resolve({ ok: false, error: e.message || "Invalid JSON" });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Connection timeout" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.end();
  });
}

/**
 * Executes the `status` command.
 */
export async function statusCommand(
  options: StatusCommandOptions = {}
): Promise<CliCommandResult<CliRuntimeStatus>> {
  const host = options.host || "127.0.0.1";
  const port = options.port || 20128;
  const timeoutMs = options.timeoutMs ?? 3000;
  const writeOut = options.stdout || console.log;
  const isJson = !!options.json;

  const healthRes = await queryGatewayHealth(host, port, timeoutMs);

  const status: CliRuntimeStatus = {
    online: healthRes.ok,
    port,
    host,
    version: (healthRes.data?.version as string) || pkg.version,
    pid: healthRes.data?.pid as number | undefined,
    uptimeSeconds: healthRes.data?.uptime as number | undefined,
    redisConnected: healthRes.data?.redisConnected as boolean | undefined,
  };

  const safeStatus = maskSecrets(status) as CliRuntimeStatus;

  if (isJson) {
    writeOut(JSON.stringify(safeStatus, null, 2));
  } else if (safeStatus.online) {
    writeOut(
      [
        "✅ KhatamRouter gateway is online",
        `• Address: http://${host}:${port}`,
        `• Port:    ${port}`,
        `• Version: ${safeStatus.version}`,
        safeStatus.pid ? `• PID:     ${safeStatus.pid}` : null,
        safeStatus.uptimeSeconds ? `• Uptime:  ${safeStatus.uptimeSeconds}s` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } else {
    writeOut(`❌ KhatamRouter gateway is offline (not responding on http://${host}:${port})`);
  }

  return {
    exitCode: safeStatus.online ? 0 : 1,
    message: safeStatus.online ? "Gateway is online" : "Gateway is offline",
    data: safeStatus,
  };
}

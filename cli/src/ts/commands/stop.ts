import http from "node:http";
import type { CliCommandResult, StopCommandOptions, StopResult } from "../types.ts";

/**
 * Executes the `stop` command by issuing POST /api/shutdown to local gateway.
 */
export async function stopCommand(
  options: StopCommandOptions = {}
): Promise<CliCommandResult<StopResult>> {
  const host = options.host || "127.0.0.1";
  const port = options.port || 20128;
  const timeoutMs = options.timeoutMs ?? 4000;
  const writeOut = options.stdout || console.log;
  const writeErr = options.stderr || console.error;

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: "/api/shutdown",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
        },
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
              writeOut("✅ Shutdown initiated for KhatamRouter gateway");
              resolve({
                exitCode: 0,
                message: "Shutdown initiated",
                data: { success: true, message: data.message || "Shutting down" },
              });
            } else {
              const err = data.message || `HTTP ${res.statusCode}`;
              writeErr(`❌ Failed to stop KhatamRouter: ${err}`);
              resolve({
                exitCode: 1,
                message: err,
                data: { success: false, message: err },
              });
            }
          } catch (e: any) {
            writeErr(`❌ Shutdown response error: ${e.message}`);
            resolve({
              exitCode: 1,
              message: e.message,
              data: { success: false, message: e.message },
            });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      writeErr("❌ Shutdown request timed out");
      resolve({
        exitCode: 1,
        message: "Timeout",
        data: { success: false, message: "Request timed out" },
      });
    });

    req.on("error", (err: any) => {
      if (err.code === "ECONNREFUSED") {
        writeOut(`ℹ️ KhatamRouter is not running on http://${host}:${port}`);
        resolve({
          exitCode: 0,
          message: "Not running",
          data: { success: false, message: "Gateway not running" },
        });
      } else {
        writeErr(`❌ Error contacting gateway: ${err.message}`);
        resolve({
          exitCode: 1,
          message: err.message,
          data: { success: false, message: err.message },
        });
      }
    });

    req.end();
  });
}

#!/usr/bin/env bun
import fs from "fs";

// Parse CLI flags (-config <file>)
const args = process.argv.slice(2);
let configPath = process.env.CONFIG_PATH || null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-config" && i + 1 < args.length) {
    configPath = args[i + 1];
    i++;
  }
}

if (process.env.FAKE_SIDECAR_WRITE_MARKER) {
  try {
    fs.appendFileSync(process.env.FAKE_SIDECAR_WRITE_MARKER, `spawn ${Date.now()}\n`);
  } catch {}
}

if (process.env.FAKE_SIDECAR_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    // Ignore SIGTERM intentionally
  });
}

let listen = process.env.LISTEN_ADDRESS || "127.0.0.1:0";
let warpEnabled = true;
if (configPath && fs.existsSync(configPath)) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.listen) {
      listen = parsed.listen;
    }
    if (parsed.warp?.enabled === false) warpEnabled = false;
  } catch {}
}

// Mirrors the real daemon: WARP init is the one startup step that needs the
// network and aborts the process. With WARP off it starts and serves.
if (process.env.FAKE_SIDECAR_WARP_FAIL === "1" && warpEnabled) {
  console.log(
    JSON.stringify({
      level: "ERROR",
      msg: "failed to initialize runtime",
      error: "initialize WARP egress: create WARP device: Post \"https://api.cloudflareclient.com/v0i1909051800/reg\": EOF",
    })
  );
  process.exit(1);
}

const parts = listen.split(":");
const hostname = parts.length > 1 ? parts[0] : "127.0.0.1";
const port = parts.length > 1 ? parseInt(parts[1], 10) : parseInt(parts[0], 10);

let healthzCount = 0;

Bun.serve({
  port,
  hostname,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      healthzCount++;

      if (process.env.FAKE_SIDECAR_NEVER_READY === "1") {
        return new Response(JSON.stringify({ status: "starting", ready: false }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      const isDegraded =
        process.env.FAKE_SIDECAR_DEGRADED === "1" ||
        (process.env.FAKE_SIDECAR_DEGRADED &&
          fs.existsSync(process.env.FAKE_SIDECAR_DEGRADED));

      if (isDegraded) {
        return new Response(
          JSON.stringify({
            status: "degraded",
            ready: false,
            warp: { status: "degraded", active: 0, standby: 0, cooling: 0 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (process.env.FAKE_SIDECAR_CRASH_AFTER_READY === "1" && healthzCount === 1) {
        setTimeout(() => {
          process.exit(1);
        }, 50);
      }

      return new Response(
        JSON.stringify({
          status: "ok",
          ready: true,
          warp: { status: "ready", active: 2, standby: 2, cooling: 0 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/v1/chat/completions") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
            )
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

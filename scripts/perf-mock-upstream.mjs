#!/usr/bin/env bun
/**
 * Zero-latency Mock Upstream Server for Wave 8 Performance Ladder (T021).
 *
 * Emulates the OpenAI Chat Completions API with zero-overhead fixed responses,
 * allowing performance ladder measurements to isolate GATEWAY latency overhead
 * rather than measuring downstream LLM provider network/inference latency.
 *
 * Supported Endpoints:
 * - POST /v1/chat/completions (and /chat/completions)
 *     * Streaming (stream: true): OpenAI-compliant SSE chunks ending with data: [DONE]
 *     * Non-streaming: OpenAI-compliant ChatCompletion JSON object
 * - GET  /v1/models (and /models): Model catalogue including gpt-4o-mini
 * - GET  /health: Healthcheck endpoint {"status":"ok"}
 *
 * Registration with KhatamRouter Gateway:
 * To point an OpenAI-compatible node at this mock upstream:
 * 1. Log in to dashboard:
 *    POST http://127.0.0.1:20128/api/auth/login with {"password":"<INITIAL_PASSWORD>"}
 * 2. Create provider node:
 *    POST http://127.0.0.1:20128/api/provider-nodes
 *    Body: {
 *      "name": "perf-mock",
 *      "prefix": "perf-mock",
 *      "type": "openai-compatible",
 *      "apiType": "chat",
 *      "baseUrl": "http://127.0.0.1:40128/v1"
 *    }
 *    -> Returns node with id e.g. "openai-compatible-chat-<id>"
 * 3. Create active provider connection:
 *    POST http://127.0.0.1:20128/api/providers
 *    Body: {
 *      "provider": "<node.id>",
 *      "name": "Perf Mock Connection",
 *      "apiKey": "sk-mock-key"
 *    }
 * 4. Create client API key:
 *    POST http://127.0.0.1:20128/api/keys
 *    Body: { "name": "perf-ladder-key" }
 *    -> Use the generated sk-... key for PERF_API_KEY.
 * Requests with model "perf-mock/gpt-4o-mini" route directly to this mock upstream.
 */

import http from "node:http";

const DEFAULT_PORT = 40128;
const DEFAULT_HOST = "127.0.0.1";

const FIXED_SSE_CHUNKS = [
  "data: {\"id\":\"chatcmpl-mock-1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Mock response from zero-latency upstream.\"},\"finish_reason\":null}]}\n\n",
  "data: {\"id\":\"chatcmpl-mock-1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
  "data: [DONE]\n\n",
].join("");

const FIXED_JSON_RESPONSE = JSON.stringify({
  id: "chatcmpl-mock-1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Mock response from zero-latency upstream.",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 8,
    total_tokens: 18,
  },
});

const FIXED_MODELS_RESPONSE = JSON.stringify({
  object: "list",
  data: [
    {
      id: "gpt-4o-mini",
      object: "model",
      created: 1700000000,
      owned_by: "perf-mock",
    },
    {
      id: "gpt-4o",
      object: "model",
      created: 1700000000,
      owned_by: "perf-mock",
    },
  ],
});

/**
 * Start the in-process mock upstream server.
 * Uses Bun.serve when running under Bun runtime, or node:http when running under Node (e.g. Vitest).
 * @param {object} [options]
 * @param {number} [options.port=40128] - Port to listen on (0 for dynamic).
 * @param {string} [options.host="127.0.0.1"] - Host address.
 * @param {number} [options.errorRate=0] - Probability of returning 500 error (0.0 to 1.0).
 * @param {number} [options.delay=0] - Artificial delay in ms before responding.
 * @returns {Promise<{ server: object, port: number, host: string, url: string, close: () => Promise<void> }>}
 */
export async function startMockServer(options = {}) {
  const port = options.port !== undefined ? options.port : parseInt(process.env.MOCK_PORT || String(DEFAULT_PORT), 10);
  const host = options.host || process.env.MOCK_HOST || DEFAULT_HOST;
  const errorRate = options.errorRate || 0;
  const delay = options.delay || 0;

  if (typeof Bun !== "undefined") {
    const server = Bun.serve({
      port,
      hostname: host,
      async fetch(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Healthcheck
        if (pathname === "/health" || pathname === "/api/health") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Models list
        if (pathname === "/v1/models" || pathname === "/models") {
          return new Response(FIXED_MODELS_RESPONSE, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Chat completions
        if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
          if (req.method !== "POST") {
            return new Response(JSON.stringify({ error: { message: "Method not allowed" } }), {
              status: 405,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (errorRate > 0 && Math.random() < errorRate) {
            return new Response(JSON.stringify({ error: { message: "Induced mock upstream error" } }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          let isStreaming = false;
          try {
            const body = await req.json();
            if (body?.stream === true || body?.stream === "true") {
              isStreaming = true;
            }
          } catch {
            if (req.headers.get("accept")?.includes("text/event-stream")) {
              isStreaming = true;
            }
          }

          if (isStreaming) {
            return new Response(FIXED_SSE_CHUNKS, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
              },
            });
          }

          return new Response(FIXED_JSON_RESPONSE, {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }

        return new Response(JSON.stringify({ error: { message: `Not found: ${pathname}` } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const actualPort = server.port;
    const boundUrl = `http://${host}:${actualPort}`;

    return {
      server,
      port: actualPort,
      host,
      url: boundUrl,
      async close() {
        server.stop(true);
      },
    };
  }

  // Node.js fallback (for Vitest Node environment)
  const nodeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const pathname = url.pathname;

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (pathname === "/health" || pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === "/v1/models" || pathname === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(FIXED_MODELS_RESPONSE);
      return;
    }

    if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
        return;
      }

      if (errorRate > 0 && Math.random() < errorRate) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Induced mock upstream error" } }));
        return;
      }

      const rawBody = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
        });
        req.on("end", () => resolve(data));
        req.on("error", () => resolve(""));
      });

      let isStreaming = false;
      try {
        const body = JSON.parse(rawBody);
        if (body?.stream === true || body?.stream === "true") {
          isStreaming = true;
        }
      } catch {
        if (req.headers.accept?.includes("text/event-stream")) {
          isStreaming = true;
        }
      }

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.end(FIXED_SSE_CHUNKS);
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(FIXED_JSON_RESPONSE);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not found: ${pathname}` } }));
  });

  await new Promise((resolve) => {
    nodeServer.listen(port, host, resolve);
  });

  const address = nodeServer.address();
  const actualPort = typeof address === "object" ? address.port : port;
  const boundUrl = `http://${host}:${actualPort}`;

  return {
    server: nodeServer,
    port: actualPort,
    host,
    url: boundUrl,
    async close() {
      await new Promise((resolve) => nodeServer.close(resolve));
    },
  };
}

// Standalone execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let errorRate = 0;
  let delay = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (arg === "--host" && i + 1 < args.length) {
      host = args[++i];
    } else if (arg === "--error-rate" && i + 1 < args.length) {
      errorRate = parseFloat(args[++i]);
    } else if (arg === "--delay" && i + 1 < args.length) {
      delay = parseInt(args[++i], 10);
    }
  }

  const { url, port: boundPort, close } = await startMockServer({ port, host, errorRate, delay });
  console.log(`[perf-mock-upstream] Listening on ${url} (port ${boundPort}, errorRate=${errorRate}, delay=${delay}ms)`);

  const shutdown = async () => {
    console.log("\n[perf-mock-upstream] Shutting down...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

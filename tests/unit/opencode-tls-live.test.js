import { describe, it, expect } from "vitest";

const isLive = process.env.OPENCODE_TLS_LIVE === "1";

describe.skipIf(!isLive)("OpenCode TLS Live Probe & Stream Verification", () => {
  it("verifies the JA4 cipher hash 5b57614c22b0 via a public TLS echo service", async () => {
    const { createSession } = await import("wreq-js");
    const { OPENCODE_CIPHER_LIST } = await import("../../open-sse/services/opencodeTlsClient.js");

    const session = await createSession({
      emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
    });
    // Public echo services are flaky; the cipher hash is the same on every one.
    const probes = ["https://tls.browserleaks.com/json", "https://tls.peet.ws/api/clean"];
    let ja4 = null;
    const errors = [];
    for (const url of probes) {
      try {
        const res = await session.fetch(url, { method: "GET", headers: { accept: "application/json" }, timeout: 10000 });
        if (res.status !== 200) { errors.push(`${url} -> ${res.status}`); continue; }
        ja4 = (await res.json())?.ja4;
        if (typeof ja4 === "string") break;
      } catch (error) {
        errors.push(`${url} -> ${error?.message || error}`);
      }
    }
    session.close?.();
    expect(typeof ja4, `no TLS echo service answered: ${errors.join("; ")}`).toBe("string");
    // Cipher-hash segment equals Bun's native BoringSSL hash that the OpenCode gate accepts.
    expect(ja4).toContain("5b57614c22b0");
  }, 30000);

  it("streams response incrementally from a local Bun server without buffering", async () => {
    const { createSession } = await import("wreq-js");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk-one\n"));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("chunk-two\n"));
              controller.close();
            }, 60);
          },
        }), {
          headers: { "content-type": "text/plain" },
        });
      },
    });

    try {
      const session = await createSession();
      const res = await session.fetch(`http://127.0.0.1:${server.port}/`, {
        method: "GET",
      });

      expect(res.status).toBe(200);
      expect(typeof res.body?.getReader).toBe("function");

      const reader = res.body.getReader();
      const received = [];
      const times = [];

      const start = Date.now();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        times.push(Date.now() - start);
        received.push(new TextDecoder().decode(value));
      }

      expect(received).toEqual(["chunk-one\n", "chunk-two\n"]);
      // Chunk two should arrive after the 60ms delay, confirming streaming
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(40);

      session.close?.();
    } finally {
      server.stop();
    }
  });

  it("aborts in-flight stream when AbortSignal fires", async () => {
    const { createSession } = await import("wreq-js");

    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return new Response("done");
      },
    });

    try {
      const session = await createSession();
      const controller = new AbortController();

      // Abort after 40ms
      setTimeout(() => controller.abort(new Error("operation aborted")), 40);

      await expect(
        session.fetch(`http://127.0.0.1:${server.port}/`, {
          signal: controller.signal,
        })
      ).rejects.toThrow();

      session.close?.();
    } finally {
      server.stop();
    }
  });
});

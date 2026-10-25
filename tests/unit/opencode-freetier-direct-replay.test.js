// #4983: OpenCode's free-tier gate rejects requests whose *egress IP* it has
// flagged with 403 FreeTierError. The transport succeeds, so the existing
// proxy-failure fallback never fires and every retry keeps leaving through the
// same flagged proxy. Live measurement: identical body and headers in the same
// minute — flagged pool → 403 FreeTierError, direct egress → 200.
//
// proxyAwareFetch now inspects a proxied 403 and replays once on the direct
// egress when the body carries the FreeTierError marker.
//
// Security hardening & deviations from upstream:
// (a) Restricted to OpenCode origin(s) only (opencode.ai and subdomains).
//     Non-OpenCode hosts with FreeTierError in 403 are never replayed.
// (b) strictProxy = true never replays direct and passes rejection through.
// (c) Body read is bounded to 64 KiB to prevent DoS via unbounded buffering.
// (d) Replays at most once without credential leaks or query logging.
// (e) Handled streamed/one-shot consumed request bodies (no replay).
import { beforeEach, describe, expect, it, vi } from "vitest";

const FREE_TIER_403 = JSON.stringify({
  type: "error",
  error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
});
const OTHER_403 = JSON.stringify({ error: { type: "permission_error", message: "quota exhausted" } });

// Captured as originalFetch when proxyFetch.js loads; proxy attempts carry an
// undici dispatcher, direct attempts do not.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// getDispatcher() imports undici lazily on the proxy path.
vi.mock("undici", () => ({
  Agent: class {},
  ProxyAgent: class {},
}));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

function proxiedThenDirect({ proxiedResponse, directResponse }) {
  fetchMock.mockImplementation(async (_url, opts = {}) =>
    opts.dispatcher ? proxiedResponse() : directResponse());
}

const PROXY = { enabled: true, url: "http://127.0.0.1:9999" };

beforeEach(() => {
  fetchMock.mockReset();
});

describe("proxied 403 FreeTierError replays direct (#4983)", () => {
  // Upstream test 1: replay once direct and return 200
  it("replays once on the direct egress and returns its 200", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("data: ok", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
    expect(fetchMock.mock.calls[1][1]?.dispatcher).toBeFalsy();
  });

  // Upstream test 2: strictProxy keeps configured path
  it("keeps strictProxy on the configured path — returns the 403, no replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, { ...PROXY, strictProxy: true });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Upstream test 3: non-gate 403 returned untouched without direct replay
  it("returns a non-gate 403 untouched, without a direct replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(OTHER_403, { status: 403, headers: { "content-type": "application/json", "x-request-id": "req-1" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await res.text()).toBe(OTHER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Upstream test 4: leaves proxied 200 stream untouched
  it("leaves a proxied 200 stream untouched — one call, body not consumed", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response("data: chunk\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: chunk\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Upstream test 5: surfaces original 403 when direct replay itself fails
  it("surfaces the original 403 when the direct replay itself fails", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      call += 1;
      if (call === 1) return new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } });
      expect(opts.dispatcher).toBeFalsy();
      throw new Error("direct egress down");
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
  });

  // Security deviation (a): non-OpenCode host with FreeTierError body is NOT replayed
  it("does NOT replay a non-OpenCode host even when body has FreeTierError marker", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT replay for lookalike domains (e.g. notopencode.ai or opencode.ai.attacker.com)", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res1 = await proxyAwareFetch("https://notopencode.ai/v1/chat", { method: "POST", body: "{}" }, PROXY);
    expect(res1.status).toBe(403);

    const res2 = await proxyAwareFetch("https://opencode.ai.attacker.com/v1/chat", { method: "POST", body: "{}" }, PROXY);
    expect(res2.status).toBe(403);

    expect(fetchMock).toHaveBeenCalledTimes(2); // each was called exactly once, no replay
  });

  it("replays on direct egress for an opencode.ai subdomain", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("data: ok subdomain", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://inference.opencode.ai/v1/chat", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok subdomain");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Security deviation (c): oversized body is not buffered unboundedly
  it("does NOT replay and does NOT buffer when content-length exceeds 64 KiB", async () => {
    let getReaderCalled = false;
    const bodyStream = {
      getReader() {
        getReaderCalled = true;
        throw new Error("must not be called");
      },
    };

    proxiedThenDirect({
      proxiedResponse: () => new Response(null, {
        status: 403,
        headers: {
          "content-type": "application/json",
          "content-length": "70000", // > 64 KiB
        },
      }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    // We can also test with custom response having body with getReader:
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      if (opts.dispatcher) {
        return {
          status: 403,
          headers: new Headers({
            "content-type": "application/json",
            "content-length": "70000",
          }),
          body: {
            getReader() {
              getReaderCalled = true;
              throw new Error("getReader must not be called when content-length > 64 KiB");
            },
          },
        };
      }
      return new Response("must not run", { status: 200 });
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    // Because content-length > 64 KiB, the stream body was not consumed/read
    expect(getReaderCalled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds stream buffering at 64 KiB for oversized stream and does NOT replay", async () => {
    let chunksRead = 0;
    let streamCancelled = false;
    const chunkSize = 16 * 1024; // 16 KiB per chunk
    const chunkData = new Uint8Array(chunkSize).fill(65); // 'A'

    const infiniteStream = new ReadableStream({
      pull(controller) {
        chunksRead++;
        controller.enqueue(chunkData);
      },
      cancel() {
        streamCancelled = true;
      },
    });

    proxiedThenDirect({
      proxiedResponse: () => new Response(infiniteStream, {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1); // No replay
    expect(streamCancelled).toBe(true);
    // At 16 KiB per chunk, 5 chunks = 80 KiB (> 64 KiB cap), so it cancels after 5 chunks
    expect(chunksRead).toBeLessThanOrEqual(6);
    const body = await res.text();
    expect(body.length).toBeLessThanOrEqual(64 * 1024 + chunkSize);
  });

  // Preservation check: Headers, status, statusText preservation on rebuilt response
  it("preserves status, statusText, and custom headers on rebuilt response while stripping framing", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(OTHER_403, {
        status: 403,
        statusText: "Forbidden By Policy",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-custom-456",
          "x-ratelimit-remaining": "42",
          "content-length": String(OTHER_403.length),
          "content-encoding": "identity",
        },
      }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(res.statusText).toBe("Forbidden By Policy");
    expect(res.headers.get("x-request-id")).toBe("req-custom-456");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("42");
    expect(res.headers.get("content-type")).toBe("application/json");
    // Framing headers stripped on rebuilt response
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(OTHER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Security deviation (e): one-shot / already consumed request body
  it("does NOT replay when request body is a locked ReadableStream and returns rebuilt response", async () => {
    const requestStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("req-body"));
        controller.close();
      },
    });
    // Lock the reader before passing options
    const reader = requestStream.getReader();

    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", body: requestStream },
      PROXY,
    );

    reader.releaseLock();
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1); // No replay because request body was locked
  });

  // Security deviation (d): replayed request carries exact method, body, headers, and no leaked credentials
  it("replays with identical request parameters and logs only the host", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let directOpts = null;
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      if (opts.dispatcher) {
        return new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } });
      }
      directOpts = opts;
      return new Response("ok", { status: 200 });
    });

    const requestHeaders = {
      Authorization: "Bearer secret-token",
      "x-custom": "val",
    };

    const res = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions?secret_key=topsecret",
      { method: "POST", body: JSON.stringify({ model: "test" }), headers: requestHeaders },
      PROXY,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify replayed request carries exact same method, body, and headers without alteration
    expect(directOpts.method).toBe("POST");
    expect(directOpts.body).toBe(JSON.stringify({ model: "test" }));
    expect(directOpts.headers).toEqual(requestHeaders);
    expect(directOpts.dispatcher).toBeFalsy();

    // Verify warn log contains host only and NEVER query string or headers
    const loggedMessages = warnSpy.mock.calls.map((c) => c.join(" "));
    const replayWarn = loggedMessages.find((msg) => msg.includes("replaying direct"));
    expect(replayWarn).toBeTruthy();
    expect(replayWarn).toContain("opencode.ai");
    expect(replayWarn).not.toContain("secret_key");
    expect(replayWarn).not.toContain("topsecret");
    expect(replayWarn).not.toContain("Bearer");

    warnSpy.mockRestore();
  });
});

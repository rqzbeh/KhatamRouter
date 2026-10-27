import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createSessionMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
}));

vi.mock("wreq-js", () => ({
  createSession: createSessionMock,
}));

describe("opencodeTlsClient", () => {
  let warnSpy;

  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("uses the 17-entry cipher list the upstream accepts and sends ALPN-negotiated requests", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    });
    const fakeWreqRes = {
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/event-stream"]]),
      body: stream,
    };
    const fetchMock = vi.fn().mockResolvedValue(fakeWreqRes);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const options = createSessionMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    expect(__test__.OPENCODE_CIPHER_LIST.split(":")).toHaveLength(17);
    expect(__test__.OPENCODE_CIPHER_LIST.startsWith("TLS_AES_128_GCM_SHA256")).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    // Verify live stream body is forwarded without buffering
    expect(result.body).toBe(stream);
  });

  it("reuses one session across requests", async () => {
    const fakeRes = { status: 200, statusText: "OK", headers: new Map(), body: null };
    const fetchMock = vi.fn().mockResolvedValue(fakeRes);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets the session when resetOpencodeTlsSession is called", async () => {
    const closeMock = vi.fn();
    const fakeRes = { status: 200, statusText: "OK", headers: new Map(), body: null };
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(fakeRes), close: closeMock });

    const { opencodeTlsFetch, resetOpencodeTlsSession } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/first", {});
    expect(createSessionMock).toHaveBeenCalledTimes(1);

    resetOpencodeTlsSession();
    await Promise.resolve();
    expect(closeMock).toHaveBeenCalledTimes(1);

    await opencodeTlsFetch("https://opencode.ai/second", {});
    expect(createSessionMock).toHaveBeenCalledTimes(2);
  });

  it("forwards the abort signal so a cancelled stream stops upstream", async () => {
    const fakeRes = { status: 200, statusText: "OK", headers: new Map(), body: null };
    const fetchMock = vi.fn().mockResolvedValue(fakeRes);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/stream", {}, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("validates hosts via isOpencodeHost", async () => {
    const { isOpencodeHost } = await import("../../open-sse/services/opencodeTlsClient.js");

    expect(isOpencodeHost("https://opencode.ai/inference/v1/chat/completions")).toBe(true);
    expect(isOpencodeHost("https://api.opencode.ai/v1")).toBe(true);
    expect(isOpencodeHost("https://sub.sub.opencode.ai/path")).toBe(true);

    expect(isOpencodeHost("http://opencode.ai/inference/v1")).toBe(false); // http rejected
    expect(isOpencodeHost("https://evil-opencode.ai/api")).toBe(false);
    expect(isOpencodeHost("https://opencode.ai.attacker.com/")).toBe(false);
    expect(isOpencodeHost("https://chatgpt.com/backend-api/transcribe")).toBe(false);
    expect(isOpencodeHost("invalid-url")).toBe(false);
    expect(isOpencodeHost("https://.opencode.ai/api")).toBe(false); // empty subdomain label
  });

  it("never follows redirects, so Authorization cannot be replayed off-host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 302, statusText: "Found", headers: new Map([["location", "https://attacker.example/sink"]]), body: null });
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(res.status).toBe(302);
  });

  it("sets no total timeout by default (a live SSE stream must not be cut) but honours an explicit one", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({ status: 200, statusText: "OK", headers: new Map(), body: null }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("timeout");
    await opencodeTlsFetch("https://opencode.ai/b", {}, { timeoutMs: 5000 });
    expect(fetchMock.mock.calls[1][1].timeout).toBe(5000);
  });

  it("clears the shared session cookie jar after each response", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, statusText: "OK", headers: new Map(), body: null });
    createSessionMock.mockResolvedValue({ fetch: fetchMock, clearCookies, close: vi.fn() });
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(clearCookies).toHaveBeenCalledTimes(1);
  });

  it("keeps repeated response headers instead of overwriting them", async () => {
    const headers = { forEach: (cb) => { cb("a=1", "set-cookie"); cb("b=2", "set-cookie"); } };
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue({ status: 200, statusText: "OK", headers, body: null }), close: vi.fn() });
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(res.headers.get("set-cookie")).toBe("a=1, b=2");
  });

  it("refuses foreign hosts in opencodeTlsFetch", async () => {
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    await expect(opencodeTlsFetch("https://chatgpt.com/api", {})).rejects.toThrow(
      /opencodeTlsFetch refused: host is not opencode.ai/
    );
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("surfaces OpencodeTlsUnavailableError when wreq-js runtime is missing createSession", async () => {
    createSessionMock.mockImplementation(() => {
      throw new Error("Native binding not available");
    });

    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );

    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toBeInstanceOf(
      OpencodeTlsUnavailableError
    );
  });

  describe("opencodeDirectFetch fail-open wrapper", () => {
    it("fails open to globalThis.fetch and logs warning ONCE when wreq-js unavailable", async () => {
      createSessionMock.mockImplementation(() => {
        throw new Error("Missing binary");
      });

      const globalFetchMock = vi.fn().mockResolvedValue(new Response("from-native", { status: 200 }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = globalFetchMock;

      try {
        const { opencodeDirectFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
        __test__.resetWarnLogged();

        const res1 = await opencodeDirectFetch("https://opencode.ai/inference/v1/chat", {
          method: "POST",
          headers: { "x-custom": "1" },
          body: JSON.stringify({ model: "oc/test" }),
        });
        expect(res1.status).toBe(200);
        expect(await res1.text()).toBe("from-native");
        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toBe(
          "[OpenCode TLS] wreq-js unavailable; falling back to native Bun fetch"
        );

        // Second call: still falls back to native fetch, but warning is NOT repeated
        const res2 = await opencodeDirectFetch("https://opencode.ai/inference/v1/chat", {
          method: "POST",
          headers: { "x-custom": "2" },
        });
        expect(res2.status).toBe(200);
        expect(globalFetchMock).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("propagates request-level errors from session.fetch unchanged (no fail-open retry)", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
      createSessionMock.mockResolvedValue({ fetch: fetchMock });

      const globalFetchMock = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = globalFetchMock;

      try {
        const { opencodeDirectFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
        await expect(
          opencodeDirectFetch("https://opencode.ai/inference/v1/chat", { method: "POST" })
        ).rejects.toThrow("ECONNRESET");

        // globalThis.fetch must NOT be called as fallback for a request-level error
        expect(globalFetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("propagates foreign host validation error unchanged", async () => {
      const { opencodeDirectFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
      await expect(
        opencodeDirectFetch("https://notopencode.ai/test", {})
      ).rejects.toThrow(/opencodeTlsFetch refused/);
    });
  });
});

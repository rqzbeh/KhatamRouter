import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function mockUndici(fetchMock) {
  if (typeof Bun !== "undefined") {
    try {
      const { mock } = await import("bun:test");
      const actual = await import("undici");
      mock.module("undici", () => ({ ...actual, fetch: fetchMock }));
    } catch {}
  }
  if (typeof vi !== "undefined" && typeof vi.doMock === "function") {
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });
  }
}

describe("transport-019-safety: Strict proxy, bounded safe replay, caller cancellation, and CodeBuddy prompt preservation", () => {
  const savedEnv = { ...process.env };
  const ENV_KEYS = [
    "FETCH_KEEPALIVE_TIMEOUT_MS",
    "FETCH_FRESH_RETRY",
    "KIRO_INTEGRITY_GATE",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    if (typeof Bun !== "undefined") {
      try {
        const { mock } = await import("bun:test");
        const actual = await vi.importActual("undici");
        mock.module("undici", () => actual);
      } catch {}
    }
    vi.doUnmock("undici");
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });

  describe("1. Strict proxy preservation & fail-closed behavior", () => {
    it("fails closed and never falls back to direct when proxy leg errors with strictProxy: true", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Proxy connection refused"));
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      await expect(
        proxyAwareFetch(
          "https://api.openai.com/v1/chat/completions",
          { method: "POST", body: "{}" },
          { enabled: true, url: "http://127.0.0.1:9999", strictProxy: true }
        )
      ).rejects.toThrow(/strictProxy=true/);

      // Only the proxy dispatcher was attempted, no direct fallback attempt
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws 503 before network attempt when strictProxy is true but pool has empty proxy URL", async () => {
      const fetchMock = vi.fn();
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      let error = null;
      try {
        await proxyAwareFetch(
          "https://api.openai.com/v1/chat/completions",
          { method: "POST", body: "{}" },
          { enabled: true, url: "", strictProxy: true }
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeTruthy();
      expect(error.message).toMatch(/strictProxy=true/);
      expect(error.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not leak direct connection on MITM-bypassed host when strictProxy is true and proxy fails", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Proxy unreachable"));
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      // "generativelanguage.googleapis.com" is in MITM_BYPASS_HOSTS
      await expect(
        proxyAwareFetch(
          "https://generativelanguage.googleapis.com/v1beta/models",
          { method: "GET" },
          { enabled: true, url: "http://127.0.0.1:9999", strictProxy: true }
        )
      ).rejects.toThrow(/strictProxy=true/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. Bounded safe replay on dead pooled sockets", () => {
    it("replays exactly once on fresh-socket dispatcher for dead socket errors", async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))
        .mockResolvedValueOnce({ status: 200, ok: true });
      await mockUndici(fetchMock);

      const {
        proxyAwareFetch,
        getDirectDispatcher,
        getFreshRetryDispatcher,
        resetDirectDispatchersForTests,
      } = await import("../../open-sse/utils/proxyFetch.js");
      resetDirectDispatchersForTests();

      const res = await proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const directAgent = await getDirectDispatcher(false);
      const freshAgent = await getFreshRetryDispatcher(false);
      expect(fetchMock.mock.calls[0][1].dispatcher).toBe(directAgent);
      expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshAgent);
    });

    it("never replays when request body is a stream (unlocked WebStream or Node Readable)", async () => {
      const { Readable } = await import("stream");
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      // Unlocked WebStream must NOT be replayed
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
      expect(stream.locked).toBe(false);

      await expect(
        proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          body: stream,
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Node Readable must NOT be replayed
      fetchMock.mockClear();
      const nodeStream = Readable.from(["chunk"]);
      await expect(
        proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          body: nodeStream,
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never replays on headers timeout even if error message contains 'socket hang up'", async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("socket hang up"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      await expect(
        proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          body: "{\"prompt\":\"hi\"}",
        })
      ).rejects.toThrow(/socket hang up/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never replays when request body is a locked stream", async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
      // Lock the stream by acquiring a reader
      const reader = stream.getReader();
      expect(stream.locked).toBe(true);

      await expect(
        proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          body: stream,
        })
      ).rejects.toThrow(/disturbed|locked|fetch failed/);

      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
      reader.releaseLock();
    });

    it("never replays when proxied request fails with dead socket (replay is direct-path only)", async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      // Proxy failed: strictProxy rejects immediately without internal fresh-socket replay
      await expect(
        proxyAwareFetch(
          "https://api.openai.com/v1/chat/completions",
          { method: "POST", body: "{}" },
          { enabled: true, url: "http://127.0.0.1:9090", strictProxy: true }
        )
      ).rejects.toThrow(/strictProxy=true/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not replay when FETCH_FRESH_RETRY=off", async () => {
      process.env.FETCH_FRESH_RETRY = "off";
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      await expect(
        proxyAwareFetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          body: "{}",
        })
      ).rejects.toThrow(/fetch failed/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Caller cancellation", () => {
    it("immediately aborts in BaseExecutor without retrying when signal is aborted", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
      vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

      const { BaseExecutor } = await import("../../open-sse/executors/base.js");
      const ex = new BaseExecutor("openai", {
        baseUrl: "https://api.openai.com/v1/chat/completions",
        retry: { 502: { attempts: 3, delayMs: 0 } },
      });

      const controller = new AbortController();
      controller.abort();

      await expect(
        ex.execute({
          model: "gpt-4o",
          body: { messages: [] },
          stream: false,
          credentials: { apiKey: "test" },
          signal: controller.signal,
        })
      ).rejects.toThrow();

      // Zero or one call, definitely no 3 retries
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it("does not trigger fresh socket replay in proxyAwareFetch when signal is aborted", async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error("fetch failed"), { name: "AbortError", cause: { code: "UND_ERR_SOCKET" } })
      );
      await mockUndici(fetchMock);

      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
        "../../open-sse/utils/proxyFetch.js"
      );
      resetDirectDispatchersForTests();

      const controller = new AbortController();
      controller.abort();

      await expect(
        proxyAwareFetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        })
      ).rejects.toThrow();

      // Never retried/replayed
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe("4. Kiro served-region allowlist & integrity gate", () => {
    it("restricts hostname regionalization to allowed services", async () => {
      const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
      const ex = new KiroExecutor();

      const idcCredentials = (region) => ({
        accessToken: "test",
        providerSpecificData: { authMethod: "idc", region },
      });

      // eu-central-1 is valid for Q, but not codewhisperer
      const urls = ex.getOrderedBaseUrls(idcCredentials("eu-central-1"));
      expect(urls[0]).toBe("https://q.eu-central-1.amazonaws.com/generateAssistantResponse");
      expect(urls).not.toContain("https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse");

      // unserved region keeps default us-east-1
      const unservedUrls = ex.getOrderedBaseUrls(idcCredentials("ap-southeast-1"));
      expect(unservedUrls[0]).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse");
    });

    it("neutralizes attacker injection in region", async () => {
      const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
      const ex = new KiroExecutor();

      const hostile = "evil.com#";
      const urls = ex.getOrderedBaseUrls({
        accessToken: "test",
        providerSpecificData: { authMethod: "idc", region: hostile },
      });

      for (const u of urls) {
        expect(u).not.toContain("evil.com");
        expect(new URL(u).hostname).toMatch(/amazonaws\.com$|\.kiro\.dev$/);
      }
    });
  });

  describe("5. CodeBuddy system prompt preservation & authorized CLI sanitization", () => {
    it("preserves user-authored system prompt without truncation or omission", async () => {
      const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
      const exec = new CodeBuddyIntlExecutor();

      const userSystem = "Act as an expert Rust engineer specialized in async tokio.";
      const out = exec.transformRequest(
        "deepseek-v4.1-flash",
        {
          messages: [
            { role: "system", content: userSystem },
            { role: "user", content: "Explain pinned futures." },
          ],
        },
        false,
        {}
      );

      expect(out.messages[0]).toEqual({
        role: "system",
        content: userSystem,
      });
      expect(out.messages[1].role).toBe("user");
      expect(out.messages[1].content).toEqual([{ type: "text", text: "Explain pinned futures." }]);
    });

    it("merges multiple system/developer messages into single system prompt", async () => {
      const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
      const exec = new CodeBuddyIntlExecutor();

      const out = exec.transformRequest(
        "deepseek-v4.1-flash",
        {
          messages: [
            { role: "system", content: "Part 1: Rules" },
            { role: "developer", content: "Part 2: Constraints" },
            { role: "user", content: "Hi" },
          ],
        },
        false,
        {}
      );

      expect(out.messages[0]).toEqual({
        role: "system",
        content: "Part 1: Rules\n\nPart 2: Constraints",
      });
    });

    it("neutralizes injected third-party agent identity metadata while keeping other instructions", async () => {
      const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
      const exec = new CodeBuddyIntlExecutor();

      const out = exec.transformRequest(
        "deepseek-v4.1-flash",
        {
          messages: [
            { role: "system", content: "You are Claude Code, Anthropic's official CLI." },
            { role: "user", content: "Refactor" },
          ],
        },
        false,
        {}
      );

      expect(out.messages[0]).toEqual({
        role: "system",
        content: "You are a helpful AI assistant that helps with software engineering tasks.",
      });
    });
  });

  describe("6. OpenCode Go endpoint migration", () => {
    it("uses /inference/go/ endpoints exclusively in registry and executor", async () => {
      const opencodeGoRegistry = (await import("../../open-sse/providers/registry/opencode-go.js")).default;
      expect(opencodeGoRegistry.transport.baseUrl).toBe(
        "https://opencode.ai/inference/go/openai/v1/chat/completions"
      );
      expect(opencodeGoRegistry.transport.usage.url).toBe(
        "https://opencode.ai/inference/go/v1/usage"
      );
      expect(opencodeGoRegistry.transports[0].baseUrl).toBe(
        "https://opencode.ai/inference/go/openai/v1/chat/completions"
      );
      expect(opencodeGoRegistry.transports[1].baseUrl).toBe(
        "https://opencode.ai/inference/go/anthropic/v1/messages"
      );
      expect(opencodeGoRegistry.transports[1].thinkingFormat).toBe("claude-adaptive");
      expect(opencodeGoRegistry.transports[2].baseUrl).toBe(
        "https://opencode.ai/inference/go/openai/v1/responses"
      );

      const { OpenCodeGoExecutor } = await import("../../open-sse/executors/opencode-go.js");
      const exec = new OpenCodeGoExecutor();
      expect(exec.buildUrl("gpt-5.6-luna")).toBe(
        "https://opencode.ai/inference/go/openai/v1/responses"
      );
    });
  });
});

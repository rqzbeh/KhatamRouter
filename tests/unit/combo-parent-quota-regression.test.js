import { afterEach, describe, expect, it, vi } from "vitest";
import { clearComboCooldowns, handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {} };
afterEach(() => { clearComboCooldowns(); vi.useRealTimers(); });

describe("independent wrapped quota fallback regression", () => {
  it.each([
    '[429]: You have reached the daily limit of 60 free-model requests for your account. Retry after 11114 seconds. (reset after 19s)',
    '[429]: Daily quota exceeded. Rate limit resets in 11114 seconds.',
  ])("tries the healthy member without a transient outage sleep for %s", async (message) => {
    vi.useFakeTimers();
    const calls = [];
    const pending = handleComboChat({
      body: { messages: [{ role: "user", content: "fixture" }] },
      models: ["openai/exhausted", "openai/healthy"],
      comboName: "parent-review", comboStrategy: "fallback", cooldownScope: "parent-scope", log,
      handleSingleModel: async (_, model) => {
        calls.push(model);
        if (model.endsWith("healthy")) return new Response('{"ok":true}', { status: 200 });
        return new Response(JSON.stringify({ error: {
          message,
        } }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "11114" } });
      },
    });
    // Flush promise continuations, never advance timers: immediate fallback must not
    // require the transient-delay timer to fire.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const immediateCalls = [...calls];
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(immediateCalls).toEqual(["openai/exhausted", "openai/healthy"]);
    expect(response.status).toBe(200);
  });

  it("does not rewrite an unrelated genuine outage as a rate limit", async () => {
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "fixture" }] },
      models: ["openai/outage"], comboName: "parent-outage", log,
      handleSingleModel: async () => new Response(JSON.stringify({ error: { message: "Service unavailable" } }), {
        status: 503, headers: { "Retry-After": "11114", "Content-Type": "application/json" },
      }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("11114");
  });
});

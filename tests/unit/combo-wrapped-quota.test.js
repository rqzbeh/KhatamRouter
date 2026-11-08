import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearComboCooldowns,
  handleComboChat,
  getCooldownEntry,
  isComboModelCooling,
  isQuotaShapedTransientError,
} from "../../open-sse/services/combo.js";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("combo wrapped quota & 503 fallback correctness", () => {
  beforeEach(() => {
    clearComboCooldowns();
  });

  afterEach(() => {
    clearComboCooldowns();
    vi.useRealTimers();
  });

  describe("isQuotaShapedTransientError predicate", () => {
    it("returns false for non-5xx statuses", () => {
      expect(isQuotaShapedTransientError(400, null, "[429]: Daily limit")).toBe(false);
      expect(isQuotaShapedTransientError(401, null, "[429]: Daily limit")).toBe(false);
      expect(isQuotaShapedTransientError(403, null, "[429]: Daily limit")).toBe(false);
      expect(isQuotaShapedTransientError(429, null, "Rate limit")).toBe(false);
      expect(isQuotaShapedTransientError(500, null, "[429]: Daily limit")).toBe(false);
    });

    it("returns true for 502/503/504 with structured upstream_status 429", () => {
      expect(isQuotaShapedTransientError(503, { upstream_status: 429 }, "")).toBe(true);
      expect(isQuotaShapedTransientError(502, { upstreamStatus: 429 }, "")).toBe(true);
      expect(isQuotaShapedTransientError(504, { error: { upstream_status: 429 } }, "")).toBe(true);
      // Does not confuse outer status 503 with nested upstream status
      expect(isQuotaShapedTransientError(503, { status: 503 }, "Service unavailable")).toBe(false);
    });

    it("returns true for 502/503/504 with structured quota error code/type", () => {
      expect(isQuotaShapedTransientError(503, { error: { code: "rate_limit_exceeded" } }, "")).toBe(true);
      expect(isQuotaShapedTransientError(503, { error: { type: "rate_limit_error" } }, "")).toBe(true);
      expect(isQuotaShapedTransientError(503, { error: { code: "insufficient_quota" } }, "")).toBe(true);
    });

    it("returns true for 502/503/504 with bounded explicit quota text patterns", () => {
      expect(isQuotaShapedTransientError(503, null, "[429]: You have reached the daily limit of 60 free-model requests")).toBe(true);
      expect(isQuotaShapedTransientError(503, null, "[429]: Daily quota exceeded. Rate limit resets in 11114 seconds.")).toBe(true);
      expect(isQuotaShapedTransientError(503, null, "upstream returned 429")).toBe(true);
      expect(isQuotaShapedTransientError(503, null, "HTTP 429 Too Many Requests")).toBe(true);
    });

    it("returns false for genuine 503 outage or arbitrary quoted digits without quota signal", () => {
      expect(isQuotaShapedTransientError(503, null, "Service unavailable: cluster degraded")).toBe(false);
      expect(isQuotaShapedTransientError(503, null, "server overloaded")).toBe(false);
      expect(isQuotaShapedTransientError(503, null, "Internal compiler error in module core.c at line 429")).toBe(false);
    });
  });

  describe("immediate fallback without transient 503 sleep for quota-shaped errors", () => {
    it.each([
      {
        name: "Variant A (daily limit + retry after 11114s + 19s short reset)",
        message: "[429]: You have reached the daily limit of 60 free-model requests for your account. Retry after 11114 seconds. (reset after 19s)",
        status: 503,
      },
      {
        name: "Variant B (daily quota exceeded + rate limit resets in 11114 seconds.)",
        message: "[429]: Daily quota exceeded. Rate limit resets in 11114 seconds.",
        status: 503,
      },
      {
        name: "Structured upstream_status 429 in outer 503",
        body: { error: { upstream_status: 429, message: "Rate limit reached for account" } },
        status: 503,
      },
      {
        name: "Structured code rate_limit_exceeded in outer 503",
        body: { error: { code: "rate_limit_exceeded", message: "Capacity limit reached" } },
        status: 503,
      },
    ])("fails over immediately without transient sleep: $name", async ({ message, body, status }) => {
      vi.useFakeTimers();
      const calls = [];
      const errorBody = body || { error: { message } };

      const pending = handleComboChat({
        body: { messages: [{ role: "user", content: "test" }] },
        models: ["model-exhausted", "model-healthy"],
        comboName: "test-combo",
        comboStrategy: "fallback",
        cooldownScope: "test-scope",
        log,
        handleSingleModel: async (_, model) => {
          calls.push(model);
          if (model === "model-healthy") {
            return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(errorBody), {
            status,
            statusText: "Service Unavailable",
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "11114",
            },
          });
        },
      });

      // Flush microtasks without advancing timers. If combo.js sleeps for 2s,
      // model-healthy will NOT have been called yet.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const immediateCalls = [...calls];

      await vi.runAllTimersAsync();
      const response = await pending;

      expect(immediateCalls).toEqual(["model-exhausted", "model-healthy"]);
      expect(response.status).toBe(200);
    });
  });

  describe("generic 503 outage preservation & outer status preservation", () => {
    it("preserves genuine 503 outage status and authoritative Retry-After header", async () => {
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "fixture" }] },
        models: ["openai/outage"],
        comboName: "parent-outage",
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "Service unavailable: cluster degraded" } }), {
            status: 503,
            headers: { "Retry-After": "11114", "Content-Type": "application/json" },
          }),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("11114");
    });

    it("preserves outer status 503 when all models fail (no rewrite to 429)", async () => {
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "test" }] },
        models: ["model-quota-1", "model-quota-2"],
        comboName: "all-quota-combo",
        log,
        handleSingleModel: async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "[429]: You have reached the daily limit of 60 free-model requests for your account. Retry after 11114 seconds.",
              },
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "11114" },
            }
          ),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("11114");
    });

    it("leaves generic 503 transient wait behavior unchanged even with long Retry-After header", async () => {
      vi.useFakeTimers();
      const calls = [];
      const pending = handleComboChat({
        body: { messages: [{ role: "user", content: "test" }] },
        models: ["model-overloaded", "model-secondary"],
        comboName: "overload-combo",
        log,
        handleSingleModel: async (_, model) => {
          calls.push(model);
          if (model === "model-secondary") {
            return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ error: { message: "server overloaded" } }),
            {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "11114" },
            }
          );
        },
      });

      // Flush microtasks without advancing timers. For generic "server overloaded",
      // transient wait (2s) MUST occur, so model-secondary is not called yet.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(calls).toEqual(["model-overloaded"]);

      // Advance timers to allow transient delay to complete
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(calls).toEqual(["model-overloaded", "model-secondary"]);
      expect(response.status).toBe(200);
    });
  });

  describe("scope isolation in combo cooldown tracking", () => {
    it("does not suppress models across different scopes", async () => {
      await handleComboChat({
        body: { messages: [{ role: "user", content: "test" }] },
        models: ["shared-model", "backup-model"],
        comboName: "shared-combo",
        cooldownScope: "scope-A",
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "[429]: Daily quota exceeded." } }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "3600" },
          }),
      });

      expect(isComboModelCooling("scope-A", "shared-combo", "shared-model")).toBe(true);
      expect(isComboModelCooling("scope-B", "shared-combo", "shared-model")).toBe(false);
      expect(isComboModelCooling(null, "shared-combo", "shared-model")).toBe(false);
    });
  });
});

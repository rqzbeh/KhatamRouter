import { describe, it, expect, beforeEach } from "vitest";
import { getEventListeners } from "node:events";
import {
  parseRetryAfter,
  setCooldownEntry,
  getCooldownEntry,
  pruneExpiredCooldowns,
  clearComboCooldowns,
  getComboCooldownMapSize,
  isComboModelCooling,
  markComboModelCooldown,
  handleComboChat,
} from "../../open-sse/services/combo.js";

describe("combo cooldown correctness & isolation", () => {
  beforeEach(() => {
    clearComboCooldowns();
  });

  describe("parseRetryAfter", () => {
    it("parses numeric seconds string", () => {
      const parsed = parseRetryAfter("120");
      expect(parsed).not.toBeNull();
      expect(parsed.seconds).toBe(120);
      expect(parsed.durationMs).toBe(120000);
      expect(parsed.untilEpochMs).toBeGreaterThan(Date.now() + 110000);

      // Extreme seconds must not throw on toISOString and must preserve raw header
      const extreme = parseRetryAfter("9999999999999999");
      expect(extreme).not.toBeNull();
      expect(extreme.raw).toBe("9999999999999999");
      expect(extreme.iso).toBeNull();

      const uint64Max = parseRetryAfter("18446744073709551615");
      expect(uint64Max).not.toBeNull();
      expect(uint64Max.raw).toBe("18446744073709551615");
      expect(uint64Max.iso).toBeNull();
    });

    it("parses HTTP date string", () => {
      const futureDate = new Date(Date.now() + 60000).toUTCString();
      const parsed = parseRetryAfter(futureDate);
      expect(parsed).not.toBeNull();
      expect(parsed.seconds).toBeGreaterThanOrEqual(58);
      expect(parsed.seconds).toBeLessThanOrEqual(61);
      expect(parsed.durationMs).toBeGreaterThan(0);
    });

    it("returns null for invalid inputs", () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("")).toBeNull();
      expect(parseRetryAfter("invalid-format")).toBeNull();
      expect(parseRetryAfter("Infinity")).toBeNull();
      expect(parseRetryAfter("-Infinity")).toBeNull();
      expect(parseRetryAfter("NaN")).toBeNull();
      expect(parseRetryAfter("-10")).toBeNull();
    });

    it("does not truncate durations above 90s", () => {
      const parsed = parseRetryAfter("300");
      expect(parsed).not.toBeNull();
      expect(parsed.seconds).toBe(300);
      expect(parsed.durationMs).toBe(300000);
    });
  });

  describe("bounded cooldown map & pruning", () => {
    it("enforces maximum entries and prunes expired entries", () => {
      const now = Date.now();
      // Add expired entries
      for (let i = 0; i < 50; i++) {
        setCooldownEntry(`expired::scope::model-${i}`, {
          until: now - 1000,
          status: 429,
          errorText: "expired"
        });
      }

      // Add fresh entries
      for (let i = 0; i < 50; i++) {
        setCooldownEntry(`fresh::scope::model-${i}`, {
          until: now + 60000,
          status: 429,
          errorText: "fresh"
        });
      }

      pruneExpiredCooldowns(now);
      expect(getComboCooldownMapSize()).toBe(50);

      // Verify expired entries return null
      expect(getCooldownEntry("expired::scope::model-0")).toBeNull();
      // Verify fresh entry returns valid object
      const fresh = getCooldownEntry("fresh::scope::model-0");
      expect(fresh).not.toBeNull();
      expect(fresh.status).toBe(429);
    });

    it("bounds maximum entries under high load", () => {
      // Add 1200 entries to verify cap at 1000
      for (let i = 0; i < 1200; i++) {
        setCooldownEntry(`load::scope::model-${i}`, {
          until: Date.now() + 60000,
          status: 503,
          errorText: "overload"
        });
      }

      expect(getComboCooldownMapSize()).toBeLessThanOrEqual(1000);

      // markComboModelCooldown with extreme duration must not throw on toISOString and must bound safely
      expect(() => {
        markComboModelCooldown("scope", "combo", "model-extreme", 429, 9999999999999999 * 1000);
      }).not.toThrow();

      // Negative or invalid duration must not throw
      expect(() => {
        markComboModelCooldown("scope", "combo", "model-negative", 429, -5000);
      }).not.toThrow();
    });
  });

  describe("scope isolation in cooldown lookup", () => {
    it("isolates cooldown between different caller scopes", () => {
      markComboModelCooldown("tenant-A", "combo1", "modelX", 429, 60000);

      expect(isComboModelCooling("tenant-A", "combo1", "modelX")).toBe(true);
      expect(isComboModelCooling("tenant-B", "combo1", "modelX")).toBe(false);
      expect(isComboModelCooling(null, "combo1", "modelX")).toBe(false);
    });

    it("does not suppress models when no scope is provided", () => {
      // Unscoped calls must not record or read cross-request cooldown
      expect(isComboModelCooling(null, "combo1", "modelX")).toBe(false);
    });
  });

  describe("AbortSignal handling & transient delay cleanup", () => {
    it("handles pre-aborted signal, removes listeners on completed transient delay, and cancels body on abort", async () => {
      // 1. Pre-aborted signal returns 499
      const controller = new AbortController();
      controller.abort();

      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "test" }] },
        models: ["modelA", "modelB"],
        handleSingleModel: async () => new Response("ok", { status: 200 }),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        comboName: "test-combo",
        signal: controller.signal
      });

      expect(res.status).toBe(499);
      const json = await res.json();
      expect(json.error.message).toMatch(/aborted/i);

      // 2. Normally completed transient delays must leave 0 listeners on clientSignal (even when repeated)
      const reusableController = new AbortController();
      for (let run = 0; run < 2; run++) {
        let call = 0;
        const transientRes = await handleComboChat({
          body: { messages: [{ role: "user", content: "transient" }] },
          models: ["transient-model-1", "transient-model-2"],
          handleSingleModel: async () => {
            call++;
            if (call === 1) {
              return new Response(JSON.stringify({ error: { message: "server overloaded" } }), {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json" }
              });
            }
            return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" } }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          },
          log: { info: () => {}, warn: () => {}, error: () => {} },
          comboName: "transient-combo",
          signal: reusableController.signal
        });
        expect(transientRes.status).toBe(200);
        expect(getEventListeners(reusableController.signal, "abort").length).toBe(0);
      }

      // 3. Abort during transient delay returns 499 and cancels response body
      const abortMidWaitCtrl = new AbortController();
      let bodyCanceled = false;
      setTimeout(() => abortMidWaitCtrl.abort(), 20);

      const midWaitRes = await handleComboChat({
        body: { messages: [{ role: "user", content: "abort-mid" }] },
        models: ["mid-1", "mid-2"],
        handleSingleModel: async () => {
          return {
            status: 503,
            statusText: "Service Unavailable",
            headers: new Headers({ "Content-Type": "application/json" }),
            clone: () => ({ json: async () => ({ error: { message: "server overloaded" } }) }),
            body: {
              cancel: async () => { bodyCanceled = true; }
            }
          };
        },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        comboName: "mid-combo",
        signal: abortMidWaitCtrl.signal
      });

      expect(midWaitRes.status).toBe(499);
      expect(bodyCanceled).toBe(true);

      // 4. Malformed resetsAtMs produces 429 rather than 500 / Invalid Date
      const malformedRes = await handleComboChat({
        body: { messages: [{ role: "user", content: "malformed-resets" }] },
        models: ["model-malformed"],
        handleSingleModel: async () => new Response(JSON.stringify({
          error: { message: "rate limited" },
          resetsAtMs: 1e25
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" }
        }),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        comboName: "malformed-combo"
      });
      expect(malformedRes.status).toBe(429);
      expect(malformedRes.status).not.toBe(500);
    }, 15000);
  });
});

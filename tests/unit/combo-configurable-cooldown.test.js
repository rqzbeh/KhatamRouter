import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeMemberCooldownMs,
  MEMBER_COOLDOWN_PRESETS_MS,
  clearComboCooldowns,
  isComboModelCooling,
  getCooldownEntry,
  handleComboChat,
} from "../../open-sse/services/combo.js";
import { resolveCooldownScope, handleChat } from "../../src/sse/handlers/chat.js";
import { PATCH as settingsPatch } from "../../src/app/api/settings/route.js";
import {
  calculateComboStrategyUpdate,
  executeComboUpdateTransaction,
  executeComboCreateTransaction,
} from "../../src/app/(dashboard)/dashboard/combos/comboUpdateHelper.js";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("combo configurable cooldown & scope isolation", () => {
  beforeEach(() => {
    clearComboCooldowns();
  });

  afterEach(() => {
    clearComboCooldowns();
    vi.useRealTimers();
  });

  describe("normalizeMemberCooldownMs", () => {
    it("accepts valid presets", () => {
      expect(normalizeMemberCooldownMs("1m")).toBe(60_000);
      expect(normalizeMemberCooldownMs("5m")).toBe(300_000);
      expect(normalizeMemberCooldownMs("1h")).toBe(3_600_000);
    });

    it("accepts valid millisecond integers between 10s and 24h", () => {
      expect(normalizeMemberCooldownMs(10_000)).toBe(10_000);
      expect(normalizeMemberCooldownMs(60_000)).toBe(60_000);
      expect(normalizeMemberCooldownMs(300_000)).toBe(300_000);
      expect(normalizeMemberCooldownMs(86_400_000)).toBe(86_400_000);
    });

    it("accepts numeric strings containing integer milliseconds in range", () => {
      expect(normalizeMemberCooldownMs("10000")).toBe(10_000);
      expect(normalizeMemberCooldownMs("60000")).toBe(60_000);
    });

    it("rejects values outside 10s..24h or invalid types", () => {
      expect(normalizeMemberCooldownMs(null)).toBeNull();
      expect(normalizeMemberCooldownMs(undefined)).toBeNull();
      expect(normalizeMemberCooldownMs("")).toBeNull();
      expect(normalizeMemberCooldownMs(9999)).toBeNull();
      expect(normalizeMemberCooldownMs(86_400_001)).toBeNull();
      expect(normalizeMemberCooldownMs(-1)).toBeNull();
      expect(normalizeMemberCooldownMs(0)).toBeNull();
      expect(normalizeMemberCooldownMs(12.34)).toBeNull();
      expect(normalizeMemberCooldownMs("invalid")).toBeNull();
      expect(normalizeMemberCooldownMs("10m")).toBeNull();
      expect(normalizeMemberCooldownMs({})).toBeNull();
      expect(normalizeMemberCooldownMs([])).toBeNull();
    });

    it("returns null for Object prototype property names ('toString', 'constructor', 'valueOf', '__proto__')", () => {
      expect(normalizeMemberCooldownMs("toString")).toBeNull();
      expect(normalizeMemberCooldownMs("constructor")).toBeNull();
      expect(normalizeMemberCooldownMs("valueOf")).toBeNull();
      expect(normalizeMemberCooldownMs("__proto__")).toBeNull();
      expect(normalizeMemberCooldownMs("hasOwnProperty")).toBeNull();
      expect(normalizeMemberCooldownMs("isPrototypeOf")).toBeNull();
    });
  });

  describe("resolveCooldownScope", () => {
    it("returns stable keyRecord.id for authenticated callers (not secret API key)", () => {
      const scope = resolveCooldownScope(
        new Request("http://localhost:20128/v1/chat/completions", {
          headers: { authorization: "Bearer secret-raw-token" },
        }),
        { keyRecord: { id: "key_record_id_123", key: "secret-raw-token" } }
      );
      expect(scope).toBe("key_record_id_123");
      expect(scope).not.toContain("secret-raw-token");
    });

    it("returns string id for numeric keyRecord id", () => {
      const scope = resolveCooldownScope(null, { keyRecord: { id: 42 } });
      expect(scope).toBe("42");
    });

    it("returns null for trusted internal requests (never globally cool users)", () => {
      const scope = resolveCooldownScope(
        new Request("http://localhost:20128/v1/chat/completions"),
        { keyRecord: { id: "admin-key" }, isTrustedInternal: true }
      );
      expect(scope).toBeNull();
    });

    it("does NOT allow public caller with fake x-probe or x-synthetic-probe to evade key scope", () => {
      const req1 = new Request("http://localhost:20128/v1/chat/completions", {
        headers: { "x-probe": "1" },
      });
      expect(resolveCooldownScope(req1, { keyRecord: { id: "user-key-1" } })).toBe("user-key-1");

      const req2 = new Request("http://localhost:20128/v1/chat/completions", {
        headers: { "x-synthetic-probe": "true" },
      });
      expect(resolveCooldownScope(req2, { keyRecord: { id: "user-key-2" } })).toBe("user-key-2");
    });

    it("returns explicit local single-user scope for authenticated local peer via trusted peer token", () => {
      const token = "test-peer-token";
      process.env.NINEROUTER_PEER_TOKEN = token;
      const req = new Request("http://localhost:20128/v1/chat/completions", {
        headers: {
          "x-9r-peer-token": token,
          "x-9r-real-ip": "127.0.0.1",
        },
      });
      const scope = resolveCooldownScope(req, { keyRecord: null });
      expect(scope).toBe("local:single-user");
    });

    it("does not mistake a public Host localhost header for a loopback socket", () => {
      const req = new Request("http://localhost:20128/v1/chat/completions", {
        headers: {
          host: "localhost:20128",
          "x-forwarded-for": "203.0.113.11",
        },
      });
      const scope = resolveCooldownScope(req, { keyRecord: null });
      expect(scope).toBeNull();
    });

    it("returns null for remote anonymous callers (no cross-request suppression)", () => {
      const req = new Request("http://remote.host:20128/v1/chat/completions", {
        headers: { "x-forwarded-for": "203.0.113.195" },
      });
      const scope = resolveCooldownScope(req, { keyRecord: null });
      expect(scope).toBeNull();
    });
  });

  describe("exact combo name scope isolation", () => {
    it("isolates cooldown by exact combo name even for the same model and caller", async () => {
      const scope = "user-123";
      const callsA = [];
      const callsB = [];

      // Call in combo-alpha: model-1 fails 429
      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["model-shared", "model-backup"],
        comboName: "combo-alpha",
        cooldownScope: scope,
        memberCooldownMs: "1m",
        log,
        handleSingleModel: async (_, m) => {
          callsA.push(m);
          if (m === "model-shared") {
            return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(isComboModelCooling(scope, "combo-alpha", "model-shared")).toBe(true);
      // Combo beta must NOT have model-shared cooling!
      expect(isComboModelCooling(scope, "combo-beta", "model-shared")).toBe(false);

      // Call in combo-beta: model-shared should be attempted!
      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi from beta" }] },
        models: ["model-shared", "model-backup"],
        comboName: "combo-beta",
        cooldownScope: scope,
        memberCooldownMs: "1m",
        log,
        handleSingleModel: async (_, m) => {
          callsB.push(m);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(callsB).toContain("model-shared");
    });
  });

  describe("status cooling and status preservation", () => {
    it.each([401, 402, 403, 429, 502, 503, 504])("cools member on status %i when configured", async (status) => {
      const scope = `scope-${status}`;
      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["model-fail", "model-ok"],
        comboName: `combo-${status}`,
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "model-fail") {
            return new Response(JSON.stringify({ error: { message: `Failure with status ${status}` } }), {
              status,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(isComboModelCooling(scope, `combo-${status}`, "model-fail")).toBe(true);
    });

    it.each([400, 404, 422])("never cools member on request-scoped status %i", async (status) => {
      const scope = `scope-${status}`;
      await handleComboChat({
        body: { messages: [{ role: "user", content: "bad payload" }] },
        models: ["model-fail", "model-ok"],
        comboName: `combo-${status}`,
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "model-fail") {
            return new Response(JSON.stringify({ error: { message: `Request error ${status}` } }), {
              status,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(isComboModelCooling(scope, `combo-${status}`, "model-fail")).toBe(false);
    });

    it("never cools member on policy refusal even with 400/403 status", async () => {
      const scope = "scope-policy";
      await handleComboChat({
        body: { messages: [{ role: "user", content: "moderation test" }] },
        models: ["model-refuse", "model-ok"],
        comboName: "combo-policy",
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "model-refuse") {
            return new Response(
              JSON.stringify({ error: { message: "Content policy violation: blocked by safety system" } }),
              { status: 403, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(isComboModelCooling(scope, "combo-policy", "model-refuse")).toBe(false);
    });

    it("fast-fails with upstream 401 when all members cooled by 401 (no fake 429)", async () => {
      const scope = "scope-auth";
      // First call: model fails with 401
      const res1 = await handleComboChat({
        body: { messages: [{ role: "user", content: "auth test" }] },
        models: ["model-unauth"],
        comboName: "combo-auth",
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "Unauthorized key expired" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
      });
      expect(res1.status).toBe(401);

      // Second call: fast-fail while cooling
      const res2 = await handleComboChat({
        body: { messages: [{ role: "user", content: "auth test 2" }] },
        models: ["model-unauth"],
        comboName: "combo-auth",
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async () => {
          throw new Error("Should not be called during fast-fail");
        },
      });

      expect(res2.status).toBe(401);
      const data = await res2.json();
      expect(data.error.message).toMatch(/Unauthorized/);
    });

    it("fast-fails with upstream 403 when all members cooled by 403 (no fake 429)", async () => {
      const scope = "scope-forbidden";
      await handleComboChat({
        body: { messages: [{ role: "user", content: "forbidden test" }] },
        models: ["model-denied"],
        comboName: "combo-forbidden",
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "Forbidden account access denied" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      });

      const res2 = await handleComboChat({
        body: { messages: [{ role: "user", content: "forbidden test 2" }] },
        models: ["model-denied"],
        comboName: "combo-forbidden",
        cooldownScope: scope,
        memberCooldownMs: 60_000,
        log,
        handleSingleModel: async () => {
          throw new Error("Should not be called");
        },
      });

      expect(res2.status).toBe(403);
    });
  });

  describe("Retry-After and cooldown duration calculation", () => {
    it("never shortens configured cooldown when upstream Retry-After is shorter", async () => {
      const scope = "scope-duration-1";
      const configuredMs = 300_000; // 5m

      await handleComboChat({
        body: { messages: [{ role: "user", content: "retry-after test" }] },
        models: ["model-rate-short"],
        comboName: "combo-dur-1",
        cooldownScope: scope,
        memberCooldownMs: configuredMs,
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "30" }, // 30s < 5m
          }),
      });

      const entry = getCooldownEntry(`${scope}::combo-dur-1::model-rate-short`);
      expect(entry).not.toBeNull();
      expect(entry.durationMs).toBe(configuredMs);
    });

    it("never shortens upstream Retry-After when upstream is longer than configured", async () => {
      const scope = "scope-duration-2";
      const configuredMs = 60_000; // 1m

      await handleComboChat({
        body: { messages: [{ role: "user", content: "retry-after test" }] },
        models: ["model-rate-long"],
        comboName: "combo-dur-2",
        cooldownScope: scope,
        memberCooldownMs: configuredMs,
        log,
        handleSingleModel: async () =>
          new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "180" }, // 180s > 1m
          }),
      });

      const entry = getCooldownEntry(`${scope}::combo-dur-2::model-rate-long`);
      expect(entry).not.toBeNull();
      expect(entry.durationMs).toBe(180_000);
    });
  });

  describe("TTL re-entry using fake clock", () => {
    it("skips cooling model until TTL expires, then allows re-entry", async () => {
      vi.useFakeTimers();
      const scope = "scope-ttl";
      const cooldownMs = 60_000;
      let modelCalls = 0;

      const handler = async (_, m) => {
        if (m === "primary") {
          modelCalls++;
          if (modelCalls === 1) {
            return new Response(JSON.stringify({ error: { message: "Temporary failure" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ choices: [{ message: { content: "primary ok" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "backup ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      // Call 1: primary fails 503, backup succeeds
      const res1 = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["primary", "backup"],
        comboName: "combo-ttl",
        cooldownScope: scope,
        memberCooldownMs: cooldownMs,
        log,
        handleSingleModel: handler,
      });
      expect(res1.status).toBe(200);
      expect(modelCalls).toBe(1);
      expect(isComboModelCooling(scope, "combo-ttl", "primary")).toBe(true);

      // Call 2 (at 10s): primary is still cooling, skipped straight to backup
      vi.advanceTimersByTime(10_000);
      const res2 = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi 2" }] },
        models: ["primary", "backup"],
        comboName: "combo-ttl",
        cooldownScope: scope,
        memberCooldownMs: cooldownMs,
        log,
        handleSingleModel: handler,
      });
      expect(res2.status).toBe(200);
      expect(modelCalls).toBe(1); // primary was NOT called!

      // Advance time past TTL (cooldownMs = 60s, advance 55s more -> 65s total)
      vi.advanceTimersByTime(55_000);
      expect(isComboModelCooling(scope, "combo-ttl", "primary")).toBe(false);

      // Call 3: primary re-entered rotation and succeeds!
      const res3 = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi 3" }] },
        models: ["primary", "backup"],
        comboName: "combo-ttl",
        cooldownScope: scope,
        memberCooldownMs: cooldownMs,
        log,
        handleSingleModel: handler,
      });
      expect(res3.status).toBe(200);
      expect(modelCalls).toBe(2); // primary was called and succeeded!
      const data3 = await res3.json();
      expect(data3.choices[0].message.content).toBe("primary ok");
    });
  });

  describe("combo chat threading contracts", () => {
    it("capacity adapter pseudo-combo keeps cooldownScope and memberCooldownMs as null", async () => {
      let passedScope = "initial";
      let passedCooldown = "initial";

      await handleComboChat({
        body: { messages: [{ role: "user", content: "capacity adapter fallback" }] },
        models: ["solo-model", "capacity-vision-fallback"],
        comboName: "solo-model", // capacity adapter pseudo combo named after the solo model
        comboStrategy: "fallback",
        cooldownScope: null,
        memberCooldownMs: null,
        log,
        handleSingleModel: async (b, m) => {
          passedScope = null;
          passedCooldown = null;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(passedScope).toBeNull();
      expect(passedCooldown).toBeNull();
    });

    it("top-level named combo passes configured memberCooldownMs and resolved scope", async () => {
      const scope = "key-user-1";
      const memberCooldownMs = 120_000;
      let recordedScope = null;
      let recordedCooldown = null;

      await handleComboChat({
        body: { messages: [{ role: "user", content: "top level" }] },
        models: ["m1", "m2"],
        comboName: "top-combo",
        comboStrategy: "fallback",
        cooldownScope: scope,
        memberCooldownMs,
        log,
        handleSingleModel: async (b, m) => {
          recordedScope = scope;
          recordedCooldown = memberCooldownMs;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(recordedScope).toBe("key-user-1");
      expect(recordedCooldown).toBe(120_000);
    });
  });

  describe("settings API memberCooldownMs validation", () => {
    it("accepts valid presets (1m, 5m, 1h) and stores them", async () => {
      const res = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "test-valid-preset": { fallbackStrategy: "fallback", memberCooldownMs: "5m" },
            },
          }),
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comboStrategies["test-valid-preset"].memberCooldownMs).toBe("5m");
    });

    it("accepts valid integer milliseconds in range 10s..24h", async () => {
      const res = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "test-valid-ms": { fallbackStrategy: "round-robin", memberCooldownMs: 120_000 },
            },
          }),
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comboStrategies["test-valid-ms"].memberCooldownMs).toBe(120_000);
    });

    it.each([
      9999, // < 10s
      86_400_001, // > 24h
      "invalid-cooldown",
      "10m", // unsupported preset
      -500,
    ])("rejects invalid memberCooldownMs (%s) with status 400", async (invalidVal) => {
      const res = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "test-invalid-cooldown": { memberCooldownMs: invalidVal },
            },
          }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid memberCooldownMs/);
    });

    it("rejects non-object strategy entry with status 400", async () => {
      const res = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "test-invalid-shape": "not-an-object",
            },
          }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid strategy for combo/);
    });
  });

  describe("rename transactionality & strategy synchronization", () => {
    it("moves strategy configuration on combo rename", () => {
      const initial = {
        "old-combo": { fallbackStrategy: "smart", memberCooldownMs: "5m" },
        "other-combo": { fallbackStrategy: "round-robin" },
      };

      const { updated, strategiesChanged } = calculateComboStrategyUpdate(
        initial,
        "old-combo",
        "new-combo",
        undefined
      );

      expect(strategiesChanged).toBe(true);
      expect(updated["old-combo"]).toBeUndefined();
      expect(updated["new-combo"]).toEqual({ fallbackStrategy: "smart", memberCooldownMs: "5m" });
      expect(updated["other-combo"]).toEqual({ fallbackStrategy: "round-robin" });
    });

    it("applies new memberCooldownMs and prunes empty config", () => {
      const initial = {
        "my-combo": { memberCooldownMs: 60_000 },
      };

      // Clearing memberCooldownMs on a combo with no other config prunes the entry
      const { updated, strategiesChanged } = calculateComboStrategyUpdate(
        initial,
        "my-combo",
        "my-combo",
        null
      );

      expect(strategiesChanged).toBe(true);
      expect(updated["my-combo"]).toBeUndefined();
    });

    it("successfully commits rename and settings when both APIs succeed", async () => {
      const calls = [];
      const oldCombo = { id: "combo-1", name: "combo-old", models: ["m1", "m2"] };
      const currentStrategies = { "combo-old": { fallbackStrategy: "fallback", memberCooldownMs: "1m" } };

      const result = await executeComboUpdateTransaction({
        id: "combo-1",
        oldCombo,
        newComboData: { name: "combo-new", models: ["m1", "m2"] },
        memberCooldownMs: "5m",
        comboStrategies: currentStrategies,
        updateComboApi: async (id, data) => {
          calls.push({ op: "updateCombo", id, data });
          return { ok: true };
        },
        persistStrategiesApi: async (updated) => {
          calls.push({ op: "persistStrategies", updated });
        },
      });

      expect(result.ok).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(result.updatedStrategies["combo-new"].memberCooldownMs).toBe("5m");
      expect(result.updatedStrategies["combo-old"]).toBeUndefined();
      expect(calls).toEqual([
        { op: "updateCombo", id: "combo-1", data: { name: "combo-new", models: ["m1", "m2"] } },
        {
          op: "persistStrategies",
          updated: {
            "combo-new": { fallbackStrategy: "fallback", memberCooldownMs: "5m" },
          },
        },
      ]);
    });

    it("does not touch settings if combo DB update fails initially", async () => {
      const calls = [];
      const oldCombo = { id: "combo-2", name: "combo-old", models: ["m1"] };
      const currentStrategies = { "combo-old": { memberCooldownMs: "1m" } };

      const result = await executeComboUpdateTransaction({
        id: "combo-2",
        oldCombo,
        newComboData: { name: "combo-new", models: ["m1"] },
        memberCooldownMs: "1m",
        comboStrategies: currentStrategies,
        updateComboApi: async (id, data) => {
          calls.push({ op: "updateCombo", id, data });
          return { ok: false, error: "Unique constraint violated: combo name already exists" };
        },
        persistStrategiesApi: async (updated) => {
          calls.push({ op: "persistStrategies", updated });
        },
      });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.error).toMatch(/Unique constraint violated/);
      expect(calls.length).toBe(1); // persistStrategies was NOT called
    });

    it("rolls back combo DB rename when settings persist fails", async () => {
      const calls = [];
      const oldCombo = { id: "combo-3", name: "combo-v1", models: ["m1", "m2"] };
      const currentStrategies = { "combo-v1": { fallbackStrategy: "round-robin", memberCooldownMs: "1m" } };

      const result = await executeComboUpdateTransaction({
        id: "combo-3",
        oldCombo,
        newComboData: { name: "combo-v2", models: ["m1", "m2"] },
        memberCooldownMs: "1h",
        comboStrategies: currentStrategies,
        updateComboApi: async (id, data) => {
          calls.push({ op: "updateCombo", id, data });
          return { ok: true };
        },
        persistStrategiesApi: async () => {
          calls.push({ op: "persistStrategies" });
          throw new Error("Disk full: cannot write settings.json");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toMatch(/Disk full: cannot write settings.json/);

      // Verify the sequence:
      // 1. Initial combo update to new name "combo-v2"
      // 2. Settings persist attempt
      // 3. Rollback combo update back to "combo-v1" with old models!
      expect(calls).toEqual([
        { op: "updateCombo", id: "combo-3", data: { name: "combo-v2", models: ["m1", "m2"] } },
        { op: "persistStrategies" },
        { op: "updateCombo", id: "combo-3", data: { name: "combo-v1", models: ["m1", "m2"] } },
      ]);
    });

    it("rolls back created combo via delete when settings persist fails", async () => {
      const calls = [];
      const result = await executeComboCreateTransaction({
        comboData: { name: "new-combo", models: ["m1"] },
        memberCooldownMs: "5m",
        comboStrategies: {},
        createComboApi: async (data) => {
          calls.push({ op: "createCombo", data });
          return { ok: true, data: { id: "created-id-456", ...data } };
        },
        deleteComboApi: async (id) => {
          calls.push({ op: "deleteCombo", id });
          return { ok: true };
        },
        persistStrategiesApi: async () => {
          calls.push({ op: "persistStrategies" });
          throw new Error("Settings write failure");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.rollbackSucceeded).toBe(true);
      expect(calls).toEqual([
        { op: "createCombo", data: { name: "new-combo", models: ["m1"] } },
        { op: "persistStrategies" },
        { op: "deleteCombo", id: "created-id-456" },
      ]);
    });

    it("truthfully reports failure when created combo delete rollback fails", async () => {
      const result = await executeComboCreateTransaction({
        comboData: { name: "new-combo-fail", models: ["m1"] },
        memberCooldownMs: "5m",
        comboStrategies: {},
        createComboApi: async (data) => ({ ok: true, data: { id: "created-id-789", ...data } }),
        deleteComboApi: async () => ({ ok: false, error: "Network timeout" }),
        persistStrategiesApi: async () => { throw new Error("Settings write failure"); },
      });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.rollbackSucceeded).toBe(false);
      expect(result.error).toMatch(/inconsistent partial state/);
    });
  });
});

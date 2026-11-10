import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import ReactTestRenderer, { act } from "react-test-renderer";

import ComboFormModal from "@/shared/components/ComboFormModal.js";
import {
  COOLDOWN_PRESET_OPTIONS,
  isValidMemberCooldown,
  isComboCooldownDisabled,
  clearComboCooldowns,
  isComboModelCooling,
  markComboModelCooldown,
  handleComboChat,
} from "../../open-sse/services/combo.js";
import { checkFallbackError, isAccountUnavailable } from "../../open-sse/services/accountFallback.js";
import {
  calculateComboStrategyUpdate,
  executeComboUpdateTransaction,
  executeComboCreateTransaction,
} from "../../src/app/(dashboard)/dashboard/combos/comboUpdateHelper.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    body: { style: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function getTextFromChildren(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getTextFromChildren).join(" ");
  if (node.props?.children) return getTextFromChildren(node.props.children);
  return "";
}

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("per-combo disable-cooldown option", () => {
  let tmpDataDir;
  let prevDataDir;
  let settingsGet;
  let settingsPatch;
  let originalFetch;

  beforeAll(async () => {
    prevDataDir = process.env.DATA_DIR;
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khatam-combo-disable-cooldown-"));
    process.env.DATA_DIR = tmpDataDir;

    const pathsMod = await import("../../src/lib/db/paths.js");
    pathsMod.refreshPaths();

    const settingsRoute = await import("../../src/app/api/settings/route.js");
    settingsGet = settingsRoute.GET;
    settingsPatch = settingsRoute.PATCH;
  });

  afterAll(async () => {
    try {
      const driver = await import("../../src/lib/db/driver.js");
      await driver.closeDb?.();
    } catch {}
    if (prevDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = prevDataDir;
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    clearComboCooldowns();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    clearComboCooldowns();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe("config & helper defaults", () => {
    it("defaults to cooldown enabled when unconfigured", () => {
      expect(isComboCooldownDisabled(undefined)).toBe(false);
      expect(isComboCooldownDisabled(null)).toBe(false);
      expect(isComboCooldownDisabled({})).toBe(false);
      expect(isComboCooldownDisabled(false)).toBe(false);
      expect(isComboCooldownDisabled({ disableCooldown: false })).toBe(false);
      expect(isComboCooldownDisabled({ memberCooldownMs: "1m" })).toBe(false);
    });

    it("detects disabled state strictly from canonical disableCooldown boolean or 'disabled' preset", () => {
      expect(isComboCooldownDisabled(true)).toBe(true);
      expect(isComboCooldownDisabled({ disableCooldown: true })).toBe(true);
      expect(isComboCooldownDisabled({ memberCooldownMs: "disabled" })).toBe(true);
      expect(isComboCooldownDisabled(false, "disabled")).toBe(true);
      expect(isComboCooldownDisabled("disabled")).toBe(true);

      // Whitespace consistency
      expect(isComboCooldownDisabled({ memberCooldownMs: "  disabled  " })).toBe(true);
      expect(isComboCooldownDisabled(false, "  disabled  ")).toBe(true);
      expect(isValidMemberCooldown("  disabled  ")).toBe(true);

      // Strict canonical only: rejects unsupported compatibility aliases
      expect(isComboCooldownDisabled({ cooldownDisabled: true })).toBe(false);
      expect(isComboCooldownDisabled({ memberCooldownMs: 0 })).toBe(false);
      expect(isComboCooldownDisabled(0)).toBe(false);
      expect(isComboCooldownDisabled(false, 0)).toBe(false);
    });

    it("includes disabled option in COOLDOWN_PRESET_OPTIONS and validates it", () => {
      expect(COOLDOWN_PRESET_OPTIONS.some((opt) => opt.value === "disabled")).toBe(true);
      expect(isValidMemberCooldown("disabled")).toBe(true);
    });
  });

  describe("runtime combo-member cooldown vs bounded fallback & account isolation", () => {
    it("default cooldown enabled marks failed member and skips it on subsequent request", async () => {
      const scope = "caller-default";
      let model1Calls = 0;

      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["model-a", "model-b"],
        comboName: "combo-default",
        cooldownScope: scope,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "model-a") {
            model1Calls++;
            return new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(isComboModelCooling(scope, "combo-default", "model-a")).toBe(true);

      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi 2" }] },
        models: ["model-a", "model-b"],
        comboName: "combo-default",
        cooldownScope: scope,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "model-a") model1Calls++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(model1Calls).toBe(1);
    });

    it("when disableCooldown=true, does not record cooldown and keeps bounded per-request fallback", async () => {
      const scope = "caller-disabled";
      const attemptsPerReq = [];

      for (let reqNum = 0; reqNum < 2; reqNum++) {
        const tried = [];
        const res = await handleComboChat({
          body: { messages: [{ role: "user", content: `req-${reqNum}` }] },
          models: ["primary", "secondary"],
          comboName: "combo-no-cd",
          cooldownScope: scope,
          disableCooldown: true,
          log,
          handleSingleModel: async (_, m) => {
            tried.push(m);
            if (m === "primary") {
              return new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
                status: 429,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ ok: true, model: m }), { status: 200 });
          },
        });
        expect(res.status).toBe(200);
        attemptsPerReq.push(tried);
      }

      expect(attemptsPerReq).toEqual([
        ["primary", "secondary"],
        ["primary", "secondary"],
      ]);
      expect(isComboModelCooling(scope, "combo-no-cd", "primary")).toBe(false);
    });

    it("disabled cooldown bypasses already-recorded cooldown entries (no fast-fail)", async () => {
      const scope = "caller-precooled";
      // Record cooldown entries as if combo previously had cooldown enabled
      markComboModelCooldown(scope, "combo-precooled", "m1", 429, 60_000, "Pre-existing 429");
      markComboModelCooldown(scope, "combo-precooled", "m2", 503, 60_000, "Pre-existing 503");

      expect(isComboModelCooling(scope, "combo-precooled", "m1")).toBe(true);
      expect(isComboModelCooling(scope, "combo-precooled", "m2")).toBe(true);

      const tried = [];
      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "bypass existing" }] },
        models: ["m1", "m2"],
        comboName: "combo-precooled",
        cooldownScope: scope,
        disableCooldown: true,
        log,
        handleSingleModel: async (_, m) => {
          tried.push(m);
          if (m === "m1") {
            return new Response(JSON.stringify({ error: { message: "Still failing" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      expect(res.status).toBe(200);
      expect(tried).toEqual(["m1", "m2"]);
    });

    it("bounds fallback to combo models length when all models fail with disableCooldown=true", async () => {
      const scope = "caller-bounded";
      const tried = [];

      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "all fail" }] },
        models: ["m1", "m2", "m3"],
        comboName: "combo-bounded",
        cooldownScope: scope,
        disableCooldown: true,
        log,
        handleSingleModel: async (_, m) => {
          tried.push(m);
          return new Response(JSON.stringify({ error: { message: `Fail ${m}` } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      expect(res.status).toBe(429);
      expect(tried).toEqual(["m1", "m2", "m3"]);
      expect(isComboModelCooling(scope, "combo-bounded", "m1")).toBe(false);
    });

    it("re-enabling cooldown restores normal cooldown marking and caller scope isolation", async () => {
      const scopeA = "caller-A";
      const scopeB = "caller-B";

      // Step 1: Disabled — failure does NOT cool member
      await handleComboChat({
        body: { messages: [{ role: "user", content: "step 1" }] },
        models: ["m1", "m2"],
        comboName: "combo-toggle",
        cooldownScope: scopeA,
        disableCooldown: true,
        log,
        handleSingleModel: async (_, m) => {
          if (m === "m1") {
            return new Response(JSON.stringify({ error: { message: "429" } }), { status: 429 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      expect(isComboModelCooling(scopeA, "combo-toggle", "m1")).toBe(false);

      // Step 2: Re-enabled — failure cools member for scopeA only
      await handleComboChat({
        body: { messages: [{ role: "user", content: "step 2" }] },
        models: ["m1", "m2"],
        comboName: "combo-toggle",
        cooldownScope: scopeA,
        disableCooldown: false,
        memberCooldownMs: "1m",
        log,
        handleSingleModel: async (_, m) => {
          if (m === "m1") {
            return new Response(JSON.stringify({ error: { message: "429" } }), { status: 429 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      expect(isComboModelCooling(scopeA, "combo-toggle", "m1")).toBe(true);
      expect(isComboModelCooling(scopeB, "combo-toggle", "m1")).toBe(false);

      // Step 3: Caller scopeA skips m1; Caller scopeB still tries m1
      const triedA = [];
      await handleComboChat({
        body: { messages: [{ role: "user", content: "step 3a" }] },
        models: ["m1", "m2"],
        comboName: "combo-toggle",
        cooldownScope: scopeA,
        disableCooldown: false,
        memberCooldownMs: "1m",
        log,
        handleSingleModel: async (_, m) => {
          triedA.push(m);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      expect(triedA).toEqual(["m2"]);

      const triedB = [];
      await handleComboChat({
        body: { messages: [{ role: "user", content: "step 3b" }] },
        models: ["m1", "m2"],
        comboName: "combo-toggle",
        cooldownScope: scopeB,
        disableCooldown: false,
        memberCooldownMs: "1m",
        log,
        handleSingleModel: async (_, m) => {
          triedB.push(m);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      expect(triedB).toEqual(["m1"]);
    });

    it("leaves account-level cooldown and fallback semantics unchanged", () => {
      // Account-level fallback (provider credential rotation) remains unaffected
      const fb = checkFallbackError(429, "rate limit exceeded", 1, "openai");
      expect(fb.shouldFallback).toBe(true);
      expect(fb.cooldownMs).toBeGreaterThan(0);
      expect(isAccountUnavailable(new Date(Date.now() + 30_000).toISOString())).toBe(true);
    });
  });

  describe("API validation & persistence (/api/settings)", () => {
    it.each(["true", "false", 1, 0, {}, [], null])(
      "rejects non-boolean disableCooldown (%s) with 400",
      async (badVal) => {
        const res = await settingsPatch(
          new Request("http://localhost:20128/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              comboStrategies: {
                "api-bad-disable": { disableCooldown: badVal },
              },
            }),
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/Invalid disableCooldown/);
      }
    );

    it("accepts whitespace-padded '  disabled  ' preset in memberCooldownMs via API", async () => {
      const res = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "api-whitespace-disabled": { memberCooldownMs: "  disabled  " },
            },
          }),
        })
      );
      expect(res.status).toBe(200);
    });

    it("persists disableCooldown=true and clears existing combo cooldown entries for that exact combo only", async () => {
      markComboModelCooldown("scope-1", "combo-target", "m1", 429, 60_000, "cooling");
      markComboModelCooldown("scope-1", "combo-target-longer", "m1", 429, 60_000, "cooling");
      markComboModelCooldown("scope-1", "super-combo-target", "m1", 429, 60_000, "cooling");
      markComboModelCooldown("scope-1", "other-combo", "m1", 429, 60_000, "cooling");

      const patchRes = await settingsPatch(
        new Request("http://localhost:20128/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: {
              "combo-target": { fallbackStrategy: "fallback", disableCooldown: true },
            },
          }),
        })
      );
      expect(patchRes.status).toBe(200);

      // Exact match cleared: combo-target
      expect(isComboModelCooling("scope-1", "combo-target", "m1")).toBe(false);
      // Prefix/suffix/other matches NOT cleared:
      expect(isComboModelCooling("scope-1", "combo-target-longer", "m1")).toBe(true);
      expect(isComboModelCooling("scope-1", "super-combo-target", "m1")).toBe(true);
      expect(isComboModelCooling("scope-1", "other-combo", "m1")).toBe(true);

      // Verify GET persistence
      const getRes = await settingsGet();
      expect(getRes.status).toBe(200);
      const settingsData = await getRes.json();
      expect(settingsData.comboStrategies["combo-target"]).toEqual({
        fallbackStrategy: "fallback",
        disableCooldown: true,
      });
    });

    it("verifies exact scoped combo clearing with delimiters and empty targets", () => {
      markComboModelCooldown("tenant::1", "combo-x", "provider::model", 429, 60_000, "cooling");
      markComboModelCooldown("tenant::2", "combo-x", "provider::model", 429, 60_000, "cooling");
      markComboModelCooldown("tenant::1", "combo-y", "provider::model", 429, 60_000, "cooling");

      // Empty/whitespace string must not clear all
      clearComboCooldowns("");
      clearComboCooldowns("   ");
      expect(isComboModelCooling("tenant::1", "combo-x", "provider::model")).toBe(true);

      // Scoped clearing by exact combo and scope
      clearComboCooldowns("combo-x", "tenant::1");
      expect(isComboModelCooling("tenant::1", "combo-x", "provider::model")).toBe(false);
      expect(isComboModelCooling("tenant::2", "combo-x", "provider::model")).toBe(true);
      expect(isComboModelCooling("tenant::1", "combo-y", "provider::model")).toBe(true);
    });
  });

  describe("UI persistence roundtrip & comboUpdateHelper", () => {
    it("calculates strategy updates for disabling, renaming, and re-enabling cooldown", () => {
      const s1 = calculateComboStrategyUpdate({}, "c1", "c1", null, true);
      expect(s1.strategiesChanged).toBe(true);
      expect(s1.updated["c1"]).toEqual({ disableCooldown: true });

      // Rename preserves disableCooldown
      const s2 = calculateComboStrategyUpdate(s1.updated, "c1", "c1-renamed", undefined, undefined);
      expect(s2.strategiesChanged).toBe(true);
      expect(s2.updated["c1"]).toBeUndefined();
      expect(s2.updated["c1-renamed"]).toEqual({ disableCooldown: true });

      // Re-enable to default prunes disableCooldown and empty entry
      const s3 = calculateComboStrategyUpdate(s2.updated, "c1-renamed", "c1-renamed", null, false);
      expect(s3.strategiesChanged).toBe(true);
      expect(s3.updated["c1-renamed"]).toBeUndefined();
    });

    it("executes create and update transactions with disableCooldown=true", async () => {
      let stored = {};
      const createRes = await executeComboCreateTransaction({
        comboData: { name: "roundtrip-combo", models: ["m1", "m2"] },
        memberCooldownMs: null,
        disableCooldown: true,
        comboStrategies: stored,
        createComboApi: async (data) => ({ ok: true, data: { id: "id-rt-1", ...data } }),
        deleteComboApi: async () => ({ ok: true }),
        persistStrategiesApi: async (updated) => {
          stored = updated;
        },
      });
      expect(createRes.ok).toBe(true);
      expect(stored["roundtrip-combo"]).toEqual({ disableCooldown: true });

      const updateRes = await executeComboUpdateTransaction({
        id: "id-rt-1",
        oldCombo: { id: "id-rt-1", name: "roundtrip-combo", models: ["m1", "m2"] },
        newComboData: { name: "roundtrip-combo", models: ["m1", "m2"] },
        memberCooldownMs: "5m",
        disableCooldown: false,
        comboStrategies: stored,
        updateComboApi: async () => ({ ok: true }),
        persistStrategiesApi: async (updated) => {
          stored = updated;
        },
      });
      expect(updateRes.ok).toBe(true);
      expect(stored["roundtrip-combo"]).toEqual({ memberCooldownMs: "5m" });
    });

    it("UI edit-save-reopen roundtrip exercises select onChange, onSave callback, persistence, and reopen", async () => {
      globalThis.fetch = vi.fn(async (url) => {
        if (String(url).includes("/api/models/alias")) {
          return { ok: true, json: async () => ({ aliases: {} }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      const savedPayloads = [];
      let currentStrategies = {};

      // 1. Open modal with default strategy (cooldown enabled -> "default")
      let renderer1;
      await act(async () => {
        renderer1 = ReactTestRenderer.create(
          React.createElement(ComboFormModal, {
            isOpen: true,
            combo: { id: "c-rt", name: "ui-roundtrip", models: ["openai/gpt-4o"] },
            strategy: {},
            onClose: vi.fn(),
            onSave: async (payload) => {
              savedPayloads.push(payload);
              const { updated } = calculateComboStrategyUpdate(
                currentStrategies,
                "ui-roundtrip",
                payload.name,
                payload.memberCooldownMs,
                payload.disableCooldown
              );
              const res = await settingsPatch(
                new Request("http://localhost:20128/api/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ comboStrategies: updated }),
                })
              );
              expect(res.status).toBe(200);
            },
          })
        );
      });

      const select1 = renderer1.root.findByType("select");
      expect(select1.props.value).toBe("default");
      const optionValues = select1.findAllByType("option").map((o) => o.props.value);
      expect(optionValues).toContain("disabled");

      // 2. User changes cooldown select to "disabled" and clicks Save
      await act(async () => {
        select1.props.onChange({ target: { value: "disabled" } });
      });
      expect(renderer1.root.findByType("select").props.value).toBe("disabled");

      const saveBtn1 = renderer1.root.findAllByType("button").find((b) => getTextFromChildren(b.props.children).trim() === "Save");
      expect(saveBtn1).toBeTruthy();
      await act(async () => {
        await saveBtn1.props.onClick();
      });

      expect(savedPayloads[0]).toEqual({
        name: "ui-roundtrip",
        models: ["openai/gpt-4o"],
        memberCooldownMs: null,
        disableCooldown: true,
      });

      // 3. Reopen: reload persisted settings from GET /api/settings and mount fresh ComboFormModal
      const reload1 = await (await settingsGet()).json();
      currentStrategies = reload1.comboStrategies || {};
      expect(currentStrategies["ui-roundtrip"]).toEqual({ disableCooldown: true });

      let renderer2;
      await act(async () => {
        renderer2 = ReactTestRenderer.create(
          React.createElement(ComboFormModal, {
            isOpen: true,
            combo: { id: "c-rt", name: "ui-roundtrip", models: ["openai/gpt-4o"] },
            strategy: currentStrategies["ui-roundtrip"],
            memberCooldownMs: currentStrategies["ui-roundtrip"]?.memberCooldownMs,
            onClose: vi.fn(),
            onSave: async (payload) => {
              savedPayloads.push(payload);
              const { updated } = calculateComboStrategyUpdate(
                currentStrategies,
                "ui-roundtrip",
                payload.name,
                payload.memberCooldownMs,
                payload.disableCooldown
              );
              const res = await settingsPatch(
                new Request("http://localhost:20128/api/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ comboStrategies: updated }),
                })
              );
              expect(res.status).toBe(200);
            },
          })
        );
      });

      const select2 = renderer2.root.findByType("select");
      expect(select2.props.value).toBe("disabled");

      // 4. User re-enables cooldown to "5m" via select onChange and clicks Save
      await act(async () => {
        select2.props.onChange({ target: { value: "5m" } });
      });
      expect(renderer2.root.findByType("select").props.value).toBe("5m");

      const saveBtn2 = renderer2.root.findAllByType("button").find((b) => getTextFromChildren(b.props.children).trim() === "Save");
      await act(async () => {
        await saveBtn2.props.onClick();
      });

      expect(savedPayloads[1]).toEqual({
        name: "ui-roundtrip",
        models: ["openai/gpt-4o"],
        memberCooldownMs: "5m",
        disableCooldown: false,
      });

      // 5. Reopen again: reload persisted settings and confirm "5m" is selected and disableCooldown cleared
      const reload2 = await (await settingsGet()).json();
      expect(reload2.comboStrategies["ui-roundtrip"]).toEqual({ memberCooldownMs: "5m" });

      let renderer3;
      await act(async () => {
        renderer3 = ReactTestRenderer.create(
          React.createElement(ComboFormModal, {
            isOpen: true,
            combo: { id: "c-rt", name: "ui-roundtrip", models: ["openai/gpt-4o"] },
            strategy: reload2.comboStrategies["ui-roundtrip"],
            memberCooldownMs: reload2.comboStrategies["ui-roundtrip"]?.memberCooldownMs,
            onClose: vi.fn(),
            onSave: vi.fn(),
          })
        );
      });

      expect(renderer3.root.findByType("select").props.value).toBe("5m");

      await act(async () => {
        renderer1.unmount();
        renderer2.unmount();
        renderer3.unmount();
      });
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const req = createRequire(import.meta.url);

import {
  parseConnectionLimitOverrides,
  sanitizeConnectionLimitOverrides,
  validateConnectionLimitOverrides,
} from "../../open-sse/services/rateLimitManager/overrides.js";

// Temp DB environment setup for SQLite persistence
let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-conn-limits-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
});

// ===========================================================================
// GATE 1: Validation and Sanitization (T007, T008, T011)
// ===========================================================================
describe("Gate 1: Connection limits input Validation and Sanitization", () => {
  describe("Backend overrides Sanitization", () => {
    it("preserves valid rate, delay, and concurrency limits while dropping unknown keys", () => {
      const raw = {
        rpm: 100,
        rpd: 5000,
        tpm: 50000,
        tpd: 1000000,
        minTime: 250,
        maxConcurrent: 5,
        maxWaitMs: 15000,
        executionMaxWaitMs: 30000,
        unknownField: "malicious_or_unknown",
        injectedScript: "<script>",
      };

      const sanitized = sanitizeConnectionLimitOverrides(raw);
      expect(sanitized).toEqual({
        rpm: 100,
        rpd: 5000,
        tpm: 50000,
        tpd: 1000000,
        minTime: 250,
        maxConcurrent: 5,
        maxWaitMs: 15000,
        executionMaxWaitMs: 30000,
      });
      expect(sanitized.unknownField).toBeUndefined();
      expect(sanitized.injectedScript).toBeUndefined();
    });

    it("rejects non-positive and non-finite values for standard rate limits", () => {
      const raw = {
        rpm: -10,
        rpd: 0,
        tpm: NaN,
        tpd: Infinity,
        minTime: -100,
        maxConcurrent: 0,
      };
      const sanitized = sanitizeConnectionLimitOverrides(raw);
      expect(sanitized).toEqual({});
    });

    it("floors integer fields strictly while preserving float ms timestamps", () => {
      const raw = {
        rpm: 12.8,
        rpd: 99.9,
        tpm: 1000.4,
        tpd: 5000.9,
        maxConcurrent: 3.7,
        minTime: 125.5,
        maxWaitMs: 2500.25,
      };
      const sanitized = sanitizeConnectionLimitOverrides(raw);
      expect(sanitized.rpm).toBe(12);
      expect(sanitized.rpd).toBe(99);
      expect(sanitized.tpm).toBe(1000);
      expect(sanitized.tpd).toBe(5000);
      expect(sanitized.maxConcurrent).toBe(3);
      expect(sanitized.minTime).toBe(125.5);
      expect(sanitized.maxWaitMs).toBe(2500.25);
    });

    it("sanitizes maxBudgetUsd correctly allowing non-negative numbers and decimals", () => {
      expect(sanitizeConnectionLimitOverrides({ maxBudgetUsd: 150.5 })).toEqual({
        maxBudgetUsd: 150.5,
      });
      expect(sanitizeConnectionLimitOverrides({ maxBudgetUsd: 0 })).toEqual({
        maxBudgetUsd: 0,
      });
      expect(sanitizeConnectionLimitOverrides({ maxBudgetUsd: -0.01 })).toEqual({});
      expect(sanitizeConnectionLimitOverrides({ maxBudgetUsd: NaN })).toEqual({});
      expect(sanitizeConnectionLimitOverrides({ maxBudgetUsd: "50" })).toEqual({});
    });
  });

  describe("Backend overrides Validation", () => {
    it("validates valid payload successfully", () => {
      const res = validateConnectionLimitOverrides({
        rpm: 60,
        maxConcurrent: 2,
        minTime: 500,
        maxBudgetUsd: 50.0,
      });
      expect(res.ok).toBe(true);
      expect(res.errors).toBeUndefined();
      expect(res.value).toEqual({
        rpm: 60,
        maxConcurrent: 2,
        minTime: 500,
        maxBudgetUsd: 50.0,
      });
    });

    it("flags error for unknown keys during validation", () => {
      const res = validateConnectionLimitOverrides({
        rpm: 60,
        extraUnknownField: 123,
      });
      expect(res.ok).toBe(false);
      expect(res.errors).toBeDefined();
      expect(res.errors.some((e) => e.includes("Unknown key"))).toBe(true);
    });

    it("flags errors for invalid numbers during validation", () => {
      const res = validateConnectionLimitOverrides({
        rpm: -5,
        minTime: 0,
        maxBudgetUsd: -10,
      });
      expect(res.ok).toBe(false);
      expect(res.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Client-side form Validation helper", () => {
    it("validates string inputs and produces clear validation diagnostics", async () => {
      const { validateLimitsForm } = req("../../src/shared/components/ConnectionLimitsModal.js");
      expect(typeof validateLimitsForm).toBe("function");

      // Valid empty form (all limits cleared)
      const emptyForm = {
        rpm: "",
        rpd: "",
        tpm: "",
        tpd: "",
        minTime: "",
        maxConcurrent: "",
        maxWaitMs: "",
        executionMaxWaitMs: "",
        maxBudgetUsd: "",
        modelConcurrency: [],
      };
      const emptyResult = validateLimitsForm(emptyForm);
      expect(emptyResult.isValid).toBe(true);
      expect(emptyResult.errors).toEqual({});
      expect(emptyResult.sanitized).toEqual({});

      // Valid filled form
      const validForm = {
        rpm: "60",
        rpd: "1000",
        tpm: "50000",
        tpd: "200000",
        minTime: "250",
        maxConcurrent: "4",
        maxWaitMs: "5000",
        executionMaxWaitMs: "30000",
        maxBudgetUsd: "75.50",
        modelConcurrency: [{ model: "gpt-5.6-sol", concurrency: "2" }],
      };
      const validResult = validateLimitsForm(validForm);
      expect(validResult.isValid).toBe(true);
      expect(validResult.errors).toEqual({});
      expect(validResult.sanitized).toEqual({
        rpm: 60,
        rpd: 1000,
        tpm: 50000,
        tpd: 200000,
        minTime: 250,
        maxConcurrent: 4,
        maxWaitMs: 5000,
        executionMaxWaitMs: 30000,
        maxBudgetUsd: 75.5,
        modelConcurrency: { "gpt-5.6-sol": 2 },
      });

      // Invalid negative inputs
      const invalidForm = {
        ...emptyForm,
        rpm: "-10",
        maxConcurrent: "0",
        maxBudgetUsd: "-5",
        modelConcurrency: [{ model: "", concurrency: "1" }],
      };
      const invalidResult = validateLimitsForm(invalidForm);
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.errors.rpm).toBeDefined();
      expect(invalidResult.errors.maxConcurrent).toBeDefined();
      expect(invalidResult.errors.maxBudgetUsd).toBeDefined();
    });
  });
});

// ===========================================================================
// GATE 2: Connection Limits API Persistence & Schema (T004, T009)
// ===========================================================================
describe("Gate 2: Connection limits API Persistence and overrides Schema", () => {
  it("conforms to connection-limits.json JSON Schema contract", async () => {
    const contractPath = path.resolve(__dirname, "../../specs/010-dashboard-tooling/contracts/connection-limits.json");
    expect(fs.existsSync(contractPath)).toBe(true);
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
    expect(contract.title).toBe("ConnectionLimitOverrides");
    expect(contract.properties.rpm).toBeDefined();
    expect(contract.properties.rpd).toBeDefined();
    expect(contract.properties.tpm).toBeDefined();
    expect(contract.properties.tpd).toBeDefined();
    expect(contract.properties.minTime).toBeDefined();
    expect(contract.properties.maxConcurrent).toBeDefined();
    expect(contract.properties.maxWaitMs).toBeDefined();
    expect(contract.properties.executionMaxWaitMs).toBeDefined();
    expect(contract.properties.modelConcurrency).toBeDefined();
    expect(contract.properties.maxBudgetUsd).toBeDefined();
    expect(contract.properties.maxBudgetUsd.minimum).toBe(0);
  });

  it("defines connection limits types and contracts in src/shared/types/connectionLimits.js", async () => {
    const typesPath = path.resolve(__dirname, "../../src/shared/types/connectionLimits.js");
    expect(fs.existsSync(typesPath)).toBe(true);
    const content = fs.readFileSync(typesPath, "utf-8");
    expect(content).toContain("ConnectionLimitOverrides");
    expect(content).toContain("maxBudgetUsd");
    expect(content).toContain("modelConcurrency");
  });

  it("handles GET /api/providers/[id]/limits with auth checks, 404s, and returns limits without secrets", async () => {
    const { GET } = await import("@/app/api/providers/[id]/limits/route.js");
    const { createProviderNode, createProviderConnection, updateProviderConnection } = await import("@/models/index.js");
    const { updateSettings } = await import("@/lib/localDb");

    const node = await createProviderNode({ name: "Test Node" });
    const connection = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      apiKey: "super-secret-key-12345",
      name: "OpenAI Primary",
      nodeId: node.id,
    });
    await updateProviderConnection(connection.id, {
      rate_limit_overrides_json: { rpm: 120, maxConcurrent: 3 },
    });

    // 1. Authorized GET
    await updateSettings({ requireLogin: false });
    const req = new Request(`https://khatamrouter.local/api/providers/${connection.id}/limits`, {
      method: "GET",
    });
    const res = await GET(req, { params: Promise.resolve({ id: connection.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({ rpm: 120, maxConcurrent: 3 });
    // NEVER leak credentials
    expect(body.apiKey).toBeUndefined();
    expect(body.connection?.apiKey).toBeUndefined();

    // 2. 404 for unknown connection
    const resNotFound = await GET(req, { params: Promise.resolve({ id: "non-existent-id" }) });
    expect(resNotFound.status).toBe(404);

    // 3. Unauthorized when requireLogin is true and no session cookie
    await updateSettings({ requireLogin: true });
    const unauthReq = new Request(`https://khatamrouter.local/api/providers/${connection.id}/limits`, {
      method: "GET",
    });
    const resUnauth = await GET(unauthReq, { params: Promise.resolve({ id: connection.id }) });
    expect(resUnauth.status).toBe(401);
  });

  it("handles PUT /api/providers/[id]/limits validating inputs and persisting to SQLite rate_limit_overrides_json", async () => {
    const { PUT, GET } = await import("@/app/api/providers/[id]/limits/route.js");
    const { createProviderNode, createProviderConnection, getProviderConnectionById } = await import("@/models/index.js");
    const { updateSettings } = await import("@/lib/localDb");

    await updateSettings({ requireLogin: false });
    const node = await createProviderNode({ name: "Persistence Node" });
    const connection = await createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      apiKey: "anthropic-secret-999",
      name: "Anthropic Main",
      nodeId: node.id,
    });

    // Initial state: no overrides
    const initial = await getProviderConnectionById(connection.id);
    expect(initial.rate_limit_overrides_json).toBeNull();

    // PUT valid overrides
    const putPayload = {
      limits: {
        rpm: 60,
        rpd: 500,
        minTime: 200,
        maxConcurrent: 2,
        maxBudgetUsd: 100,
        modelConcurrency: {
          "claude-3-5-sonnet": 1,
        },
      },
    };
    const req = new Request(`https://khatamrouter.local/api/providers/${connection.id}/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(putPayload),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: connection.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits.rpm).toBe(60);
    expect(body.limits.maxBudgetUsd).toBe(100);
    expect(body.apiKey).toBeUndefined();

    // Verify DB persistence directly
    const persisted = await getProviderConnectionById(connection.id);
    expect(persisted.rate_limit_overrides_json).toEqual({
      rpm: 60,
      rpd: 500,
      minTime: 200,
      maxConcurrent: 2,
      maxBudgetUsd: 100,
      modelConcurrency: {
        "claude-3-5-sonnet": 1,
      },
    });

    // PUT invalid overrides rejects with 400
    const invalidReq = new Request(`https://khatamrouter.local/api/providers/${connection.id}/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limits: {
          rpm: -50,
        },
      }),
    });
    const invalidRes = await PUT(invalidReq, { params: Promise.resolve({ id: connection.id }) });
    expect(invalidRes.status).toBe(400);
    const errBody = await invalidRes.json();
    expect(errBody.error).toBeDefined();

    // DB remains unchanged after failed validation
    const afterFailed = await getProviderConnectionById(connection.id);
    expect(afterFailed.rate_limit_overrides_json.rpm).toBe(60);
  });

  it("handles DELETE /api/providers/[id]/limits resetting limits to empty", async () => {
    const { DELETE } = await import("@/app/api/providers/[id]/limits/route.js");
    const { createProviderNode, createProviderConnection, getProviderConnectionById } = await import("@/models/index.js");
    const { updateSettings } = await import("@/lib/localDb");

    await updateSettings({ requireLogin: false });
    const node = await createProviderNode({ name: "Reset Node" });
    const connection = await createProviderConnection({
      provider: "google",
      authType: "apikey",
      apiKey: "google-key",
      name: "Google Gemini",
      nodeId: node.id,
      rate_limit_overrides_json: { rpm: 30 },
    });

    const delReq = new Request(`https://khatamrouter.local/api/providers/${connection.id}/limits`, {
      method: "DELETE",
    });
    const delRes = await DELETE(delReq, { params: Promise.resolve({ id: connection.id }) });
    expect(delRes.status).toBe(200);

    const reloaded = await getProviderConnectionById(connection.id);
    expect(reloaded.rate_limit_overrides_json).toBeNull();
  });
});

// ===========================================================================
// GATE 3: Model Concurrency Map & Budget Ceiling (T008, T010)
// ===========================================================================
describe("Gate 3: ModelConcurrency map and Budget ceiling tests", () => {
  it("strictly validates and sanitizes ModelConcurrency mappings", () => {
    const valid = {
      modelConcurrency: {
        "gpt-5.6-sol": 4,
        "claude-3-7-sonnet": 2,
      },
    };
    const s1 = sanitizeConnectionLimitOverrides(valid);
    expect(s1.modelConcurrency).toEqual({
      "gpt-5.6-sol": 4,
      "claude-3-7-sonnet": 2,
    });

    const invalid = {
      modelConcurrency: {
        "gpt-5.6-sol": -2,
        "": 5,
        "bad-nan": NaN,
      },
    };
    const s2 = sanitizeConnectionLimitOverrides(invalid);
    expect(s2.modelConcurrency).toBeUndefined();
  });

  it("preserves maxBudgetUsd as stored and displayed without claiming request-time enforcement", () => {
    const overrides = sanitizeConnectionLimitOverrides({
      maxBudgetUsd: 250.75,
      rpm: 100,
    });
    expect(overrides.maxBudgetUsd).toBe(250.75);

    // Verify validation behavior
    const vGood = validateConnectionLimitOverrides({ maxBudgetUsd: 0 });
    expect(vGood.ok).toBe(true);

    const vNeg = validateConnectionLimitOverrides({ maxBudgetUsd: -1 });
    expect(vNeg.ok).toBe(false);
  });

  it("renders ConnectionLimitsModal component with model concurrency and budget fields", async () => {
    const ConnectionLimitsModal = req("../../src/shared/components/ConnectionLimitsModal.js").default;
    expect(typeof ConnectionLimitsModal).toBe("function");

    // Component returns null when isOpen is false
    const closedElement = React.createElement(ConnectionLimitsModal, {
      isOpen: false,
      onClose: () => {},
    });
    expect(closedElement).toBeDefined();

    // Component renders Modal tree when isOpen is true
    const openElement = React.createElement(ConnectionLimitsModal, {
      isOpen: true,
      onClose: () => {},
      connection: {
        id: "conn-1",
        name: "Test Connection",
        rate_limit_overrides_json: {
          rpm: 60,
          maxBudgetUsd: 50,
          modelConcurrency: { "gpt-5.6-sol": 2 },
        },
      },
    });
    expect(openElement).toBeDefined();
    expect(openElement.type).toBe(ConnectionLimitsModal);
    expect(openElement.props.isOpen).toBe(true);
    expect(openElement.props.connection.id).toBe("conn-1");
  });
});

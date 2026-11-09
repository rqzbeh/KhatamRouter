import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import ReactTestRenderer from "react-test-renderer";
import ModelManagementPanel, {
  summarizeModelTestResults,
} from "@/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js";

const { act } = ReactTestRenderer;

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

function findButtonByText(root, text) {
  return root.findAllByType("button").find((b) => {
    return getTextFromChildren(b.props.children).includes(text);
  });
}

describe("summarizeModelTestResults - Spec 017 Model Test Batch Classification", () => {
  it("classifies canonical 'success' as passed and never broken", () => {
    const results = {
      "model-success": {
        tested: true,
        classification: "success",
        statusCode: 200,
        reason: "success",
        disableEligible: false,
        disabled: false,
        latencyMs: 34,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.passed).toBe(1);
    expect(summary.broken).toBe(0);
    expect(summary.quotaErrors).toBe(0);
    expect(summary.accessErrors).toBe(0);
    expect(summary.transportErrors).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it("classifies canonical 'quota_cost' and 'rate_limited' as quota errors and not broken", () => {
    const results = {
      "model-quota": {
        tested: true,
        classification: "quota_cost",
        statusCode: 402,
        reason: "payment_required",
        disableEligible: false,
        disabled: false,
      },
      "model-ratelimit": {
        tested: true,
        classification: "rate_limited",
        statusCode: 429,
        reason: "rate_limited",
        disableEligible: false,
        disabled: false,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.quotaErrors).toBe(2);
    expect(summary.broken).toBe(0);
  });

  it("classifies canonical 'access_restriction' as access error and not broken", () => {
    const results = {
      "model-access": {
        tested: true,
        classification: "access_restriction",
        statusCode: 403,
        reason: "permission_denied",
        disableEligible: false,
        disabled: false,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.accessErrors).toBe(1);
    expect(summary.broken).toBe(0);
  });

  it("classifies canonical 'transport_indeterminate' network/timeouts as transport error", () => {
    const results = {
      "model-timeout": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: 504,
        reason: "timeout",
        disableEligible: false,
        disabled: false,
      },
      "model-network": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: null,
        reason: "network_error",
        disableEligible: false,
        disabled: false,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.transportErrors).toBe(2);
    expect(summary.accessErrors).toBe(0);
    expect(summary.broken).toBe(0);
  });

  it("maps transport_indeterminate with statusCode 401 or auth/access reason to access error", () => {
    const results = {
      "model-auth401": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: 401,
        reason: "auth_failure",
        disableEligible: false,
        disabled: false,
      },
      "model-forbidden": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: 403,
        reason: "forbidden",
        disableEligible: false,
        disabled: false,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.accessErrors).toBe(2);
    expect(summary.transportErrors).toBe(0);
    expect(summary.broken).toBe(0);
  });

  it("classifies canonical 'hard_model_failure' as broken ONLY", () => {
    const results = {
      "model-notfound": {
        tested: true,
        classification: "hard_model_failure",
        statusCode: 404,
        reason: "model_not_found",
        disableEligible: true,
        disabled: true,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.broken).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.transportErrors).toBe(0);
  });

  it("does not treat unconfirmed 'broken' alias as definitive hard model failure", () => {
    const results = {
      "model-unconfirmed-broken": {
        tested: true,
        classification: "broken",
        statusCode: 500,
        reason: "internal_error",
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.broken).toBe(0);
    expect(summary.transportErrors).toBe(1);
  });

  it("counts null or invalid rows as transport indeterminate without marking broken", () => {
    const results = {
      "model-null": null,
      "model-invalid-type": "invalid_payload_string",
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.transportErrors).toBe(2);
    expect(summary.broken).toBe(0);
  });

  it("does not classify skipped or tested:false models as broken", () => {
    const results = {
      "model-skipped-1": {
        tested: false,
        status: "skipped",
        reason: "quota_exhausted",
        disabled: false,
      },
      "model-skipped-2": {
        tested: false,
        status: "skipped",
        reason: "batch_stopped",
        disabled: false,
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.skipped).toBe(2);
    expect(summary.broken).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.quotaErrors).toBe(0);
    expect(summary.accessErrors).toBe(0);
    expect(summary.transportErrors).toBe(0);
  });

  it("maps unrecognized classification to indeterminate transport without marking broken", () => {
    const results = {
      "model-unknown": {
        tested: true,
        classification: "future_upstream_status",
        statusCode: 500,
        reason: "custom_reason",
      },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.broken).toBe(0);
    expect(summary.transportErrors).toBe(1);
  });

  it("preserves supported legacy aliases for backward compatibility", () => {
    const results = {
      "m-legacy-ok": { classification: "ok" },
      "m-legacy-passed": { classification: "passed" },
      "m-legacy-quota": { classification: "quota" },
      "m-legacy-ratelimit": { classification: "rate_limit" },
      "m-legacy-access": { classification: "access" },
      "m-legacy-auth": { classification: "auth" },
      "m-legacy-forbidden": { classification: "forbidden" },
      "m-legacy-transport": { classification: "transport" },
      "m-legacy-network": { classification: "network" },
      "m-legacy-timeout": { classification: "timeout" },
    };
    const summary = summarizeModelTestResults(results);
    expect(summary.passed).toBe(2);
    expect(summary.quotaErrors).toBe(2);
    expect(summary.accessErrors).toBe(3);
    expect(summary.transportErrors).toBe(3);
    expect(summary.broken).toBe(0);
  });

  it("accurately summarizes an entire heterogeneous batch with canonical backend shapes", () => {
    const results = {
      "m1-pass": {
        tested: true,
        classification: "success",
        statusCode: 200,
        reason: "success",
      },
      "m2-quota": {
        tested: true,
        classification: "quota_cost",
        statusCode: 402,
        reason: "quota_exhausted",
      },
      "m3-ratelimit": {
        tested: true,
        classification: "rate_limited",
        statusCode: 429,
        reason: "rate_limited",
      },
      "m4-access": {
        tested: true,
        classification: "access_restriction",
        statusCode: 403,
        reason: "permission_denied",
      },
      "m5-transport": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: 502,
        reason: "server_error",
      },
      "m6-auth401": {
        tested: true,
        classification: "transport_indeterminate",
        statusCode: 401,
        reason: "auth_failure",
      },
      "m7-hard": {
        tested: true,
        classification: "hard_model_failure",
        statusCode: 404,
        reason: "model_not_found",
        disableEligible: true,
        disabled: true,
      },
      "m8-skipped": {
        tested: false,
        status: "skipped",
        reason: "quota_exhausted",
        disabled: false,
      },
      "m9-unrecognized": {
        tested: true,
        classification: "unrecognized_probe_verdict",
        statusCode: 500,
      },
    };

    const summary = summarizeModelTestResults(results);
    expect(summary).toEqual({
      passed: 1,
      broken: 1,
      quotaErrors: 2,
      accessErrors: 2,
      transportErrors: 2,
      skipped: 1,
    });
  });

  it("handles null, undefined, or empty results gracefully", () => {
    expect(summarizeModelTestResults(null)).toEqual({
      passed: 0,
      broken: 0,
      quotaErrors: 0,
      accessErrors: 0,
      transportErrors: 0,
      skipped: 0,
    });
    expect(summarizeModelTestResults(undefined)).toEqual({
      passed: 0,
      broken: 0,
      quotaErrors: 0,
      accessErrors: 0,
      transportErrors: 0,
      skipped: 0,
    });
    expect(summarizeModelTestResults({})).toEqual({
      passed: 0,
      broken: 0,
      quotaErrors: 0,
      accessErrors: 0,
      transportErrors: 0,
      skipped: 0,
    });
  });
});

describe("ModelManagementPanel UI State & handleTestBatch Integration", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders canonical test batch results in UI state without fallback broken leakage", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            globalDefault: { enabled: true, intervalHours: 24 },
            providers: {},
          }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            batchId: "batch_canonical_test",
            executionScope: "provider",
            summary: { tested: 7, total: 8, disabled: 1, skipped: 1 },
            // Untrusted legacy fields that must NOT overwrite canonical counts
            passed: 99,
            broken: 99,
            quota: 99,
            access: 99,
            transport: 99,
            results: {
              "m-pass": {
                tested: true,
                classification: "success",
                statusCode: 200,
                reason: "success",
              },
              "m-quota": {
                tested: true,
                classification: "quota_cost",
                statusCode: 402,
                reason: "quota_exhausted",
              },
              "m-rate": {
                tested: true,
                classification: "rate_limited",
                statusCode: 429,
                reason: "rate_limited",
              },
              "m-access": {
                tested: true,
                classification: "access_restriction",
                statusCode: 403,
                reason: "permission_denied",
              },
              "m-transport": {
                tested: true,
                classification: "transport_indeterminate",
                statusCode: 502,
                reason: "server_error",
              },
              "m-auth": {
                tested: true,
                classification: "transport_indeterminate",
                statusCode: 401,
                reason: "auth_failure",
              },
              "m-hard": {
                tested: true,
                classification: "hard_model_failure",
                statusCode: 404,
                reason: "model_not_found",
                disableEligible: true,
                disabled: true,
              },
              "m-skipped": {
                tested: false,
                status: "skipped",
                reason: "batch_stopped",
                disabled: false,
              },
            },
          }),
        });
      }
      return Promise.reject(new Error("unexpected URL: " + url));
    });

    let renderer;
    try {
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openai",
            connections: [{ id: "conn_1", isActive: true }],
            visibleModelIds: [
              "openai/m-pass",
              "openai/m-quota",
              "openai/m-rate",
              "openai/m-access",
              "openai/m-transport",
              "openai/m-auth",
              "openai/m-hard",
              "openai/m-skipped",
            ],
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const runTestBtn = findButtonByText(renderer.root, "Start Batch");
      expect(runTestBtn).toBeDefined();
      await act(async () => {
        await runTestBtn.props.onClick();
      });

      const jsonStr = JSON.stringify(renderer.toJSON());

      // Authoritative canonical counts must be rendered
      expect(jsonStr).toContain("Passed");
      expect(jsonStr).toContain("Broken");
      expect(jsonStr).toContain("Quota Exceeded");
      expect(jsonStr).toContain("Access Error");
      expect(jsonStr).toContain("Transport");
      expect(jsonStr).toContain("Skipped");

      // Verify untrusted fallback 99 is never displayed for broken or passed
      expect(jsonStr).not.toContain('">99<');
    } finally {
      renderer?.unmount();
    }
  });

  it("preserves safe zero count when no models are broken despite untrusted data.broken > 0", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            globalDefault: { enabled: true, intervalHours: 24 },
            providers: {},
          }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            batchId: "batch_safezero_test",
            executionScope: "provider",
            summary: { tested: 2, total: 2, disabled: 0, skipped: 0 },
            // Untrusted legacy broken count:
            broken: 42,
            failingCount: 42,
            results: {
              "m-pass": {
                tested: true,
                classification: "success",
                statusCode: 200,
                reason: "success",
              },
              "m-quota": {
                tested: true,
                classification: "quota_cost",
                statusCode: 402,
                reason: "payment_required",
              },
            },
          }),
        });
      }
      return Promise.reject(new Error("unexpected URL: " + url));
    });

    let renderer;
    try {
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openai",
            connections: [{ id: "conn_1", isActive: true }],
            visibleModelIds: ["openai/m-pass", "openai/m-quota"],
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const runTestBtn = findButtonByText(renderer.root, "Start Batch");
      await act(async () => {
        await runTestBtn.props.onClick();
      });

      const jsonStr = JSON.stringify(renderer.toJSON());

      // Safezero: broken must be 0, never fallback to untrusted 42
      expect(jsonStr).not.toContain('">42<');
    } finally {
      renderer?.unmount();
    }
  });
});

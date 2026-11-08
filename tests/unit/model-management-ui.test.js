import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import ReactTestRenderer, { act } from "react-test-renderer";

import ModelManagementPanel from "@/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js";
import ModelOverrideModal from "@/app/(dashboard)/dashboard/providers/[id]/ModelOverrideModal.js";
import ModelRow from "@/app/(dashboard)/dashboard/providers/[id]/ModelRow.js";

// Enable React act() testing environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Provide minimal document mock for Node testing environment
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

// Helper to reliably find buttons by text even when Button component wraps icons/children into arrays
function findButtonByText(root, text) {
  return root.findAllByType("button").find((b) => {
    return getTextFromChildren(b.props.children).includes(text);
  });
}

describe("Model Management UI Slice (Spec 017)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("Feature 1: Model Import & Connection Handling", () => {
    it("explains connection requirement when no active connection is available without fake disabled forever", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        return Promise.reject(new Error("unexpected url"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openai-compatible-test",
            connections: [],
            visibleModelIds: ["gpt-4o", "gpt-4o-mini"],
          })
        );
      });

      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("Importing models requires an active connection");

      const importBtn = findButtonByText(renderer.root, "Import Models");
      expect(importBtn).toBeDefined();
      expect(importBtn.props.disabled).toBe(true);
    });

    it("executes POST /api/providers/:connectionId/import-models on click and renders import summary", async () => {
      let capturedUrl = null;
      let capturedMethod = null;
      const onChangedSpy = vi.fn();

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        if (url.includes("/import-models")) {
          capturedUrl = url;
          capturedMethod = opts?.method;
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              authoritative: true,
              added: ["model-new-1", "model-new-2"],
              updated: ["model-existing"],
              removed: ["model-deleted"],
              stale: ["model-manual"],
              unchanged: 10,
            }),
          });
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openrouter",
            connections: [{ id: "conn_123", name: "Primary Key", isActive: true }],
            visibleModelIds: ["model-existing"],
            onChanged: onChangedSpy,
          })
        );
      });

      const importBtn = findButtonByText(renderer.root, "Import Models");
      expect(importBtn).toBeDefined();

      await act(async () => {
        await importBtn.props.onClick();
      });

      expect(capturedUrl).toBe("/api/providers/conn_123/import-models");
      expect(capturedMethod).toBe("POST");
      expect(onChangedSpy).toHaveBeenCalledTimes(1);

      // Verify import summary rendered with exact counts
      const textNodes = JSON.stringify(renderer.toJSON());
      expect(textNodes).toContain("Added:");
      expect(textNodes).toContain("2");
      expect(textNodes).toContain("Updated:");
      expect(textNodes).toContain("1");
      expect(textNodes).toContain("Removed:");
      expect(textNodes).toContain("Preserved (manual):");
      expect(textNodes).toContain("Unchanged:");
      expect(textNodes).toContain("10");
    });

    it("displays non-authoritative warning when listing was incomplete", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        if (url.includes("/import-models")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              authoritative: false,
              added: [],
              updated: [],
              removed: [],
              stale: [],
              unchanged: 5,
            }),
          });
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openrouter",
            connections: [{ id: "conn_1", isActive: true }],
            visibleModelIds: ["m1"],
          })
        );
      });

      const importBtn = findButtonByText(renderer.root, "Import Models");

      await act(async () => {
        await importBtn.props.onClick();
      });

      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("The provider did not return a live authoritative listing");
    });
  });

  describe("Feature 2: Batch Testing, Routing Scope & Classifications", () => {
    it("renders provider routing label, cost warning, and defaults autoDisable to false", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openrouter",
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: ["gpt-4o"],
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("Tests use this provider’s configured account routing");
      expect(jsonStr).toContain("Tests send real requests and may consume quota/credits");

      // Verify autoDisable checkbox defaults to false (unchecked)
      const checkbox = renderer.root.findByType("input");
      expect(checkbox.props.type).toBe("checkbox");
      expect(checkbox.props.checked).toBe(false);
    });

    it("executes POST /api/models/test-batch with raw model IDs, provider scope, and classifications", async () => {
      let capturedPayload = null;

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        if (url.includes("/api/models/test-batch")) {
          capturedPayload = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              batchId: "batch_abc",
              executionScope: "provider",
              summary: { tested: 3, total: 3, disabled: 1, skipped: 0 },
              results: {
                "gpt-4o": { classification: "ok", statusCode: 200, latencyMs: 120 },
                "broken-model": { classification: "broken", statusCode: 500, disableEligible: true },
                "rate-limited-model": { classification: "quota", statusCode: 429, reason: "Quota exceeded" },
              },
            }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openai",
            connections: [{ id: "conn_1", isActive: true }],
            visibleModelIds: ["openai/gpt-4o", "openai/broken-model", "openai/rate-limited-model"],
          })
        );
      });

      // Switch to Test tab
      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      // Run batch test
      const runTestBtn = findButtonByText(renderer.root, "Start Batch");
      expect(runTestBtn).toBeDefined();
      await act(async () => {
        await runTestBtn.props.onClick();
      });

      // Verify payload sent: raw model IDs (stripped prefix), autoDisable: false default, respectRateLimit: true
      expect(capturedPayload).toEqual({
        providerId: "openai",
        connectionId: "conn_1",
        modelIds: ["gpt-4o", "broken-model", "rate-limited-model"],
        autoDisable: false,
        respectRateLimit: true,
      });

      // Verify classifications display: passed: 1, broken: 1, quota: 1 (never mislabeled as broken)
      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("Passed");
      expect(jsonStr).toContain("Broken");
      expect(jsonStr).toContain("Quota Exceeded");
    });

    it("bounds chunking to 100 IDs without silent capping and supports pagination", async () => {
      // 150 models total: chunk into 100 + 50
      const largeModelList = Array.from({ length: 150 }, (_, i) => `model-${i + 1}`);

      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openrouter",
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: largeModelList,
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const jsonStr = JSON.stringify(renderer.toJSON());
      // Displays Batch 1 of 2 (100 models, 50 remaining)
      expect(jsonStr).toContain("Batch 1 of 2");
      expect(jsonStr).toContain("100 models");
      expect(jsonStr).toContain("50 remaining");

      // Verify Next Batch button exists
      const nextBatchBtn = findButtonByText(renderer.root, "Next Batch (");
      expect(nextBatchBtn).toBeDefined();

      await act(async () => {
        nextBatchBtn.props.onClick();
      });

      const updatedJson = JSON.stringify(renderer.toJSON());
      expect(updatedJson).toContain("Batch 2 of 2");
      expect(updatedJson).toContain("50 models");
    });

    it("supports AbortController cancellation for stopped batch", async () => {
      let abortTriggered = false;

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/sync-policy")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
          });
        }
        if (url.includes("/api/models/test-batch")) {
          return new Promise((_, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener("abort", () => {
                abortTriggered = true;
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "openrouter",
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: ["m1", "m2"],
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const runTestBtn = findButtonByText(renderer.root, "Start Batch");
      expect(runTestBtn).toBeDefined();

      // Start the batch test
      act(() => {
        runTestBtn.props.onClick();
      });

      // Find Cancel Test button
      const cancelBtn = findButtonByText(renderer.root, "Cancel Test");
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn.props.onClick();
      });

      expect(abortTriggered).toBe(true);
      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("Batch testing was cancelled by the user");
    });
  });

  describe("Feature 3: Automatic Catalog Sync Policy", () => {
    it("fetches sync policy safely and merges provider updates without clobbering other providers", async () => {
      let putPayload = null;

      const serverPolicy = {
        globalDefault: { enabled: true, intervalHours: 12 },
        providers: {
          "other-provider": { enabled: false, intervalHours: 48 },
        },
      };

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/sync-policy") && (!opts || opts.method === "GET" || !opts.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => serverPolicy,
          });
        }
        if (url.includes("/api/models/sync-policy") && opts?.method === "PUT") {
          putPayload = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: async () => putPayload,
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelManagementPanel, {
            providerId: "my-provider",
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: ["m1"],
          })
        );
      });

      // Switch to Auto-Sync tab
      const syncTabBtn = findButtonByText(renderer.root, "Auto-Sync");
      await act(async () => {
        syncTabBtn.props.onClick();
      });

      // Change provider sync mode to enabled
      const providerSelect = renderer.root.findByProps({ id: "provider-sync-select" });
      await act(async () => {
        providerSelect.props.onChange({ target: { value: "enabled" } });
      });

      // Click Save Sync Policy
      const saveBtn = findButtonByText(renderer.root, "Save Sync Policy");
      expect(saveBtn).toBeDefined();

      await act(async () => {
        await saveBtn.props.onClick();
      });

      // Assert PUT payload: other-provider was preserved, my-provider was merged!
      expect(putPayload).toBeDefined();
      expect(putPayload.providers["other-provider"]).toEqual({ enabled: false, intervalHours: 48 });
      expect(putPayload.providers["my-provider"]).toEqual({ enabled: true, intervalHours: 24 });
      expect(putPayload.globalDefault.intervalHours).toBe(12);
    });
  });

  describe("Feature 4: Model Capability Overrides Modal & Tri-State Preservation", () => {
    it("fetches manual overrides from GET manual (not inferring from resolved) and PUTs manualDraft", async () => {
      let putPayload = null;
      const onSavedSpy = vi.fn();

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/overrides") && (!opts || !opts.method || opts.method === "GET")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              resolved: {
                supportsVision: true,
                supportsTools: true,
                contextWindow: 128000,
                maxOutputTokens: 4096,
              },
              provenance: { source: "registry" },
              // Crucial: manual only has supportsTools: true, but vision is unset (auto)
              manual: {
                supportsTools: true,
              },
            }),
          });
        }
        if (url.includes("/api/models/overrides") && opts?.method === "PUT") {
          putPayload = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelOverrideModal, {
            isOpen: true,
            onClose: () => {},
            providerId: "openrouter",
            modelId: "anthropic/claude-3-opus",
            onSaved: onSavedSpy,
          })
        );
      });

      // Explicitly set supportsVision to false (manual false preservation)
      const visionSelect = renderer.root.findByProps({ id: "override-supportsVision" });
      await act(async () => {
        visionSelect.props.onChange({ target: { value: "false" } });
      });

      // Set custom context window
      const ctxInput = renderer.root.findByProps({ id: "override-context-window" });
      await act(async () => {
        ctxInput.props.onChange({ target: { value: "200000" } });
      });

      // Save overrides
      const saveBtn = findButtonByText(renderer.root, "Save Overrides");
      expect(saveBtn).toBeDefined();

      await act(async () => {
        await saveBtn.props.onClick();
      });

      expect(putPayload).toBeDefined();
      expect(putPayload.provider).toBe("openrouter");
      expect(putPayload.modelId).toBe("anthropic/claude-3-opus");
      // supportsVision: false MUST be preserved as false (not omitted, not null, not true)
      expect(putPayload.capabilities.supportsVision).toBe(false);
      expect(putPayload.capabilities.supportsTools).toBe(true);
      expect(putPayload.capabilities.contextWindow).toBe(200000);
      // All other unspecified capabilities left as 'auto' MUST NOT be in manualDraft
      expect(putPayload.capabilities.supportsAudio).toBeUndefined();
      expect(putPayload.capabilities.supportsVideo).toBeUndefined();
      expect(onSavedSpy).toHaveBeenCalledTimes(1);
    });

    it("resets all overrides via DELETE /api/models/overrides when clicking Reset to Automatic", async () => {
      let deleteUrl = null;
      let deleteMethod = null;
      const onSavedSpy = vi.fn();

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/overrides") && (!opts || !opts.method || opts.method === "GET")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              resolved: { supportsVision: true },
              manual: { supportsVision: false },
            }),
          });
        }
        if (url.includes("/api/models/overrides") && opts?.method === "DELETE") {
          deleteUrl = url;
          deleteMethod = opts.method;
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelOverrideModal, {
            isOpen: true,
            onClose: () => {},
            providerId: "openrouter",
            modelId: "gpt-4o",
            onSaved: onSavedSpy,
          })
        );
      });

      const resetBtn = findButtonByText(renderer.root, "Reset to Automatic");
      expect(resetBtn).toBeDefined();

      await act(async () => {
        await resetBtn.props.onClick();
      });

      expect(deleteUrl).toContain("/api/models/overrides?provider=openrouter&modelId=gpt-4o");
      expect(deleteMethod).toBe("DELETE");
      expect(onSavedSpy).toHaveBeenCalledTimes(1);
    });

    it("saves reasoning configuration with effortLevels array and tri-state supported", async () => {
      let putPayload = null;

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("/api/models/overrides") && (!opts || !opts.method || opts.method === "GET")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              resolved: { supportsReasoning: true },
              manual: {},
            }),
          });
        }
        if (url.includes("/api/models/overrides") && opts?.method === "PUT") {
          putPayload = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelOverrideModal, {
            isOpen: true,
            onClose: () => {},
            providerId: "openai",
            modelId: "o3-mini",
          })
        );
      });

      // Configure reasoning supported to true
      const reasoningSelect = renderer.root.findByProps({ id: "override-reasoning-supported" });
      await act(async () => {
        reasoningSelect.props.onChange({ target: { value: "true" } });
      });

      // Configure effort levels
      const effortInput = renderer.root.findByProps({ id: "override-effort-levels" });
      await act(async () => {
        effortInput.props.onChange({ target: { value: "low, medium, high" } });
      });

      const saveBtn = findButtonByText(renderer.root, "Save Overrides");
      await act(async () => {
        await saveBtn.props.onClick();
      });

      expect(putPayload).toBeDefined();
      expect(putPayload.capabilities.reasoning).toEqual({
        supported: true,
        effortLevels: ["low", "medium", "high"],
      });
    });
  });

  describe("Feature 5: ModelRow Capabilities Integration", () => {
    it("renders onEditCaps button in ModelRow and triggers callback with model id", async () => {
      const onEditCapsSpy = vi.fn();

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(
          React.createElement(ModelRow, {
            model: { id: "test-model-1", name: "Test Model 1" },
            fullModel: "provider/test-model-1",
            copied: "",
            onCopy: () => {},
            onEditCaps: onEditCapsSpy,
          })
        );
      });

      const editBtn = renderer.root.findAllByType("button").find((b) =>
        b.props["aria-label"] === "Edit capabilities for test-model-1"
      );
      expect(editBtn).toBeDefined();

      await act(async () => {
        editBtn.props.onClick();
      });

      expect(onEditCapsSpy).toHaveBeenCalledWith("test-model-1");
    });
  });
});

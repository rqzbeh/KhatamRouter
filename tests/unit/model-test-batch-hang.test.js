import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import ReactTestRenderer, { act } from "react-test-renderer";

const hoistedMocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: hoistedMocks.getApiKeys,
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: hoistedMocks.getConsistentMachineId,
}));

import {
  runModelTestBatch,
  MODEL_TEST_CLASSIFICATION,
  MODEL_TEST_REASON,
} from "@/lib/models/modelTestBatch.js";
import { pingModelByKind } from "@/app/api/models/test/ping.js";
import ModelManagementPanel from "@/app/(dashboard)/dashboard/providers/[id]/ModelManagementPanel.js";

// Enable React act() testing environment
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
  if (node.children) return getTextFromChildren(node.children);
  if (node.props?.children) return getTextFromChildren(node.props.children);
  return "";
}

function findButtonByText(root, text) {
  return root.findAllByType("button").find((b) => {
    return getTextFromChildren(b.props.children).includes(text);
  });
}

describe("Reproduce and verify 42-model batch hang and cancellation (Spec 017)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    hoistedMocks.getApiKeys.mockResolvedValue([{ key: "sk-test", isActive: true }]);
    hoistedMocks.getConsistentMachineId.mockResolvedValue("test-machine-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("G1/G2: 42-model batch bounds noncooperative hung probe and halts safely without leaking overlapping background probes", async () => {
    // 42 models: model-7 has a noncooperative hung fetch that never settles
    const modelIds = Array.from({ length: 42 }, (_, i) => `model-${i + 1}`);

    const probe = vi.fn().mockImplementation((id) => {
      if (id === "model-7") {
        // Noncooperative hung fetch: returns a promise that never resolves or rejects even if signal aborts
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, status: 200, latencyMs: 5 });
    });

    // Guard with 400ms timeout race so the test fails fast deterministically
    const testTimeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ isTestTimeout: true });
      }, 400);
    });

    const batchPromise = runModelTestBatch({
      modelIds,
      probe,
      intervalMs: 0,
      probeTimeoutMs: 30,
      probeCleanupMs: 10,
      maxBatchDurationMs: 10000,
    });

    const batchResult = await Promise.race([batchPromise, testTimeoutPromise]);

    expect(batchResult.isTestTimeout).toBeUndefined(); // Must NOT hang indefinitely!
    expect(batchResult.results["model-7"]).toBeDefined();
    expect(batchResult.results["model-7"].tested).toBe(true);
    expect(batchResult.results["model-7"].classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
    expect(batchResult.results["model-7"].reason).toBe(MODEL_TEST_REASON.TIMEOUT);

    // Safety halt: because probe-7 failed to settle within cleanup drain, unproven cleanup halts batch
    expect(batchResult.stoppedEarly).toBe(true);
    expect(batchResult.stopReason).toBe(MODEL_TEST_REASON.TRANSPORT_INDETERMINATE);

    // Remaining models safely marked skipped (terminal states for all 42 models)
    expect(batchResult.results["model-8"].status).toBe("skipped");
    expect(batchResult.results["model-42"].status).toBe("skipped");
    expect(batchResult.summary.tested).toBe(7);
    expect(batchResult.summary.skipped).toBe(35);
    expect(batchResult.summary.tested + batchResult.summary.skipped).toBe(42);

    // CRITICAL: probe was called EXACTLY 7 times, proving NO overlapping network probe was spawned!
    expect(probe).toHaveBeenCalledTimes(7);
  });

  it("G1/G2: 42-model batch with cooperative probe timeout continues cleanly across all 42 models", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `model-${i + 1}`);

    const probe = vi.fn().mockImplementation((id, { signal }) => {
      if (id === "model-7") {
        // Cooperative timeout: probe respects signal and cleanly settles with timeout error
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ ok: false, status: 0, code: "timeout", error: "Request timed out" });
          }, { once: true });
        });
      }
      return Promise.resolve({ ok: true, status: 200, latencyMs: 2 });
    });

    const batchResult = await runModelTestBatch({
      modelIds,
      probe,
      intervalMs: 0,
      probeTimeoutMs: 20,
      probeCleanupMs: 10,
      maxBatchDurationMs: 10000,
    });

    expect(batchResult.results["model-7"].tested).toBe(true);
    expect(batchResult.results["model-7"].classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
    expect(batchResult.results["model-7"].reason).toBe(MODEL_TEST_REASON.TIMEOUT);

    // Since probe settled cleanly, remaining models continue testing
    expect(batchResult.summary.tested).toBe(42);
    expect(batchResult.summary.skipped).toBe(0);
    expect(batchResult.stoppedEarly).toBe(false);
    expect(probe).toHaveBeenCalledTimes(42);
  });

  it("G2: 42-model batch cancellation settles immediately even when in-flight probe is a noncooperative hung fetch", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `model-${i + 1}`);
    const controller = new AbortController();

    const probe = vi.fn().mockImplementation((id) => {
      if (id === "model-3") {
        // Trigger abort mid-batch during model-3
        setTimeout(() => controller.abort(), 15);
        // Noncooperative hung probe: never settles
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, status: 200, latencyMs: 5 });
    });

    const startTime = Date.now();

    const testGuardPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ isTestTimeout: true });
      }, 350);
    });

    const batchPromise = runModelTestBatch({
      modelIds,
      probe,
      signal: controller.signal,
      intervalMs: 0,
      probeTimeoutMs: 50,
      probeCleanupMs: 10,
      maxBatchDurationMs: 60000, // Long total budget
    });

    const batchResult = await Promise.race([batchPromise, testGuardPromise]);
    const elapsed = Date.now() - startTime;

    expect(batchResult.isTestTimeout).toBeUndefined(); // Must NOT time out!
    expect(elapsed).toBeLessThan(300);
    expect(batchResult.stoppedEarly).toBe(true);
    expect(batchResult.stopReason).toBe(MODEL_TEST_REASON.ABORTED);
    // All 42 models must have terminal outcome (either tested or skipped)
    expect(batchResult.summary.tested + batchResult.summary.skipped).toBe(42);
  });

  it("G2: pingModelByKind bounds stalled response body reads (res.text()) within timeout", async () => {
    const abortController = new AbortController();

    // Mock fetch returning a Response where res.text() hangs forever
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: () => new Promise(() => {}), // hung body stream
        body: {
          cancel: vi.fn(),
        },
      });
    });

    // Abort after 20ms
    setTimeout(() => abortController.abort(), 20);

    const testGuard = new Promise((resolve) => {
      setTimeout(() => resolve({ isTestTimeout: true }), 250);
    });

    const pingPromise = pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20128", {
      signal: abortController.signal,
      timeoutMs: 50,
    });

    const result = await Promise.race([pingPromise, testGuard]);

    expect(result.isTestTimeout).toBeUndefined(); // Must NOT hang indefinitely on res.text()!
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/timeout|abort/i);
  });

  it("G2: pingModelByKind cancels late-resolved fetch response body to prevent socket/memory leaks", async () => {
    let resolveLateFetch;
    const cancelBodyMock = vi.fn();

    globalThis.fetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveLateFetch = () => {
          resolve({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            text: async () => JSON.stringify({ choices: [{ message: { content: "late" } }] }),
            body: { cancel: cancelBodyMock },
          });
        };
      });
    });

    // Start ping with very short 20ms timeout
    const pingPromise = pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20128", {
      timeoutMs: 20,
    });

    const result = await pingPromise;
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");

    // Simulate fetch resolving 10ms AFTER timeout fired
    expect(cancelBodyMock).not.toHaveBeenCalled();
    resolveLateFetch();

    // Allow microtasks to run late response handler
    await new Promise((r) => setTimeout(r, 20));

    // Must have invoked body.cancel() on the late-resolved response!
    expect(cancelBodyMock).toHaveBeenCalledTimes(1);
  });

  it("G2: pingModelByKind bounds stalled body read on native Response(new ReadableStream) with actual stream cancel and no unhandled rejection", async () => {
    const cancelSpy = vi.fn().mockImplementation(() => Promise.resolve());
    const hangingStream = new ReadableStream({
      pull() {
        return new Promise(() => {}); // never yields chunk
      },
      cancel(reason) {
        return cancelSpy(reason);
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(hangingStream, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const pingPromise = pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20128", {
      timeoutMs: 30,
    });

    const result = await pingPromise;
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");

    // Allow microtasks to complete reader cancellation
    await new Promise((r) => setTimeout(r, 20));

    // Must have invoked cancel on the native underlying stream!
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("G1/G2: ModelManagementPanel with 42 models provides progress feedback and retains useful state on cancellation", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `openai/model-${i + 1}`);

    let abortCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        return new Promise((resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => {
              abortCalled = true;
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
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
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: modelIds,
          })
        );
      });

      // Switch to Test tab
      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      expect(testTabBtn).toBeDefined();
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const initialJson = JSON.stringify(renderer.toJSON());
      expect(initialJson).toContain("Batch 1 of 1 (42 models)");

      // Click Start Batch Test
      const startBtn = findButtonByText(renderer.root, "Start Batch Test");
      expect(startBtn).toBeDefined();

      await act(async () => {
        startBtn.props.onClick();
      });

      // While testing, UI must display testing state / progress and Cancel Test button
      const cancelBtn = findButtonByText(renderer.root, "Cancel Test");
      expect(cancelBtn).toBeDefined();

      const testingJson = JSON.stringify(renderer.toJSON());
      expect(testingJson).toContain("Testing");

      // Click Cancel Test
      await act(async () => {
        cancelBtn.props.onClick();
      });

      expect(abortCalled).toBe(true);

      const afterCancelJson = JSON.stringify(renderer.toJSON());
      // Should show cancellation message with useful context, not stuck testing
      expect(afterCancelJson).toContain("cancelled");
    } finally {
      renderer?.unmount();
    }
  });

  it("G1/G2/G3: 42-model batch with autoDisable: true disables hard failure models but NEVER auto-disables timeouts (transport_indeterminate)", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `model-${i + 1}`);
    const disableModel = vi.fn().mockResolvedValue({ ok: true });

    const probe = vi.fn().mockImplementation(async (id) => {
      if (id === "model-10") {
        // Hard model failure: 404 model_not_found
        return {
          ok: false,
          status: 404,
          error: "HTTP 404: The model model-10 does not exist",
          code: "model_not_found",
        };
      }
      if (id === "model-20") {
        // Timeout: returns error with code: timeout (transport_indeterminate)
        return {
          ok: false,
          status: 0,
          error: "Request timed out",
          code: "timeout",
        };
      }
      if (id === "model-30") {
        // Rate limited
        return {
          ok: false,
          status: 429,
          error: "HTTP 429: Rate limit reached",
          code: "rate_limit_exceeded",
        };
      }
      return { ok: true, status: 200, latencyMs: 5 };
    });

    const progressEvents = [];
    const batchResult = await runModelTestBatch({
      modelIds,
      probe,
      autoDisable: true,
      disableModel,
      intervalMs: 0,
      probeTimeoutMs: 50,
      probeCleanupMs: 10,
      maxBatchDurationMs: 10000,
      onProgress: (prog) => {
        progressEvents.push({ modelId: prog.modelId, index: prog.index, total: prog.total });
      },
    });

    // 1. All 42 models reached terminal state
    expect(batchResult.summary.tested).toBe(42);
    expect(batchResult.summary.total).toBe(42);
    expect(batchResult.summary.skipped).toBe(0);
    expect(batchResult.stoppedEarly).toBe(false);

    // 2. onProgress was called for all 42 models with correct indices
    expect(progressEvents.length).toBe(42);
    expect(progressEvents[0]).toEqual({ modelId: "model-1", index: 0, total: 42 });
    expect(progressEvents[41]).toEqual({ modelId: "model-42", index: 41, total: 42 });

    // 3. Hard model failure was disabled
    expect(batchResult.results["model-10"].classification).toBe(MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE);
    expect(batchResult.results["model-10"].disableEligible).toBe(true);
    expect(batchResult.results["model-10"].disabled).toBe(true);

    // 4. Timeout is transport_indeterminate and NEVER auto-disabled
    expect(batchResult.results["model-20"].classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
    expect(batchResult.results["model-20"].reason).toBe(MODEL_TEST_REASON.TIMEOUT);
    expect(batchResult.results["model-20"].disableEligible).toBe(false);
    expect(batchResult.results["model-20"].disabled).toBe(false);

    // 5. Rate limit is not disabled
    expect(batchResult.results["model-30"].classification).toBe(MODEL_TEST_CLASSIFICATION.RATE_LIMITED);
    expect(batchResult.results["model-30"].disabled).toBe(false);

    // 6. Only model-10 was disabled in summary and callback
    expect(batchResult.summary.disabled).toBe(1);
    expect(disableModel).toHaveBeenCalledTimes(1);
    expect(disableModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "model-10", reason: MODEL_TEST_REASON.MODEL_NOT_FOUND })
    );
  });

  it("G2: overall batch duration timeout cleanly bounds batch and marks remaining models as skipped with BATCH_TIMEOUT", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `model-${i + 1}`);

    // Each probe takes 15ms
    const probe = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, status: 200, latencyMs: 15 };
    });

    const startTime = Date.now();
    const batchResult = await runModelTestBatch({
      modelIds,
      probe,
      intervalMs: 0,
      probeTimeoutMs: 100,
      probeCleanupMs: 10,
      maxBatchDurationMs: 40, // Short total budget: should stop after ~2-3 models
    });
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(250); // Bounded completion
    expect(batchResult.stoppedEarly).toBe(true);
    expect(batchResult.stopReason).toBe(MODEL_TEST_REASON.BATCH_TIMEOUT);

    // Terminal result for every model: tested + skipped must equal 42
    expect(batchResult.summary.tested + batchResult.summary.skipped).toBe(42);
    expect(batchResult.summary.skipped).toBeGreaterThan(0);

    // Check that a skipped model has reason batch_timeout
    const skippedModel = Object.values(batchResult.results).find((r) => r.status === "skipped");
    expect(skippedModel).toBeDefined();
    expect(skippedModel.reason).toBe(MODEL_TEST_REASON.BATCH_TIMEOUT);
  });

  it("G1/G2: ModelManagementPanel renders live streaming NDJSON progress and retains partial completed results upon mid-batch cancellation", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `openai/model-${i + 1}`);
    const encoder = new TextEncoder();

    let streamCancelled = false;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        let timer = null;
        let streamCtrl = null;
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            streamCancelled = true;
            if (timer) clearTimeout(timer);
            try {
              streamCtrl?.close();
            } catch {}
          });
        }
        const readable = new ReadableStream({
          start(ctrl) {
            streamCtrl = ctrl;
            // Emit progress event for model 1 immediately
            ctrl.enqueue(encoder.encode(JSON.stringify({
              type: "progress",
              modelId: "model-1",
              index: 0,
              total: 42,
              record: { tested: true, classification: "success", statusCode: 200, reason: "success", latencyMs: 12 },
              summary: { tested: 1, total: 42, disabled: 0, skipped: 0 },
            }) + "\n"));

            // Emit progress event for model 2 after 10ms
            timer = setTimeout(() => {
              if (streamCancelled) return;
              try {
                ctrl.enqueue(encoder.encode(JSON.stringify({
                  type: "progress",
                  modelId: "model-2",
                  index: 1,
                  total: 42,
                  record: { tested: true, classification: "quota_cost", statusCode: 429, reason: "rate_limited", latencyMs: 8 },
                  summary: { tested: 2, total: 42, disabled: 0, skipped: 0 },
                }) + "\n"));
              } catch {}
            }, 10);
          },
          cancel() {
            streamCancelled = true;
            if (timer) clearTimeout(timer);
          },
        });

        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-type": "application/x-ndjson; charset=utf-8",
          }),
          body: readable,
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
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: modelIds,
          })
        );
      });

      // Switch to Test tab
      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      // Start batch
      const startBtn = findButtonByText(renderer.root, "Start Batch Test");
      await act(async () => {
        startBtn.props.onClick();
      });

      // Allow stream microtasks to process model 1 and model 2
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });

      // Assert live progress is visible
      const progressJson = JSON.stringify(renderer.toJSON());
      expect(progressJson).toContain("Testing");

      // Cancel mid-batch
      const cancelBtn = findButtonByText(renderer.root, "Cancel Test");
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn.props.onClick();
      });

      expect(streamCancelled).toBe(true);

      const afterCancelJson = JSON.stringify(renderer.toJSON());
      // Expect cancellation note
      expect(afterCancelJson).toContain("cancelled");
      // Expect partial completed results to be preserved (NOT wiped out)
      expect(afterCancelJson).toContain("Results");
      expect(afterCancelJson).toContain("Passed");
      expect(afterCancelJson).toContain("Quota Exceeded");
    } finally {
      renderer?.unmount();
    }
  });

  it("G1/G2/G3: ModelManagementPanel completes all 42 models via NDJSON stream with accurate terminal summary and timeout transport classification", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `openai/model-${i + 1}`);
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        const results = {};
        const lines = [];
        for (let i = 0; i < 42; i++) {
          const id = `model-${i + 1}`;
          let record;
          if (i === 5) {
            record = {
              tested: true,
              classification: "hard_model_failure",
              disableEligible: true,
              statusCode: 404,
              reason: "model_not_found",
              disabled: false,
              latencyMs: 10,
            };
          } else if (i === 15) {
            record = {
              tested: true,
              classification: "transport_indeterminate",
              disableEligible: false,
              statusCode: 0,
              reason: "timeout",
              disabled: false,
              latencyMs: 15000,
            };
          } else {
            record = {
              tested: true,
              classification: "success",
              disableEligible: false,
              statusCode: 200,
              reason: "success",
              disabled: false,
              latencyMs: 12,
            };
          }
          results[id] = record;
          lines.push(
            JSON.stringify({
              type: "progress",
              modelId: id,
              index: i,
              total: 42,
              record,
              summary: { tested: i + 1, total: 42, disabled: 0, skipped: 0 },
            })
          );
        }
        lines.push(
          JSON.stringify({
            type: "done",
            batchId: "batch-42-complete",
            providerId: "openai",
            executionScope: "provider",
            summary: { tested: 42, total: 42, disabled: 0, skipped: 0 },
            results,
            stoppedEarly: false,
            stopReason: null,
          })
        );

        const payload = lines.join("\n") + "\n";
        const readable = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(payload));
            ctrl.close();
          },
        });

        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/x-ndjson; charset=utf-8" }),
          body: readable,
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
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: modelIds,
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const startBtn = findButtonByText(renderer.root, "Start Batch Test");
      await act(async () => {
        await startBtn.props.onClick();
      });

      const renderedText = getTextFromChildren(renderer.toJSON());
      expect(renderedText).toMatch(/Batch\s+1\s+Results/);
      expect(renderedText).toMatch(/42\s+models tested/);
      expect(renderedText).toContain("Passed 40");
      expect(renderedText).toContain("Broken 1");
      expect(renderedText).toContain("Transport 1");
      expect(renderedText).not.toContain("Cancel Test");
    } finally {
      renderer?.unmount();
    }
  });

  it("G1/G2: ModelManagementPanel handles truncated NDJSON stream (EOF without done): marks batch incomplete, displays error alert, and retains partial results", async () => {
    const modelIds = Array.from({ length: 42 }, (_, i) => `openai/model-${i + 1}`);
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/api/models/sync-policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ globalDefault: { enabled: true, intervalHours: 24 }, providers: {} }),
        });
      }
      if (url.includes("/api/models/test-batch")) {
        // Emit only 3 models then immediately close stream without done payload
        const lines = [
          JSON.stringify({
            type: "progress",
            modelId: "model-1",
            index: 0,
            total: 42,
            record: { tested: true, classification: "success", statusCode: 200, reason: "success", latencyMs: 10 },
            summary: { tested: 1, total: 42, disabled: 0, skipped: 0 },
          }),
          JSON.stringify({
            type: "progress",
            modelId: "model-2",
            index: 1,
            total: 42,
            record: { tested: true, classification: "success", statusCode: 200, reason: "success", latencyMs: 10 },
            summary: { tested: 2, total: 42, disabled: 0, skipped: 0 },
          }),
          JSON.stringify({
            type: "progress",
            modelId: "model-3",
            index: 2,
            total: 42,
            record: { tested: true, classification: "success", statusCode: 200, reason: "success", latencyMs: 10 },
            summary: { tested: 3, total: 42, disabled: 0, skipped: 0 },
          }),
        ];
        const payload = lines.join("\n") + "\n";
        const readable = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(payload));
            ctrl.close(); // Truncated stream: EOF without done payload!
          },
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/x-ndjson; charset=utf-8" }),
          body: readable,
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
            connections: [{ id: "c1", isActive: true }],
            visibleModelIds: modelIds,
          })
        );
      });

      const testTabBtn = findButtonByText(renderer.root, "Test All (");
      await act(async () => {
        testTabBtn.props.onClick();
      });

      const startBtn = findButtonByText(renderer.root, "Start Batch Test");
      await act(async () => {
        await startBtn.props.onClick();
      });

      const renderedText = getTextFromChildren(renderer.toJSON());
      // Expect error alert informing user of premature stream termination
      expect(renderedText).toContain("ended prematurely without completion");
      // Expect partial completed results to be preserved (3 tested, 39 skipped)
      expect(renderedText).toContain("Passed 3");
      expect(renderedText).toContain("Skipped 39");
      expect(renderedText).not.toContain("Cancel Test");
    } finally {
      renderer?.unmount();
    }
  });
});

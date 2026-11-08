import { describe, it, expect, vi } from "vitest";
import {
  runModelTestBatch,
  MODEL_TEST_CLASSIFICATION,
  MODEL_TEST_REASON,
} from "@/lib/models/modelTestBatch.js";

describe("runModelTestBatch (Spec 017 Core)", () => {
  describe("Input Validation & Request Sanitization", () => {
    it("rejects non-array modelIds", async () => {
      await expect(runModelTestBatch({ modelIds: null, probe: vi.fn() })).rejects.toThrow(TypeError);
      await expect(runModelTestBatch({ modelIds: "gpt-4", probe: vi.fn() })).rejects.toThrow(TypeError);
    });

    it("rejects empty modelIds array or array exceeding hard cap", async () => {
      await expect(runModelTestBatch({ modelIds: [], probe: vi.fn() })).rejects.toThrow(RangeError);

      const tooMany = Array.from({ length: 101 }, (_, i) => `model-${i}`);
      await expect(runModelTestBatch({ modelIds: tooMany, probe: vi.fn() })).rejects.toThrow(RangeError);

      const customMax = Array.from({ length: 6 }, (_, i) => `model-${i}`);
      await expect(
        runModelTestBatch({ modelIds: customMax, maxModels: 5, probe: vi.fn() })
      ).rejects.toThrow(RangeError);
    });

    it("rejects caller-supplied maxModels that attempts to bypass the 100 model cap", async () => {
      const probe = vi.fn();
      await expect(
        runModelTestBatch({
          modelIds: Array.from({ length: 101 }, (_, i) => `model-${i}`),
          maxModels: 1000,
          probe,
        })
      ).rejects.toThrow(RangeError);
      expect(probe).not.toHaveBeenCalled();
    });

    it("rejects invalid options (negative intervalMs, invalid maxBatchDurationMs, invalid thresholds)", async () => {
      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), intervalMs: -50 })
      ).rejects.toThrow(RangeError);

      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), intervalMs: NaN })
      ).rejects.toThrow(RangeError);

      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), maxBatchDurationMs: 0 })
      ).rejects.toThrow(RangeError);

      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), maxBatchDurationMs: Infinity })
      ).rejects.toThrow(RangeError);

      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), rateLimitThreshold: 0 })
      ).rejects.toThrow(RangeError);

      await expect(
        runModelTestBatch({ modelIds: ["m1"], probe: vi.fn(), botBlockThreshold: -1 })
      ).rejects.toThrow(RangeError);
    });

    it("rejects non-string or empty model IDs", async () => {
      await expect(
        runModelTestBatch({ modelIds: ["valid-1", 123], probe: vi.fn() })
      ).rejects.toThrow(TypeError);

      await expect(
        runModelTestBatch({ modelIds: ["valid-1", "   "], probe: vi.fn() })
      ).rejects.toThrow(/must not be empty/);
    });

    it("rejects model IDs exceeding 256 characters", async () => {
      const longId = "a".repeat(257);
      await expect(
        runModelTestBatch({ modelIds: ["valid-1", longId], probe: vi.fn() })
      ).rejects.toThrow(RangeError);
    });

    it("rejects model IDs containing forbidden control characters or NUL byte", async () => {
      await expect(
        runModelTestBatch({ modelIds: ["valid-1", "model\0null"], probe: vi.fn() })
      ).rejects.toThrow(/forbidden control characters/);

      await expect(
        runModelTestBatch({ modelIds: ["valid-1", "model\x1btest"], probe: vi.fn() })
      ).rejects.toThrow(/forbidden control characters/);
    });

    it("rejects duplicate model IDs after trimming whitespace", async () => {
      await expect(
        runModelTestBatch({ modelIds: ["model-alpha", " model-alpha "], probe: vi.fn() })
      ).rejects.toThrow(/duplicate modelId/);
    });

    it("rejects invalid probe function", async () => {
      await expect(
        runModelTestBatch({ modelIds: ["model-1"], probe: "not-a-func" })
      ).rejects.toThrow(TypeError);
    });

    it("rejects autoDisable === true when disableModel is not a function", async () => {
      await expect(
        runModelTestBatch({
          modelIds: ["model-1"],
          probe: vi.fn(),
          autoDisable: true,
          disableModel: null,
        })
      ).rejects.toThrow(TypeError);
    });

    it("stores legal prototype-shaped model IDs without pollution or hiding rows", async () => {
      const batch = await runModelTestBatch({
        modelIds: ["__proto__"],
        probe: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      });
      expect(Object.hasOwn(batch.results, "__proto__")).toBe(true);
      expect(Object.keys(batch.results)).toEqual(["__proto__"]);
      expect(batch.results.__proto__.tested).toBe(true);
    });
  });

  describe("Sequential Execution & Basic Batch Contract", () => {
    it("executes probes strictly one-at-a-time and returns expected batch contract with latencyMs", async () => {
      let activeProbes = 0;
      let maxActiveProbes = 0;
      const sleepMock = vi.fn().mockResolvedValue();

      const probe = vi.fn().mockImplementation(async (modelId) => {
        activeProbes++;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        await new Promise((r) => setTimeout(r, 10));
        activeProbes--;
        return { ok: true, status: 200, modelId, latencyMs: 42 };
      });

      const batch = await runModelTestBatch({
        modelIds: ["model-1", "model-2", "model-3"],
        probe,
        sleep: sleepMock,
        intervalMs: 50,
      });

      expect(maxActiveProbes).toBe(1);
      expect(batch.batchId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(batch.stoppedEarly).toBe(false);
      expect(batch.stopReason).toBeNull();
      expect(batch.summary).toEqual({
        tested: 3,
        total: 3,
        disabled: 0,
        skipped: 0,
      });

      expect(batch.results["model-1"].tested).toBe(true);
      expect(batch.results["model-1"].classification).toBe(MODEL_TEST_CLASSIFICATION.SUCCESS);
      expect(batch.results["model-1"].latencyMs).toBe(42);
      expect(batch.results["model-2"].tested).toBe(true);
      expect(batch.results["model-3"].tested).toBe(true);

      expect(sleepMock).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(50, expect.any(Object));
    });
  });

  describe("Immediate Quota, Auth, & Access Halt Controls", () => {
    it("immediately halts on quota exhaustion to avoid burning provider", async () => {
      const probe = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({
          status: 429,
          error: { message: "Daily quota exceeded for this account" },
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const sleepMock = vi.fn().mockResolvedValue();

      const batch = await runModelTestBatch({
        modelIds: ["model-1", "model-2", "model-3"],
        probe,
        sleep: sleepMock,
      });

      expect(probe).toHaveBeenCalledTimes(2);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.QUOTA_EXHAUSTED);
      expect(batch.summary).toEqual({
        tested: 2,
        total: 3,
        disabled: 0,
        skipped: 1,
      });

      expect(batch.results["model-2"].classification).toBe(MODEL_TEST_CLASSIFICATION.QUOTA_COST);
      expect(batch.results["model-3"]).toEqual({
        tested: false,
        status: "skipped",
        reason: MODEL_TEST_REASON.QUOTA_EXHAUSTED,
        disabled: false,
      });
    });

    it("immediately halts on access restriction (regional block or permission denied)", async () => {
      const probe = vi.fn().mockResolvedValueOnce({
        status: 403,
        error: { code: "permission_denied", message: "User account suspended or restricted" },
      });

      const batch = await runModelTestBatch({
        modelIds: ["model-1", "model-2"],
        probe,
        sleep: vi.fn(),
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.ACCESS_RESTRICTED);
      expect(batch.summary).toEqual({
        tested: 1,
        total: 2,
        disabled: 0,
        skipped: 1,
      });

      expect(batch.results["model-1"].classification).toBe(MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION);
      expect(batch.results["model-2"].tested).toBe(false);
    });

    it("immediately halts on 401 auth_failure to prevent hammering invalid credentials", async () => {
      const probe = vi.fn()
        .mockResolvedValueOnce({ status: 401, error: "Invalid API Key" })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2"],
        probe,
        sleep: vi.fn(),
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.AUTH_FAILURE);
      expect(batch.summary.tested).toBe(1);
      expect(batch.summary.skipped).toBe(1);
      expect(batch.results.m2.tested).toBe(false);
      expect(batch.results.m2.reason).toBe(MODEL_TEST_REASON.AUTH_FAILURE);
    });
  });

  describe("Consecutive Throttle & Bot Block Thresholds", () => {
    it("halts after rateLimitThreshold (3) consecutive transient 429 responses", async () => {
      const probe = vi.fn()
        .mockResolvedValueOnce({ status: 429, error: "Too many requests (RPM)" })
        .mockResolvedValueOnce({ status: 429, error: "Too many requests (RPM)" })
        .mockResolvedValueOnce({ status: 429, error: "Too many requests (RPM)" })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2", "m3", "m4"],
        probe,
        rateLimitThreshold: 3,
        sleep: vi.fn().mockResolvedValue(),
      });

      expect(probe).toHaveBeenCalledTimes(3);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.CONSECUTIVE_RATE_LIMITS);
      expect(batch.summary).toEqual({
        tested: 3,
        total: 4,
        disabled: 0,
        skipped: 1,
      });
      expect(batch.results["m4"].tested).toBe(false);
    });

    it("resets consecutive rate limit counter when a non-throttle response occurs", async () => {
      const probe = vi.fn()
        .mockResolvedValueOnce({ status: 429, error: "Too many requests" })
        .mockResolvedValueOnce({ status: 429, error: "Too many requests" })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ status: 429, error: "Too many requests" });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2", "m3", "m4"],
        probe,
        rateLimitThreshold: 3,
        sleep: vi.fn().mockResolvedValue(),
      });

      expect(probe).toHaveBeenCalledTimes(4);
      expect(batch.stoppedEarly).toBe(false);
      expect(batch.summary.tested).toBe(4);
      expect(batch.summary.skipped).toBe(0);
    });

    it("halts after botBlockThreshold (2) consecutive bot 403 blocks", async () => {
      const probe = vi.fn()
        .mockResolvedValueOnce({ status: 403, error: "Forbidden (Cloudflare challenge)" })
        .mockResolvedValueOnce({ status: 403, error: "Forbidden (Cloudflare challenge)" })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2", "m3"],
        probe,
        botBlockThreshold: 2,
        sleep: vi.fn().mockResolvedValue(),
      });

      expect(probe).toHaveBeenCalledTimes(2);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.CONSECUTIVE_BOT_BLOCKS);
      expect(batch.summary.skipped).toBe(1);
    });
  });

  describe("Hard Failure Disabling & Persistence Safety", () => {
    it("does not disable model when autoDisable === false even if hard failure occurs", async () => {
      const disableModel = vi.fn();
      const probe = vi.fn().mockResolvedValue({
        status: 404,
        error: { code: "model_not_found", message: "Model does not exist" },
      });

      const batch = await runModelTestBatch({
        modelIds: ["bad-model"],
        probe,
        autoDisable: false,
        disableModel,
      });

      expect(batch.results["bad-model"].classification).toBe(MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE);
      expect(batch.results["bad-model"].disableEligible).toBe(true);
      expect(batch.results["bad-model"].disabled).toBe(false);
      expect(batch.summary.disabled).toBe(0);
      expect(disableModel).not.toHaveBeenCalled();
    });

    it("awaits disableModel with clean payload when autoDisable === true and records disabled status", async () => {
      const disableModel = vi.fn().mockResolvedValue({ ok: true });
      const probe = vi.fn().mockResolvedValue({
        status: 404,
        error: { code: "model_not_found", message: "Model does not exist" },
      });

      const batch = await runModelTestBatch({
        modelIds: ["missing-model"],
        probe,
        autoDisable: true,
        disableModel,
      });

      expect(disableModel).toHaveBeenCalledTimes(1);
      expect(disableModel).toHaveBeenCalledWith({
        id: "missing-model",
        reason: MODEL_TEST_REASON.MODEL_NOT_FOUND,
        disabledAt: expect.any(String),
        batchId: batch.batchId,
      });

      expect(batch.results["missing-model"].disabled).toBe(true);
      expect(batch.results["missing-model"].disabledAt).toBeDefined();
      expect(batch.summary.disabled).toBe(1);
    });

    it("handles persistence failure safely without crashing batch or pretending model is disabled", async () => {
      const disableModel = vi.fn().mockRejectedValue(new Error("SQLite database locked: SQLITE_BUSY"));
      const probe = vi.fn().mockResolvedValue({
        status: 404,
        error: { code: "model_not_found", message: "Model does not exist" },
      });

      const batch = await runModelTestBatch({
        modelIds: ["failing-db-model"],
        probe,
        autoDisable: true,
        disableModel,
      });

      expect(batch.results["failing-db-model"].disabled).toBe(false);
      expect(batch.results["failing-db-model"].persistenceError).toBe(MODEL_TEST_REASON.FAILED_TO_DISABLE);
      expect(batch.summary.disabled).toBe(0);
      expect(batch.stoppedEarly).toBe(false);
    });
  });

  describe("Pacing Floor, Upstream Retry-After, and Batch Deadline", () => {
    it("honors upstream Retry-After as floor for next call", async () => {
      const sleepMock = vi.fn().mockResolvedValue();
      const probe = vi.fn()
        .mockResolvedValueOnce({
          status: 429,
          headers: { "retry-after": "5" },
          error: "Short rate limit",
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await runModelTestBatch({
        modelIds: ["m1", "m2"],
        probe,
        intervalMs: 1000,
        sleep: sleepMock,
      });

      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(5000, expect.any(Object));
    });

    it("stops rather than shortens delay if pacing floor exceeds total batch deadline", async () => {
      const sleepMock = vi.fn().mockResolvedValue();
      const probe = vi.fn().mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "60" },
        error: "Short rate limit",
      });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2"],
        probe,
        maxBatchDurationMs: 5000,
        sleep: sleepMock,
      });

      expect(sleepMock).not.toHaveBeenCalled();
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.BATCH_TIMEOUT);
      expect(batch.summary.skipped).toBe(1);
    });

    it("stops at total deadline and never hangs or overlaps when probe promise never settles", async () => {
      vi.useFakeTimers();
      try {
        let completed = false;
        let batchResult = null;

        const hangingProbe = vi.fn().mockImplementation(() => new Promise(() => {}));

        const promise = runModelTestBatch({
          modelIds: ["hang-1", "hang-2"],
          maxBatchDurationMs: 500,
          probe: hangingProbe,
        }).then((res) => {
          completed = true;
          batchResult = res;
        });

        await vi.advanceTimersByTimeAsync(600);
        expect(completed).toBe(true);
        expect(batchResult.stoppedEarly).toBe(true);
        expect(batchResult.stopReason).toBe(MODEL_TEST_REASON.BATCH_TIMEOUT);
        expect(hangingProbe).toHaveBeenCalledTimes(1); // Never launched probe 2!
        expect(batchResult.summary.skipped).toBe(2);
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("AbortSignal Handling & Clean Listener Lifecycle", () => {
    it("stops immediately if signal is already aborted before starting", async () => {
      const controller = new AbortController();
      controller.abort();

      const probe = vi.fn();
      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2"],
        probe,
        signal: controller.signal,
      });

      expect(probe).not.toHaveBeenCalled();
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.ABORTED);
      expect(batch.summary.tested).toBe(0);
      expect(batch.summary.skipped).toBe(2);
    });

    it("halts cleanly when aborted mid-batch without dangling sleep or unhandled rejections", async () => {
      const controller = new AbortController();
      const probe = vi.fn().mockImplementation(async (id) => {
        if (id === "m2") {
          controller.abort();
        }
        return { ok: true, status: 200 };
      });

      const batch = await runModelTestBatch({
        modelIds: ["m1", "m2", "m3"],
        probe,
        signal: controller.signal,
        intervalMs: 100,
      });

      expect(probe).toHaveBeenCalledTimes(2);
      expect(batch.stoppedEarly).toBe(true);
      expect(batch.stopReason).toBe(MODEL_TEST_REASON.ABORTED);
      expect(batch.summary.tested).toBe(2);
      expect(batch.summary.skipped).toBe(1);
      expect(batch.results["m3"].tested).toBe(false);
    });
  });
});

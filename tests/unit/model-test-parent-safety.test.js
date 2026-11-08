import { describe, expect, it, vi } from "vitest";
import { classifyModelTestResult, runModelTestBatch } from "../../src/lib/models/modelTestBatch.js";

describe("independent batch testing safety", () => {
  it("does not disable ambiguous model-or-access denial", () => {
    const result = classifyModelTestResult({ status: 404, error: { code: "model_not_found", message: "The model example does not exist or you do not have access to it." } });
    expect(result.disableEligible).toBe(false);
  });
  it("returns a result for a legal prototype-shaped model ID", async () => {
    const result = await runModelTestBatch({ modelIds: ["__proto__"], probe: async () => ({ ok: true }) });
    expect(Object.hasOwn(result.results, "__proto__")).toBe(true);
    expect(Object.keys(result.results)).toEqual(["__proto__"]);
  });
  it("rejects caller-supplied bounds that would exceed the hard model cap before any call", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    await expect(runModelTestBatch({ modelIds: Array.from({ length: 101 }, (_, n) => `m${n}`), maxModels: 1000, intervalMs: 0, probe })).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });
  it("stops at the total deadline even if a probe never settles", async () => {
    vi.useFakeTimers();
    try {
      let completed = false;
      let result;
      const running = runModelTestBatch({ modelIds: ["one", "two"], maxBatchDurationMs: 1000, probe: async () => new Promise(() => {}) })
        .then((value) => { completed = true; result = value; });
      await vi.advanceTimersByTimeAsync(1100);
      expect(completed).toBe(true);
      expect(result.stopReason).toBe("batch_timeout");
      await running;
    } finally { vi.useRealTimers(); }
  });
});

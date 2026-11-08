import { describe, expect, it, vi } from "vitest";
import { executeComboUpdateTransaction } from "../../src/app/(dashboard)/dashboard/combos/comboUpdateHelper.js";

describe("independent combo save recovery truthfulness", () => {
  it.each(["throws", "rejects"])("does not claim rollback succeeded when compensating update %s", async (mode) => {
    const updateComboApi = vi.fn().mockResolvedValueOnce({ ok: true });
    if (mode === "throws") updateComboApi.mockRejectedValueOnce(new Error("offline"));
    else updateComboApi.mockResolvedValueOnce({ ok: false, error: "conflict" });
    const result = await executeComboUpdateTransaction({
      id: "combo-one", oldCombo: { name: "old", models: ["a/m"] },
      newComboData: { name: "new", models: ["b/m"] }, memberCooldownMs: 60000,
      comboStrategies: { old: { fallbackStrategy: "round-robin" } },
      updateComboApi, persistStrategiesApi: async () => { throw new Error("settings unavailable"); },
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/rollback|recover|partial|inconsistent/i);
  });
});

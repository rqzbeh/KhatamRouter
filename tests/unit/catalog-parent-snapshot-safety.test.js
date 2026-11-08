import { describe, expect, it } from "vitest";
import { reconcileCatalog } from "../../src/lib/models/catalogReconcile.js";

const previous = [{ id: "known", capabilities: { supportsVision: true } }, { id: "retained", capabilities: {} }];

describe("independent authoritative snapshot safety", () => {
  it("never prunes when a declared-complete listing contains invalid records", () => {
    const result = reconcileCatalog({ previous, listing: { complete: true, models: [{ id: "known" }, null] } });
    expect(result.remove).toEqual([]);
    expect(result.skipped.invalid).toBe(1);
    expect(result.skipped.prune).toBeTruthy();
  });

  it("applies an explicit false capability update instead of retaining obsolete true", () => {
    const result = reconcileCatalog({
      previous,
      listing: { complete: true, models: [{ id: "known", supportsVision: false }, { id: "retained" }] },
    });
    expect(result.update.find((record) => record.id === "known")?.changes.supportsVision).toBe(false);
  });

  it("rejects negative or non-finite limit enrichment rather than publishing it", () => {
    const result = reconcileCatalog({ previous: [], listing: { complete: true, models: [{ id: "new" }] },
      enrichment: { new: { contextWindow: Infinity, maxOutputTokens: -1 } } });
    expect(result.add[0].capabilities.contextWindow).toBeUndefined();
    expect(result.add[0].capabilities.maxOutputTokens).toBeUndefined();
  });
});

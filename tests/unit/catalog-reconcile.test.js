import { describe, expect, it } from "vitest";
import { reconcileCatalog, FIELD_SOURCES } from "@/lib/models/catalogReconcile.js";

const listing = (models, extra = {}) => ({ complete: true, authoritativeEmpty: false, models, ...extra });
const m = (id, over = {}) => ({ id, name: id, contextWindow: 128000, supportsVision: false, ...over });
const prev = (entries) => entries.map((e) => ({ id: e.id, lifecycle: "active", capabilities: {}, ...e }));
const ids = (list) => list.map((x) => x.id).sort();

describe("reconcileCatalog: add / update / remove", () => {
  it("adds models that are new in a listing", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "a", capabilities: { contextWindow: 128000 } }]),
      listing: listing([m("a"), m("b")]),
    });
    expect(ids(r.add)).toEqual(["b"]);
    expect(ids(r.unchanged)).toEqual(["a"]);
    expect(r.remove).toEqual([]);
  });

  it("removes models missing from a COMPLETE authoritative listing", () => {
    const r = reconcileCatalog({ previous: prev([{ id: "a" }, { id: "old" }]), listing: listing([m("a")]) });
    expect(ids(r.remove)).toEqual(["old"]);
    expect(r.skipped.prune).toBeNull();
  });

  it("updates a model whose listed capabilities changed", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "a", capabilities: { contextWindow: 8000, supportsVision: false } }]),
      listing: listing([m("a", { contextWindow: 200000, supportsVision: true })]),
    });
    expect(ids(r.update)).toEqual(["a"]);
    expect(r.update[0].changes).toEqual({ contextWindow: 200000, supportsVision: true });
    expect(r.update[0].provenance.contextWindow).toBe(FIELD_SOURCES.LISTING);
  });

  it("is idempotent: reconciling the result again changes nothing", () => {
    const first = reconcileCatalog({ previous: [], listing: listing([m("a"), m("b")]) });
    const snapshot = first.add.map((x) => ({ id: x.id, lifecycle: "active", capabilities: x.capabilities }));
    const second = reconcileCatalog({ previous: snapshot, listing: listing([m("a"), m("b")]) });
    expect(second.add).toEqual([]);
    expect(second.update).toEqual([]);
    expect(second.remove).toEqual([]);
  });
});

describe("reconcileCatalog: never prune on untrustworthy input", () => {
  const before = prev([{ id: "a" }, { id: "b" }]);
  it.each([
    ["incomplete listing", { complete: false, models: [m("a")] }, "incomplete_listing"],
    ["empty listing without the authoritative flag", { complete: true, models: [] }, "authoritative_empty_required"],
    ["fallback/static listing", { complete: true, fallback: true, models: [m("a")] }, "fallback_listing"],
  ])("%s removes nothing and reports why", (_n, l, reason) => {
    const r = reconcileCatalog({ previous: before, listing: { authoritativeEmpty: false, ...l } });
    expect(r.remove).toEqual([]);
    expect(r.skipped.prune).toBe(reason);
    // additions from a partial listing are still safe and still reported
    expect(Array.isArray(r.add)).toBe(true);
  });

  it("removes everything only for an explicitly authoritative empty listing", () => {
    const r = reconcileCatalog({ previous: before, listing: listing([], { authoritativeEmpty: true }) });
    expect(ids(r.remove)).toEqual(["a", "b"]);
  });

  it("treats a failed fetch (listing null) as skip, not as empty", () => {
    const r = reconcileCatalog({ previous: before, listing: null });
    expect(r.remove).toEqual([]);
    expect(r.add).toEqual([]);
    expect(r.skipped.prune).toBe("no_listing");
  });
});

describe("reconcileCatalog: manual overrides always win", () => {
  it("does not update a manually pinned field and reports the divergence", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "a", capabilities: { contextWindow: 1000000 } }]),
      listing: listing([m("a", { contextWindow: 200000 })]),
      overrides: { a: { contextWindow: { value: 1000000, source: "manual" } } },
    });
    expect(r.update).toEqual([]);
    expect(r.divergences).toEqual([
      { id: "a", field: "contextWindow", manual: 1000000, discovered: 200000 },
    ]);
  });

  it("keeps a model that has a manual override even if the listing dropped it", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "a" }, { id: "gone" }]),
      listing: listing([m("a")]),
      overrides: { gone: { supportsVision: { value: true, source: "manual" } } },
    });
    expect(r.remove).toEqual([]);
    expect(ids(r.stale)).toEqual(["gone"]);
  });

  it("keeps a manually authored model that no listing advertises", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "mine", provenance: "manual" }, { id: "x" }]),
      listing: listing([m("x")]),
    });
    expect(r.remove).toEqual([]);
  });

  it("ignores auto:discovery overrides when deciding what is protected", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "gone" }]),
      listing: listing([m("other")]),
      overrides: { gone: { contextWindow: { value: 1, source: "auto:discovery" } } },
    });
    expect(ids(r.remove)).toEqual(["gone"]);
  });
});

describe("reconcileCatalog: unknown stays unknown", () => {
  it("never turns a missing capability into false", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([{ id: "a", name: "a" }]), // listing says nothing about vision/reasoning
    });
    const caps = r.add[0].capabilities;
    expect(caps.supportsVision).toBeUndefined();
    expect(caps.supportsReasoning).toBeUndefined();
    expect(r.add[0].provenance.supportsVision).toBe(FIELD_SOURCES.UNKNOWN);
  });

  it("does not downgrade a known value when the listing omits it", () => {
    const r = reconcileCatalog({
      previous: prev([{ id: "a", capabilities: { supportsVision: true, contextWindow: 9000 } }]),
      listing: listing([{ id: "a", name: "a" }]),
    });
    expect(r.update).toEqual([]);
    expect(ids(r.unchanged)).toEqual(["a"]);
  });

  it("fills only the fields the listing lacks from enrichment, with provenance", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([{ id: "a", name: "a", contextWindow: 64000 }]),
      enrichment: { a: { contextWindow: 999, supportsVision: true, maxOutputTokens: 8192 } },
    });
    const a = r.add[0];
    expect(a.capabilities.contextWindow).toBe(64000); // listing beats enrichment
    expect(a.capabilities.supportsVision).toBe(true);
    expect(a.capabilities.maxOutputTokens).toBe(8192);
    expect(a.provenance.contextWindow).toBe(FIELD_SOURCES.LISTING);
    expect(a.provenance.supportsVision).toBe(FIELD_SOURCES.ENRICHMENT);
  });
});

describe("reconcileCatalog: robustness and determinism", () => {
  it("drops malformed listing records without throwing and counts them", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([m("a"), null, "str", { id: "" }, { name: "no-id" }, 42]),
    });
    expect(ids(r.add)).toEqual(["a"]);
    expect(r.skipped.invalid).toBe(5);
  });

  it("dedupes repeated ids in a listing, last one wins", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([m("a", { contextWindow: 1 }), m("a", { contextWindow: 2 })]),
    });
    expect(r.add).toHaveLength(1);
    expect(r.add[0].capabilities.contextWindow).toBe(2);
  });

  it("returns results in a stable sorted order regardless of input order", () => {
    const a = reconcileCatalog({ previous: [], listing: listing([m("c"), m("a"), m("b")]) });
    const b = reconcileCatalog({ previous: [], listing: listing([m("b"), m("c"), m("a")]) });
    expect(a.add.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate its inputs", () => {
    const previous = prev([{ id: "a" }, { id: "old" }]);
    const l = listing([m("a"), m("b")]);
    const snapPrev = JSON.stringify(previous);
    const snapList = JSON.stringify(l);
    reconcileCatalog({ previous, listing: l });
    expect(JSON.stringify(previous)).toBe(snapPrev);
    expect(JSON.stringify(l)).toBe(snapList);
  });

  it("keeps token-LIMIT fields while still scrubbing credential keys", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([{ id: "a", name: "a", maxOutputTokens: 4096, contextWindow: 8000 }]),
    });
    expect(r.add[0].capabilities.maxOutputTokens).toBe(4096);
    const s = reconcileCatalog({
      previous: [],
      listing: listing([{ id: "b", name: "b", raw: { access_token: "abc123def456", refreshToken: "r-9999999", client_secret: "zzzzzzzz" } }]),
    });
    expect(JSON.stringify(s)).not.toMatch(/abc123def456|r-9999999|zzzzzzzz/);
  });

  it("does not carry secrets from the raw payload into results", () => {
    const r = reconcileCatalog({
      previous: [],
      listing: listing([{ id: "a", name: "a", raw: { apiKey: "sk-live-secret-123456", token: "t0k3n-abcdef" } }]),
    });
    expect(JSON.stringify(r)).not.toMatch(/sk-live-secret|t0k3n-abcdef/);
  });
});

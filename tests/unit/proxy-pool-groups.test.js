import { describe, it, expect } from "vitest";
import {
  GROUP_LABELS,
  poolSourceKey,
  groupPools,
} from "@/lib/network/proxyPoolGroups.js";

describe("proxyPoolGroups", () => {
  describe("GROUP_LABELS", () => {
    it("is frozen and contains expected labels in canonical keys", () => {
      expect(Object.isFrozen(GROUP_LABELS)).toBe(true);
      expect(GROUP_LABELS).toEqual({
        oneproxy: "1proxy (free feed)",
        proxifly: "Proxifly (free feed)",
        iplocate: "IPLocate (free feed)",
        psiphon: "Psiphon rotating tunnel",
        opencode2api: "WARP rotating egress (opencode2api)",
        manual: "Manual / relay pools",
      });
    });
  });

  describe("poolSourceKey mapping", () => {
    it("maps free feeds from pool.provenance.source", () => {
      expect(poolSourceKey({ provenance: { source: "free:oneproxy" } })).toBe("oneproxy");
      expect(poolSourceKey({ provenance: { source: "free:proxifly" } })).toBe("proxifly");
      expect(poolSourceKey({ provenance: { source: "free:iplocate" } })).toBe("iplocate");
    });

    it("maps free feeds from pool.data.provenance.source fallback", () => {
      expect(poolSourceKey({ data: { provenance: { source: "free:oneproxy" } } })).toBe("oneproxy");
      expect(poolSourceKey({ data: { provenance: { source: "free:proxifly" } } })).toBe("proxifly");
      expect(poolSourceKey({ data: { provenance: { source: "free:iplocate" } } })).toBe("iplocate");
    });

    it("maps special tunnel types psiphon and opencode2api from pool.type", () => {
      expect(poolSourceKey({ type: "psiphon" })).toBe("psiphon");
      expect(poolSourceKey({ type: "opencode2api" })).toBe("opencode2api");
    });

    it("maps empty/null/undefined or non-matching pools to manual", () => {
      expect(poolSourceKey(null)).toBe("manual");
      expect(poolSourceKey(undefined)).toBe("manual");
      expect(poolSourceKey({})).toBe("manual");
      expect(poolSourceKey({ type: "http" })).toBe("manual");
      expect(poolSourceKey({ type: "socks5" })).toBe("manual");
      expect(poolSourceKey({ provenance: { source: "other" }, type: "http" })).toBe("manual");
    });

    it("prioritizes free provenance over pool.type", () => {
      expect(
        poolSourceKey({
          type: "http",
          provenance: { source: "free:oneproxy" },
        })
      ).toBe("oneproxy");
    });
  });

  describe("groupPools", () => {
    it("returns an empty array for empty or non-array input", () => {
      expect(groupPools([])).toEqual([]);
      expect(groupPools(null)).toEqual([]);
      expect(groupPools(undefined)).toEqual([]);
    });

    it("preserves fixed group ordering regardless of input ordering", () => {
      const pools = [
        { id: "m1", name: "Manual Pool B", type: "http" },
        { id: "w1", name: "WARP 1", type: "opencode2api" },
        { id: "p1", name: "Psiphon 1", type: "psiphon" },
        { id: "f1", name: "Free Oneproxy", provenance: { source: "free:oneproxy" } },
        { id: "f2", name: "Free IPLocate", provenance: { source: "free:iplocate" } },
        { id: "f3", name: "Free Proxifly", provenance: { source: "free:proxifly" } },
      ];

      const groups = groupPools(pools);
      const keys = groups.map((g) => g.key);

      expect(keys).toEqual([
        "psiphon",
        "opencode2api",
        "oneproxy",
        "proxifly",
        "iplocate",
        "manual",
      ]);
      expect(groups.map((g) => g.label)).toEqual([
        "Psiphon rotating tunnel",
        "WARP rotating egress (opencode2api)",
        "1proxy (free feed)",
        "Proxifly (free feed)",
        "IPLocate (free feed)",
        "Manual / relay pools",
      ]);
    });

    it("omits empty groups", () => {
      const pools = [
        { id: "p1", name: "Psiphon", type: "psiphon" },
        { id: "m1", name: "Relay", type: "http" },
      ];

      const groups = groupPools(pools);
      expect(groups.map((g) => g.key)).toEqual(["psiphon", "manual"]);
    });

    it("sorts pools within each group alphabetically by name", () => {
      const pools = [
        { id: "o3", name: "Zebra Proxy", provenance: { source: "free:oneproxy" } },
        { id: "o1", name: "Alpha Proxy", provenance: { source: "free:oneproxy" } },
        { id: "o2", name: "Beta Proxy", provenance: { source: "free:oneproxy" } },
      ];

      const groups = groupPools(pools);
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe("oneproxy");
      expect(groups[0].pools.map((p) => p.name)).toEqual([
        "Alpha Proxy",
        "Beta Proxy",
        "Zebra Proxy",
      ]);
    });
  });
});

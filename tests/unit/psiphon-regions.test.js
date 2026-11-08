import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PSIPHON_SELECTABLE_REGIONS } from "@/lib/network/psiphon/regions.js";
import { validateRegion, validateRegions } from "@/lib/network/psiphon/config.js";
import regionhopRelease from "@/lib/network/psiphon/regionhopRelease.json" with { type: "json" };

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("Psiphon selectable region list", () => {
  it("contains BR exactly once as a valid ISO alpha-2 code", () => {
    expect(PSIPHON_SELECTABLE_REGIONS).toContain("BR");
    expect(PSIPHON_SELECTABLE_REGIONS.filter((r) => r === "BR")).toHaveLength(1);
    for (const region of PSIPHON_SELECTABLE_REGIONS) {
      expect(region).toMatch(/^[A-Z]{2}$/);
    }
    expect(new Set(PSIPHON_SELECTABLE_REGIONS).size).toBe(PSIPHON_SELECTABLE_REGIONS.length);
  });

  it("BR is selectable through the same validation used for every other entry", () => {
    expect(validateRegion("BR")).toBe(true);
    expect(() => validateRegions(["US", "BR"])).not.toThrow();
  });

  it("BR is exposed only by a release that provides it (regionhop >= v1.27.0)", () => {
    if (!PSIPHON_SELECTABLE_REGIONS.includes("BR")) return;
    const [major, minor] = regionhopRelease.version.replace(/^v/, "").split(".").map(Number);
    const atLeast127 = major > 1 || (major === 1 && minor >= 27);
    expect(atLeast127, `BR requires regionhop >= v1.27.0, pinned ${regionhopRelease.version}`).toBe(true);
  });

  it("the dashboard region field renders the selectable list instead of a hardcoded string", () => {
    const page = fs.readFileSync(
      path.join(REPO_ROOT, "src/app/(dashboard)/dashboard/proxy-pools/page.js"),
      "utf8"
    );
    expect(page).toContain("PSIPHON_SELECTABLE_REGIONS.join");
    expect(page).toContain('from "@/lib/network/psiphon/regions.js"');
  });

  it("selectable list does not narrow validation (any ISO-2 code still accepted)", () => {
    // A code outside the UI list must remain configurable via the API.
    expect(validateRegion("ZA")).toBe(true);
    expect(() => validateRegions(["ZA", "AR"])).not.toThrow();
  });
});

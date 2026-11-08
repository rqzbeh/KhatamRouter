import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let directory;
const originalDir = process.env.DATA_DIR;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "override-parent-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter;
  vi.resetModules();
});
afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDir;
  vi.restoreAllMocks();
});
describe("independent model override cache safety", () => {
  it("does not let capability payload fields replace trusted provider identity", async () => {
    const repo = await import("@/lib/db/repos/modelMetadataRepo.js");
    await repo.upsertCapabilityOverride({ provider: "openai", modelId: "fixture", capabilities: { supportsVision: true, provider: "attacker-provider", modelId: "attacker-model", source: "auto:discovery" }, source: "manual" });
    const cache = await import("@/lib/models/overrideCache.js");
    const view = await cache.initializeOverrideCache();
    const row = view.manualOverrides.find((entry) => entry.provider === "openai" && entry.modelId === "fixture");
    expect(row).toBeDefined();
    expect(view.manualOverrides.some((entry) => entry.provider === "attacker-provider")).toBe(false);
  });
  it("does not reload all override rows on each already-initialized request", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const cache = await import("@/lib/models/overrideCache.js");
    await cache.initializeOverrideCache();
    const adapter = await getAdapter();
    const all = vi.spyOn(adapter, "all");
    await cache.initializeOverrideCache();
    await cache.initializeOverrideCache();
    expect(all).not.toHaveBeenCalled();
  });
});

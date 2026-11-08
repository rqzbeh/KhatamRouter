import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
let directory;
const original = process.env.DATA_DIR;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-parent-shared-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter;
  vi.resetModules();
});
afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(directory, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
});

describe("independent importer shared-source safety", () => {
  it("never removes a shared custom model while another connection still advertises it", async () => {
    const metadata = await import("@/lib/db/repos/modelMetadataRepo.js");
    const aliases = await import("@/lib/db/repos/aliasRepo.js");
    const { importProviderModels } = await import("@/lib/models/importOrchestrator.js");
    const repo = { ...metadata, ...aliases };
    const run = (connectionId, ids) => importProviderModels({
      provider: "fixture", providerAlias: "fixture", connectionId, repo,
      discover: async () => ({ complete: true, models: ids.map((id) => ({ id, context_length: 8000 })) }),
    });
    await run("one", ["shared", "keep"]);
    await run("two", ["shared"]);
    await run("one", ["keep"]);
    expect((await aliases.getCustomModels()).some((row) => row.id === "shared")).toBe(true);
    expect((await metadata.listImportedModels({ provider: "fixture", connectionId: "two", lifecycle: "active" }))
      .some((row) => row.modelId === "shared")).toBe(true);
  });
});

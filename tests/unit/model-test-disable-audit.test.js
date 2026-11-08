import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-disable-audit-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Disabled Models Repository with Audit History (Spec 017)", () => {
  it("records disabled models and appends audit entries atomically", async () => {
    const { disableModelsWithAudit, getDisabledModels, getDisabledByProvider, getDisabledModelAudit } =
      await import("@/lib/db/repos/disabledModelsRepo.js");

    const batchId = "batch-uuid-1234";
    const disabledAt = "2026-11-08T12:00:00.000Z";

    await disableModelsWithAudit("openai", ["gpt-4-legacy", "gpt-3.5-old"], {
      reason: "model_not_found",
      disabledAt,
      batchId,
    });

    // 1. Existing getDisabledModels returns provider -> string[]
    const all = await getDisabledModels();
    expect(all.openai).toEqual(["gpt-4-legacy", "gpt-3.5-old"]);

    const byProvider = await getDisabledByProvider("openai");
    expect(byProvider).toEqual(["gpt-4-legacy", "gpt-3.5-old"]);

    // 2. Audit returns structured log
    const audit = await getDisabledModelAudit("openai");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual({
      id: "gpt-4-legacy",
      reason: "model_not_found",
      disabledAt,
      batchId,
      reenabledAt: null,
    });
    expect(audit[1]).toEqual({
      id: "gpt-3.5-old",
      reason: "model_not_found",
      disabledAt,
      batchId,
      reenabledAt: null,
    });
  });

  it("updates reenabledAt when models are re-enabled, preserving historical entries", async () => {
    const { disableModelsWithAudit, enableModels, getDisabledByProvider, getDisabledModelAudit } =
      await import("@/lib/db/repos/disabledModelsRepo.js");

    await disableModelsWithAudit("anthropic", ["claude-v1", "claude-v2"], {
      reason: "model_not_found",
      batchId: "batch-1",
    });

    // Re-enable claude-v1 specifically
    await enableModels("anthropic", ["claude-v1"]);

    const activeDisabled = await getDisabledByProvider("anthropic");
    expect(activeDisabled).toEqual(["claude-v2"]);

    const audit = await getDisabledModelAudit("anthropic");
    expect(audit).toHaveLength(2);
    const claudeV1Entry = audit.find((e) => e.id === "claude-v1");
    const claudeV2Entry = audit.find((e) => e.id === "claude-v2");

    expect(claudeV1Entry.reenabledAt).toBeDefined();
    expect(typeof claudeV1Entry.reenabledAt).toBe("string");
    expect(claudeV2Entry.reenabledAt).toBeNull();

    // Re-enable all remaining models (empty list deletes scope)
    await enableModels("anthropic", []);
    const remaining = await getDisabledByProvider("anthropic");
    expect(remaining).toEqual([]);

    const auditAfterAll = await getDisabledModelAudit("anthropic");
    expect(auditAfterAll).toHaveLength(2);
    expect(auditAfterAll.every((e) => typeof e.reenabledAt === "string")).toBe(true);
  });

  it("bounds audit history to the latest 1000 entries", async () => {
    const { disableModelsWithAudit, getDisabledModelAudit } =
      await import("@/lib/db/repos/disabledModelsRepo.js");

    // Add 1050 items in chunks of 350
    for (let chunk = 0; chunk < 3; chunk++) {
      const ids = Array.from({ length: 350 }, (_, i) => `model-chunk${chunk}-${i}`);
      await disableModelsWithAudit("fast-provider", ids, {
        reason: "model_not_found",
        batchId: `batch-${chunk}`,
      });
    }

    const audit = await getDisabledModelAudit("fast-provider");
    expect(audit.length).toBe(1000);
    // Oldest items (chunk 0 first 50 items) should have been pruned
    expect(audit[0].id).toBe("model-chunk0-50");
    expect(audit[999].id).toBe("model-chunk2-349");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-import-db-cache-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  global._dbAdapter = null;

  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
  global._dbAdapter = null;
});

describe("importDb cache invalidation", () => {
  it("immediately invalidates modelAliases, combos, and providerNodes caches on importDb", async () => {
    const {
      getModelAliases,
      setModelAlias,
      getComboByName,
      createCombo,
      getProviderNodes,
      createProviderNode,
      importDb,
      exportDb,
    } = await import("@/lib/db/index.js");

    // 1. Seed initial data
    await setModelAlias("alias-pre", "openai/model-pre");
    await createCombo({ name: "combo-pre", models: ["openai/pre-1"] });
    await createProviderNode({ id: "node-pre", type: "openai-compatible", name: "Pre Node", prefix: "pre" });

    // 2. Warm each cache
    const initialAliases = await getModelAliases();
    expect(initialAliases["alias-pre"]).toBe("openai/model-pre");

    const initialCombo = await getComboByName("combo-pre");
    expect(initialCombo).not.toBeNull();
    expect(initialCombo.models).toEqual(["openai/pre-1"]);

    const initialNodes = await getProviderNodes({ type: "openai-compatible" });
    expect(initialNodes.length).toBe(1);
    expect(initialNodes[0].name).toBe("Pre Node");

    // 3. Prepare an importDb payload with completely different aliases, combos, and nodes
    const payload = await exportDb();
    payload.modelAliases = {
      "alias-imported": "openai/model-imported",
    };
    payload.combos = [
      {
        id: "combo-imported-id",
        name: "combo-imported",
        kind: "combo",
        models: ["openai/imported-1", "anthropic/imported-2"],
      },
    ];
    payload.providerNodes = [
      {
        id: "node-imported-id",
        type: "openai-compatible",
        name: "Imported Node",
        prefix: "imported",
      },
    ];

    // 4. Call importDb
    await importDb(payload);

    // 5. Read immediately (WITHOUT waiting 5s for TTL expiry)
    // All 3 caches MUST return the new imported data immediately!
    const freshAliases = await getModelAliases();
    expect(freshAliases["alias-pre"]).toBeUndefined();
    expect(freshAliases["alias-imported"]).toBe("openai/model-imported");

    const oldCombo = await getComboByName("combo-pre");
    expect(oldCombo).toBeNull();

    const freshCombo = await getComboByName("combo-imported");
    expect(freshCombo).not.toBeNull();
    expect(freshCombo.models).toEqual(["openai/imported-1", "anthropic/imported-2"]);

    const freshNodes = await getProviderNodes({ type: "openai-compatible" });
    expect(freshNodes.length).toBe(1);
    expect(freshNodes[0].name).toBe("Imported Node");
    expect(freshNodes[0].prefix).toBe("imported");
  });
});

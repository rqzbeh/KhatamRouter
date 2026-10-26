import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fx = vi.hoisted(() => ({
  nodes: [],
  combos: [],
  aliases: {},
  nodesQueried: false,
}));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => fx.aliases,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async (filter = {}) => {
    fx.nodesQueried = true;
    return fx.nodes.filter((n) => !filter.type || n.type === filter.type);
  },
}));

let currentGetModelInfo;
let masterGetModelInfo;
let masterTmpFile;

beforeAll(async () => {
  // Load current branch implementation
  const currentModule = await import("@/sse/services/model.js");
  currentGetModelInfo = currentModule.getModelInfo;

  // Extract and load origin/master implementation
  const masterCode = execSync("git show origin/master:src/sse/services/model.js").toString();
  masterTmpFile = path.resolve(import.meta.dirname, ".master_model_test.tmp.mjs");
  fs.writeFileSync(masterTmpFile, masterCode);
  const masterModule = await import(masterTmpFile);
  masterGetModelInfo = masterModule.getModelInfo;
});

afterAll(() => {
  if (masterTmpFile && fs.existsSync(masterTmpFile)) {
    fs.unlinkSync(masterTmpFile);
  }
});

beforeEach(() => {
  fx.nodes = [];
  fx.combos = [];
  fx.aliases = {};
  fx.nodesQueried = false;
});

describe("model reserved prefixes: equivalence with origin/master", () => {
  const testCases = [
    {
      name: "node prefix 'el' (elevenlabs alias in registry)",
      nodes: [{ id: "node-el", type: "openai-compatible", prefix: "el" }],
      query: "el/my-model",
    },
    {
      name: "node prefix 'EL' (uppercase)",
      nodes: [{ id: "node-EL", type: "openai-compatible", prefix: "EL" }],
      query: "EL/my-model",
    },
    {
      name: "node prefix 'jina' (jina-ai alias in registry)",
      nodes: [{ id: "node-jina", type: "openai-compatible", prefix: "jina" }],
      query: "jina/rerank-v1",
    },
    {
      name: "node prefix 'JINA' (uppercase)",
      nodes: [{ id: "node-JINA", type: "openai-compatible", prefix: "JINA" }],
      query: "JINA/rerank-v1",
    },
    {
      name: "node prefix 'openai' (reserved builtin id)",
      nodes: [{ id: "rogue-openai-node", type: "openai-compatible", prefix: "openai" }],
      query: "openai/gpt-4o",
    },
    {
      name: "node prefix 'cx' (reserved builtin alias)",
      nodes: [{ id: "rogue-cx-node", type: "openai-compatible", prefix: "cx" }],
      query: "cx/codex-mini",
    },
    {
      name: "node prefix 'custom-prefix' (unreserved user node)",
      nodes: [{ id: "custom-node-1", type: "openai-compatible", prefix: "custom-prefix" }],
      query: "custom-prefix/model-x",
    },
    {
      name: "node prefix 'anthropic' (reserved builtin id)",
      nodes: [{ id: "rogue-claude-node", type: "openai-compatible", prefix: "anthropic" }],
      query: "anthropic/claude-3-5-sonnet",
    },
  ];

  for (const tc of testCases) {
    it(`resolves "${tc.query}" identically to origin/master (${tc.name})`, async () => {
      // 1. Run master implementation
      fx.nodes = tc.nodes;
      fx.nodesQueried = false;
      const masterResult = await masterGetModelInfo(tc.query);
      const masterQueried = fx.nodesQueried;

      // 2. Run current implementation
      fx.nodes = tc.nodes;
      fx.nodesQueried = false;
      const currentResult = await currentGetModelInfo(tc.query);
      const currentQueried = fx.nodesQueried;

      // 3. Assert exact equivalence
      expect(currentResult).toEqual(masterResult);
      expect(currentQueried).toBe(masterQueried);
    });
  }

  it("never consults provider nodes for reserved builtin prefixes 'openai' and 'cx'", async () => {
    fx.nodes = [
      { id: "node-openai", type: "openai-compatible", prefix: "openai" },
      { id: "node-cx", type: "openai-compatible", prefix: "cx" },
    ];

    fx.nodesQueried = false;
    const resOpenai = await currentGetModelInfo("openai/gpt-4o");
    expect(resOpenai.provider).toBe("openai");
    expect(resOpenai.model).toBe("gpt-4o");
    expect(fx.nodesQueried).toBe(false);

    fx.nodesQueried = false;
    const resCx = await currentGetModelInfo("cx/codex-mini");
    expect(resCx.provider).toBe("codex");
    expect(resCx.model).toBe("codex-mini");
    expect(fx.nodesQueried).toBe(false);
  });
});

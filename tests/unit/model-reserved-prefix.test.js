import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseModel as parseModelCore, getModelInfoCore } from "open-sse/services/model.js";
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";

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

// Frozen origin/master reference implementation to avoid git dependency on CI shallow checkouts
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const snapshotPath = path.resolve(import.meta.dirname, "../fixtures/model-reserved-prefix.master-snapshot.json");
const masterSnapshotArray = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const MASTER_RESERVED_PROVIDER_PREFIXES = new Set(masterSnapshotArray);

function masterParseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

async function masterGetModelInfo(modelStr) {
  const parsed = masterParseModel(modelStr);

  if (!parsed.isAlias) {
    if (!MASTER_RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  const combo = await getComboByName(parsed.model);
  if (combo) {
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

let currentGetModelInfo;

beforeAll(async () => {
  // Load current branch implementation
  const currentModule = await import("@/sse/services/model.js");
  currentGetModelInfo = currentModule.getModelInfo;
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

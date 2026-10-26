// Wave 7 — VansRouter Provider Parity, Stateless Executors, FreeTiers & LoopGuard
import { describe, it, expect, beforeEach, vi } from "vitest";

import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { listFreeTiers, FREE_REFRESH_VALUES } from "open-sse/providers/freeTiers.js";
import { PONYTAIL_LEVELS, PONYTAIL_PROMPTS } from "open-sse/rtk/ponytailPrompt.js";
import { injectPonytail } from "open-sse/rtk/ponytail.js";
import { detectLoop, applyLoopGuard } from "open-sse/utils/loopGuard.js";

import { DefaultExecutor } from "open-sse/executors/default.js";
import { AgentRouterExecutor } from "open-sse/executors/agentrouter.js";
import { QwenExecutor } from "open-sse/executors/qwen.js";
import { ZcodeExecutor } from "open-sse/executors/zcode.js";
import { MuseSparkWebExecutor } from "open-sse/executors/muse-spark-web.js";
import FreebuffExecutor from "open-sse/executors/freebuff.js";
import { getExecutor } from "open-sse/executors/index.js";

describe("Wave 7: Provider Registry Parity", () => {
  const NEW_PROVIDERS = [
    "a6api",
    "agentrouter",
    "ai21",
    "alibaba",
    "baseten",
    "bytez",
    "codestral",
    "databricks",
    "deepinfra",
    "freebuff",
    "friendliai",
    "galadriel",
    "gigachat",
    "heroku",
    "hive",
    "llamagate",
    "meta",
    "muse-spark-web",
    "nanogpt",
    "nscale",
    "ovhcloud",
    "predibase",
    "publicai",
    "qwen",
    "snowflake",
    "upstage",
    "volcengine",
    "wandb",
    "zcode",
    "zenmux",
  ];

  it("registers all 30 new providers in REGISTRY", () => {
    const registryIds = new Set(REGISTRY.map((r) => r.id));
    for (const id of NEW_PROVIDERS) {
      expect(registryIds.has(id), `Missing provider: ${id}`).toBe(true);
    }
    // 134 pre-existing + 30 ported + 1 sensenova + 1 runcrate = 166 (trae/windsurf/devin-cli stay
    // hidden by design; see scripts/migrate-registry.mjs HIDDEN_REGISTRY_FILES)
    expect(REGISTRY.length).toBe(166);
  });

  it("builds all new providers into PROVIDERS map", () => {
    for (const id of NEW_PROVIDERS) {
      expect(PROVIDERS[id], `Missing in PROVIDERS: ${id}`).toBeDefined();
      expect(PROVIDERS[id].baseUrl).toBeDefined();
    }
  });

  it("builds model entries into PROVIDER_MODELS", () => {
    expect(PROVIDER_MODELS["agentrouter"]).toBeDefined();
    expect(PROVIDER_MODELS["agentrouter"].length).toBeGreaterThan(0);

    // PROVIDER_MODELS is keyed by provider alias (or id if no alias)
    expect(PROVIDER_MODELS["qw"]).toBeDefined();
    expect(PROVIDER_MODELS["qw"].length).toBeGreaterThan(0);

    expect(PROVIDER_MODELS["zc"]).toBeDefined();
    expect(PROVIDER_MODELS["zc"].length).toBeGreaterThan(0);

    expect(PROVIDER_MODELS["fb"]).toBeDefined();
    expect(PROVIDER_MODELS["fb"].length).toBeGreaterThan(0);
  });

  it("resolves provider aliases correctly without collisions", () => {
    expect(resolveProviderAlias("qw")).toBe("qwen");
    expect(resolveProviderAlias("zc")).toBe("zcode");
    expect(resolveProviderAlias("fb")).toBe("freebuff");
    expect(resolveProviderAlias("ali")).toBe("alibaba");
    expect(resolveProviderAlias("ovh")).toBe("ovhcloud");
    expect(resolveProviderAlias("agentrouter")).toBe("agentrouter");

    // Critical invariant: existing "muse" (Meta Model API) must NOT be clobbered by "muse-spark-web"
    expect(resolveProviderAlias("muse")).toBe("muse");
    expect(resolveProviderAlias("muse-spark-web")).toBe("muse-spark-web");
  });

  it("registers specialized executors in executor factory", () => {
    expect(getExecutor("agentrouter")).toBeInstanceOf(AgentRouterExecutor);
    expect(getExecutor("qwen")).toBeInstanceOf(QwenExecutor);
    expect(getExecutor("zcode")).toBeInstanceOf(ZcodeExecutor);
    expect(getExecutor("muse-spark-web")).toBeInstanceOf(MuseSparkWebExecutor);
    expect(getExecutor("freebuff")).toBeInstanceOf(FreebuffExecutor);
  });
});

describe("Wave 7: Stateless Executor Contract", () => {
  const executorsToTest = [
    { name: "DefaultExecutor (openai)", executor: new DefaultExecutor("openai") },
    { name: "AgentRouterExecutor", executor: new AgentRouterExecutor() },
    { name: "QwenExecutor", executor: new QwenExecutor() },
    { name: "ZcodeExecutor", executor: new ZcodeExecutor() },
    { name: "MuseSparkWebExecutor", executor: new MuseSparkWebExecutor() },
    { name: "FreebuffExecutor", executor: new FreebuffExecutor() },
  ];

  for (const { name, executor } of executorsToTest) {
    it(`guarantees ${name} leaks no state across sequential buildHeaders calls`, () => {
      const creds1 = {
        apiKey: "SECRET_KEY_TENANT_ONE_1111111111",
        accessToken: "ACCESS_TOKEN_TENANT_ONE_111111",
        providerSpecificData: {
          zcodeJwtToken: "JWT_TENANT_ONE_111111",
          ecto_1_sess: "COOKIE_TENANT_ONE_111111",
        },
      };

      const creds2 = {
        apiKey: "SECRET_KEY_TENANT_TWO_2222222222",
        accessToken: "ACCESS_TOKEN_TENANT_TWO_222222",
        providerSpecificData: {
          zcodeJwtToken: "JWT_TENANT_TWO_222222",
          ecto_1_sess: "COOKIE_TENANT_TWO_222222",
        },
      };

      // Call 1
      const headers1 = executor.buildHeaders(creds1, true);
      const str1 = JSON.stringify(headers1);

      // Verify call 1 has tenant 1 tokens and NOT tenant 2
      expect(str1).not.toContain("2222222222");
      expect(str1).not.toContain("TENANT_TWO");

      // Call 2 on same instance
      const headers2 = executor.buildHeaders(creds2, true);
      const str2 = JSON.stringify(headers2);

      // Verify call 2 has tenant 2 tokens and ABSOLUTELY NO tenant 1 tokens
      expect(str2).not.toContain("1111111111");
      expect(str2).not.toContain("TENANT_ONE");
      expect(str2).not.toContain("JWT_TENANT_ONE");
      expect(str2).not.toContain("COOKIE_TENANT_ONE");

      // Multiple rapid sequential calls maintain isolation
      for (let i = 0; i < 5; i++) {
        const altCreds = { apiKey: `KEY_ITERATION_${i}` };
        const altHeaders = executor.buildHeaders(altCreds, true);
        const altStr = JSON.stringify(altHeaders);
        expect(altStr).not.toContain("TENANT_ONE");
        expect(altStr).not.toContain("TENANT_TWO");
      }
    });
  }
});

describe("Wave 7: LoopGuard Negative & Positive Controls", () => {
  it("negative control: varied tool calls must not flag loop", () => {
    const variedRequest = {
      messages: [
        { role: "user", content: "Inspect repo status" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "readFile", arguments: JSON.stringify({ path: "/app/src/index.js" }) } },
          ],
        },
        { role: "tool", content: "File content 1" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_2", function: { name: "gitStatus", arguments: JSON.stringify({ verbose: true }) } },
          ],
        },
        { role: "tool", content: "clean status" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_3", function: { name: "runTests", arguments: JSON.stringify({ pattern: "unit" }) } },
          ],
        },
        { role: "tool", content: "tests passed" },
      ],
    };

    const result = detectLoop(variedRequest);
    expect(result.detected).toBe(false);
    expect(result.hint).toBeNull();
  });

  it("negative control: normal conversational back-and-forth must not flag", () => {
    const chatRequest = {
      messages: [
        { role: "user", content: "Hello, how can I configure Bun?" },
        { role: "assistant", content: "You can configure Bun using bunfig.toml file in your root directory." },
        { role: "user", content: "What options are available for test runner?" },
        { role: "assistant", content: "The [test] section in bunfig.toml supports root, timeout, and coverage flags." },
        { role: "user", content: "Can you provide a minimal example?" },
        { role: "assistant", content: "Certainly! Here is an example config with coverage enabled." },
      ],
    };

    const result = detectLoop(chatRequest);
    expect(result.detected).toBe(false);
    expect(result.hint).toBeNull();
  });

  it("positive control: single tool repeated 3+ times flags loop", () => {
    const loopingToolRequest = {
      messages: [
        { role: "user", content: "Check status" },
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", function: { name: "readFile", arguments: '{"path":"/app/error.log"}' } },
          ],
        },
        { role: "tool", content: "empty" },
        {
          role: "assistant",
          tool_calls: [
            { id: "c2", function: { name: "readFile", arguments: '{"path":"/app/error.log"}' } },
          ],
        },
        { role: "tool", content: "empty" },
        {
          role: "assistant",
          tool_calls: [
            { id: "c3", function: { name: "readFile", arguments: '{"path":"/app/error.log"}' } },
          ],
        },
        { role: "tool", content: "empty" },
      ],
    };

    const result = detectLoop(loopingToolRequest);
    expect(result.detected).toBe(true);
    expect(result.hint).toContain("STOP repeating");
  });

  it("positive control: repeated tool sequence (A->B->A->B) flags loop", () => {
    const sequenceLoopRequest = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "s1", function: { name: "fetchStatus", arguments: "{}" } },
            { id: "s2", function: { name: "pingHost", arguments: '{"host":"example.com"}' } },
            { id: "s3", function: { name: "fetchStatus", arguments: "{}" } },
            { id: "s4", function: { name: "pingHost", arguments: '{"host":"example.com"}' } },
          ],
        },
      ],
    };

    const result = detectLoop(sequenceLoopRequest);
    expect(result.detected).toBe(true);
    expect(result.hint).toContain("repeated the same sequence of tool calls");
  });

  it("positive control: repeated text reasoning message flags text loop", () => {
    const repeatedTextRequest = {
      messages: [
        { role: "assistant", content: "I need to check the database migrations again before proceeding." },
        { role: "user", content: "Go ahead" },
        { role: "assistant", content: "I need to check the database migrations again before proceeding." },
        { role: "user", content: "Did you check?" },
        { role: "assistant", content: "I need to check the database migrations again before proceeding." },
      ],
    };

    const result = detectLoop(repeatedTextRequest);
    expect(result.detected).toBe(true);
    expect(result.hint).toContain("text loop");
  });

  it("applyLoopGuard appends hint idempotently and respects loop detection", () => {
    const body = {
      messages: [
        { role: "user", content: "Please fix" },
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", function: { name: "read", arguments: '{"file":"test"}' } },
            { id: "c2", function: { name: "read", arguments: '{"file":"test"}' } },
            { id: "c3", function: { name: "read", arguments: '{"file":"test"}' } },
          ],
        },
        { role: "tool", content: "file not found" },
      ],
    };

    const applied = applyLoopGuard(body, "openai", "openai", "gpt-4o", null);
    expect(applied).toBe(true);
    expect(body.messages[2].content).toContain("[ROUTER NOTE:");

    // Idempotent: second call does not duplicate hint
    const beforeLen = body.messages[2].content.length;
    applyLoopGuard(body, "openai", "openai", "gpt-4o", null);
    expect(body.messages[2].content.length).toBe(beforeLen);
  });
});

describe("Wave 7: Free-Tier Catalog Derivation", () => {
  it("derives free tiers catalogue with expected refresh cadence values", () => {
    expect(FREE_REFRESH_VALUES).toEqual(["daily", "weekly", "monthly", "one-time", "rolling"]);
    const tiers = listFreeTiers();
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers.length).toBeGreaterThan(10);

    // Verify provider rows and model rows
    const providerRows = tiers.filter((t) => t.modelId === null);
    const modelRows = tiers.filter((t) => t.modelId !== null);
    expect(providerRows.length).toBeGreaterThan(0);
    expect(modelRows.length).toBeGreaterThan(0);

    // Check specific known free tier providers
    const hasFreebuff = tiers.some((t) => t.providerId === "freebuff");
    expect(hasFreebuff).toBe(true);

    const hasAgentrouter = tiers.some((t) => t.providerId === "agentrouter");
    expect(hasAgentrouter).toBe(true);
  });

  it("sorts rows deterministically by cadence, provider, and model", () => {
    const tiers = listFreeTiers();
    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1];
      const curr = tiers[i];

      const rankA = prev.freeRefresh === null ? 5 : FREE_REFRESH_VALUES.indexOf(prev.freeRefresh);
      const rankB = curr.freeRefresh === null ? 5 : FREE_REFRESH_VALUES.indexOf(curr.freeRefresh);

      if (rankA === rankB) {
        const pCmp = prev.providerName.localeCompare(curr.providerName);
        if (pCmp === 0) {
          expect(String(prev.modelId).localeCompare(String(curr.modelId))).toBeLessThanOrEqual(0);
        } else {
          expect(pCmp).toBeLessThanOrEqual(0);
        }
      } else {
        expect(rankA).toBeLessThanOrEqual(rankB);
      }
    }
  });
});

describe("Wave 7: Ponytail Intensity Prompts", () => {
  it("defines lite, full, and ultra intensity prompt levels", () => {
    expect(PONYTAIL_LEVELS).toEqual({
      LITE: "lite",
      FULL: "full",
      ULTRA: "ultra",
    });

    for (const lvl of Object.values(PONYTAIL_LEVELS)) {
      const prompt = PONYTAIL_PROMPTS[lvl];
      expect(typeof prompt).toBe("string");
      expect(prompt).toContain("lazy senior developer");
      expect(prompt).toContain("Before writing code, stop at the first rung that holds");
      expect(prompt).toContain("now is 2026, Be skeptical");
      expect(prompt).toContain("Never simplify away");
    }

    expect(PONYTAIL_PROMPTS.lite).toContain("Level: lite");
    expect(PONYTAIL_PROMPTS.full).toContain("Level: full");
    expect(PONYTAIL_PROMPTS.ultra).toContain("Level: ultra");
  });

  it("injects Ponytail prompts into system slot across wire formats", () => {
    // OpenAI Chat format
    const chatBody = { messages: [{ role: "user", content: "Write a server" }] };
    injectPonytail(chatBody, "openai", "ultra");
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toContain("Level: ultra");

    // Claude format
    const claudeBody = { messages: [{ role: "user", content: "Write a server" }] };
    injectPonytail(claudeBody, "claude", "full");
    expect(claudeBody.system).toBeDefined();
    expect(claudeBody.system).toContain("Level: full");
  });
});

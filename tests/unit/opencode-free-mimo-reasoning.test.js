import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { liftReasoningAliases } from "../../open-sse/translator/concerns/reasoning.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "mimo-v2.6-flash-free";
const PROVIDER = "opencode";
// Every value the lane accepts, probed live (200 vs 400 "Invalid option").
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function effortOnWire(level) {
  const body = { model: MODEL, messages: [], reasoning_effort: level };
  applyThinking(FORMATS.OPENAI, MODEL, body, PROVIDER);
  return body;
}

describe("oc/mimo-v2.6-flash-free reasoning levels", () => {
  it("advertises the OpenAI effort enum and a working off switch", () => {
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
    });
    expect(getCapabilitiesForModel(PROVIDER, `oc/${MODEL}`).thinkingCanDisable).toBe(true);

    expect(getThinkingLevels(PROVIDER, MODEL)).toEqual(LEVELS);
    expect(getThinkingLevels(PROVIDER, `oc/${MODEL}`)).toEqual(LEVELS);
    expect(getThinkingLevels("xiaomi-mimo", MODEL)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("forwards every level verbatim and disables via reasoning_effort none", () => {
    for (const level of LEVELS) expect(effortOnWire(level).reasoning_effort).toBe(level);
    // The family's DeepSeek shape would emit a `thinking` object the lane ignores.
    expect(effortOnWire("none").thinking).toBeUndefined();
    expect(effortOnWire("high").thinking).toBeUndefined();
  });

  it("sends the requested level to the free chat endpoint end to end", () => {
    const executor = new OpenCodeExecutor();
    for (const level of LEVELS) {
      // The handler strips the provider prefix before dispatch (oc/… → bare id).
      const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI,
        `${MODEL}(${level})`,
        body,
        true,
        {},
        PROVIDER,
      );
      const out = executor.transformRequest(MODEL, translated, true, { connectionId: "oc-mimo-levels-test" });
      expect(executor.buildUrl(MODEL)).toBe("https://opencode.ai/inference/v1/chat/completions");
      expect(out.reasoning_effort).toBe(level);
      expect(out.thinking).toBeUndefined();
    }
  });

  it("drops adaptive \"auto\" instead of shipping a value the lane 400s on", () => {
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, MODEL, body, true, {}, PROVIDER);
    expect(translated.reasoning_effort).toBe("auto");

    const out = new OpenCodeExecutor().transformRequest(MODEL, translated, true, { connectionId: "oc-mimo-auto-test" });
    expect(out.reasoning_effort).toBeUndefined();

    // A named level still rides through untouched.
    const kept = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      MODEL,
      { model: MODEL, messages: [], reasoning_effort: "xhigh" },
      true,
      {},
      PROVIDER,
    );
    expect(new OpenCodeExecutor().transformRequest(MODEL, kept, true, {}).reasoning_effort).toBe("xhigh");
  });
});

describe("liftReasoningAliases helper", () => {
  it("lifts reasoning/reasoning_details into reasoning_content and keeps the aliases", () => {
    expect(liftReasoningAliases({ reasoning: "abc" })).toEqual({ reasoning: "abc", reasoning_content: "abc" });
    expect(liftReasoningAliases({ reasoning_details: [{ text: "ab" }, { content: "c" }] }).reasoning_content).toBe("abc");
    // Never rewrites a delta that already carries the canonical field.
    expect(liftReasoningAliases({ reasoning_content: "kept", reasoning: "other" })).toEqual({ reasoning_content: "kept", reasoning: "other" });
    expect(liftReasoningAliases({ content: "no thinking" })).toEqual({ content: "no thinking" });
  });
});

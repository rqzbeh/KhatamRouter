import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "deepseek-v4.1-flash-free";
const PROVIDER = "opencode";
// The lane exposes low, high, max verbatim.
const LEVELS = ["low", "high", "max"];

const effortOnWire = (level, { model = MODEL, provider = PROVIDER, format = FORMATS.OPENAI } = {}) => {
  const body = { model, messages: [], reasoning_effort: level };
  applyThinking(format, model, body, provider);
  return body.reasoning_effort;
};

describe("oc/deepseek-v4.1-flash-free reasoning levels", () => {
  it("advertises exactly low|high|max", () => {
    expect(getThinkingLevels(PROVIDER, MODEL)).toEqual(LEVELS);
    expect(getThinkingLevels(PROVIDER, `oc/${MODEL}`)).toEqual(LEVELS);
    expect(getThinkingLevels(PROVIDER, `${MODEL}(max)`)).toEqual(LEVELS);
  });

  it("resolves the same set through the oc alias and the keyed zen lane", () => {
    for (const provider of ["oc", "opencode-zen", "ocz"]) {
      expect(getThinkingLevels(provider, MODEL)).toEqual(LEVELS);
    }
  });

  it("stays a reasoning model with deepseek wire format", () => {
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({
      reasoning: true,
      thinkingFormat: "deepseek",
    });
  });

  it("forwards low|high|max verbatim", () => {
    for (const level of LEVELS) expect(effortOnWire(level)).toBe(level);
  });

  it("collapses levels the model does not serve", () => {
    expect(effortOnWire("minimal")).toBe("low");
    expect(effortOnWire("medium")).toBe("high");
    expect(effortOnWire("xhigh")).toBe("max");
  });

  it("keeps thinking disable working (no effort on wire)", () => {
    const body = { model: MODEL, messages: [], reasoning_effort: "none" };
    applyThinking(FORMATS.OPENAI, MODEL, body, PROVIDER);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sends requested level to the chat endpoint end to end", () => {
    const executor = new OpenCodeExecutor();
    for (const level of LEVELS) {
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
      const out = executor.transformRequest(MODEL, translated, true, { connectionId: "oc-deepseek-effort-test" });
      expect(executor.buildUrl(MODEL)).toBe("https://opencode.ai/inference/v1/chat/completions");
      expect(out.reasoning_effort).toBe(level);
      expect(out.model).toBe(MODEL);
    }
  });
});

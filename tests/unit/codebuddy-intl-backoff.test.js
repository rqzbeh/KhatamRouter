import { describe, expect, it } from "vitest";
import { BACKOFF_CONFIG } from "../../open-sse/config/errorConfig.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("CodeBuddy Intl block backoff (#5024)", () => {
  it.each(["11128:request illegal", "conversation id missing"])("backs off for %s", (msg) => {
    expect(checkFallbackError(400, { code: 11128, msg }, 0, "codebuddy-intl")).toEqual({
      shouldFallback: true,
      cooldownMs: BACKOFF_CONFIG.base,
      newBackoffLevel: 1,
    });
  });

  it("increases repeated block cooldowns and respects the existing cap", () => {
    expect([0, 1, 2].map((level) =>
      checkFallbackError(400, "request illegal", level, "codebuddy-intl").cooldownMs,
    )).toEqual([BACKOFF_CONFIG.base, BACKOFF_CONFIG.base * 2, BACKOFF_CONFIG.base * 4]);

    expect(checkFallbackError(400, "request illegal", BACKOFF_CONFIG.maxLevel, "codebuddy-intl")).toEqual({
      shouldFallback: true,
      cooldownMs: BACKOFF_CONFIG.max,
      newBackoffLevel: BACKOFF_CONFIG.maxLevel,
    });
  });

  it.each(["openai", "codebuddy-cn", null])("keeps the same text request-scoped for provider %s", (provider) => {
    expect(checkFallbackError(400, "request illegal", 0, provider)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
      requestScoped: true,
    });
  });

  it("does not classify every 11128 code as a block", () => {
    expect(checkFallbackError(400, { code: 11128, msg: "first message is not system prompt" }, 0, "codebuddy-intl")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
      requestScoped: true,
    });
  });
});

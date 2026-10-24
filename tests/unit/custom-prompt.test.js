import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectCustomPrompt } from "../../open-sse/rtk/customPrompt.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ROLE } from "../../open-sse/translator/schema/roles.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const SEP = "\n\n";

describe("injectCustomPrompt", () => {
  it("does nothing if prompt is empty or blank", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    expect(injectCustomPrompt(body, FORMATS.OPENAI, "")).toBe(false);
    expect(injectCustomPrompt(body, FORMATS.OPENAI, "   \n\t")).toBe(false);
    expect(injectCustomPrompt(body, FORMATS.OPENAI, undefined)).toBe(false);
    expect(injectCustomPrompt(body, FORMATS.OPENAI, null)).toBe(false);
    expect(injectCustomPrompt(body, FORMATS.OPENAI, 123)).toBe(false);
    expect(body.messages).toEqual([{ role: ROLE.USER, content: "hi" }]);
  });

  it("fails open gracefully on invalid body", () => {
    expect(injectCustomPrompt(null, FORMATS.OPENAI, "MY PROMPT")).toBe(false);
    expect(injectCustomPrompt(undefined, FORMATS.OPENAI, "MY PROMPT")).toBe(false);
    expect(injectCustomPrompt("string-body", FORMATS.OPENAI, "MY PROMPT")).toBe(false);
    expect(injectCustomPrompt(123, FORMATS.OPENAI, "MY PROMPT")).toBe(false);
  });

  it("appends prompt to existing system message", () => {
    const body = {
      messages: [
        { role: ROLE.SYSTEM, content: "hello" },
        { role: ROLE.USER, content: "hi" },
      ],
    };
    expect(injectCustomPrompt(body, FORMATS.OPENAI, "MY PROMPT")).toBe(true);
    expect(body.messages[0].content).toBe(`hello${SEP}MY PROMPT`);
  });

  it("creates system message if none exists", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    expect(injectCustomPrompt(body, FORMATS.OPENAI, "MY PROMPT")).toBe(true);
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "MY PROMPT" });
  });

  it("is idempotent for the same prompt", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }] };
    injectCustomPrompt(body, FORMATS.OPENAI, "MY PROMPT");
    injectCustomPrompt(body, FORMATS.OPENAI, "MY PROMPT");
    expect(body.messages[0].content).toBe(`hello${SEP}MY PROMPT`);
  });

  it("coexists additively with caveman and ponytail prompts", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base instruction" }] };
    // Simulate caveman
    injectCaveman(body, FORMATS.OPENAI, "lite");
    const afterCaveman = body.messages[0].content;
    expect(afterCaveman).toContain("base instruction");

    // Simulate ponytail
    injectPonytail(body, FORMATS.OPENAI, "lite");
    const afterPonytail = body.messages[0].content;
    expect(afterPonytail).toContain(afterCaveman);

    // Simulate custom prompt
    expect(injectCustomPrompt(body, FORMATS.OPENAI, "MY CUSTOM STYLE")).toBe(true);
    const afterCustom = body.messages[0].content;
    expect(afterCustom).toContain(afterPonytail);
    expect(afterCustom).toContain("MY CUSTOM STYLE");
  });

  it("lands in Claude system field", () => {
    const body = {
      system: "hello",
      messages: [{ role: ROLE.USER, content: "hi" }],
    };
    expect(injectCustomPrompt(body, FORMATS.CLAUDE, "MY PROMPT")).toBe(true);
    expect(body.system).toBe(`hello${SEP}MY PROMPT`);
    expect(body.messages).toEqual([{ role: ROLE.USER, content: "hi" }]);
  });

  it("lands in Gemini systemInstruction field", () => {
    const body = { contents: [{ role: ROLE.USER, parts: [{ text: "hi" }] }] };
    expect(injectCustomPrompt(body, FORMATS.GEMINI, "MY PROMPT")).toBe(true);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "MY PROMPT" }] });
  });

  it("lands in Responses instructions field", () => {
    const body = { instructions: "hello", input: [] };
    expect(injectCustomPrompt(body, FORMATS.OPENAI_RESPONSES, "MY PROMPT")).toBe(true);
    expect(body.instructions).toBe(`hello${SEP}MY PROMPT`);
  });

  it("lands in Kiro conversationState field", () => {
    const body = {
      conversationState: {
        history: [{ userInputMessage: { content: "hi" } }],
      },
    };
    expect(injectCustomPrompt(body, FORMATS.KIRO, "MY PROMPT")).toBe(true);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`hi${SEP}MY PROMPT`);
  });
});

describe("handleChatCore with customPrompt wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
              index: 0,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("injects custom prompt into body dispatched to executor", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };
    const customPromptText = "Always respond in JSON.";

    await handleChatCore({
      body: {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      customPromptEnabled: true,
      customPrompt: customPromptText,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages[0]).toEqual({
      role: "system",
      content: customPromptText,
    });
    expect(dispatchedBody.messages[1]).toEqual({
      role: "user",
      content: "hello",
    });

    const lineCalls = log.line.mock.calls.map((c) => c.join(" "));
    expect(lineCalls.some((call) => call.includes(`CUSTOMPROMPT:${customPromptText.length}c`))).toBe(true);
  });

  it("does not inject custom prompt when customPromptEnabled is false", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      customPromptEnabled: false,
      customPrompt: "Should not be injected",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("does not inject custom prompt when customPrompt is empty", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      customPromptEnabled: true,
      customPrompt: "   ",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("coexists additively with caveman prompt in handleChatCore", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };

    await handleChatCore({
      body: {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "lite",
      customPromptEnabled: true,
      customPrompt: "House style convention.",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages[0].role).toBe("system");
    expect(dispatchedBody.messages[0].content).toContain("House style convention.");
    expect(dispatchedBody.messages[0].content).toContain("Respond tersely");

    const lineCalls = log.line.mock.calls.map((c) => c.join(" "));
    expect(lineCalls.some((call) => call.includes("CAVEMAN:lite") && call.includes("CUSTOMPROMPT:23c"))).toBe(true);
  });
});


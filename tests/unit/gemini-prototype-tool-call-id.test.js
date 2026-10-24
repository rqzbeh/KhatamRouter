import { describe, expect, it } from "vitest";

import { sanitizeFunctionResponsePayload } from "../../open-sse/translator/formats/gemini.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

// A tool_call_id and a tool-result payload key are both client-supplied. A value
// like "constructor" must be treated as a key, never as an inherited member of
// Object.prototype — reading one and then calling .push threw a TypeError that
// failed the whole request (regression vs origin/main, found by strict audit).
const RESERVED = ["constructor", "toString", "valueOf", "hasOwnProperty", "prototype", "__proto__"];

describe("prototype-named keys are treated as data", () => {
  it("keeps a reserved payload key instead of rewriting it to inherited source", () => {
    const out = sanitizeFunctionResponsePayload({ constructor: "C", toString: "T", ok: "O" });

    expect(out.constructor).toBe("C");
    expect(out.toString).toBe("T");
    expect(out.ok).toBe("O");
  });

  it("keeps a client-supplied __proto__ key as an own property without re-prototyping", () => {
    // `out[key] = value` hits the prototype setter for "__proto__": the key
    // vanished from the output and the object got an attacker-controlled
    // prototype. defineProperty makes a real own property instead.
    const payload = JSON.parse('{"__proto__":{"polluted":true},"$ref":"R"}');
    const out = sanitizeFunctionResponsePayload(payload);

    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out).polluted).toBeUndefined();
    expect(out._ref).toBe("R");
  });

  it("still renames the genuinely reserved $ref key", () => {
    const out = sanitizeFunctionResponsePayload({ $ref: "R", nested: { $ref: "N" } });

    expect(out._ref).toBe("R");
    expect(out.nested).toEqual({ _ref: "N" });
    expect(out.$ref).toBeUndefined();
  });

  it("returns the same reference when nothing needs renaming", () => {
    const payload = { a: 1, b: "two" };

    expect(sanitizeFunctionResponsePayload(payload)).toBe(payload);
  });

  it("does not throw for any reserved key name", () => {
    for (const key of RESERVED) {
      expect(() => sanitizeFunctionResponsePayload({ [key]: "v" })).not.toThrow();
    }
  });

  it("reproduces the old failure mode: ||= on a bare object reads an inherited function", () => {
    // Guards the exact pattern that regressed: a null-prototype map is required
    // for `(map[id] ||= []).push(...)` to be safe for client-supplied ids.
    const unsafe = {};
    expect(() => (unsafe.constructor ||= []).push("x")).toThrow(TypeError);

    const safe = Object.create(null);
    expect(() => (safe.constructor ||= []).push("x")).not.toThrow();
    expect(safe.constructor).toEqual(["x"]);
  });

  it("translates OpenAI requests with prototype-named tool_call_id without throwing", () => {
    for (const reservedId of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
      const body = {
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: reservedId,
                type: "function",
                function: { name: "test_tool", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: reservedId,
            content: '{"result":"success"}',
          },
        ],
      };

      expect(() => openaiToGeminiRequest("gemini-2.5-flash", body, false)).not.toThrow();
      const geminiReq = openaiToGeminiRequest("gemini-2.5-flash", body, false);
      expect(geminiReq.contents).toBeDefined();

      const functionResponsePart = geminiReq.contents
        .flatMap((c) => c.parts || [])
        .find((p) => p.functionResponse)?.functionResponse;

      expect(functionResponsePart).toBeDefined();
      expect(functionResponsePart.name).toBe("test_tool");
      expect(functionResponsePart.id).toBe(reservedId);
      expect(functionResponsePart.response).toEqual({ result: { result: "success" } });
    }
  });
});

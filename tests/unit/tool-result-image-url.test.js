/**
 * Regression for #5125 & security hardening: an image_url part inside a
 * role:"tool" message must be converted to a Claude image block (data: URI only),
 * never forwarded as an OpenAI part, remote http(s) URLs rejected, mime types
 * restricted to supported raster formats, and oversized payloads dropped.
 */
import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

const PNG_DATA = "data:image/png;base64,iVBORw0KGgo=";
const JPEG_DATA = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const GIF_DATA = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const WEBP_DATA = "data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA";

function toolResultContent(body) {
  const toolMsg = body.messages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")
  );
  return toolMsg.content.find((b) => b.type === "tool_result").content;
}

describe("tool message with image_url part (#5125)", () => {
  it("converts PNG image_url inside a tool result to a Claude image block", () => {
    const body = {
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "look at image" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "v", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "t1",
          content: [
            { type: "text", text: "shot" },
            { type: "image_url", image_url: { url: PNG_DATA } },
          ],
        },
      ],
    };

    const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
    const content = toolResultContent(out);

    expect(content.some((p) => p.type === "image_url")).toBe(false);
    const img = content.find((p) => p.type === "image");
    expect(img).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(content.find((p) => p.type === "text").text).toBe("shot");
  });

  it("converts JPEG, GIF, and WebP data URIs", () => {
    for (const [url, expectedMime] of [
      [JPEG_DATA, "image/jpeg"],
      [GIF_DATA, "image/gif"],
      [WEBP_DATA, "image/webp"],
    ]) {
      const body = {
        model: "claude-haiku-4-5",
        messages: [
          { role: "user", content: "view" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t2", type: "function", function: { name: "v", arguments: "{}" } }],
          },
          {
            role: "tool",
            tool_call_id: "t2",
            content: [{ type: "image_url", image_url: { url } }],
          },
        ],
      };

      const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
      const content = toolResultContent(out);
      const img = content.find((p) => p.type === "image");
      expect(img).toBeDefined();
      expect(img.source.media_type).toBe(expectedMime);
      expect(img.source.type).toBe("base64");
    }
  });

  it("keeps a plain string tool result unchanged", () => {
    const body = {
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t3", type: "function", function: { name: "v", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t3", content: "plain result" },
      ],
    };
    const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
    expect(toolResultContent(out)).toBe("plain result");
  });

  it("rejects remote http and https URLs and fails open", () => {
    for (const remoteUrl of [
      "http://example.com/test.png",
      "https://example.com/test.png",
      "http://127.0.0.1:8080/secret.jpg",
      "https://169.254.169.254/metadata",
    ]) {
      const body = {
        model: "claude-haiku-4-5",
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t4", type: "function", function: { name: "v", arguments: "{}" } }],
          },
          {
            role: "tool",
            tool_call_id: "t4",
            content: [
              { type: "text", text: "accompanying text" },
              { type: "image_url", image_url: { url: remoteUrl } },
            ],
          },
        ],
      };

      const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
      const content = toolResultContent(out);
      expect(content.some((p) => p.type === "image_url")).toBe(false);
      expect(content.some((p) => p.type === "image")).toBe(false);
      expect(content.find((p) => p.type === "text").text).toBe("accompanying text");
    }
  });

  it("rejects non-http remote schemes (ftp, file, javascript)", () => {
    for (const schemeUrl of [
      "file:///etc/passwd",
      "ftp://example.com/test.png",
      "javascript:alert(1)",
    ]) {
      const body = {
        model: "claude-haiku-4-5",
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t5", type: "function", function: { name: "v", arguments: "{}" } }],
          },
          {
            role: "tool",
            tool_call_id: "t5",
            content: [{ type: "image_url", image_url: { url: schemeUrl } }],
          },
        ],
      };

      const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
      const content = toolResultContent(out);
      expect(content.some((p) => p.type === "image_url")).toBe(false);
      expect(content.some((p) => p.type === "image")).toBe(false);
    }
  });

  it("rejects disallowed media types (svg, html, bmp, pdf)", () => {
    for (const badMime of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGgxPkhlbGxvPC9oMT4=",
      "data:image/bmp;base64,Qk0=",
      "data:application/pdf;base64,JVBERi0=",
    ]) {
      const body = {
        model: "claude-haiku-4-5",
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t6", type: "function", function: { name: "v", arguments: "{}" } }],
          },
          {
            role: "tool",
            tool_call_id: "t6",
            content: [
              { type: "text", text: "kept text" },
              { type: "image_url", image_url: { url: badMime } },
            ],
          },
        ],
      };

      const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
      const content = toolResultContent(out);
      expect(content.some((p) => p.type === "image_url")).toBe(false);
      expect(content.some((p) => p.type === "image")).toBe(false);
      expect(content.find((p) => p.type === "text").text).toBe("kept text");
    }
  });

  it("rejects oversized base64 payload bounded before decoding", () => {
    // 15 MiB base64 payload (exceeds 10 MiB limit)
    const oversize = "data:image/png;base64," + "A".repeat(15 * 1024 * 1024);
    const body = {
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t7", type: "function", function: { name: "v", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "t7",
          content: [
            { type: "text", text: "summary" },
            { type: "image_url", image_url: { url: oversize } },
          ],
        },
      ],
    };

    const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
    const content = toolResultContent(out);
    expect(content.some((p) => p.type === "image_url")).toBe(false);
    expect(content.some((p) => p.type === "image")).toBe(false);
    expect(content.find((p) => p.type === "text").text).toBe("summary");
  });

  it("handles hostile / malformed inputs without throwing", () => {
    const hostileInputs = [
      null,
      undefined,
      {},
      { type: "unknown" },
      { type: "image_url" },
      { type: "image_url", image_url: null },
      { type: "image_url", image_url: {} },
      { type: "image_url", image_url: { url: null } },
      { type: "image_url", image_url: { url: 12345 } },
      { type: "image_url", image_url: { url: "" } },
      { type: "image_url", image_url: { url: "not-a-data-uri" } },
      { type: "image_url", image_url: { url: "data:" } },
      { type: "image_url", image_url: { url: "data:;base64," } },
      { type: "image_url", image_url: { url: "data:image/png" } },
      { type: "image", source: null },
      { type: "image", source: { type: "url", url: "https://evil.com/img.png" } },
      { type: "image", source: { type: "base64", media_type: "text/plain", data: "dGVzdA==" } },
    ];

    for (const hostile of hostileInputs) {
      expect(() => {
        const body = {
          model: "claude-haiku-4-5",
          messages: [
            { role: "user", content: "test" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t8", type: "function", function: { name: "v", arguments: "{}" } }],
            },
            {
              role: "tool",
              tool_call_id: "t8",
              content: [hostile],
            },
          ],
        };
        const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
        const content = toolResultContent(out);
        expect(content.some((p) => p.type === "image_url")).toBe(false);
      }).not.toThrow();
    }
  });

  it("passes through valid already-Claude image blocks", () => {
    const body = {
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t9", type: "function", function: { name: "v", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "t9",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    };

    const out = openaiToClaudeRequest("claude-haiku-4-5", body, false);
    const content = toolResultContent(out);
    const img = content.find((p) => p.type === "image");
    expect(img).toBeDefined();
    expect(img.source.data).toBe("iVBORw0KGgo=");
  });
});

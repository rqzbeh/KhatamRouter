import { describe, it, expect, vi } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";
import { decloakToolsInResponse } from "@/lib/stealth/toolCloak.js";

describe("US7 Scenario 7: Passthrough Streaming Tool Decloaking", () => {
  it("decloakToolsInResponse rewrites cloaked names in raw SSE strings", () => {
    const restoreMap = new Map([
      ["BashCommand", "bash"],
      ["ReadFile", "read_file"],
    ]);

    const sseChunk = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"BashCommand"}}\n\n';
    const decloaked = decloakToolsInResponse(sseChunk, restoreMap);

    expect(decloaked).toContain('"name":"bash"');
    expect(decloaked).not.toContain('"name":"BashCommand"');
  });

  it("applies tool name decloak map to same-format passthrough streaming response", async () => {
    const toolNameMap = new Map([
      ["BashCommand", "bash"],
    ]);

    // Upstream returns same-format (e.g. Claude -> Claude) SSE stream with cloaked tool name
    const sseLines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"BashCommand"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(new TextEncoder().encode(line));
        }
        controller.close();
      },
    });

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await handleStreamingResponse({
      providerResponse: mockResponse,
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      sourceFormat: "claude",
      targetFormat: "claude", // Same-format passthrough!
      userAgent: "curl",
      body: { model: "claude-sonnet-4.5" },
      stream: true,
      translatedBody: {},
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      toolNameMap,
      streamController: {
        signal: new AbortController().signal,
        isConnected: () => true,
        handleComplete: () => {},
        handleError: () => {},
      },
    });

    expect(result.success).toBe(true);

    // Read full client response stream
    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }
    accumulated += decoder.decode();

    // Verify that the cloaked tool name was decloaked in the stream chunks!
    expect(accumulated).toContain('"name":"bash"');
    expect(accumulated).not.toContain('"name":"BashCommand"');
  });
});

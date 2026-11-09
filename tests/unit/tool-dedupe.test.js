import { describe, it, expect } from "vitest";
import { dedupeTools } from "../../open-sse/utils/toolDeduper.js";
import { CLAUDE_BLOCK } from "../../open-sse/translator/schema/blocks.js";

const BASH = (name = "Bash", desc = "Run a shell command") => ({
  name,
  description: desc,
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
});

const FUNC_SHAPE = (name = "Bash") => ({
  type: "function",
  function: { name, description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } },
});

const MCP_EXA = { name: "mcp__exa__web_search_exa", description: "search" };

describe("toolDeduper — MCP-equivalent built-in rules (existing behavior)", () => {
  it("claude client + Exa MCP → drops built-in WebSearch/WebFetch", () => {
    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "web" }, { name: "WebFetch", description: "web" }, BASH()],
      { clientTool: "claude" }
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"]);
    expect(stripped.sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  it("non-claude client → MCP built-in rules do NOT run (behavior preserved)", () => {
    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "web" }],
      { clientTool: "codex" }
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "WebSearch"]);
    expect(stripped).toEqual([]);
  });

  it("legacy call without opts still applies MCP rules for claude callers (back-compat shape)", () => {
    const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }]);
    expect(tools).toHaveLength(2);
    expect(stripped).toEqual([]);
  });
});

describe("toolDeduper — DeepSeek same-name dedup", () => {
  it("deepseek model + duplicate tool names → keeps first definition", () => {
    const first = BASH();
    const dup = BASH("Bash", "duplicate description");
    const { tools, stripped } = dedupeTools([first, dup], { model: "deepseek-v4-flash" });
    expect(tools).toEqual([first]);
    expect(stripped).toEqual(["Bash"]);
  });

  it("deepseek model + (max) thinking suffix → still dedups", () => {
    const { tools, stripped } = dedupeTools([BASH(), BASH("Bash", "dup")], { model: "deepseek-v4-flash(max)" });
    expect(tools).toHaveLength(1);
    expect(stripped).toEqual(["Bash"]);
  });

  it("deepseek + 3 same-name tools → keeps first, drops both duplicates", () => {
    const { tools, stripped } = dedupeTools([BASH(), BASH("Bash", "d1"), BASH("Bash", "d2")], { model: "deepseek-v4-pro" });
    expect(tools).toHaveLength(1);
    expect(stripped).toEqual(["Bash", "Bash"]);
  });

  it("deepseek + OpenAI function-shape tools → dedups by function.name", () => {
    const { tools } = dedupeTools([FUNC_SHAPE("Bash"), FUNC_SHAPE("Bash")], { model: "deepseek-v4-flash" });
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("Bash");
  });

  it("non-DeepSeek model + duplicate tool names → untouched", () => {
    const tools = [BASH(), BASH("Bash", "dup")];
    const { tools: out, stripped } = dedupeTools(tools, { model: "glm-5.2" });
    expect(out).toBe(tools);
    expect(stripped).toEqual([]);
  });

  it("no model declared → same-name dedup does NOT run", () => {
    const tools = [BASH(), BASH("Bash", "dup")];
    const { tools: out, stripped } = dedupeTools(tools, {});
    expect(out).toBe(tools);
    expect(stripped).toEqual([]);
  });

  it("deepseek + distinct names → nothing stripped", () => {
    const { tools, stripped } = dedupeTools([BASH("Bash"), BASH("ReadFile")], { model: "deepseek-v4-flash" });
    expect(tools).toHaveLength(2);
    expect(stripped).toEqual([]);
  });

  it("claude client + deepseek + MCP trigger → both rules apply (union stripped)", () => {
    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "web" }, BASH(), BASH("Bash", "dup")],
      { clientTool: "claude", model: "deepseek-v4-flash" }
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"]);
    expect(stripped.sort()).toEqual(["Bash", "WebSearch"]);
  });
});

describe("toolDeduper — cleanStrippedToolReferences (#a3039ab1)", () => {
  it("drops tool_reference blocks naming stripped tools from tool_result content", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: CLAUDE_BLOCK.TOOL_RESULT,
            tool_use_id: "toolu_1",
            content: [
              { type: CLAUDE_BLOCK.TOOL_REFERENCE, tool_name: "WebSearch" },
              { type: CLAUDE_BLOCK.TEXT, text: "Remaining content" },
            ],
          },
        ],
      },
    ];

    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "search" }, BASH()],
      { clientTool: "claude", messages }
    );

    expect(stripped).toContain("WebSearch");
    const resultBlock = messages[0].content[0];
    expect(resultBlock.content).toEqual([{ type: CLAUDE_BLOCK.TEXT, text: "Remaining content" }]);
  });

  it("replaces content with unavailable note when tool_reference was the only block", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: CLAUDE_BLOCK.TOOL_RESULT,
            tool_use_id: "toolu_2",
            content: [
              { type: CLAUDE_BLOCK.TOOL_REFERENCE, tool_name: "WebFetch" },
            ],
          },
        ],
      },
    ];

    const { tools, stripped } = dedupeTools(
      [MCP_EXA, { name: "WebFetch", description: "fetch" }],
      { clientTool: "claude", messages }
    );

    expect(stripped).toContain("WebFetch");
    const resultBlock = messages[0].content[0];
    expect(resultBlock.content).toEqual([
      { type: CLAUDE_BLOCK.TEXT, text: "[Tool WebFetch is unavailable]" },
    ]);
  });

  it("does not strip references for unstripped tools", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: CLAUDE_BLOCK.TOOL_RESULT,
            tool_use_id: "toolu_3",
            content: [
              { type: CLAUDE_BLOCK.TOOL_REFERENCE, tool_name: "Bash" },
            ],
          },
        ],
      },
    ];

    dedupeTools(
      [MCP_EXA, { name: "WebSearch", description: "search" }, BASH()],
      { clientTool: "claude", messages }
    );

    const resultBlock = messages[0].content[0];
    expect(resultBlock.content).toEqual([
      { type: CLAUDE_BLOCK.TOOL_REFERENCE, tool_name: "Bash" },
    ]);
  });
});

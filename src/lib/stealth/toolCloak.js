/**
 * Tool-Name Cloaking, Schema Sanitisation and RESTORE Map (Wave 5)
 *
 * Providers fingerprint clients by inspecting tool names and JSON schemas.
 * Third-party agent harnesses emit snake_case / lowercase tool names and
 * schemas carrying keywords providers reject or flag (`$schema`, `$id`, `$ref`,
 * empty `required`). This module:
 *
 *   1. Sanitises tool parameter schemas (non-mutating deep clone).
 *   2. Remaps tool names to canonical PascalCase Claude Code spellings.
 *   3. Returns a RESTORE map so responses can be decloaked transparently.
 *
 * Default-OFF behind STEALTH_TOOL_CLOAK=1 / STEALTH_ALL=1 / CLI_COMPAT_<PROVIDER>=1.
 */

/** Canonical Claude Code PascalCase spellings. */
export const TOOL_RENAME_MAP = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  agent: "Agent",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  question: "Question",
  askuserquestion: "AskUserQuestion",
  skill: "Skill",
  slashcommand: "SlashCommand",
  multiedit: "MultiEdit",
  notebook: "Notebook",
  notebookedit: "NotebookEdit",
  notebookread: "NotebookRead",
  lsp: "Lsp",
  apply_patch: "ApplyPatch",
  applypatch: "ApplyPatch",
  bashoutput: "BashOutput",
  killshell: "KillShell",
  killbash: "KillBash",
  enterplanmode: "EnterPlanMode",
  exitplanmode: "ExitPlanMode",
  enterworktree: "EnterWorktree",
  exitworktree: "ExitWorktree",
  croncreate: "CronCreate",
  crondelete: "CronDelete",
  cronlist: "CronList",
  taskoutput: "TaskOutput",
  taskstop: "TaskStop",
  taskcreate: "TaskCreate",
  taskupdate: "TaskUpdate",
  tasklist: "TaskList",
};

/** Harness-specific aliases mapped onto genuine Claude Code tools. */
export const HARNESS_CANONICAL_MAP = {
  read_file: "Read",
  write_file: "Write",
  search_files: "Grep",
  grep_search: "Grep",
  list_directory: "Glob",
  run_command: "Bash",
  terminal: "Bash",
  todo: "TodoWrite",
  todo_write: "TodoWrite",
  todo_read: "TodoRead",
  patch: "Edit",
  multi_edit: "MultiEdit",
};

/** Schema keywords stripped from tool parameters. */
export const STRIPPED_SCHEMA_KEYWORDS = ["$schema", "$id", "$comment"];

/** Anthropic server-side tool type pattern (e.g. `web_search_20250305`). */
const VERSIONED_SERVER_TOOL_TYPE = /^[a-z][a-z0-9_]*_\d{8}$/;
const NON_VERSIONED_SERVER_TOOL_TYPES = new Set(["web_search", "web_search_preview"]);

/**
 * Check if tool cloaking is enabled for the provider or globally.
 * Default is FALSE (default-off).
 *
 * @param {string} [provider]
 * @returns {boolean}
 */
export function isToolCloakEnabled(provider) {
  if (typeof process === "undefined" || !process.env) return false;
  if (
    process.env.STEALTH_ALL === "1" ||
    process.env.STEALTH_TOOL_CLOAK === "1" ||
    process.env.STEALTH_CLOAK === "1"
  ) {
    return true;
  }
  if (!provider || typeof provider !== "string") return false;

  const key = provider.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const envKey = `STEALTH_TOOL_CLOAK_${key.toUpperCase()}`;
  return process.env[envKey] === "1" || process.env[envKey] === "true";
}

/**
 * Anthropic server tools bind a reserved literal `name` to their `type`.
 * Never rename them.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isAnthropicServerToolType(type) {
  if (typeof type !== "string" || type.length === 0) return false;
  return VERSIONED_SERVER_TOOL_TYPE.test(type) || NON_VERSIONED_SERVER_TOOL_TYPES.has(type);
}

/**
 * True when a tool name should be cloaked.
 * MCP names (`mcp__*`) are reserved by the client and left alone.
 * Names already PascalCase without separators are already canonical.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function shouldCloakToolName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith("mcp__")) return false;
  if (TOOL_RENAME_MAP[name] || HARNESS_CANONICAL_MAP[name]) return true;
  // Snake_case / kebab-case / leading lowercase → not a genuine Claude Code name.
  return /[a-z]/.test(name.charAt(0)) || name.includes("_") || name.includes("-");
}

/**
 * Convert an arbitrary identifier to PascalCase.
 *
 * @param {string} name
 * @returns {string}
 */
export function toPascalCaseToolName(name) {
  const parts = String(name)
    .split(/[_\-\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return name;
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

/**
 * Sanitise a JSON schema for a tool parameter object.
 * Non-mutating: builds an independent deep copy.
 *
 * - strips `$schema`, `$id`, `$comment`
 * - drops empty `required` arrays
 * - forces root `type: "object"` for parameter schemas
 *
 * `$ref` is preserved deliberately: it cannot be resolved here and stripping it
 * would widen the schema to "anything goes".
 *
 * @param {unknown} schema
 * @param {{ root?: boolean }} [options]
 * @returns {unknown}
 */
export function sanitizeToolSchema(schema, options = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;

    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (STRIPPED_SCHEMA_KEYWORDS.includes(key)) continue;
      if (key === "required" && Array.isArray(child) && child.length === 0) continue;
      out[key] = walk(child);
    }
    return out;
  };

  const cleaned = walk(schema);

  if (options.root !== false) {
    cleaned.type = "object";
    if (
      !cleaned.properties ||
      typeof cleaned.properties !== "object" ||
      Array.isArray(cleaned.properties)
    ) {
      cleaned.properties = {};
    }
  }

  return cleaned;
}

/** Read a tool's declared name from flat (`{name}`) or chat (`{function:{name}}`) shapes. */
function readToolName(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

/**
 * Return a copy of a tool with a replaced name (preserves flat/chat shape).
 */
function withToolName(tool, name) {
  const fn = tool?.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    return { ...tool, function: { ...fn, name } };
  }
  return { ...tool, name };
}

/**
 * Sanitise the parameter schema on a tool copy (flat `parameters` / `input_schema`,
 * or chat `function.parameters`).
 */
function sanitizeToolOnWire(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
  if (isAnthropicServerToolType(tool.type)) return tool;

  let next = tool;

  if (next.parameters && typeof next.parameters === "object" && !Array.isArray(next.parameters)) {
    next = { ...next, parameters: sanitizeToolSchema(next.parameters) };
  }
  if (next.input_schema && typeof next.input_schema === "object" && !Array.isArray(next.input_schema)) {
    next = { ...next, input_schema: sanitizeToolSchema(next.input_schema) };
  }
  const fn = next.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    if (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) {
      next = { ...next, function: { ...fn, parameters: sanitizeToolSchema(fn.parameters) } };
    }
  }

  return next;
}

/**
 * Cloak tools in a request body.
 *
 * Returns `{ body, restoreMap }` where `restoreMap` maps SENT name → ORIGINAL name.
 * When cloaking is disabled, `restoreMap` is an empty Map and `body` is returned unchanged.
 *
 * @param {object} body - Request body (Claude/OpenAI/Responses shape)
 * @param {{ provider?: string, force?: boolean }} [options]
 * @returns {{ body: object, restoreMap: Map<string, string> }}
 */
export function cloakToolsInRequest(body, options = {}) {
  const restoreMap = new Map();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, restoreMap };
  }

  const enabled = options.force || isToolCloakEnabled(options.provider);
  if (!enabled) {
    return { body, restoreMap };
  }

  const tools = Array.isArray(body.tools) ? body.tools : null;
  if (!tools || tools.length === 0) {
    return { body, restoreMap };
  }

  const used = new Set();
  for (const tool of tools) {
    const name = readToolName(tool);
    if (name) used.add(name);
  }

  const assigned = new Map();

  const aliasFor = (original) => {
    if (assigned.has(original)) return assigned.get(original);
    const base =
      TOOL_RENAME_MAP[original] ?? HARNESS_CANONICAL_MAP[original] ?? toPascalCaseToolName(original);
    let alias = base;
    let suffix = 2;
    while (alias !== original && used.has(alias)) {
      alias = `${base}${suffix++}`;
    }
    used.add(alias);
    assigned.set(original, alias);
    restoreMap.set(alias, original);
    return alias;
  };

  const nextTools = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    // Server tools keep their type-bound literal name.
    if (isAnthropicServerToolType(tool.type)) return sanitizeToolOnWire(tool);

    let next = sanitizeToolOnWire(tool);
    const name = readToolName(next);
    if (name && shouldCloakToolName(name)) {
      next = withToolName(next, aliasFor(name));
    }
    return next;
  });

  let nextBody = { ...body, tools: nextTools };

  // Rewrite tool_use blocks in message history.
  if (Array.isArray(body.messages)) {
    nextBody.messages = body.messages.map((message) => {
      if (!message || typeof message !== "object" || !Array.isArray(message.content)) return message;
      const content = message.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        if (block.type !== "tool_use" || typeof block.name !== "string") return block;
        if (!shouldCloakToolName(block.name)) return block;
        return { ...block, name: aliasFor(block.name) };
      });
      return { ...message, content };
    });
  }

  // Rewrite tool_choice.
  const choice = body.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    if (choice.type === "tool" && typeof choice.name === "string" && shouldCloakToolName(choice.name)) {
      nextBody.tool_choice = { ...choice, name: aliasFor(choice.name) };
    } else if (choice.function && typeof choice.function === "object" && typeof choice.function.name === "string" && shouldCloakToolName(choice.function.name)) {
      nextBody.tool_choice = {
        ...choice,
        function: { ...choice.function, name: aliasFor(choice.function.name) },
      };
    }
  }

  return { body: nextBody, restoreMap };
}

/**
 * Decloak tool names in a response payload (JSON object / array / SSE string).
 *
 * Handles:
 *   - Claude block objects: `{ type: "tool_use", name }`
 *   - OpenAI chat: `choice.message.tool_calls[].function.name`, `delta.tool_calls[]`
 *   - OpenAI Responses: `output[].name`, SSE `item.name`
 *   - Raw SSE/NDJSON strings (JSON payloads are rewritten in place)
 *
 * @param {unknown} payload
 * @param {Map<string, string> | null | undefined} restoreMap
 * @returns {unknown}
 */
export function decloakToolsInResponse(payload, restoreMap) {
  if (!restoreMap || restoreMap.size === 0 || payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload === "string") {
    return decloakText(payload, restoreMap);
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => decloakToolsInResponse(item, restoreMap));
  }

  if (typeof payload !== "object") return payload;

  let changed = false;
  const out = { ...payload };

  /** Restore a name if the map knows it. */
  const restore = (name) => (typeof name === "string" && restoreMap.has(name) ? restoreMap.get(name) : name);

  // Claude block / Responses item
  if (typeof out.name === "string" && restoreMap.has(out.name)) {
    const restored = restore(out.name);
    if (restored !== out.name) {
      out.name = restored;
      changed = true;
    }
  }

  // Anthropic content blocks (non-streaming body)
  if (Array.isArray(out.content)) {
    const content = out.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      if (block.type !== "tool_use" || typeof block.name !== "string") return block;
      const restored = restore(block.name);
      if (restored === block.name) return block;
      changed = true;
      return { ...block, name: restored };
    });
    if (changed) out.content = content;
  }

  // OpenAI chat choices
  if (Array.isArray(out.choices)) {
    let choicesChanged = false;
    const choices = out.choices.map((choice) => {
      if (!choice || typeof choice !== "object") return choice;
      let nextChoice = choice;
      for (const holder of ["message", "delta"]) {
        const value = choice[holder];
        if (!value || typeof value !== "object" || !Array.isArray(value.tool_calls)) continue;
        let callsChanged = false;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name !== "string" || !restoreMap.has(name)) return call;
          callsChanged = true;
          return { ...call, function: { ...call.function, name: restore(name) } };
        });
        if (callsChanged) {
          nextChoice = { ...nextChoice, [holder]: { ...value, tool_calls: calls } };
        }
      }
      if (nextChoice !== choice) choicesChanged = true;
      return nextChoice;
    });
    if (choicesChanged) {
      out.choices = choices;
      changed = true;
    }
  }

  // OpenAI Responses output
  if (Array.isArray(out.output)) {
    let outputChanged = false;
    const output = out.output.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type !== "function_call" || typeof item.name !== "string") return item;
      const restored = restore(item.name);
      if (restored === item.name) return item;
      outputChanged = true;
      return { ...item, name: restored };
    });
    if (outputChanged) {
      out.output = output;
      changed = true;
    }
  }

  // Responses SSE `item`
  if (out.item && typeof out.item === "object" && typeof out.item.name === "string") {
    const restored = restore(out.item.name);
    if (restored !== out.item.name) {
      out.item = { ...out.item, name: restored };
      changed = true;
    }
  }

  // Anthropic SSE content_block_start
  if (out.content_block && typeof out.content_block === "object" && typeof out.content_block.name === "string") {
    const restored = restore(out.content_block.name);
    if (restored !== out.content_block.name) {
      out.content_block = { ...out.content_block, name: restored };
      changed = true;
    }
  }

  return changed ? out : payload;
}

/**
 * Restore cloaked names inside raw SSE/NDJSON text.
 *
 * Only exact `"name":"<alias>"` / `"name": "<alias>"` JSON fragments are
 * rewritten; free-form prose containing the alias is untouched.
 *
 * @param {string} text
 * @param {Map<string, string>} restoreMap
 * @returns {string}
 */
function decloakText(text, restoreMap) {
  let out = text;
  for (const [alias, original] of restoreMap) {
    if (!out.includes(alias)) continue;
    out = out.split(`"name":"${alias}"`).join(`"name":"${original}"`);
    out = out.split(`"name": "${alias}"`).join(`"name": "${original}"`);
  }
  return out;
}

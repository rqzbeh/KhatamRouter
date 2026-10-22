// Wave 5 — Stealth and anti-ban suite.
//
// Covers (spec.md US1..US5 / NR1..NR4):
// 1. CLI fingerprints: canonical header ordering + body field ordering
// 2. Header scrubbing: proxy/browser markers stripped, encoding normalised
// 3. Tool cloaking: schema sanitisation + PascalCase remap with RESTORE map
// 4. Zero-width: U+200D obfuscation, Persian half-space preservation
// 5. Stickiness: SHA-256 first-message pin, TTL, fail-open
// 6. Default-OFF isolation: every capability is a no-op when flags are unset

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fingerprints = await import("@/lib/stealth/cliFingerprints.js");
const headerScrub = await import("@/lib/stealth/headerScrub.js");
const toolCloak = await import("@/lib/stealth/toolCloak.js");
const zeroWidth = await import("@/lib/stealth/zeroWidth.js");
const stickiness = await import("@/lib/stealth/stickiness.js");
const dispatch = await import("@/lib/stealth/dispatch.js");

const STEALTH_ENV_KEYS = [
  "STEALTH_ALL",
  "STEALTH_FINGERPRINTS",
  "STEALTH_HEADER_SCRUB",
  "STEALTH_SCRUB",
  "STEALTH_TOOL_CLOAK",
  "STEALTH_ZERO_WIDTH",
  "STEALTH_STICKINESS",
  "CLI_COMPAT_ALL",
  "CLI_COMPAT_CLAUDE",
  "CLI_COMPAT_CODEX",
  "CLI_COMPAT_ANTIGRAVITY",
];

function clearStealthEnv() {
  for (const key of STEALTH_ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  clearStealthEnv();
});

afterEach(() => {
  clearStealthEnv();
  vi.useRealTimers();
  stickiness.clearStickyConnections();
});

// ─── US1: CLI fingerprints ──────────────────────────────────────────────────

describe("Wave 5 / CLI Fingerprints", () => {
  it("orders headers per the codex profile and appends unlisted ones last", () => {
    const headers = {
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "X-Custom": "kept",
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Host: "chatgpt.com",
      Accept: "*/*",
      "User-Agent": "codex-cli/1.0",
    };

    const ordered = fingerprints.orderHeaders(headers, fingerprints.CLI_FINGERPRINTS.codex.headerOrder);

    expect(Object.keys(ordered)).toEqual([
      "Host",
      "Content-Type",
      "Authorization",
      "Accept",
      "User-Agent",
      "Accept-Encoding",
      "X-Custom",
    ]);
    expect(ordered["X-Custom"]).toBe("kept");
    expect(ordered.Authorization).toBe("Bearer tok");
  });

  it("matches header names case-insensitively but emits canonical casing", () => {
    const headers = { "user-agent": "cli", authorization: "Bearer x", host: "api.anthropic.com" };
    const ordered = fingerprints.orderHeaders(headers, ["Host", "Authorization", "User-Agent"]);

    expect(Object.keys(ordered)).toEqual(["Host", "Authorization", "User-Agent"]);
    expect(ordered.Host).toBe("api.anthropic.com");
  });

  it("orders body fields per the codex profile, appending unlisted fields", () => {
    const body = {
      metadata: { k: "v" },
      stream: true,
      model: "gpt-6",
      extra: "kept",
      input: [],
    };

    const ordered = fingerprints.orderFields(body, fingerprints.CLI_FINGERPRINTS.codex.bodyFieldOrder);

    expect(Object.keys(ordered).slice(0, 3)).toEqual(["model", "stream", "input"]);
    expect(Object.keys(ordered)).toContain("extra");
    expect(Object.keys(ordered).indexOf("metadata")).toBeLessThan(Object.keys(ordered).indexOf("extra"));
  });

  it("does not mutate the caller's body or headers", () => {
    const body = { b: 1, a: 2 };
    const headers = { "x-b": "2", "x-a": "1" };
    const bodySnapshot = JSON.stringify(body);
    const headerSnapshot = JSON.stringify(headers);

    fingerprints.orderFields(body, ["a", "b"]);
    fingerprints.orderHeaders(headers, ["x-a", "x-b"]);

    expect(JSON.stringify(body)).toBe(bodySnapshot);
    expect(JSON.stringify(headers)).toBe(headerSnapshot);
  });

  it("strips internal engine markers from the outgoing body", () => {
    const body = {
      model: "gpt-6",
      _toolNameMap: new Map([["Read", "read"]]),
      _customToolNames: ["x"],
      _nativeCodexPassthrough: true,
      _khatamResilience: { on: true },
      _omnirouteSkipContextRelay: true,
      messages: [],
    };

    const stripped = fingerprints.stripInternalBodyFields(body);

    expect(stripped).not.toHaveProperty("_toolNameMap");
    expect(stripped).not.toHaveProperty("_customToolNames");
    expect(stripped).not.toHaveProperty("_nativeCodexPassthrough");
    expect(stripped).not.toHaveProperty("_khatamResilience");
    expect(stripped).not.toHaveProperty("_omnirouteSkipContextRelay");
    expect(stripped.model).toBe("gpt-6");
    // Caller's object untouched.
    expect(body).toHaveProperty("_toolNameMap");
  });

  it("normalises provider aliases to fingerprint keys", () => {
    expect(fingerprints.normalizeFingerprintProvider("copilot")).toBe("github");
    expect(fingerprints.normalizeFingerprintProvider("github-copilot")).toBe("github");
    expect(fingerprints.normalizeFingerprintProvider("Claude-Code")).toBe("claude-code-compatible");
    expect(fingerprints.normalizeFingerprintProvider("codex")).toBe("codex");
  });

  it("applies header + body ordering through applyFingerprint when forced", () => {
    const out = fingerprints.applyFingerprint(
      "codex",
      { "Accept-Encoding": "gzip", model: undefined, Authorization: "Bearer t" },
      { extra: 1, stream: true, model: "gpt-6", _khatamMarker: 1 },
      { force: true }
    );

    expect(Object.keys(out.headers)[0]).toBe("Authorization");
    const parsed = JSON.parse(out.bodyString);
    expect(Object.keys(parsed).slice(0, 2)).toEqual(["model", "stream"]);
    expect(parsed).not.toHaveProperty("_khatamMarker");
  });
});

// ─── US2: header scrubbing ──────────────────────────────────────────────────

describe("Wave 5 / Header Scrub", () => {
  const dirtyHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer secret-token",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-host": "internal.proxy",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.7",
    forwarded: "for=203.0.113.7",
    via: "1.1 nginx",
    "sec-ch-ua": '"Chromium";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "none",
    priority: "u=1, i",
    "x-khatam-request-id": "abc",
    "Accept-Encoding": "gzip, deflate, br, zstd",
  };

  it("strips proxy, forwarding and browser fingerprint headers", () => {
    const cleaned = headerScrub.scrubHeaders(dirtyHeaders, { force: true });

    for (const banned of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "forwarded",
      "via",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-fetch-mode",
      "sec-fetch-site",
      "priority",
      "x-khatam-request-id",
    ]) {
      expect(Object.keys(cleaned).map((k) => k.toLowerCase())).not.toContain(banned);
    }
  });

  it("normalises Accept-Encoding to the Node CLI value", () => {
    const cleaned = headerScrub.scrubHeaders(dirtyHeaders, { force: true });
    expect(cleaned["Accept-Encoding"]).toBe(headerScrub.NODE_ACCEPT_ENCODING);
    expect(cleaned["Accept-Encoding"]).not.toContain("zstd");
  });

  it("keeps auth and content headers, and does not mutate the input", () => {
    const snapshot = JSON.stringify(dirtyHeaders);
    const cleaned = headerScrub.scrubHeaders(dirtyHeaders, { force: true });

    expect(cleaned.Authorization).toBe("Bearer secret-token");
    expect(cleaned["Content-Type"]).toBe("application/json");
    expect(JSON.stringify(dirtyHeaders)).toBe(snapshot);
  });

  it("preserves Stainless headers for claude and strips them otherwise", () => {
    const headers = { "x-stainless-lang": "js", "X-Title": "proxy", Authorization: "Bearer t" };

    const claudeOut = headerScrub.scrubHeaders(headers, { force: true, provider: "claude" });
    expect(claudeOut["x-stainless-lang"]).toBe("js");
    expect(claudeOut).not.toHaveProperty("X-Title");

    const otherOut = headerScrub.scrubHeaders(headers, { force: true, provider: "codex" });
    expect(otherOut).not.toHaveProperty("x-stainless-lang");
  });

  it("can defer the Authorization header to the end (Antigravity wire order)", () => {
    const cleaned = headerScrub.scrubHeaders(
      { Authorization: "Bearer t", Accept: "*/*", "Content-Type": "application/json" },
      { force: true, deferAuthorization: true, normalizeEncoding: false }
    );
    const keys = Object.keys(cleaned);
    expect(keys[keys.length - 1]).toBe("Authorization");
  });
});

// ─── US3: tool cloaking ─────────────────────────────────────────────────────

describe("Wave 5 / Tool Cloak and Schema", () => {
  const baseBody = () => ({
    model: "claude-x",
    tools: [
      {
        name: "read_file",
        description: "read",
        input_schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "urn:read",
          type: "object",
          properties: { path: { type: "string" } },
          required: [],
        },
      },
      { name: "run_command", description: "run", input_schema: { type: "object", properties: {} } },
      { name: "mcp__custom__do_thing", description: "mcp", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305", name: "web_search" },
    ],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
    ],
    tool_choice: { type: "tool", name: "run_command" },
  });

  it("sanitises schema keywords without touching the input schema", () => {
    const input = baseBody().tools[0].input_schema;
    const snapshot = JSON.stringify(input);

    const cleaned = toolCloak.sanitizeToolSchema(input);

    expect(cleaned).not.toHaveProperty("$schema");
    expect(cleaned).not.toHaveProperty("$id");
    expect(cleaned).not.toHaveProperty("required");
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({ path: { type: "string" } });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("forces a root object type and empty properties for non-object roots", () => {
    expect(toolCloak.sanitizeToolSchema({ type: null })).toEqual({ type: "object", properties: {} });
    expect(toolCloak.sanitizeToolSchema({ anyOf: [{ type: "string" }] })).toEqual({
      anyOf: [{ type: "string" }],
      type: "object",
      properties: {},
    });
  });

  it("preserves $ref (cannot resolve it, must not widen the schema)", () => {
    const schema = { type: "object", properties: { a: { $ref: "#/defs/A" } } };
    const cleaned = toolCloak.sanitizeToolSchema(schema);
    expect(cleaned.properties.a.$ref).toBe("#/defs/A");
  });

  it("remaps snake_case/lowercase tools to PascalCase and records a RESTORE map", () => {
    const { body, restoreMap } = toolCloak.cloakToolsInRequest(baseBody(), { force: true });

    expect(body.tools[0].name).toBe("Read");
    expect(body.tools[1].name).toBe("Bash");
    expect(restoreMap.get("Read")).toBe("read_file");
    expect(restoreMap.get("Bash")).toBe("run_command");
  });

  it("leaves MCP tools and Anthropic server tools untouched", () => {
    const { body } = toolCloak.cloakToolsInRequest(baseBody(), { force: true });
    expect(body.tools[2].name).toBe("mcp__custom__do_thing");
    expect(body.tools[3]).toEqual({ type: "web_search_20250305", name: "web_search" });
  });

  it("rewrites tool_use history and tool_choice consistently", () => {
    const { body } = toolCloak.cloakToolsInRequest(baseBody(), { force: true });
    expect(body.messages[1].content[0].name).toBe("Read");
    expect(body.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  it("sanitises tool schemas on the wire copy", () => {
    const { body } = toolCloak.cloakToolsInRequest(baseBody(), { force: true });
    expect(body.tools[0].input_schema).not.toHaveProperty("$schema");
    expect(body.tools[0].input_schema).not.toHaveProperty("$id");
    expect(body.tools[0].input_schema.required).toBeUndefined();
  });

  it("decloaks a non-streaming Claude response body", () => {
    const { restoreMap } = toolCloak.cloakToolsInRequest(baseBody(), { force: true });
    const response = {
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t2", name: "Read", input: { path: "/x" } },
      ],
    };

    const restored = toolCloak.decloakToolsInResponse(response, restoreMap);
    expect(restored.content[1].name).toBe("read_file");
    // Input untouched.
    expect(response.content[1].name).toBe("Read");
  });

  it("decloaks OpenAI chat and Responses shapes", () => {
    const restoreMap = new Map([["Read", "read_file"]]);

    const chat = toolCloak.decloakToolsInResponse(
      { choices: [{ delta: { tool_calls: [{ function: { name: "Read", arguments: "{}" } }] } }] },
      restoreMap
    );
    expect(chat.choices[0].delta.tool_calls[0].function.name).toBe("read_file");

    const responses = toolCloak.decloakToolsInResponse(
      { output: [{ type: "function_call", name: "Read", arguments: "{}" }] },
      restoreMap
    );
    expect(responses.output[0].name).toBe("read_file");
  });

  it("decloaks Anthropic SSE content_block_start and raw SSE text", () => {
    const restoreMap = new Map([["Read", "read_file"]]);

    const event = toolCloak.decloakToolsInResponse(
      { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } },
      restoreMap
    );
    expect(event.content_block.name).toBe("read_file");

    const text = 'event: x\ndata: {"type":"tool_use","name":"Read"}\n\n';
    expect(toolCloak.decloakToolsInResponse(text, restoreMap)).toContain('"name":"read_file"');
    // Prose mentioning the alias is untouched.
    expect(toolCloak.decloakToolsInResponse("the Read tool is great", restoreMap)).toBe(
      "the Read tool is great"
    );
  });

  it("resolves alias collisions deterministically", () => {
    const body = {
      tools: [
        { name: "read_file", input_schema: { type: "object", properties: {} } },
        { name: "Read", input_schema: { type: "object", properties: {} } },
      ],
    };

    const { body: cloaked, restoreMap } = toolCloak.cloakToolsInRequest(body, { force: true });

    // "Read" is genuine Claude Code spelling; read_file must not steal the name.
    expect(cloaked.tools[1].name).toBe("Read");
    expect(cloaked.tools[0].name).not.toBe("Read");
    expect(restoreMap.get(cloaked.tools[0].name)).toBe("read_file");
  });

  it("returns the body untouched and an empty map when disabled", () => {
    const body = baseBody();
    const { body: out, restoreMap } = toolCloak.cloakToolsInRequest(body);

    expect(out).toBe(body);
    expect(restoreMap.size).toBe(0);
  });
});

// ─── US4: zero-width ────────────────────────────────────────────────────────

describe("Wave 5 / Zero-Width and Persian Half-Space", () => {
  const ZWJ = "‍";
  const ZWNJ = "‌";

  it("inserts a joiner after the first character of an agent word", () => {
    const out = zeroWidth.obfuscateAgentWords("please use opencode now", ["opencode"], { force: true });
    expect(out).toBe(`please use o${ZWJ}pencode now`);
  });

  it("round-trips obfuscation back to the original text", () => {
    const original = "route through opencode and cline";
    const obfuscated = zeroWidth.obfuscateAgentWords(original, ["opencode", "cline"], { force: true });
    expect(obfuscated).not.toBe(original);
    expect(zeroWidth.stripObfuscationZeroWidth(obfuscated, { force: true })).toBe(original);
  });

  it("preserves Persian half-spaces (U+200C) verbatim", () => {
    const persian = `می${ZWNJ}روم به خانه و کتاب${ZWNJ}ها را می${ZWNJ}خوانم`;
    const out = zeroWidth.stripObfuscationZeroWidth(persian, { force: true });
    expect(out).toBe(persian);
    expect(out).toContain(ZWNJ);
    expect(out).toContain("می‌روم");
    expect(out).toContain("کتاب‌ها");
  });

  it("preserves Persian half-space while cleaning an interleaved ASCII obfuscation", () => {
    const mixed = `o${ZWJ}pencode و می${ZWNJ}روم`;
    const out = zeroWidth.stripObfuscationZeroWidth(mixed, { force: true });
    expect(out).toBe(`opencode و می${ZWNJ}روم`);
  });

  it("preserves emoji ZWJ sequences", () => {
    const family = "👨‍👩‍👧";
    expect(zeroWidth.stripObfuscationZeroWidth(family, { force: true })).toBe(family);
  });

  it("strips ZWSP and BOM unconditionally", () => {
    expect(zeroWidth.stripObfuscationZeroWidth("a​b﻿c", { force: true })).toBe("abc");
  });

  it("cleans a joiner left dangling at a streaming delta boundary", () => {
    // A delta that is only the joiner between two ASCII halves.
    expect(zeroWidth.stripObfuscationZeroWidth(`o${ZWJ}`, { force: true })).toBe("o");
    // A lone joiner with no ASCII neighbour (emoji split) passes through.
    expect(zeroWidth.stripObfuscationZeroWidth(`${ZWJ}`, { force: true })).toBe(ZWJ);
  });

  it("is a no-op when disabled", () => {
    const text = "opencode";
    expect(zeroWidth.obfuscateAgentWords(text, ["opencode"])).toBe(text);
    expect(zeroWidth.stripObfuscationZeroWidth(`o${ZWJ}pencode`)).toBe(`o${ZWJ}pencode`);
  });
});

// ─── US5: stickiness ────────────────────────────────────────────────────────

describe("Wave 5 / Session Stickiness", () => {
  const conversation = () => [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "explain circuit breakers" },
    { role: "assistant", content: "sure" },
    { role: "user", content: "and now quotas?" },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    process.env.STEALTH_STICKINESS = "1";
  });

  it("derives a stable key from the first user message across turns", () => {
    const turn1 = stickiness.computeSessionKey({ messages: conversation() });
    const turn2 = stickiness.computeSessionKey({
      messages: [...conversation(), { role: "user", content: "more" }],
    });

    expect(turn1).toBeTruthy();
    expect(turn1).toHaveLength(stickiness.STICKINESS_KEY_LENGTH);
    expect(turn2).toBe(turn1);
  });

  it("changing the first message changes the key", () => {
    const a = stickiness.computeSessionKey({
      messages: [{ role: "user", content: "question A" }],
    });
    const b = stickiness.computeSessionKey({
      messages: [{ role: "user", content: "question B" }],
    });
    expect(a).not.toBe(b);
  });

  it("namespaces keys by combo/provider identity", () => {
    const messages = [{ role: "user", content: "same prompt" }];
    const a = stickiness.computeSessionKey({ messages }, "combo-a");
    const b = stickiness.computeSessionKey({ messages }, "combo-b");
    expect(a).not.toBe(b);
  });

  it("handles Claude content-block arrays", () => {
    const key = stickiness.computeSessionKey({
      messages: [{ role: "user", content: [{ type: "text", text: "block prompt" }] }],
    });
    expect(key).toBeTruthy();
  });

  it("pins, reads back and refreshes a live binding", () => {
    const key = stickiness.computeSessionKey({ messages: conversation() });
    expect(stickiness.setStickyConnection(key, "conn-1")).toBe(true);
    expect(stickiness.getStickyConnection(key)).toBe("conn-1");

    vi.advanceTimersByTime(10 * 60 * 1000);
    // A read inside TTL refreshes lastUsedAt.
    expect(stickiness.getStickyConnection(key)).toBe("conn-1");

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(stickiness.getStickyConnection(key)).toBe("conn-1");
  });

  it("expires the pin after the TTL and cleans the entry", () => {
    const key = stickiness.computeSessionKey({ messages: conversation() });
    stickiness.setStickyConnection(key, "conn-1");

    vi.advanceTimersByTime(stickiness.STICKINESS_TTL_MS + 1);

    expect(stickiness.getStickyConnection(key)).toBeNull();
    expect(stickiness.stickyConnectionCount()).toBe(0);
  });

  it("evicts the oldest entry when the cap is exceeded", () => {
    for (let i = 0; i < stickiness.STICKINESS_MAX_ENTRIES + 5; i++) {
      vi.advanceTimersByTime(1);
      stickiness.setStickyConnection(`key-${i}`, `conn-${i}`);
    }

    expect(stickiness.stickyConnectionCount()).toBeLessThanOrEqual(stickiness.STICKINESS_MAX_ENTRIES);
    expect(stickiness.getStickyConnection("key-0")).toBeNull();
    expect(stickiness.getStickyConnection(`key-${stickiness.STICKINESS_MAX_ENTRIES + 4}`)).toBe(
      `conn-${stickiness.STICKINESS_MAX_ENTRIES + 4}`
    );
  });

  it("fails open on malformed inputs without throwing", () => {
    expect(() => stickiness.computeSessionKey(null)).not.toThrow();
    expect(stickiness.computeSessionKey(null)).toBeNull();
    expect(stickiness.computeSessionKey({})).toBeNull();
    expect(stickiness.computeSessionKey({ messages: [{ role: "assistant", content: "x" }] })).toBeNull();
    expect(stickiness.computeSessionKey("a string")).toBeNull();
    expect(stickiness.setStickyConnection(null, "c")).toBe(false);
    expect(stickiness.setStickyConnection("k", null)).toBe(false);
    expect(stickiness.getStickyConnection(null)).toBeNull();
    expect(stickiness.getStickyConnection(undefined)).toBeNull();
  });

  it("does not pin or read when the flag is off", () => {
    delete process.env.STEALTH_STICKINESS;
    const key = stickiness.computeSessionKey({ messages: conversation() });
    // Key computation is pure and always available…
    expect(key).toBeTruthy();
    // …but the pin store is inert.
    expect(stickiness.setStickyConnection(key, "conn-1")).toBe(false);
    expect(stickiness.getStickyConnection(key)).toBeNull();
  });
});

// ─── NR1: default-OFF isolation ─────────────────────────────────────────────

describe("Wave 5 / Default-OFF Isolation", () => {
  it("reports every capability disabled when no flags are set", () => {
    expect(fingerprints.isCliCompatEnabled("claude")).toBe(false);
    expect(headerScrub.isHeaderScrubEnabled("claude")).toBe(false);
    expect(toolCloak.isToolCloakEnabled("claude")).toBe(false);
    expect(zeroWidth.isZeroWidthEnabled()).toBe(false);
    expect(stickiness.isStickinessEnabled()).toBe(false);
    expect(dispatch.isStealthEnabled("claude")).toBe(false);
  });

  it("changes nothing on the dispatch path when disabled", () => {
    const headers = {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      "Accept-Encoding": "gzip, deflate, br",
    };
    const body = { _khatamMarker: true, stream: true, model: "claude-x", messages: [] };

    const out = dispatch.applyStealthToDispatch("claude", headers, body);

    // Same header object (not a filtered copy) and byte-identical body JSON.
    expect(out.headers).toBe(headers);
    expect(out.bodyString).toBe(JSON.stringify(body));
    // The raw marker survives untouched when off.
    expect(out.bodyString).toContain("_khatamMarker");
  });

  it("activates per-provider CLI compat without enabling other providers", () => {
    process.env.CLI_COMPAT_CLAUDE = "1";

    expect(fingerprints.isCliCompatEnabled("claude")).toBe(true);
    expect(fingerprints.isCliCompatEnabled("codex")).toBe(false);
    expect(headerScrub.isHeaderScrubEnabled("claude")).toBe(true);
    // Tool cloaking and zero-width have their own switches.
    expect(toolCloak.isToolCloakEnabled("claude")).toBe(false);
    expect(zeroWidth.isZeroWidthEnabled()).toBe(false);
  });

  it("activates everything under STEALTH_ALL", () => {
    process.env.STEALTH_ALL = "1";

    expect(fingerprints.isCliCompatEnabled("codex")).toBe(true);
    expect(headerScrub.isHeaderScrubEnabled("codex")).toBe(true);
    expect(toolCloak.isToolCloakEnabled("codex")).toBe(true);
    expect(zeroWidth.isZeroWidthEnabled()).toBe(true);
    expect(stickiness.isStickinessEnabled()).toBe(true);
  });

  it("scrubs the dispatch headers but keeps the body intact when only scrubbing is on", () => {
    process.env.STEALTH_HEADER_SCRUB = "1";
    const headers = { "x-forwarded-for": "203.0.113.7", Authorization: "Bearer t" };
    const body = { _khatamMarker: true, model: "x" };

    const out = dispatch.applyStealthToDispatch("claude", headers, body);

    expect(out.headers).not.toHaveProperty("x-forwarded-for");
    expect(out.headers.Authorization).toBe("Bearer t");
    expect(out.bodyString).toBe(JSON.stringify(body));
  });
});

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cursorModels.js calls http2.connect (agent.api5.cursor.sh is HTTP/2-only),
// not global.fetch. Mock the module it actually imports so the tests are
// deterministic and never touch the network.
const h2 = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("http2", () => ({ default: { connect: h2.connect }, connect: h2.connect }));

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

// Fake HTTP/2 session that answers one request with the given status and body.
function fakeH2Session({ status, body = new Uint8Array() }) {
  const req = new EventEmitter();
  req.end = () => {
    queueMicrotask(() => {
      req.emit("response", { ":status": status });
      if (body.length) req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  };
  const client = new EventEmitter();
  client.request = vi.fn(() => req);
  client.close = vi.fn();
  return client;
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.connect.mockReset();
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const session = fakeH2Session({ status: 200, body: payload });
    h2.connect.mockReturnValue(session);
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.connect).toHaveBeenCalledTimes(1);
    expect(h2.connect).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(session.request).toHaveBeenCalledTimes(1);
    expect(session.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/GetUsableModels",
        "content-type": "application/proto",
        accept: "application/proto",
      }),
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.connect.mockReturnValue(fakeH2Session({ status: 403, body: text("no") }));

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});

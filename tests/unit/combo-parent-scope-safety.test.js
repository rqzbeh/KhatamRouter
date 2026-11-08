import { describe, expect, it } from "vitest";
import { resolveCooldownScope } from "../../src/sse/handlers/chat.js";

describe("independent combo cooldown trust boundary", () => {
  it.each(["x-probe", "x-synthetic-probe"])("does not accept public %s header as an internal probe", (header) => {
    const request = new Request("https://router.invalid/v1/chat/completions", { headers: { [header]: "1" } });
    expect(resolveCooldownScope(request, { keyRecord: { id: "key-public" } })).toBe("key-public");
  });
  it("does not mistake a public Host localhost header for a loopback socket", () => {
    const request = new Request("https://router.invalid/v1/chat/completions", { headers: { host: "localhost:20128", "x-forwarded-for": "203.0.113.11" } });
    expect(resolveCooldownScope(request)).toBeNull();
  });
  it("exempts a server-validated internal request", () => {
    expect(resolveCooldownScope(new Request("https://router.invalid/v1/chat/completions"), { keyRecord: { id: "key-public" }, isTrustedInternal: true })).toBeNull();
  });
});

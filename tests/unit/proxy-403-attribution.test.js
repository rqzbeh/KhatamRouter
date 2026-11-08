import { describe, expect, it } from "vitest";
import { classifyProxyFailure } from "../../src/lib/network/proxyHealthPolicy.js";

const settings = { enabled: true, statuses: [403, 429, 451, 502, 503, 504] };
function classify(status, errorText) {
  return classifyProxyFailure({ providerId: "fixture", settings, status, errorText });
}

describe("independent proxy 403 attribution regression", () => {
  it.each([
    "Forbidden",
    "API key does not have access to this model",
    "Account is suspended",
    "Request blocked by content policy",
    "Missing required geo metadata in request parameters",
    "You cannot change the country on this account",
    "This subscription is blocked",
    "Membership blocked due to missing payment",
  ])("does not cool a proxy on unproven 403: %s", (message) => {
    expect(classify(403, message)).toBeNull();
  });

  it.each([
    "This service is not available in your region",
    "Access denied: unsupported location",
    "Requests from this IP address are blocked",
  ])("attributes explicit egress refusal to this provider only: %s", (message) => {
    const result = classify(403, message);
    expect(result?.scope).toBe("fixture::*");
    expect(result?.kind).toMatch(/region_blocked|egress_blocked/);
    expect(result?.reason).not.toContain(message);
  });

  it("does not blame the proxy for the reported Gemini schema 400", () => {
    expect(classify(400, "Invalid value at tools[0].function_declarations[121].parameters (Schema), array")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { assertProductionSecrets } from "../../runtime-secrets.cjs";
import { PROVIDERS } from "open-sse/config/providers.js";

describe("US7 Scenario 11: Production Secret Enforcement & Windsurf Registry Consistency", () => {
  it("fails closed in production when placeholder secrets are detected", () => {
    expect(() => {
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "change-me-to-a-long-random-secret",
      });
    }).toThrow(/Replace placeholder production secret/);

    expect(() => {
      assertProductionSecrets({
        NODE_ENV: "production",
        API_KEY_SECRET: "changeme",
      });
    }).toThrow(/Replace placeholder production secret/);
  });

  it("passes when valid non-placeholder secrets are provided in production", () => {
    expect(() => {
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: "0123456789abcdef0123456789abcdef",
        API_KEY_SECRET: "fedcba9876543210fedcba9876543210",
      });
    }).not.toThrow();
  });

  it("maintains consistent Windsurf registry and executor alignment", () => {
    // Windsurf is intentionally in HIDDEN_REGISTRY_FILES due to missing tool calling support
    expect(PROVIDERS.windsurf).toBeUndefined();
  });
});

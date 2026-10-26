import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

describe("trusted-proxy packaging parity with runtime-secrets", () => {
  it("trusted-proxy.cjs exists at repo root", () => {
    expect(existsSync(resolve(REPO_ROOT, "trusted-proxy.cjs"))).toBe(true);
  });

  it("Dockerfile copies trusted-proxy.cjs alongside runtime-secrets.cjs", () => {
    const content = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
    expect(content).toContain("COPY --from=builder /app/runtime-secrets.cjs ./runtime-secrets.cjs");
    expect(content).toContain("COPY --from=builder /app/trusted-proxy.cjs ./trusted-proxy.cjs");
  });

  it("Dockerfile.bun copies trusted-proxy.cjs alongside runtime-secrets.cjs", () => {
    const content = readFileSync(resolve(REPO_ROOT, "Dockerfile.bun"), "utf8");
    expect(content).toContain("COPY --from=builder /app/runtime-secrets.cjs ./runtime-secrets.cjs");
    expect(content).toContain("COPY --from=builder /app/trusted-proxy.cjs ./trusted-proxy.cjs");
  });

  it("scripts/copy-standalone-assets.mjs copies trusted-proxy.cjs alongside runtime-secrets.cjs", () => {
    const content = readFileSync(resolve(REPO_ROOT, "scripts/copy-standalone-assets.mjs"), "utf8");
    expect(content).toContain("runtime-secrets.cjs");
    expect(content).toContain("trusted-proxy.cjs");
  });

  it("custom-server.js requires trusted-proxy.cjs", () => {
    const content = readFileSync(resolve(REPO_ROOT, "custom-server.js"), "utf8");
    expect(content).toMatch(/require\(["']\.\/trusted-proxy\.cjs["']\)/);
  });
});

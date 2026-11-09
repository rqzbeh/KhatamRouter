import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("transport packaging & DNS configuration (upstream 736be957 parity)", () => {
  const rootDir = path.resolve(__dirname, "../..");

  it("next.config.mjs keeps undici external and preserves Bun-only driver architecture", async () => {
    const configModule = await import("../../next.config.mjs");
    const nextConfig = configModule.default || configModule;

    const external = nextConfig.serverExternalPackages || [];

    // undici must be external for per-request connect options (ecdhCurve)
    expect(external).toContain("undici");

    // Preserved active infrastructure
    expect(external).toContain("bun:sqlite");
    expect(external).toContain("ioredis");
    expect(external).toContain("open");
    expect(external).toContain("@aws-sdk/credential-providers");
    expect(external).toContain("wreq-js");

    // Strictly NO resurrected Node drivers
    expect(external).not.toContain("better-sqlite3");
    expect(external).not.toContain("sql.js");
    expect(external).not.toContain("node:sqlite");
  });

  it("next.config.mjs defines outputFileTracingIncludes for undici", async () => {
    const configModule = await import("../../next.config.mjs");
    const nextConfig = configModule.default || configModule;

    const tracingIncludes = nextConfig.outputFileTracingIncludes;
    expect(tracingIncludes).toBeDefined();
    expect(tracingIncludes["*"]).toContain("./node_modules/undici/**/*");
  });

  it("cli/cli.js drops global --dns-result-order=ipv4first for HappyEyeballs", () => {
    const cliSrc = fs.readFileSync(path.join(rootDir, "cli/cli.js"), "utf8");

    // Must not pass global ipv4first flag anywhere
    expect(cliSrc).not.toContain("--dns-result-order=ipv4first");
    expect(cliSrc).not.toContain("--dns-result-order");

    // Verify background process spawn invocation in hide/tray branch
    expect(cliSrc).toMatch(/spawn\(\s*process\.execPath\s*,\s*\[\s*__filename\s*,\s*"--tray"/);
  });
});

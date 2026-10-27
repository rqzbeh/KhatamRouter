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

  it("cli/scripts/build-cli.js copies trusted-proxy.cjs and runtime-secrets.cjs alongside custom-server.js", () => {
    const content = readFileSync(resolve(REPO_ROOT, "cli/scripts/build-cli.js"), "utf8");
    expect(content).toContain("runtime-secrets.cjs");
    expect(content).toContain("trusted-proxy.cjs");
    // Verify it copies them to cliAppDir
    expect(content).toMatch(/copyFileSync\(\s*runtimeSecretsSrc,\s*path\.join\(cliAppDir,\s*["']runtime-secrets\.cjs["']\)\)/);
    expect(content).toMatch(/copyFileSync\(\s*trustedProxySrc,\s*path\.join\(cliAppDir,\s*["']trusted-proxy\.cjs["']\)\)/);
  });

  it("simulates shipped layout: custom-server.js + runtime-secrets.cjs + trusted-proxy.cjs load in temp dir", () => {
    const { mkdtempSync, copyFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");

    const tempDir = mkdtempSync(join(tmpdir(), "khatam-pkg-layout-"));
    try {
      copyFileSync(resolve(REPO_ROOT, "custom-server.js"), join(tempDir, "custom-server.js"));
      copyFileSync(resolve(REPO_ROOT, "runtime-secrets.cjs"), join(tempDir, "runtime-secrets.cjs"));
      copyFileSync(resolve(REPO_ROOT, "trusted-proxy.cjs"), join(tempDir, "trusted-proxy.cjs"));

      // Require trusted-proxy.cjs from the shipped layout directory
      const shippedTrustedProxy = require(join(tempDir, "trusted-proxy.cjs"));
      expect(typeof shippedTrustedProxy.resolveClientIp).toBe("function");
      expect(typeof shippedTrustedProxy.parseTrustedProxyCidrs).toBe("function");
      expect(typeof shippedTrustedProxy.isTrustedProxyPeer).toBe("function");

      // Verify custom-server.js can load its dependencies without MODULE_NOT_FOUND
      const shippedCustomServer = require(join(tempDir, "custom-server.js"));
      expect(shippedCustomServer.PORT).toBeDefined();
      expect(shippedCustomServer.PEER_TOKEN).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("asserts trusted-proxy.cjs is wired wherever runtime-secrets.cjs is packaged/copied", () => {
    // Packaging, deployment, container, and build scripts/files that copy/ship assets
    const packagingFiles = [
      resolve(REPO_ROOT, "Dockerfile"),
      resolve(REPO_ROOT, "Dockerfile.bun"),
      resolve(REPO_ROOT, "scripts/copy-standalone-assets.mjs"),
      resolve(REPO_ROOT, "cli/scripts/build-cli.js"),
    ];

    for (const file of packagingFiles) {
      const content = readFileSync(file, "utf8");
      if (content.includes("runtime-secrets.cjs")) {
        expect(
          content.includes("trusted-proxy.cjs"),
          `Expected packaging file ${file} to wire trusted-proxy.cjs alongside runtime-secrets.cjs`
        ).toBe(true);
      }
    }
  });
});

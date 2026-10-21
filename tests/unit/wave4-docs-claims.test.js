import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.resolve(repoRoot, "scripts/verify-docs-claims.mjs");

describe("Wave 4: Docs claims verifier (scripts/verify-docs-claims.mjs)", () => {
  const tempDirs = [];

  function createTempFixture(files) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-docs-claims-test-"));
    tempDirs.push(tempDir);

    for (const [relPath, content] of Object.entries(files)) {
      const target = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }

    return tempDir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("fails (non-zero exit) on negative control: cited constant mismatch (512 KiB vs 10 MiB) with fake ghcr tag", () => {
    const fixtureDir = createTempFixture({
      "open-sse/rtk/constants.js": `export const RAW_CAP = 10 * 1024 * 1024; // 10 MiB\n`,
      "README.md": `# Overview\n\nImage: ghcr.io/fake-owner/fake-repo:nonexistent\n`,
      "ROADMAP.md": `# Roadmap\n\n- Pre-translation compression with a 512 KiB ceiling in \`open-sse/rtk/constants.js\`.\n`,
      "scripts/docs-claims-allowlist.json": JSON.stringify({}),
    });

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--root", fixtureDir, "--offline", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.failures).toBeGreaterThanOrEqual(1);

    const constantFailure = parsed.claims.sourceConstants.find(
      (c) => c.status === "FAIL" && c.claim.includes("512 KiB")
    );
    expect(constantFailure).toBeDefined();
    expect(constantFailure.reason).toContain("512");
  });

  it("fails (non-zero exit) when banned adjective 'lossless' is used near RTK / token saver", () => {
    const fixtureDir = createTempFixture({
      "open-sse/rtk/constants.js": `export const RAW_CAP = 10 * 1024 * 1024; // 10 MiB\n`,
      "README.md": `# Overview\n\nLossless RTK token compression cuts input tokens by 30%.\n`,
      "ROADMAP.md": `# Roadmap\n`,
      "scripts/docs-claims-allowlist.json": JSON.stringify({}),
    });

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--root", fixtureDir, "--offline", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);

    const adjFailure = parsed.claims.bannedAdjectives.find((a) => a.status === "FAIL");
    expect(adjFailure).toBeDefined();
    expect(adjFailure.reason).toContain("lossless");
  });

  it("passes (exit 0) when all claims are valid and backed by source constants", () => {
    const fixtureDir = createTempFixture({
      "open-sse/rtk/constants.js": `export const RAW_CAP = 10 * 1024 * 1024; // 10 MiB\n`,
      "custom-server.js": `const MAX_H2C_BODY_BYTES = 64 * 1024 * 1024;\n`,
      ".env.example": `DATA_DIR=/app/data\nPORT=20128\n`,
      "README.md": `# Overview\n\n| Variable | Default |\n| --- | --- |\n| \`DATA_DIR\` | \`/app/data\` |\n`,
      "ROADMAP.md": `# Roadmap\n\n- Token saver with a 10 MiB ceiling in \`open-sse/rtk/constants.js\`.\n- Chunked stream 64 MiB ceiling in \`custom-server.js\`.\n`,
      "scripts/docs-claims-allowlist.json": JSON.stringify({}),
    });

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--root", fixtureDir, "--offline", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.failures).toBe(0);
  });
});

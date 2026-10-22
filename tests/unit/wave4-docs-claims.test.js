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

  it("fails (non-zero exit) when multilingual banned adjective (zh/fr/fa) appears near RTK and names the file", () => {
    const fixtureDir = createTempFixture({
      "open-sse/rtk/constants.js": `export const RAW_CAP = 10 * 1024 * 1024; // 10 MiB\n`,
      "README.md": `# Overview\n`,
      "ROADMAP.md": `# Roadmap\n`,
      "i18n/README.zh-CN.md": `# 中文文档\n\n通过 RTK Token Saver 实现无损压缩。\n`,
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

    const zhFailure = parsed.claims.bannedAdjectives.find(
      (a) => a.status === "FAIL" && a.doc.includes("README.zh-CN.md")
    );
    expect(zhFailure).toBeDefined();
    expect(zhFailure.term).toContain("无损");
    expect(zhFailure.lang).toBe("zh");
  });

  it("fails (CLAIM CLASS 5) when doc claims gateway is operational on 20129 without listener", () => {
    const fixtureDir = createTempFixture({
      "custom-server.js": `const ENDPOINT_PORT = 20129;\n`,
      "README.md": `# Overview\n\nThe gateway is currently live and listening on port 20129 for inference.\n`,
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

    const portFailure = parsed.claims.port20129.find((p) => p.status === "FAIL");
    expect(portFailure).toBeDefined();
    expect(portFailure.reason).toContain("20129");
  });

  it("fails (CLAIM CLASS 5) when doc provides curl against port 20129 without listener", () => {
    const fixtureDir = createTempFixture({
      "custom-server.js": `const ENDPOINT_PORT = 20129;\n`,
      "README.md": `# Overview\n\n\`\`\`bash\ncurl http://localhost:20129/v1/models\n\`\`\`\n`,
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

    const portFailure = parsed.claims.port20129.find((p) => p.status === "FAIL");
    expect(portFailure).toBeDefined();
  });

  it("passes (CLAIM CLASS 5) when 20129 is documented as reserved/planned/not listening", () => {
    const fixtureDir = createTempFixture({
      "custom-server.js": `const ENDPOINT_PORT = 20129;\n`,
      "README.md": `# Overview\n\nPort 20129 is reserved for Phase 2 Go gateway data plane.\n`,
      "ROADMAP.md": `# Roadmap\n\n> Operational Notice: no process is currently listening on port 20129.\n`,
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

  it("fails (CLAIM CLASS 6) when a Shipped row cites non-existent file", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n\n| Feature | Status | Delivery |\n| --- | :---: | --- |\n| **Fake Feature** | 🟢 Shipped | Implemented in \`src/does/not/exist.js\` |\n`,
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

    const shippedFailure = parsed.claims.shippedClaims.find((s) => s.status === "FAIL");
    expect(shippedFailure).toBeDefined();
    expect(shippedFailure.reason).toContain("src/does/not/exist.js");
  });

  it("fails (CLAIM CLASS 1b) on a foreign registry image reference in a translated README", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n`,
      "ROADMAP.md": `# Roadmap\n`,
      "i18n/README.es.md": `# Documentación\n\n## Docker\n\n- GHCR: [\`ghcr.io/someoneelse/thing\`](https://ghcr.io/someoneelse/thing)\n\n\`\`\`bash\ndocker run -d -p 20128:20128 ghcr.io/someoneelse/thing:latest\n\`\`\`\n`,
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

    const foreignFailure = parsed.claims.foreignImages.find(
      (f) => f.status === "FAIL" && f.doc.includes("README.es.md")
    );
    expect(foreignFailure).toBeDefined();
    expect(foreignFailure.ref).toContain("ghcr.io/someoneelse/thing");
    expect(foreignFailure.owner).toBe("someoneelse");
    expect(foreignFailure.line).toBeGreaterThan(0);
  });

  it("fails (CLAIM CLASS 1b) on an untagged hub.docker.com/r/<foreign-owner>/<name> reference", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n\nPublished images: [Docker Hub](https://hub.docker.com/r/decolua/9router).\n`,
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
    const foreignFailure = parsed.claims.foreignImages.find((f) => f.status === "FAIL");
    expect(foreignFailure).toBeDefined();
    expect(foreignFailure.ref).toBe("hub.docker.com/r/decolua/9router");
    expect(foreignFailure.line).toBe(3);
  });

  it("fails (CLAIM CLASS 1b) on a bare `docker pull <foreign-owner>/<name>` image line", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n\n\`\`\`bash\ndocker pull decolua/9router:latest\n\`\`\`\n`,
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
    const foreignFailure = parsed.claims.foreignImages.find((f) => f.status === "FAIL");
    expect(foreignFailure).toBeDefined();
    expect(foreignFailure.ref).toBe("decolua/9router:latest");
    expect(foreignFailure.line).toBe(4);
  });

  it("passes (CLAIM CLASS 1b) for our own registry and a plain attribution link to the upstream repo", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n\nImage: \`ghcr.io/rqzbeh/khatamrouter:edge\`\n\nBuilt on 9Router by [decolua](https://github.com/decolua/9router).\n`,
      "ROADMAP.md": `# Roadmap\n`,
      "i18n/README.fr.md": `# Documentation\n\n- GHCR : [\`ghcr.io/rqzbeh/khatamrouter\`](https://github.com/rqzbeh/KhatamRouter/pkgs/container/khatamrouter)\n`,
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
    expect(parsed.claims.foreignImages.some((f) => f.status === "FAIL")).toBe(false);
    expect(
      parsed.claims.foreignImages.filter((f) => f.doc === "README.md").map((f) => f.ref)
    ).toEqual(["ghcr.io/rqzbeh/khatamrouter:edge"]);
  });

  it("allows a foreign image reference explicitly exempted in scripts/docs-claims-allowlist.json", () => {
    const fixtureDir = createTempFixture({
      "README.md": `# Overview\n\nSidecar: \`ghcr.io/chopratejas/headroom:latest\`\n`,
      "ROADMAP.md": `# Roadmap\n`,
      "scripts/docs-claims-allowlist.json": JSON.stringify({
        foreignImageExceptions: [
          { path: "README.md", ref: "ghcr.io/chopratejas/headroom:*", reason: "third-party sidecar" },
        ],
      }),
    });

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--root", fixtureDir, "--offline", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.failures).toBe(0);
    const entry = parsed.claims.foreignImages.find((f) => f.ref.startsWith("ghcr.io/chopratejas/headroom"));
    expect(entry.status).toBe("WARN");
    expect(entry.reason).toContain("third-party sidecar");
  });

  it("passes (exit 0) when all claims are valid and backed by source constants", () => {
    const fixtureDir = createTempFixture({
      "open-sse/rtk/constants.js": `export const RAW_CAP = 10 * 1024 * 1024; // 10 MiB\n`,
      "custom-server.js": `const MAX_H2C_BODY_BYTES = 64 * 1024 * 1024;\nconst ENDPOINT_PORT = 20129;\n`,
      "Dockerfile.bun": `FROM oven/bun:1.4.3-slim\n`,
      ".env.example": `DATA_DIR=/app/data\nPORT=20128\n`,
      "README.md": `# Overview\n\n| Variable | Default |\n| --- | --- |\n| \`DATA_DIR\` | \`/app/data\` |\n\n| Feature | Status | Notes |\n| --- | :---: | --- |\n| **Native Runtime** | 🟢 Shipped | Built with \`Dockerfile.bun\` |\n`,
      "ROADMAP.md": `# Roadmap\n\n- Token saver with a 10 MiB ceiling in \`open-sse/rtk/constants.js\`.\n- Chunked stream 64 MiB ceiling in \`custom-server.js\`.\n\nNotice: port 20129 is reserved.\n`,
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

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureModuleInBundle } = require("../../cli/scripts/build-cli.js");

const REPO_ROOT = path.resolve(__dirname, "../../");

describe("wreq-js Packaging & Standalone Distribution (FR-01)", () => {
  describe("package.json optionalDependencies contract", () => {
    it("pins wreq-js to exact version 3.2.0 under optionalDependencies", () => {
      const pkgPath = path.join(REPO_ROOT, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

      expect(pkg.optionalDependencies).toBeDefined();
      expect(pkg.optionalDependencies["wreq-js"]).toBe("3.2.0");
      // Retain existing optional dependency for AWS Bedrock
      expect(pkg.optionalDependencies["@aws-sdk/credential-providers"]).toBeDefined();
    });

    it("does not list wreq-js under dependencies or devDependencies", () => {
      const pkgPath = path.join(REPO_ROOT, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

      expect(pkg.dependencies?.["wreq-js"]).toBeUndefined();
      expect(pkg.devDependencies?.["wreq-js"]).toBeUndefined();
    });
  });

  describe("next.config.mjs bundler configuration", () => {
    it("lists wreq-js in Bun serverExternalPackages alongside existing externals", async () => {
      const configPath = path.join(REPO_ROOT, "next.config.mjs");
      const raw = fs.readFileSync(configPath, "utf8");

      expect(raw).toContain('"wreq-js"');
      expect(raw).toContain(
        'serverExternalPackages: ["bun:sqlite", "ioredis", "open", "@aws-sdk/credential-providers", "wreq-js"]'
      );
      // Explanatory comment preserving upstream rationale
      expect(raw).toMatch(/wreq-js resolves its rust native binding by relative require paths/i);
    });
  });

  describe("Dockerfile and Dockerfile.bun synchronization & copy steps", () => {
    const dockerfilePath = path.join(REPO_ROOT, "Dockerfile");
    const dockerfileBunPath = path.join(REPO_ROOT, "Dockerfile.bun");

    it("both Dockerfile and Dockerfile.bun exist and are byte-for-byte identical", () => {
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      expect(fs.existsSync(dockerfileBunPath)).toBe(true);

      const df = fs.readFileSync(dockerfilePath, "utf8");
      const dfBun = fs.readFileSync(dockerfileBunPath, "utf8");
      expect(df).toBe(dfBun);
    });

    it("contains copy/ensure steps for wreq-js and @wreq-js native bindings in runner stage", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");

      expect(df).toContain(
        "COPY --from=builder /app/node_modules/wreq-js ./node_modules/wreq-js"
      );
      expect(df).toContain(
        "COPY --from=builder /app/node_modules/@wreq-js ./node_modules/@wreq-js"
      );
    });

    it("includes a production runner smoke check for wreq-js createSession", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");

      expect(df).toMatch(/bun -e.*wreq-js.*createSession/);
    });
  });

  describe("scripts/copy-standalone-assets.mjs standalone copier", () => {
    it("copies wreq-js and @wreq-js into standalone node_modules when present", () => {
      const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "wreq-standalone-test-"));
      try {
        const standaloneDir = path.join(tempRoot, ".next", "standalone");
        const nodeModulesSrc = path.join(tempRoot, "node_modules");

        fs.mkdirSync(standaloneDir, { recursive: true });
        fs.mkdirSync(path.join(nodeModulesSrc, "wreq-js", "dist"), { recursive: true });
        fs.mkdirSync(
          path.join(nodeModulesSrc, "@wreq-js", "binding-linux-x64-gnu"),
          { recursive: true }
        );

        fs.writeFileSync(
          path.join(nodeModulesSrc, "wreq-js", "package.json"),
          JSON.stringify({ name: "wreq-js", version: "3.2.0" })
        );
        fs.writeFileSync(
          path.join(
            nodeModulesSrc,
            "@wreq-js",
            "binding-linux-x64-gnu",
            "binding.node"
          ),
          "mock-binary"
        );

        copyStandaloneAssets({ projectRoot: tempRoot, distDir: ".next" });

        const copiedPkgJson = path.join(
          standaloneDir,
          "node_modules",
          "wreq-js",
          "package.json"
        );
        const copiedBinding = path.join(
          standaloneDir,
          "node_modules",
          "@wreq-js",
          "binding-linux-x64-gnu",
          "binding.node"
        );

        expect(fs.existsSync(copiedPkgJson)).toBe(true);
        expect(fs.existsSync(copiedBinding)).toBe(true);
        expect(fs.readFileSync(copiedBinding, "utf8")).toBe("mock-binary");
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("cli/package.json & cli/scripts/build-cli.js", () => {
    it("pins wreq-js in cli/package.json optionalDependencies", () => {
      const cliPkgPath = path.join(REPO_ROOT, "cli", "package.json");
      const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));

      expect(cliPkg.optionalDependencies).toBeDefined();
      expect(cliPkg.optionalDependencies["wreq-js"]).toBe("3.2.0");
    });

    it("ensures wreq-js and @wreq-js are bundled in cli/scripts/build-cli.js", () => {
      const buildScriptPath = path.join(REPO_ROOT, "cli", "scripts", "build-cli.js");
      const raw = fs.readFileSync(buildScriptPath, "utf8");

      expect(raw).toContain('ensureModuleInBundle("wreq-js")');
      expect(raw).toContain('ensureModuleInBundle("@wreq-js")');
    });

    it("ensureModuleInBundle copies module to destination directory", () => {
      const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "wreq-cli-test-"));
      try {
        const appDir = path.join(tempRoot, "app");
        const cliAppDir = path.join(tempRoot, "cli-app");
        const srcModuleDir = path.join(appDir, "node_modules", "wreq-mock");

        fs.mkdirSync(srcModuleDir, { recursive: true });
        fs.writeFileSync(path.join(srcModuleDir, "index.js"), "module.exports = {}");

        const result = ensureModuleInBundle("wreq-mock", cliAppDir, appDir, tempRoot);

        expect(result).toBe(path.join(cliAppDir, "node_modules", "wreq-mock"));
        expect(
          fs.existsSync(path.join(cliAppDir, "node_modules", "wreq-mock", "index.js"))
        ).toBe(true);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("Bun Native Execution Smoke Test", () => {
    it("imports wreq-js under Bun and exposes createSession as a function", async () => {
      const wreq = await import("wreq-js");
      const mod = wreq.default || wreq;
      expect(typeof mod.createSession).toBe("function");
    });
  });
});

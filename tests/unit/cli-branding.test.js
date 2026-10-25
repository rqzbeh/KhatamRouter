import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("T2: CLI Branding, Dual Binary Alias & CLI Update Source", () => {
  const cliDir = path.resolve(__dirname, "../../cli");
  const pkgPath = path.join(cliDir, "package.json");
  const cliJsPath = path.join(cliDir, "cli.js");
  const readmePath = path.join(cliDir, "README.md");

  describe("cli/package.json metadata and bin aliases", () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    it("preserves package name '9router' for backward compatibility", () => {
      expect(pkg.name).toBe("9router");
    });

    it("provides dual bin aliases for both 9router and khatamrouter", () => {
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin["9router"]).toBe("./cli.js");
      expect(pkg.bin["khatamrouter"]).toBe("./cli.js");
    });

    it("updates package description to reference KhatamRouter", () => {
      expect(pkg.description).toContain("KhatamRouter CLI");
      expect(pkg.description).toContain("Bun runtime");
    });
  });

  describe("cli/cli.js update source and supply-chain isolation", () => {
    const content = fs.readFileSync(cliJsPath, "utf8");

    it("does not query registry.npmjs.org for updates", () => {
      expect(content).not.toContain("registry.npmjs.org");
      expect(content).not.toContain("registry.npmjs.org/${pkg.name}");
    });

    it("does not recommend or execute npm i -g 9router or npm i -g ${APP_NAME}", () => {
      expect(content).not.toContain("npm i -g ${APP_NAME}");
      expect(content).not.toContain("npm i -g 9router");
      expect(content).not.toContain("npm install -g 9router");
    });

    it("queries GitHub releases with pinned api.github.com host", () => {
      expect(content).toContain('hostname: "api.github.com"');
      expect(content).toContain("KhatamRouter-UpdateCheck");
      expect(content).toContain("releases/latest");
    });

    it("supports KHATAM_UPDATE_CHECK=0 to disable update checks", () => {
      expect(content).toContain('process.env.KHATAM_UPDATE_CHECK === "0"');
    });

    it("broadens PROCESS_IDENTIFIERS and process filters to match both khatamrouter and 9router", () => {
      expect(content).toContain("'khatamrouter'");
      expect(content).toContain("'9router'");
      expect(content).toContain('cmd.includes("khatamrouter")');
      expect(content).toContain('cmd.includes("9router")');
    });

    it("displays KhatamRouter in banners and tray notifications", () => {
      expect(content).toContain("KhatamRouter runs exclusively on Bun");
      expect(content).toContain("KhatamRouter is running in tray");
      expect(content).toContain("KhatamRouter is now running in background");
      expect(content).toContain("KhatamRouter is now running in system tray");
    });
  });

  describe("cli/README.md documentation", () => {
    const readme = fs.readFileSync(readmePath, "utf8");

    it("identifies as KhatamRouter in header and features", () => {
      expect(readme).toContain("# KhatamRouter - Dual-Runtime AI Gateway & Proxy");
      expect(readme).toContain("ghcr.io/rqzbeh/khatamrouter:latest");
    });

    it("documents both khatamrouter and 9router aliases", () => {
      expect(readme).toContain("khatamrouter");
      expect(readme).toContain("9router");
    });

    it("preserves lineage acknowledgments to decolua/9router and Vanszs/VansRouter", () => {
      expect(readme).toContain("decolua/9router");
      expect(readme).toContain("Vanszs/VansRouter");
    });
  });
});

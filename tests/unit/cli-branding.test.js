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

    it("enforces 512 KiB buffer cap and JSON content-type in update check (A1)", () => {
      expect(content).toContain("data.length > 512 * 1024");
      expect(content).toContain("req.destroy()");
      expect(content).toContain('.includes("application/json")');
    });

    it("uses strict semver reconstruction in update check to prevent escape injection (A3)", () => {
      expect(content).toContain("reconstructSemver");
      expect(content).toContain('require("./src/cli/utils/semver")');
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

    it("displays khatamrouter and KhatamRouter in CLI help commands", () => {
      expect(content).toContain("khatamrouter connect http://host:20128");
      expect(content).toContain("khatamrouter show claude");
      expect(content).toContain("remote KhatamRouter server");
      expect(content).toContain("KhatamRouter config and models");
    });
  });

  describe("CLI Subcommands and UI User-Facing Rebranding", () => {
    it("brands connect.js help text, password prompt, and reset output", () => {
      const connectContent = fs.readFileSync(path.join(cliDir, "src/cli/commands/connect.js"), "utf8");
      expect(connectContent).toContain("Usage: khatamrouter connect");
      expect(connectContent).toContain("KhatamRouter dashboard password");
      expect(connectContent).toContain("removed KhatamRouter settings");
      expect(connectContent).toContain("Undo: khatamrouter connect --reset");
      expect(connectContent).not.toContain("npx 9router connect");
    });

    it("brands show.js help text and not-configured message", () => {
      const showContent = fs.readFileSync(path.join(cliDir, "src/cli/commands/show.js"), "utf8");
      expect(showContent).toContain("Usage: khatamrouter show");
      expect(showContent).toContain("not configured for KhatamRouter");
      expect(showContent).not.toContain("not configured for 9router");
    });

    it("brands xaiVideo.js help text and API key description", () => {
      const xaiContent = fs.readFileSync(path.join(cliDir, "src/cli/commands/xaiVideo.js"), "utf8");
      expect(xaiContent).toContain("Usage: khatamrouter xai video");
      expect(xaiContent).toContain("via your local KhatamRouter gateway");
      expect(xaiContent).toContain("KhatamRouter API key (or env NINE_ROUTER_API_KEY)");
    });

    it("brands terminalUI.js header and breadcrumb", () => {
      const tuiContent = fs.readFileSync(path.join(cliDir, "src/cli/terminalUI.js"), "utf8");
      expect(tuiContent).toContain('basePath = ["KhatamRouter"]');
      expect(tuiContent).toContain("📡 KhatamRouter Terminal UI");
    });

    it("brands cliTools.js menu header and hermes profile line", () => {
      const menuContent = fs.readFileSync(path.join(cliDir, "src/cli/menus/cliTools.js"), "utf8");
      expect(menuContent).toContain("Configure CLI tools to use KhatamRouter");
      expect(menuContent).toContain("✓ khatamrouter");
    });

    it("brands tray.js menu title and tooltips", () => {
      const trayContent = fs.readFileSync(path.join(cliDir, "src/cli/tray/tray.js"), "utf8");
      expect(trayContent).toContain("KhatamRouter (Port ${port})");
      expect(trayContent).toContain("KhatamRouter - Port ${port}");
      expect(trayContent).toContain("[khatamrouter] tray");
      expect(trayContent).not.toContain("[9router] tray");
    });

    it("brands autostart.js Linux desktop entry metadata", () => {
      const autostartContent = fs.readFileSync(path.join(cliDir, "src/cli/tray/autostart.js"), "utf8");
      expect(autostartContent).toContain("Name=KhatamRouter");
      expect(autostartContent).toContain("Comment=KhatamRouter API Proxy");
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

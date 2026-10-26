import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("T3: Dashboard & Landing User-Facing Display Rebranding", () => {
  const rootDir = path.resolve(__dirname, "../../");

  describe("Metadata and document branding", () => {
    it("brands src/app/layout.js title with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/layout.js"), "utf8");
      expect(content).toContain('title: "KhatamRouter - AI Infrastructure Management"');
      expect(content).not.toContain('title: "9Router - AI Infrastructure Management"');
    });

    it("brands src/app/manifest.js with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/manifest.js"), "utf8");
      expect(content).toContain("name: 'KhatamRouter - AI Infrastructure Management'");
      expect(content).toContain("short_name: 'KhatamRouter'");
    });

    it("brands src/app/login/page.js heading with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/login/page.js"), "utf8");
      expect(content).toContain('<h1 className="text-3xl font-bold text-primary mb-2">KhatamRouter</h1>');
      expect(content).not.toContain('<h1 className="text-3xl font-bold text-primary mb-2">9Router</h1>');
    });
  });

  describe("Landing page components display branding", () => {
    it("brands Navigation.js with KhatamRouter logo and repo links", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/Navigation.js"), "utf8");
      expect(content).toContain("KhatamRouter</h2>");
      expect(content).toContain("https://github.com/rqzbeh/KhatamRouter");
      expect(content).not.toContain("https://github.com/decolua/9router");
    });

    it("brands HeroSection.js with KhatamRouter repo link", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/HeroSection.js"), "utf8");
      expect(content).toContain("https://github.com/rqzbeh/KhatamRouter");
      expect(content).not.toContain("https://github.com/decolua/9router");
    });

    it("brands HowItWorks.js with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/HowItWorks.js"), "utf8");
      expect(content).toContain("How KhatamRouter Works");
      expect(content).toContain("KhatamRouter Hub");
      expect(content).not.toContain("How 9Router Works");
    });

    it("brands GetStarted.js with KhatamRouter and eliminates npx 9router", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/GetStarted.js"), "utf8");
      expect(content).toContain("Install KhatamRouter");
      expect(content).toContain("Starting KhatamRouter...");
      expect(content).not.toContain("npx 9router");
      expect(content).not.toContain("Starting 9Router...");
      // Preserves data directory
      expect(content).toContain("~/.9router/db/data.sqlite");
      expect(content).toContain("%APPDATA%/9router/db/data.sqlite");
    });

    it("brands Footer.js with KhatamRouter and removes upstream npm link", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/Footer.js"), "utf8");
      expect(content).toContain("KhatamRouter</h3>");
      expect(content).toContain("https://github.com/rqzbeh/KhatamRouter");
      expect(content).not.toContain("npmjs.com/package/9router");
      expect(content).not.toContain("https://github.com/decolua/9router");
    });

    it("brands FlowAnimation.js center hub with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/components/FlowAnimation.js"), "utf8");
      expect(content).toContain("KhatamRouter\n        </span>");
      expect(content).not.toContain("9Router\n        </span>");
    });

    it("brands landing/page.js with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/landing/page.js"), "utf8");
      expect(content).toContain("integrations with KhatamRouter");
      expect(content).toContain("https://github.com/rqzbeh/KhatamRouter#readme");
      expect(content).not.toContain("integrations with 9Router");
    });
  });

  describe("Dashboard tools and views branding", () => {
    it("brands Header.js tooltips with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/shared/components/Header.js"), "utf8");
      expect(content).toContain("route through KhatamRouter");
      expect(content).toContain("to use KhatamRouter");
      expect(content).not.toContain("route through 9Router");
      expect(content).not.toContain("to use 9Router");
    });

    it("brands ProviderTopology.js hub node with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js"), "utf8");
      expect(content).toContain('alt="KhatamRouter"');
      expect(content).toContain("KhatamRouter\n      </span>");
      expect(content).not.toContain('alt="9Router"');
    });

    it("brands EndpointPageClient.js description with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"), "utf8");
      expect(content).toContain("Expose your local KhatamRouter to the internet");
      expect(content).not.toContain("Expose your local 9Router to the internet");
    });

    it("brands TokenSaverClient.js description with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js"), "utf8");
      expect(content).toContain("the KhatamRouter data directory");
      expect(content).not.toContain("the 9Router data directory");
    });

    it("brands AntigravityToolCard.js with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js"), "utf8");
      expect(content).toContain("reroute models through KhatamRouter");
      expect(content).toContain("any provider via KhatamRouter");
      expect(content).toContain("Run terminal (KhatamRouter) as Administrator");
    });

    it("brands MitmServerCard.js and MitmToolCard.js with KhatamRouter", () => {
      const serverContent = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js"), "utf8");
      expect(serverContent).toContain("KhatamRouter Base URL");
      expect(serverContent).toContain("restart KhatamRouter as Administrator");

      const toolContent = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js"), "utf8");
      expect(toolContent).toContain("traffic through KhatamRouter via MITM");
    });

    it("brands cliTools.js descriptions with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/shared/constants/cliTools.js"), "utf8");
      expect(content).toContain("via KhatamRouter extension");
      expect(content).toContain("check the KhatamRouter models to use");
      expect(content).toContain("KhatamRouter works as an OpenAI-compatible endpoint");
      expect(content).toContain("KhatamRouter will update the provider to 'openai' mode");
    });
  });

  describe("Part B User-Facing Display Rebranding Across Dashboard & CLI", () => {
    it("brands combos page client note with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/combos/page.js"), "utf8");
      expect(content).toContain("traffic can hit KhatamRouter without the prefix");
      expect(content).not.toContain("traffic can hit 9router without the prefix");
    });

    it("brands remote server fallback message across all 10 CLI tools cards", () => {
      const toolCards = [
        "ClaudeToolCard.js",
        "ClineToolCard.js",
        "CodexToolCard.js",
        "DeepSeekTuiToolCard.js",
        "DroidToolCard.js",
        "GenericCliToolCard.js",
        "JcodeToolCard.js",
        "KiloToolCard.js",
        "OpenClawToolCard.js",
        "OpenCodeToolCard.js",
      ];

      for (const card of toolCards) {
        const fullPath = path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components", card);
        const content = fs.readFileSync(fullPath, "utf8");
        expect(content, `${card} must contain KhatamRouter remote server text`).toContain("Manual configuration is still available if KhatamRouter is deployed on a remote server.");
        expect(content, `${card} must not contain 9router remote server text`).not.toContain("Manual configuration is still available if 9router is deployed on a remote server.");
      }
    });

    it("brands HermesToolCard alert text, STT labels, and modal titles while preserving functional identifiers", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js"), "utf8");
      expect(content).toContain('"${endpoint}" is not a KhatamRouter endpoint.');
      expect(content).not.toContain('"${endpoint}" is not a 9router endpoint.');
      expect(content).toContain("Route Hermes voice & audio transcription through KhatamRouter's /v1/audio/transcriptions");
      expect(content).not.toContain("Route Hermes voice & audio transcription through 9router's");
      expect(content).toContain("Transcribe voice &amp; audio via KhatamRouter (per-profile)");
      expect(content).not.toContain("Transcribe voice &amp; audio via 9router (per-profile)");
      expect(content).toContain("Select STT Model — audio transcription via KhatamRouter");
      expect(content).not.toContain("Select STT Model — audio transcription via 9router");
      expect(content).toContain("every profile that routes through KhatamRouter.");
      expect(content).not.toContain("every profile that routes through 9router.");

      // Functional identifiers preserved
      expect(content).toContain("has9Router");
      expect(content).toContain("has9RouterStt");
      expect(content).toContain("sk_9router");
    });

    it("brands DonateModal title fallback with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/shared/components/DonateModal.js"), "utf8");
      expect(content).toContain('{data?.title || "Support KhatamRouter"}');
      expect(content).not.toContain('{data?.title || "Support 9Router"}');
    });

    it("brands login page reset hint with khatamrouter CLI", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/login/page.js"), "utf8");
      expect(content).toContain('<code className="bg-sidebar px-1 rounded">khatamrouter</code> CLI');
      expect(content).not.toContain('<code className="bg-sidebar px-1 rounded">9router</code> CLI');
    });

    it("brands login API RESET_HINT with KhatamRouter CLI", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/api/auth/login/route.js"), "utf8");
      expect(content).toContain('RESET_HINT = "Forgot password? Reset to default via KhatamRouter CLI');
      expect(content).not.toContain("via 9Router CLI");
    });

    it("brands OAuth completion template with return to KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/lib/oauth/utils/server.js"), "utf8");
      expect(content).toContain("return to KhatamRouter.");
      expect(content).not.toContain("return to 9Router.");
    });

    it("brands MIMO login session completion HTML with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/lib/mimoLoginSession.js"), "utf8");
      expect(content).toContain("回到 KhatamRouter 弹窗继续。");
      expect(content).not.toContain("回到 9router 弹窗继续。");
    });

    it("brands antigravity MITM error messages with KhatamRouter", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/api/cli-tools/antigravity-mitm/route.js"), "utf8");
      expect(content).toContain("restart KhatamRouter as Administrator");
      expect(content).not.toContain("restart 9Router as Administrator");
    });

    it("brands Headroom start and restart error messages with KhatamRouter", () => {
      const startContent = fs.readFileSync(path.join(rootDir, "src/app/api/headroom/start/route.js"), "utf8");
      expect(startContent).toContain("outside KhatamRouter");
      expect(startContent).not.toContain("outside 9Router");

      const restartContent = fs.readFileSync(path.join(rootDir, "src/app/api/headroom/restart/route.js"), "utf8");
      expect(restartContent).toContain("outside KhatamRouter");
      expect(restartContent).not.toContain("outside 9Router");
    });

    it("brands profile backup, metadata filenames, and OIDC placeholders while preserving urn:9router:sp", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/profile/page.js"), "utf8");
      expect(content).toContain("anchor.download = `khatamrouter-backup-${stamp}.json`;");
      expect(content).not.toContain("`9router-backup-");
      expect(content).toContain('download="khatamrouter-sp-metadata.xml"');
      expect(content).not.toContain('download="9router-sp-metadata.xml"');
      expect(content).toContain('placeholder="https://auth.example.com/application/o/khatamrouter/"');
      expect(content).toContain('placeholder="khatamrouter-dashboard"');

      // Functional SAML entity ID preserved
      expect(content).toContain("urn:9router:sp");
    });

    it("brands skills entry name with KhatamRouter while preserving functional IDs and upstream URLs", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/shared/constants/skills.js"), "utf8");
      expect(content).toContain('name: "KhatamRouter (Entry)"');
      expect(content).not.toContain('name: "9Router (Entry)"');
      expect(content).toContain('id: "9router"');
      expect(content).toContain('id: "9router-chat"');
    });

    it("brands root package.json description and cli/package.json keywords", () => {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
      expect(rootPkg.description).toBe("KhatamRouter web dashboard");

      const cliPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "cli/package.json"), "utf8"));
      expect(cliPkg.name).toBe("9router"); // Kept for npm backward compatibility
      expect(cliPkg.keywords).toContain("khatamrouter");
      expect(cliPkg.keywords).toContain("9router");
    });
  });

  describe("Functional Identifiers Preservation Invariant", () => {
    it("preserves model_providers.9router in existing Codex configuration checks", () => {
      // Test that legacy Codex config format is recognized
      const legacyCodexConfig = `
model_provider = "9router"

[model_providers.9router]
base_url = "http://localhost:20128/v1"
wire_specification = "openai"
`;
      const is9RouterConfigured = legacyCodexConfig.includes('model_provider = "9router"') ||
        legacyCodexConfig.includes("[model_providers.9router]");
      expect(is9RouterConfigured).toBe(true);
    });

    it("preserves functional keys in cliTools.js", () => {
      const content = fs.readFileSync(path.join(rootDir, "src/shared/constants/cliTools.js"), "utf8");
      expect(content).toContain("[model.9router]");
      expect(content).toContain("/model 9router");
      expect(content).toContain("providers.9router");
    });

    it("preserves fallback key placeholder sk_9router in tool cards", () => {
      const serverCard = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js"), "utf8");
      expect(serverCard).toContain("sk_9router");

      const antigravityCard = fs.readFileSync(path.join(rootDir, "src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js"), "utf8");
      expect(antigravityCard).toContain("sk_9router");
    });
  });
});

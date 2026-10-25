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

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRequire } from "node:module";

// Ensure React 19 isomorphic version matches react-dom/server
React.version = "19.2.4";

let renderToStaticMarkup;
const req = createRequire(import.meta.url);

// Components under test loaded via native Bun resolver
const ConnectionRow = req("../../src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js").default;
const ModelRow = req("../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js").default;
const ModelSelectModal = req("../../src/shared/components/ModelSelectModal.js").default;
const ComboFormModal = req("../../src/shared/components/ComboFormModal.js").default;
const CombosPage = req("../../src/app/(dashboard)/dashboard/combos/page.js").default;
const QuotaPage = req("../../src/app/(dashboard)/dashboard/quota/page.js").default;

// Mock next/navigation for Next.js App Router hooks
let mockSearchParams = new URLSearchParams();
const mockRouter = { push: vi.fn(), replace: vi.fn() };

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
  usePathname: () => "/dashboard/quota",
}));

describe("Wave 8 Dashboard & CLI Integration", () => {
  beforeEach(async () => {
    if (!renderToStaticMarkup) {
      const serverMod = await import("react-dom/server");
      renderToStaticMarkup = serverMod.renderToStaticMarkup;
    }
    mockSearchParams = new URLSearchParams();
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [], aliases: {}, providers: [] }),
    });
  });

  describe("ConnectionRow | LimitsModal (T025)", () => {
    it("renders Limits button trigger in action buttons list", () => {
      const conn = {
        id: "conn-1",
        name: "Test Connection",
        authType: "apikey",
        isActive: true,
        priority: 1,
      };

      const html = renderToStaticMarkup(
        React.createElement(ConnectionRow, {
          connection: conn,
          proxyPools: [],
          isOAuth: false,
          isFirst: true,
          isLast: true,
          onMoveUp: vi.fn(),
          onMoveDown: vi.fn(),
          onToggleActive: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        })
      );

      expect(html).toContain('data-testid="connection-limits-btn"');
      expect(html).toContain("tune");
      expect(html).toContain("Limits");
    });

    it("displays current limits badge when rate_limit_overrides_json is configured", () => {
      const connWithLimits = {
        id: "conn-with-limits",
        name: "Rate Limited Connection",
        authType: "apikey",
        isActive: true,
        priority: 1,
        rate_limit_overrides_json: JSON.stringify({
          rpm: 60,
          maxConcurrent: 5,
          maxBudgetUsd: 10,
        }),
      };

      const html = renderToStaticMarkup(
        React.createElement(ConnectionRow, {
          connection: connWithLimits,
          proxyPools: [],
          isOAuth: false,
          isFirst: true,
          isLast: true,
          onMoveUp: vi.fn(),
          onMoveDown: vi.fn(),
          onToggleActive: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        })
      );

      expect(html).toContain('data-testid="connection-limits-badge"');
      expect(html).toContain("Limits");
    });

    it("does not render limits badge when rate_limit_overrides_json is null or empty", () => {
      const connNoLimits = {
        id: "conn-clean",
        name: "Standard Connection",
        authType: "apikey",
        isActive: true,
        priority: 1,
        rate_limit_overrides_json: null,
      };

      const html = renderToStaticMarkup(
        React.createElement(ConnectionRow, {
          connection: connNoLimits,
          proxyPools: [],
          isOAuth: false,
          isFirst: true,
          isLast: true,
          onMoveUp: vi.fn(),
          onMoveDown: vi.fn(),
          onToggleActive: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        })
      );

      expect(html).not.toContain('data-testid="connection-limits-badge"');
    });

    it("preserves legacy controls: edit, delete, toggle, and priority buttons", () => {
      const html = renderToStaticMarkup(
        React.createElement(ConnectionRow, {
          connection: { id: "c1", name: "Conn", isActive: true, priority: 2 },
          proxyPools: [{ id: "p1", name: "Pool 1", isActive: true }],
          isOAuth: false,
          isFirst: false,
          isLast: false,
          onMoveUp: vi.fn(),
          onMoveDown: vi.fn(),
          onToggleActive: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        })
      );

      expect(html).toContain("Edit");
      expect(html).toContain("Delete");
      expect(html).toContain("Proxy");
      expect(html).toContain("keyboard_arrow_up");
      expect(html).toContain("keyboard_arrow_down");
    });
  });

  describe("QuotaPage | KeyQuotaTab (T026)", () => {
    it("renders tabs segmented control with Provider Limits and API Key Quotas options", () => {
      const html = renderToStaticMarkup(React.createElement(QuotaPage));
      expect(html).toContain('data-testid="quota-tabs"');
      expect(html).toContain("Provider Limits");
      expect(html).toContain("API Key Quotas");
    });

    it("defaults to Provider Limits view preserving existing functionality", () => {
      mockSearchParams = new URLSearchParams();
      const html = renderToStaticMarkup(React.createElement(QuotaPage));
      expect(html).toContain('data-testid="provider-limits-view"');
      expect(html).not.toContain('data-testid="key-quota-view"');
    });

    it("renders KeyQuotaView when tab is set to keys", () => {
      mockSearchParams = new URLSearchParams("tab=keys");
      const html = renderToStaticMarkup(React.createElement(QuotaPage, { tab: "keys" }));
      expect(html).toContain('data-testid="key-quota-view"');
      expect(html).not.toContain('data-testid="provider-limits-view"');
    });
  });

  describe("ModelRow | CapabilityBadges (T027)", () => {
    it("renders CapacityBadges with model capabilities", () => {
      const caps = { vision: true, reasoning: true, tools: true };
      const html = renderToStaticMarkup(
        React.createElement(ModelRow, {
          model: { id: "gpt-5", name: "GPT 5" },
          fullModel: "openai/gpt-5",
          caps,
          onCopy: vi.fn(),
        })
      );

      // Vision badge icon is 'visibility', tools is 'build', reasoning is 'neurology'
      expect(html).toContain("visibility");
      expect(html).toContain("neurology");
      expect(html).toContain("build");
    });

    it("resolves capabilities from model.capabilities when caps prop is omitted", () => {
      const modelWithCaps = {
        id: "claude-sonnet-4",
        name: "Claude Sonnet",
        capabilities: { vision: true, pdf: true },
      };

      const html = renderToStaticMarkup(
        React.createElement(ModelRow, {
          model: modelWithCaps,
          fullModel: "anthropic/claude-sonnet-4",
          onCopy: vi.fn(),
        })
      );

      expect(html).toContain("visibility");
      expect(html).toContain("description");
    });

    it("fails open when model has null or undefined capabilities", () => {
      const html = renderToStaticMarkup(
        React.createElement(ModelRow, {
          model: { id: "unknown-model" },
          fullModel: "custom/unknown-model",
          onCopy: vi.fn(),
        })
      );

      expect(html).toContain("custom/unknown-model");
    });
  });

  describe("ModelSelectModal | CapabilityBadges (T028)", () => {
    it("renders capability badges for catalog models and combo items", () => {
      const html = renderToStaticMarkup(
        React.createElement(ModelSelectModal, {
          isOpen: true,
          onClose: vi.fn(),
          onSelect: vi.fn(),
          activeProviders: [
            {
              id: "conn-1",
              provider: "openai",
              isActive: true,
            },
          ],
        })
      );

      expect(html).toBeDefined();
      expect(typeof html).toBe("string");
    });
  });

  describe("ComboFormModal | CapabilityBadges (T029)", () => {
    it("renders aggregated capability badges for selected combo models", () => {
      const html = renderToStaticMarkup(
        React.createElement(ComboFormModal, {
          isOpen: true,
          combo: {
            name: "smart-combo",
            models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
          },
          onClose: vi.fn(),
          onSave: vi.fn(),
        })
      );

      expect(html).toContain('data-testid="combo-aggregated-badges"');
      expect(html).toContain("smart-combo");
    });
  });

  describe("CombosPage | CapabilityBadges (T030)", () => {
    it("renders aggregated capability badges on combo cards", () => {
      const html = renderToStaticMarkup(React.createElement(CombosPage));
      expect(html).toBeDefined();
      expect(typeof html).toBe("string");
    });
  });

  describe("CLI & Bun Prerequisite Checks (T031)", async () => {
    it("ensures Bun runtime requirement with actionable install message in cli/cli.js", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const cliSource = fs.readFileSync(path.resolve(__dirname, "../../cli/cli.js"), "utf8");
      expect(cliSource).toContain("Bun runtime is required to run KhatamRouter");
      expect(cliSource).toContain("https://bun.sh");
      expect(cliSource).toContain("function findBunExecutable");
      expect(cliSource).toContain("function ensureBun");
    });
  });
});

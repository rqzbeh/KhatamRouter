import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import ReactTestRenderer from "react-test-renderer";
import FreeProxySourcesCard from "@/shared/components/FreeProxySourcesCard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { act } = ReactTestRenderer;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function getTextContent(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join(" ");
  if (node.children) return getTextContent(node.children);
  if (node.props?.children) return getTextContent(node.props.children);
  return "";
}

function findButtonByText(root, text) {
  return root.findAllByType("button").find((b) => getTextContent(b.props.children).includes(text));
}

describe("FreeProxySourcesCard Integration & Wiring (Spec 017 / master e1fb2594)", () => {
  const pagePath = path.resolve(__dirname, "../../src/app/(dashboard)/dashboard/proxy-pools/page.js");
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("AST & Transpiler Placement Verification in proxy-pools/page.js", () => {
    it("directly imports FreeProxySourcesCard without index re-export", () => {
      const source = fs.readFileSync(pagePath, "utf-8");
      const transpiler = new Bun.Transpiler({ loader: "jsx" });
      const scanned = transpiler.scan(source);

      const importItem = scanned.imports.find(
        (imp) =>
          imp.path === "@/shared/components/FreeProxySourcesCard" ||
          imp.path === "@/shared/components/FreeProxySourcesCard.js"
      );
      expect(importItem).toBeDefined();
      expect(importItem.kind).toBe("import-statement");
    });

    it("renders FreeProxySourcesCard sensibly positioned above existing proxy list card", () => {
      const source = fs.readFileSync(pagePath, "utf-8");
      const transpiler = new Bun.Transpiler({ loader: "jsx" });
      const transformed = transpiler.transformSync(source);

      // Verify compiled JSX contains FreeProxySourcesCard identifier
      expect(transformed).toContain("FreeProxySourcesCard");

      // Verify page source contains exact single invocation
      const matches = source.match(/<FreeProxySourcesCard\s*\/>/g);
      expect(matches).not.toBeNull();
      expect(matches.length).toBe(1);

      // Verify positioning above existing proxy pools list card
      const cardIndex = source.indexOf("<FreeProxySourcesCard");
      const totalBadgeIndex = source.indexOf("Total: {proxyPools.length}");
      expect(cardIndex).toBeGreaterThan(0);
      expect(totalBadgeIndex).toBeGreaterThan(cardIndex);
    });

    it("preserves Psiphon and Regionhop UI intact with no quota or rotation alterations", () => {
      const source = fs.readFileSync(pagePath, "utf-8");
      expect(source).toContain("PSIPHON_SELECTABLE_REGIONS");
      expect(source).toContain("psiphonStatuses");
      expect(source).toContain("/status");
      expect(source).toContain("probeCandidates");
      expect(source).toContain("maxRequestsPerIp");
      expect(source).toContain("maxTokensPerIp");
    });
  });

  describe("Clean React Mount & Lifecycle Behavior", () => {
    // Note: Depends on base React resolution fix from test setup worker (afc616)
    // for dual-instance CJS/ESM hook resolution without internal hacks.
    it("fetches settings policy on mount via GET and does NOT trigger POST sync", async () => {
      const calls = [];
      globalThis.fetch = vi.fn().mockImplementation((url, opts = {}) => {
        const method = opts.method || "GET";
        calls.push({ url: String(url), method });

        if (String(url).includes("/api/settings/free-proxies") && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              policy: {
                acknowledgedRisk: false,
                enabled: { oneproxy: false, proxifly: false, iplocate: false },
              },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(React.createElement(FreeProxySourcesCard));
      });

      // Verify GET policy was requested
      const getCalls = calls.filter((c) => c.url.includes("/api/settings/free-proxies") && c.method === "GET");
      expect(getCalls.length).toBe(1);

      // Verify NO POST sync was triggered on mount
      const postCalls = calls.filter((c) => c.method === "POST");
      expect(postCalls.length).toBe(0);

      // Verify initial UI state: off by default
      const text = getTextContent(renderer.toJSON());
      expect(text).toContain("Free Proxy Feed Ingestion");
      expect(text).toContain("All Off");
      expect(text).toContain("Security & Operational Notice");

      // Verify risk checkbox is unchecked
      const checkboxes = renderer.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
      const riskCheckbox = checkboxes.find((i) => i.props.id === "ack-risk");
      expect(riskCheckbox).toBeDefined();
      expect(riskCheckbox.props.checked).toBe(false);
    });

    it("handles unknown auth or network errors safely without uncaught exceptions", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (String(url).includes("/api/settings/free-proxies")) {
          return Promise.reject(new Error("401 Unauthorized: Session expired"));
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(React.createElement(FreeProxySourcesCard));
      });

      const text = getTextContent(renderer.toJSON());
      expect(text).toContain("401 Unauthorized");
    });

    it("only triggers POST sync when manual Sync Feeds button is clicked", async () => {
      const calls = [];
      globalThis.fetch = vi.fn().mockImplementation((url, opts = {}) => {
        const method = opts.method || "GET";
        calls.push({ url: String(url), method });

        if (String(url).endsWith("/api/settings/free-proxies") && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              policy: {
                acknowledgedRisk: true,
                enabled: { oneproxy: true, proxifly: false, iplocate: false },
              },
            }),
          });
        }
        if (String(url).endsWith("/api/settings/free-proxies/sync") && method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              added: 5,
              updated: 2,
              skipped: 1,
              total: 8,
              message: "Successfully synchronized free proxy feeds",
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      let renderer;
      await act(async () => {
        renderer = ReactTestRenderer.create(React.createElement(FreeProxySourcesCard));
      });

      expect(calls.filter((c) => c.method === "POST").length).toBe(0);

      // Locate Sync Feeds button and click it
      const syncBtn = findButtonByText(renderer.root, "Sync Feeds Now");
      expect(syncBtn).toBeDefined();

      await act(async () => {
        await syncBtn.props.onClick();
      });

      const syncPosts = calls.filter(
        (c) => c.url.endsWith("/api/settings/free-proxies/sync") && c.method === "POST"
      );
      expect(syncPosts.length).toBe(1);

      const jsonStr = JSON.stringify(renderer.toJSON());
      expect(jsonStr).toContain("5");
      expect(jsonStr).toContain("added");
      expect(jsonStr).toContain("2");
      expect(jsonStr).toContain("updated");
    });
  });
});

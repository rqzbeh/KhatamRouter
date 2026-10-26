import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock("@/shared/components/Tooltip", () => ({
  default: ({ text, children }) =>
    React.createElement("span", { className: "tooltip-wrapper", title: text, "data-tooltip": text }, children),
}));

import {
  CAPACITY_META,
  ORDERED_MODALITIES,
  aggregateCapabilities,
} from "@/shared/constants/capacityMeta";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const CapacityBadgesMod = req("../../src/shared/components/CapacityBadges.js");
const CapacityBadges = CapacityBadgesMod.default;
const { aggregateComboCapabilities } = CapacityBadgesMod;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCapabilitiesForModel,
  capabilitiesFromServiceKind,
} from "../../open-sse/providers/capabilities.js";

describe("Capability Modality Badges", () => {
  describe("Constants | ModalityColors", () => {
    it("defines metadata for all 9 model modalities", () => {
      const expectedKeys = [
        "vision",
        "pdf",
        "audioInput",
        "videoInput",
        "imageOutput",
        "audioOutput",
        "search",
        "tools",
        "reasoning",
      ];

      for (const key of expectedKeys) {
        expect(CAPACITY_META).toHaveProperty(key);
        const meta = CAPACITY_META[key];
        expect(meta).toHaveProperty("icon");
        expect(typeof meta.icon).toBe("string");
        expect(meta.icon.length).toBeGreaterThan(0);

        expect(meta).toHaveProperty("label");
        expect(typeof meta.label).toBe("string");
        expect(meta.label.length).toBeGreaterThan(0);

        expect(meta).toHaveProperty("desc");
        expect(typeof meta.desc).toBe("string");
        expect(meta.desc.length).toBeGreaterThan(0);

        expect(meta).toHaveProperty("color");
        expect(meta.color).toMatch(/^text-/);

        expect(meta).toHaveProperty("bgClass");
        expect(meta.bgClass).toMatch(/^bg-/);
      }
    });

    it("matches exact icon and color tokens specified in Wave 8 spec", () => {
      expect(CAPACITY_META.vision).toMatchObject({
        icon: "visibility",
        color: "text-blue-500",
      });
      expect(CAPACITY_META.pdf).toMatchObject({
        icon: "description",
        color: "text-orange-500",
      });
      expect(CAPACITY_META.audioInput).toMatchObject({
        icon: "mic",
        color: "text-purple-500",
      });
      expect(CAPACITY_META.videoInput).toMatchObject({
        icon: "videocam",
        color: "text-rose-500",
      });
      expect(CAPACITY_META.imageOutput).toMatchObject({
        icon: "image",
        color: "text-emerald-500",
      });
      expect(CAPACITY_META.audioOutput).toMatchObject({
        icon: "volume_up",
        color: "text-indigo-500",
      });
      expect(CAPACITY_META.search).toMatchObject({
        icon: "travel_explore",
        color: "text-cyan-500",
      });
      expect(CAPACITY_META.tools).toMatchObject({
        icon: "build",
        color: "text-emerald-600",
      });
      expect(CAPACITY_META.reasoning).toMatchObject({
        icon: "neurology",
        color: "text-amber-500",
      });
    });

    it("exports ORDERED_MODALITIES with all 9 modalities in logical display order", () => {
      expect(ORDERED_MODALITIES).toHaveLength(9);
      expect(ORDERED_MODALITIES).toEqual([
        "vision",
        "pdf",
        "audioInput",
        "videoInput",
        "imageOutput",
        "audioOutput",
        "search",
        "tools",
        "reasoning",
      ]);
    });
  });

  describe("BadgeRendering | Tooltips", () => {
    it("returns null when caps is missing, empty, or has no active capabilities", () => {
      expect(CapacityBadges({ caps: null })).toBeNull();
      expect(CapacityBadges({ caps: undefined })).toBeNull();
      expect(CapacityBadges({ caps: {} })).toBeNull();
      expect(
        CapacityBadges({
          caps: {
            vision: false,
            pdf: false,
            audioInput: false,
            videoInput: false,
            imageOutput: false,
            audioOutput: false,
            search: false,
            tools: false,
            reasoning: false,
          },
        })
      ).toBeNull();
    });

    it("renders single capability badge with accessible title, aria-label, and color", () => {
      const vdom = CapacityBadges({
        caps: { vision: true },
      });
      expect(vdom).not.toBeNull();
      expect(vdom.type).toBe("span");

      const children = React.Children.toArray(vdom.props.children);
      expect(children).toHaveLength(1);

      const tooltipElem = children[0];
      expect(tooltipElem.props.text).toBe("Vision — Supports image input");

      const badgeElem = tooltipElem.props.children;
      expect(badgeElem.props.title).toBe("Vision — Supports image input");
      expect(badgeElem.props["aria-label"]).toBe("Vision — Supports image input");
      expect(badgeElem.props.children).toBe("visibility");
      expect(badgeElem.props.className).toContain("text-blue-500");
    });

    it("renders all 9 modality badges when all capabilities are true", () => {
      const allCaps = {
        vision: true,
        pdf: true,
        audioInput: true,
        videoInput: true,
        imageOutput: true,
        audioOutput: true,
        search: true,
        tools: true,
        reasoning: true,
      };

      const vdom = CapacityBadges({ caps: allCaps });
      expect(vdom).not.toBeNull();
      const children = React.Children.toArray(vdom.props.children);
      expect(children).toHaveLength(9);

      const icons = children.map((c) => c.props.children.props.children);
      expect(icons).toEqual([
        "visibility",
        "description",
        "mic",
        "videocam",
        "image",
        "volume_up",
        "travel_explore",
        "build",
        "neurology",
      ]);
    });

    it("respects className, colorOverride, and size props", () => {
      const vdom = CapacityBadges({
        caps: { vision: true, reasoning: true },
        className: "custom-class-xyz",
        colorOverride: "text-text-muted/70",
        size: 12,
      });

      expect(vdom.props.className).toContain("custom-class-xyz");
      const children = React.Children.toArray(vdom.props.children);
      expect(children).toHaveLength(2);

      for (const child of children) {
        const badge = child.props.children;
        expect(badge.props.className).toContain("text-text-muted/70");
        expect(badge.props.style).toEqual({ fontSize: "12px" });
      }
    });

    it("renders badges for capabilities derived via capabilitiesFromServiceKind", () => {
      const imgToTextCaps = capabilitiesFromServiceKind("imageToText");
      const vdomVision = CapacityBadges({ caps: imgToTextCaps });
      expect(vdomVision).not.toBeNull();
      const visionChild = React.Children.toArray(vdomVision.props.children)[0];
      expect(visionChild.props.children.props.children).toBe("visibility");

      const sttCaps = capabilitiesFromServiceKind("stt");
      const vdomAudio = CapacityBadges({ caps: sttCaps });
      expect(vdomAudio).not.toBeNull();
      const audioChild = React.Children.toArray(vdomAudio.props.children)[0];
      expect(audioChild.props.children.props.children).toBe("mic");
    });

    it("is re-exported from @/shared/components with identical component contract", () => {
      const componentsIndexPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/shared/components/index.js"
      );
      const indexContent = fs.readFileSync(componentsIndexPath, "utf8");
      expect(indexContent).toMatch(
        /export\s+\{\s+default\s+as\s+CapacityBadges\s*\}\s+from\s+["']\.\/CapacityBadges(?:\.tsx)?["'];/
      );
    });
  });

  describe("ComboAggregation | Intersection", () => {
    it("aggregates raw capability objects via pure function aggregateCapabilities", () => {
      const modelA = {
        vision: true,
        pdf: false,
        audioInput: false,
        videoInput: false,
        imageOutput: false,
        audioOutput: false,
        search: false,
        tools: true,
        reasoning: true,
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: false,
        thinkingRange: null,
        contextWindow: 1000000,
        maxOutput: 128000,
      };

      const modelB = {
        vision: false,
        pdf: true,
        audioInput: false,
        videoInput: false,
        imageOutput: false,
        audioOutput: false,
        search: true,
        tools: false,
        reasoning: false,
        thinkingFormat: null,
        thinkingCanDisable: true,
        thinkingRange: null,
        contextWindow: 128000,
        maxOutput: 64000,
      };

      const aggregated = aggregateCapabilities([modelA, modelB]);
      expect(aggregated).not.toBeNull();

      // Union of modalities
      expect(aggregated.vision).toBe(true);
      expect(aggregated.pdf).toBe(true);
      expect(aggregated.search).toBe(true);
      expect(aggregated.audioInput).toBe(false);

      // Intersection of tools (A has tools, B does not => false)
      expect(aggregated.tools).toBe(false);

      // Primary reasoning (model A is primary)
      expect(aggregated.reasoning).toBe(true);
      expect(aggregated.thinkingFormat).toBe("claude-adaptive");
      expect(aggregated.thinkingCanDisable).toBe(false);

      // Conservative limits
      expect(aggregated.contextWindow).toBe(128000); // min
      expect(aggregated.maxOutput).toBe(128000); // max
    });

    it("intersection of tools is true only if ALL models support tools", () => {
      const modelA = { tools: true, reasoning: false };
      const modelB = { tools: true, reasoning: false };
      const agg1 = aggregateCapabilities([modelA, modelB]);
      expect(agg1.tools).toBe(true);

      const modelC = { tools: false, reasoning: false };
      const agg2 = aggregateCapabilities([modelA, modelB, modelC]);
      expect(agg2.tools).toBe(false);
    });

    it("primary reasoning reflects the first model, ignoring secondary reasoning", () => {
      const modelPrimaryText = {
        reasoning: false,
        thinkingFormat: null,
        tools: true,
      };
      const modelSecondaryThinking = {
        reasoning: true,
        thinkingFormat: "openai",
        tools: true,
      };

      const aggregated = aggregateCapabilities([
        modelPrimaryText,
        modelSecondaryThinking,
      ]);
      expect(aggregated.reasoning).toBe(false);
      expect(aggregated.thinkingFormat).toBeNull();
    });

    it("handles empty combos and null inputs gracefully", () => {
      expect(aggregateCapabilities([])).toBeNull();
      expect(aggregateCapabilities(null)).toBeNull();
      expect(aggregateCapabilities(undefined)).toBeNull();

      expect(aggregateComboCapabilities([])).toBeNull();
      expect(aggregateComboCapabilities(null)).toBeNull();
      expect(aggregateComboCapabilities(undefined)).toBeNull();
    });

    it("handles unknown models gracefully without throwing", () => {
      const result = aggregateComboCapabilities([
        "unknown-provider/non-existent-model-xyz",
      ]);
      expect(result).not.toBeNull();
      expect(result.vision).toBe(false);
      expect(result.reasoning).toBe(false);
      expect(result.tools).toBe(true); // default capabilities have tools: true
      expect(result.contextWindow).toBeGreaterThan(0);
    });

    it("renders combo capability badges directly via comboModels prop", () => {
      // Model with vision + tools
      // Model with reasoning
      const vdom = CapacityBadges({
        comboModels: ["claude/claude-sonnet-5", "deepseek/deepseek-chat"],
      });
      expect(vdom).not.toBeNull();
      const children = React.Children.toArray(vdom.props.children);
      const icons = children.map((c) => c.props.children.props.children);
      // claude-sonnet-5 has vision, search, tools, reasoning; deepseek-chat has tools
      expect(icons).toContain("visibility");
      expect(icons).toContain("neurology");
      expect(icons).toContain("build");
    });
  });
});

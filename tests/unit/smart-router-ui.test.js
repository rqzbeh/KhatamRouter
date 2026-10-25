import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getModelKind } from "@/shared/constants/models.js";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");

describe("Smart Router UI Components & Kind Filtering", () => {
  describe("SmartPolicyModal Barrel Export", () => {
    const barrelPath = path.join(REPO_ROOT, "src/shared/components/index.js");
    const barrelSource = fs.readFileSync(barrelPath, "utf-8");

    it("exports SmartPolicyModal from shared components barrel in index.js", () => {
      expect(barrelSource).toMatch(/export\s*\{\s*default\s+as\s+SmartPolicyModal\s*\}\s*from\s*["']\.\/SmartPolicyModal["'];/);
    });

    it("canonical SmartPolicyModal component file exists and has default export", () => {
      const modalPath = path.join(REPO_ROOT, "src/shared/components/SmartPolicyModal.js");
      expect(fs.existsSync(modalPath)).toBe(true);
      const modalSource = fs.readFileSync(modalPath, "utf-8");
      expect(modalSource).toMatch(/export\s+default\s+function\s+SmartPolicyModal/);
    });

    it("resolves SmartPolicyModal from shared components barrel at runtime via Bun", () => {
      const cmd = `bun -e '
        import { SmartPolicyModal as BarrelModal } from "./src/shared/components/index.js";
        import CanonicalModal from "./src/shared/components/SmartPolicyModal.js";
        if (typeof BarrelModal !== "function") throw new Error("BarrelModal is not a function");
        if (BarrelModal !== CanonicalModal) throw new Error("BarrelModal does not match CanonicalModal");
        console.log("OK");
      '`;
      const output = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8" });
      expect(output.trim()).toBe("OK");
    });
  });

  describe("ModelSelectModal systemone kind filtering", () => {
    const modalPath = path.join(REPO_ROOT, "src/shared/components/ModelSelectModal.js");
    const sourceCode = fs.readFileSync(modalPath, "utf-8");

    it("declares systemone within TYPED_KINDS in ModelSelectModal.js", () => {
      const match = sourceCode.match(/const TYPED_KINDS\s*=\s*new Set\(\[([^\]]+)\]\);/);
      expect(match).toBeTruthy();
      const declaredKinds = match[1];
      expect(declaredKinds).toContain('"systemone"');
    });

    it("extracts TYPED_KINDS and proves filterByKind with kindFilter='systemone' excludes normal model kinds", () => {
      const match = sourceCode.match(/const TYPED_KINDS\s*=\s*new Set\(\[([^\]]+)\]\);/);
      expect(match).toBeTruthy();
      const parsedKinds = JSON.parse(`[${match[1]}]`);
      const TYPED_KINDS = new Set(parsedKinds);

      // Verify "systemone" is actually present in the parsed set from ModelSelectModal.js
      expect(TYPED_KINDS.has("systemone")).toBe(true);

      // Implementation of filterByKind matching ModelSelectModal.js:
      // const filterByKind = (models) => {
      //   if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      //   if (!TYPED_KINDS.has(kindFilter)) return models;
      //   return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
      // };
      const filterByKind = (models, kindFilter) => {
        if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
        if (!TYPED_KINDS.has(kindFilter)) return models;
        return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
      };

      const candidateModels = [
        { id: "gpt-4o", name: "GPT-4o" }, // default untyped / standard LLM
        { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", kind: "llm" }, // explicit LLM kind
        { id: "dall-e-3", name: "DALL-E 3", type: "image" }, // image kind
        { id: "whisper-1", name: "Whisper 1", type: "stt" }, // stt kind
        { id: "tts-1", name: "TTS 1", type: "tts" }, // tts kind
        { id: "text-embedding-3-small", name: "Embedding Small", type: "embedding" }, // embedding kind
        { id: "jev-systemone", name: "System One Router", type: "systemone" }, // typed systemone model
        { id: "systemone-custom", name: "Custom System One", kind: "systemone" }, // kinded systemone model
      ];

      const filtered = filterByKind(candidateModels, "systemone");

      // Verify only systemone models survive the filter
      expect(filtered.map((m) => m.id)).toEqual(["jev-systemone", "systemone-custom"]);

      // Verify normal LLM models are strictly excluded
      expect(filtered.some((m) => m.id === "gpt-4o")).toBe(false);
      expect(filtered.some((m) => m.id === "claude-3-5-sonnet")).toBe(false);

      // Verify other typed kinds are strictly excluded
      expect(filtered.some((m) => m.id === "dall-e-3")).toBe(false);
      expect(filtered.some((m) => m.id === "whisper-1")).toBe(false);
      expect(filtered.some((m) => m.id === "tts-1")).toBe(false);
      expect(filtered.some((m) => m.id === "text-embedding-3-small")).toBe(false);
    });

    it("proves the regression: without systemone in TYPED_KINDS, normal models leak through", () => {
      // Prior to upstream fix f3f86fdd:
      const BUGGY_TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
      const buggyFilterByKind = (models, kindFilter) => {
        if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
        if (!BUGGY_TYPED_KINDS.has(kindFilter)) return models;
        return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
      };

      const candidateModels = [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "jev-systemone", name: "System One Router", type: "systemone" },
      ];

      // Buggy behavior: returns all models unfiltered because !BUGGY_TYPED_KINDS.has("systemone") is true
      const leakyResult = buggyFilterByKind(candidateModels, "systemone");
      expect(leakyResult).toHaveLength(2);
      expect(leakyResult.some((m) => m.id === "gpt-4o")).toBe(true);
    });
  });
});

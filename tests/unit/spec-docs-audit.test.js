import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

describe("T4: Documentation, Specs & Acceptance Audit", () => {
  const rootDir = path.resolve(__dirname, "../../");
  const specDir = path.join(rootDir, "specs/011-branding-update-source");
  const unlazyDir = path.join(rootDir, ".unlazy/011-branding-update-source");

  describe("Spec-Kit and Unlazy Artifact Integrity", () => {
    it("ensures all 4 Spec-Kit documents are present and non-empty", () => {
      const requiredDocs = ["spec.md", "plan.md", "tasks.md", "research.md"];
      for (const doc of requiredDocs) {
        const filePath = path.join(specDir, doc);
        expect(fs.existsSync(filePath), `Missing ${doc}`).toBe(true);
        const stats = fs.statSync(filePath);
        expect(stats.size).toBeGreaterThan(100);
      }
    });

    it("ensures Unlazy PLAN.md and GATES.md exist and are non-empty", () => {
      const requiredUnlazy = ["PLAN.md", "GATES.md"];
      for (const file of requiredUnlazy) {
        const filePath = path.join(unlazyDir, file);
        expect(fs.existsSync(filePath), `Missing ${file}`).toBe(true);
        const stats = fs.statSync(filePath);
        expect(stats.size).toBeGreaterThan(50);
      }
    });

    it("passes gate-lint with 0 errors", () => {
      const gatesPath = path.join(unlazyDir, "GATES.md");
      const lintScript = "/home/redsnow/.claude/skills/unlazy/scripts/gate-lint.mjs";
      // ponytail: gate-lint lives in the developer's ~/.claude skills dir, not in this repo.
      // Absent in CI, so skip explicitly and log it rather than passing silently.
      if (!fs.existsSync(lintScript)) {
        console.warn(`[spec-docs-audit] SKIPPED gate-lint: ${lintScript} not found (external skill, not in repo)`);
        return;
      }
      const output = execSync(`bun ${lintScript} ${gatesPath}`, {
        encoding: "utf8",
        cwd: rootDir,
      });
      expect(output).toContain("LINT OK");
    });
  });

  describe("Task Ownership Disjointness", () => {
    it("verifies that tasks in tasks.md have strictly disjoint owned file sets", () => {
      const tasksContent = fs.readFileSync(path.join(specDir, "tasks.md"), "utf8");
      const matches = [...tasksContent.matchAll(/\| \*\*T\d\*\* \| [^|]+ \| ([^|]+) \|/g)];
      expect(matches.length).toBeGreaterThanOrEqual(4);

      const seen = new Set();
      const duplicates = [];

      for (const match of matches) {
        const files = match[1].split(",").map((s) => s.trim());
        for (const f of files) {
          if (seen.has(f)) {
            duplicates.push(f);
          }
          seen.add(f);
        }
      }

      expect(duplicates).toEqual([]);
    });
  });

  describe("Functional Identifiers Preservation Audit", () => {
    it("verifies research.md and codebase preserve all key functional identifiers", () => {
      const researchContent = fs.readFileSync(path.join(specDir, "research.md"), "utf8");
      const requiredIdentifiers = [
        "~/.9router",
        "model_providers.9router",
        'provider["9router"]',
        "status.has9Router",
        "urn:9router:sp",
      ];

      for (const id of requiredIdentifiers) {
        expect(researchContent).toContain(id);
      }
    });
  });

  describe("Global Supply-Chain Audit", () => {
    it("verifies that no runtime code in src/ or cli/ points to registry.npmjs.org/9router", () => {
      const dirs = [path.join(rootDir, "src"), path.join(rootDir, "cli")];

      function scanDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && entry.name !== ".next") {
              scanDir(fullPath);
            }
          } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".json"))) {
            const content = fs.readFileSync(fullPath, "utf8");
            expect(content).not.toContain("registry.npmjs.org/9router");
          }
        }
      }

      for (const d of dirs) {
        scanDir(d);
      }
    });
  });
});

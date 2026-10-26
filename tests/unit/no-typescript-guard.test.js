import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");

/**
 * ALLOWLIST for pre-existing TypeScript files that are explicitly out of scope.
 * Principle II (CLAUDE.md): plain JavaScript (ESM), NO TypeScript.
 *
 * Every entry must exist on historical baseline commit 5882c50b and have an
 * individual, documented justification.
 */
export const TS_ALLOWLIST = new Map([
  [
    "custom-server.ts",
    "Pre-existing twin kept by PR #64; tests/unit/wave75-twins-alignment.test.js covers it",
  ],
]);

/**
 * Directory names to skip when falling back to filesystem traversal.
 */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".worktrees",
  ".claude",
]);

/**
 * Collect all repository files, preferring git ls-files and falling back
 * to a recursive directory walk if git is unavailable.
 */
export function getTrackedOrRepoFiles(rootDir = REPO_ROOT) {
  try {
    const stdout = execSync("git ls-files", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // Fallback: directory walk
    return walkDirectory(rootDir, rootDir);
  }
}

/**
 * Recursive walk fallback when git ls-files is unavailable.
 */
export function walkDirectory(currentDir, rootDir) {
  const results = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath, rootDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Identify whether a file path represents TypeScript source code
 * (.ts, .tsx, .mts, .cts, but excluding declaration files .d.ts).
 */
export function isTypeScriptSourceFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/")) return false;
  if (normalized.endsWith(".d.ts")) return false;
  return /\.(ts|tsx|mts|cts)$/.test(normalized);
}

/**
 * Scan file list for any TypeScript files not present on the allowlist.
 */
export function findDisallowedTypeScriptFiles(files, allowlist = TS_ALLOWLIST) {
  const disallowed = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (isTypeScriptSourceFile(normalized) && !allowlist.has(normalized)) {
      disallowed.push(normalized);
    }
  }
  return disallowed.sort();
}

describe("No-TypeScript Guard (Principle II & PR #64)", () => {
  it("verifies that no unallowlisted TypeScript files exist in the repository", () => {
    const files = getTrackedOrRepoFiles(REPO_ROOT);
    const violations = findDisallowedTypeScriptFiles(files, TS_ALLOWLIST);

    if (violations.length > 0) {
      const formatted = violations.map((v) => `  - ${v}`).join("\n");
      expect.fail(
        `Found ${violations.length} disallowed TypeScript file(s) in repository:\n${formatted}\n\n` +
          "Project policy (CLAUDE.md Principle II): Plain JavaScript (ESM), NO TypeScript.\n" +
          "Convert these files to plain JavaScript (.js / .jsx) or remove them."
      );
    }

    expect(violations).toEqual([]);
  });

  it("ensures every entry on the allowlist is documented with a valid justification", () => {
    expect(TS_ALLOWLIST.size).toBe(1);
    expect(TS_ALLOWLIST.has("custom-server.ts")).toBe(true);
    const justification = TS_ALLOWLIST.get("custom-server.ts");
    expect(justification).toBeTruthy();
    expect(typeof justification).toBe("string");
    expect(justification.length).toBeGreaterThan(10);
  });

  it("directory walk fallback identifies TypeScript source files correctly", () => {
    const files = walkDirectory(REPO_ROOT, REPO_ROOT);
    const violations = findDisallowedTypeScriptFiles(files, TS_ALLOWLIST);
    expect(violations).toEqual([]);
  });

  it("correctly flags mock TypeScript files during detection", () => {
    const mockFiles = [
      "src/shared/components/Test.js",
      "src/shared/components/Test.tsx",
      "cli/src/ts/index.ts",
      "custom-server.ts",
      "types/ambient.d.ts",
    ];

    const violations = findDisallowedTypeScriptFiles(mockFiles, TS_ALLOWLIST);
    expect(violations).toEqual([
      "cli/src/ts/index.ts",
      "src/shared/components/Test.tsx",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  scanRepo,
  listRepoFiles,
  ALLOWLIST,
  LOCKFILE_NAMES,
  NODE_SHEBANG,
  PKG_COMMAND,
  NODE_INTERPRETER,
} from "./bun-only-guard.lib.mjs";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");

/**
 * Bun-only policy. Bun is the only runtime, interpreter, package manager and CI
 * toolchain. Distribution of the CLI still resolves through the npm REGISTRY
 * (`bunx 9router`, `bun add -g 9router`), which is a package source, not a
 * package manager, so it is allowed and documented.
 *
 * Deliberately NOT checked: `node:` module specifiers, NODE_ENV, Next.js
 * `runtime = "nodejs"` route segments, dependency names containing "node",
 * upstream protocol-emulation strings, and historical text.
 */
describe("Bun-only guard", () => {
  const report = scanRepo(REPO_ROOT);

  it("ships no npm/yarn/pnpm lockfile", () => {
    expect(report.lockfiles, `Lockfiles found:\n  ${report.lockfiles.join("\n  ")}`).toEqual([]);
  });

  it("has no node shebang", () => {
    expect(report.nodeShebang, `Node shebangs:\n  ${report.nodeShebang.join("\n  ")}`).toEqual([]);
  });

  it("uses no actions/setup-node in workflows", () => {
    expect(report.setupNode, `setup-node in:\n  ${report.setupNode.join("\n  ")}`).toEqual([]);
  });

  it("declares no engines.node in any package.json", () => {
    expect(report.enginesNode, `engines.node in:\n  ${report.enginesNode.join("\n  ")}`).toEqual([]);
  });

  it("runs no npm/npx/yarn/pnpm commands outside the allowlist", () => {
    expect(report.npmCommands, `Package-manager commands:\n  ${report.npmCommands.join("\n  ")}`).toEqual([]);
  });

  it("uses no node as an interpreter outside the allowlist", () => {
    expect(
      report.nodeInterpreter,
      `node interpreter calls:\n  ${report.nodeInterpreter.join("\n  ")}`
    ).toEqual([]);
  });

  it("keeps the allowlist minimal: every entry matches something", () => {
    expect(
      report.staleAllowlist,
      `Stale allowlist entries (no longer needed):\n  ${report.staleAllowlist.join("\n  ")}`
    ).toEqual([]);
  });

  it("documents a reason for every allowlist entry", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.match, "allowlist entry without a path").toBeTruthy();
      expect(entry.reason.length, `missing reason for ${entry.match}`).toBeGreaterThan(10);
    }
  });

  it("allowlists only real, tracked paths", () => {
    const files = new Set(listRepoFiles(REPO_ROOT));
    for (const entry of ALLOWLIST) {
      const ok = entry.match.endsWith("/")
        ? [...files].some((f) => f.startsWith(entry.match))
        : files.has(entry.match);
      expect(ok, `allowlist path not tracked: ${entry.match}`).toBe(true);
    }
  });

  it("detects each forbidden pattern when it does appear", () => {
    // Pattern-level mutation checks: the rules must fire, not just stay quiet.
    expect(LOCKFILE_NAMES.has("package-lock.json")).toBe(true);
    expect(LOCKFILE_NAMES.has("yarn.lock")).toBe(true);
    expect(NODE_SHEBANG.test("#!/usr/bin/env node")).toBe(true);
    expect(NODE_SHEBANG.test("#!/usr/bin/node")).toBe(true);
    expect(NODE_SHEBANG.test("#!/usr/bin/env bun")).toBe(false);
    expect(PKG_COMMAND.test("npm install")).toBe(true);
    expect(PKG_COMMAND.test("  npx vitest run")).toBe(true);
    expect(PKG_COMMAND.test("yarn add left-pad")).toBe(true);
    expect(PKG_COMMAND.test("pnpm -g install x")).toBe(true);
    expect(PKG_COMMAND.test("bun install")).toBe(false);
    expect(PKG_COMMAND.test("the npm registry")).toBe(false);
    expect(NODE_INTERPRETER.test("node scripts/build.js")).toBe(true);
    expect(NODE_INTERPRETER.test("node -e 'x'")).toBe(true);
    expect(NODE_INTERPRETER.test("bun scripts/build.js")).toBe(false);
    expect(NODE_INTERPRETER.test("node:fs")).toBe(false);
  });

  it("scanRepo reports violations from a synthetic tree", () => {
    // End-to-end mutation check without touching the real worktree.
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "bun-guard-"));
    try {
      fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "pkg"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
      fs.writeFileSync(path.join(tmp, "yarn.lock"), "");
      fs.writeFileSync(path.join(tmp, "pkg/package.json"), '{"engines":{"node":">=18"}}');
      fs.writeFileSync(path.join(tmp, ".github/workflows/ci.yml"), "uses: actions/setup-node@v4\n");
      fs.writeFileSync(path.join(tmp, "script.sh"), "#!/usr/bin/env node\nnpm install foo\n");
      fs.writeFileSync(path.join(tmp, "run.mjs"), "// node run.mjs\n");
      const r = scanRepo(tmp);
      expect(r.lockfiles.sort()).toEqual(["package-lock.json", "yarn.lock"]);
      expect(r.enginesNode).toEqual(["pkg/package.json"]);
      expect(r.setupNode).toEqual([".github/workflows/ci.yml"]);
      expect(r.nodeShebang).toEqual(["script.sh"]);
      expect(r.npmCommands.some((l) => l.includes("script.sh:2"))).toBe(true);
      expect(r.nodeInterpreter.some((l) => l.includes("run.mjs:1"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

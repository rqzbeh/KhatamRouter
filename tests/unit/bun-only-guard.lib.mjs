// Pure checker for the Bun-only repository policy.
// Used by tests/unit/bun-only-guard.test.js and by out-of-tree mutation checks.
// Reads tracked files only (git ls-files, filesystem walk fallback).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", ".worktrees", ".claude"]);

export const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export const NODE_SHEBANG = /^#!\s*(\/usr\/bin\/env\s+node|\/usr\/bin\/node)(\s|$)/;

// npm/yarn/pnpm subcommands. Deliberately a closed list: an open `[a-z-]+` tail
// matches prose ("npm registry", "npm package") and produces noise, not signal.
const PKG_VERBS =
  "install|i|ci|add|remove|rm|uninstall|un|update|up|run|run-script|start|test|publish|pack|exec|view|info|init|outdated|audit|rebuild|link|login|config|cache|prefix|-g|--global|--prefix";
export const PKG_COMMAND = new RegExp(
  "(^|[\\s`$(&|;])(npm|yarn|pnpm)\\s+(" + PKG_VERBS + ")(?=\\s|$)" +
    "|(^|[\\s`$(&|;])npx\\s+\\S"
);

// `node` used as an interpreter: node -e/-p/--flag, node <file>.js|cjs|mjs|ts|sh, node ./path.
export const NODE_INTERPRETER = /(^|[\s`$(&|;"'])node\s+(-[-a-zA-Z]|[\w@./-]+\.(?:m?js|cjs|ts|sh)\b|\.{1,2}\/)/;

/**
 * Allowlist for npm-command and node-interpreter hits. Each entry needs a reason.
 * `match` is an exact repo-relative path, or a prefix when it ends with "/".
 */
export const ALLOWLIST = [
  { match: "CHANGELOG.md", reason: "historical release notes; describe past releases verbatim" },
  { match: "specs/", reason: "historical Spec-Kit artifacts, frozen as written" },
  { match: ".unlazy/", reason: "historical gate ledgers, frozen as written" },
  { match: "docs/UPSTREAM-PORTS.md", reason: "historical upstream port log" },
  { match: "docs/superpowers/plans/", reason: "historical plan docs, frozen as written" },
  { match: "docs/superpowers/specs/", reason: "historical design specs, frozen as written" },
  { match: "tests/unit/bun-only-guard.test.js", reason: "this guard; quotes the forbidden patterns" },
  { match: "tests/unit/bun-only-guard.lib.mjs", reason: "this guard's pattern definitions" },
  { match: "cli/scripts/buildMitm.js", reason: "comment explaining why a Windows file lock matters; historical npm i -g wording" },
  { match: "tests/unit/dashboard-display-branding.test.js", reason: "negative assertion that npx 9router is NOT shipped" },
  { match: "tests/__baseline__/baseline-results.json", reason: "generated test-run snapshot; contains recorded test titles" },
  { match: "tests/__baseline__/current.json", reason: "generated test-run snapshot; contains recorded test titles" },
  { match: "tests/unit/buildOutputFilter.test.js", reason: "npm install output fixtures for the RTK build-output filter (input data)" },
  { match: "tests/unit/buildOutputFilterAdversarial.test.js", reason: "npm install output fixtures for the RTK build-output filter (input data)" },
  { match: "tests/unit/rtkKiro.test.js", reason: "npm install output fixtures for the RTK build-output filter (input data)" },
  { match: "tests/unit/cli-branding.test.js", reason: "negative assertion that npm i -g is NOT recommended" },
  { match: "tests/unit/update-check-and-updater.test.js", reason: "negative assertion that npm i -g 9router is NOT shipped" },
];

function walkDirectory(currentDir, rootDir) {
  const results = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) results.push(...walkDirectory(full, rootDir));
    else if (entry.isFile()) results.push(path.relative(rootDir, full).replace(/\\/g, "/"));
  }
  return results;
}

export function listRepoFiles(rootDir) {
  try {
    return execSync("git ls-files --cached --others --exclude-standard", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return walkDirectory(rootDir, rootDir);
  }
}

function isAllowlisted(rel, used) {
  for (const entry of ALLOWLIST) {
    const hit = entry.match.endsWith("/") ? rel.startsWith(entry.match) : rel === entry.match;
    if (hit) {
      used.add(entry.match);
      return true;
    }
  }
  return false;
}

/**
 * Scan a repo and return violations per rule. Every array must be empty for a
 * Bun-only tree. `staleAllowlist` lists allowlist entries that matched nothing,
 * so the allowlist cannot silently grow past what the tree needs.
 */
export function scanRepo(rootDir) {
  const report = {
    lockfiles: [],
    nodeShebang: [],
    setupNode: [],
    enginesNode: [],
    npmCommands: [],
    nodeInterpreter: [],
    staleAllowlist: [],
  };
  const used = new Set();

  for (const rel of listRepoFiles(rootDir)) {
    const abs = path.join(rootDir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // in the index but deleted from the worktree
    }
    if (!stat.isFile()) continue;

    const base = path.basename(rel);
    if (LOCKFILE_NAMES.has(base)) report.lockfiles.push(rel);

    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const text = buf.toString("utf8");

    const firstLine = text.split("\n", 1)[0].replace(/\r$/, "");
    if (NODE_SHEBANG.test(firstLine)) report.nodeShebang.push(rel);

    if (rel.startsWith(".github/workflows/") && /\.ya?ml$/.test(rel) && /actions\/setup-node/.test(text)) {
      report.setupNode.push(rel);
    }

    if (base === "package.json") {
      try {
        const pkg = JSON.parse(text);
        if (pkg && pkg.engines && Object.prototype.hasOwnProperty.call(pkg.engines, "node")) {
          report.enginesNode.push(rel);
        }
      } catch (err) {
        report.enginesNode.push(`${rel}: invalid JSON (${err.message})`);
      }
    }

    if (isAllowlisted(rel, used)) continue;

    text.split("\n").forEach((line, i) => {
      const snippet = `${rel}:${i + 1}: ${line.trim().slice(0, 160)}`;
      if (PKG_COMMAND.test(line)) report.npmCommands.push(snippet);
      if (NODE_INTERPRETER.test(line)) report.nodeInterpreter.push(snippet);
    });
  }

  report.staleAllowlist = ALLOWLIST.filter((e) => !used.has(e.match)).map((e) => e.match);
  return report;
}

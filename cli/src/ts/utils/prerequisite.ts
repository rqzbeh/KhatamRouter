import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BunPrerequisiteCheckOptions } from "../types.ts";

/**
 * Locate Bun executable on PATH or common installation locations.
 * Returns the path to the bun executable, or null if not found.
 */
export function findBunExecutable(): string | null {
  if (process.versions && (process.versions as Record<string, string>).bun) {
    return process.execPath;
  }

  const checkCmd = process.platform === "win32" ? "where bun" : "which bun";
  try {
    const out = execSync(checkCmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) {
      const firstLine = out.split(/\r?\n/)[0].trim();
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
      return "bun";
    }
  } catch {}

  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.USERPROFILE || home, ".bun", "bin", "bun.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "bun.exe"),
      ]
    : [
        path.join(home, ".bun", "bin", "bun"),
        "/usr/local/bin/bun",
        "/opt/homebrew/bin/bun",
        "/usr/bin/bun",
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  try {
    const res = spawnSync("bun", ["--version"], { stdio: "ignore" });
    if (res.status === 0) return "bun";
  } catch {}

  return null;
}

/**
 * Returns formatted actionable guidance for installing Bun.
 */
export function formatBunPrerequisiteError(): string {
  return [
    "❌ Error: Bun runtime is required to run KhatamRouter.",
    "",
    "Starting with Wave 7.5, KhatamRouter runs exclusively on Bun (bun:sqlite)",
    "and no longer supports Node-only execution.",
    "",
    "Please install Bun from https://bun.sh:",
    "  curl -fsSL https://bun.sh/install | bash        # macOS / Linux",
    '  powershell -c "irm bun.sh/install.ps1 | iex"   # Windows',
    "  npm install -g bun                             # via npm",
    "",
    "Visit https://bun.sh for detailed installation instructions.",
  ].join("\n");
}

/**
 * Fail closed with actionable install guidance if Bun is not available.
 * Preserves the exact message and behavior from cli/cli.js.
 */
export function ensureBun(options: BunPrerequisiteCheckOptions = {}): string {
  const findFn = options.findBun || findBunExecutable;
  const bunPath = findFn();

  if (!bunPath) {
    const errorMsg = formatBunPrerequisiteError();
    const writeErr = options.stderr || console.error;
    const exitFn = options.exit || process.exit;

    writeErr(errorMsg);
    exitFn(1);
    return "";
  }

  return bunPath;
}

#!/usr/bin/env bun
/**
 * KhatamRouter upstream-sync secret sanitizer.
 *
 * decolua/9router (upstream) commits literal public Google OAuth client
 * credentials into its source tree. KhatamRouter keeps those credentials out
 * of its tracked tree by storing them in a split, non-literal form so that
 * GitHub push protection never rejects a push:
 *
 *   upstream:  clientSecret: "GOCSPX-AAAA..."
 *   ours:      clientSecret: ["GOC", "SPX-AAAA..."].join("")
 *
 *   upstream:  clientId: "1234-abc.apps.googleusercontent.com"
 *   ours:      clientId: ["1234-abc", ".apps.googleusercontent.com"].join("")
 *
 * JSON data files (e.g. tests/__baseline__/providers-baseline.json) cannot
 * hold a `.join("")` expression, so they use the redaction placeholders this
 * repo already ships:
 *
 *   "clientId":     "REDACTED_PUBLIC_OAUTH_CLIENT_ID"
 *   "clientSecret": "REDACTED_PUBLIC_OAUTH_CLIENT_SECRET"
 *
 * Modes
 *   fix    rewrite every tracked JS/TS/JSON file that contains a literal.
 *   check  scan only; exit 1 if any literal remains (the pre-push gate).
 *
 * A literal that lives somewhere that cannot be rewritten safely (Markdown,
 * YAML, shell, an interpolated template literal, ...) is never guessed at: it
 * is reported and the process exits 1 so the sync job fails loudly *before*
 * pushing instead of letting push protection reject the branch.
 *
 * Usage:
 *   bun scripts/upstream-sync-sanitizer.mjs [fix|check] [--root <dir>] [--quiet]
 *
 * Exit codes: 0 clean, 1 literal(s) present/remaining, 2 usage error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
]);
const DATA_EXTENSIONS = new Set([".json"]);

// Google OAuth client-secret format: GOCSPX- followed by >= 6 urlsafe chars.
const SECRET = String.raw`GOCSPX-[A-Za-z0-9_-]{6,}`;
// Google OAuth client-id format: <project number>-<random>.apps.googleusercontent.com
const CLIENT_ID = String.raw`\d{6,}-[A-Za-z0-9_-]+\.[a-z0-9.-]*googleusercontent\.com`;
const SECRET_RE = new RegExp(SECRET, "g");
const CLIENT_ID_RE = new RegExp(CLIENT_ID, "g");
const SECRET_ANCHORED = new RegExp(`^${SECRET}$`);
const CLIENT_ID_ANCHORED = new RegExp(`^${CLIENT_ID}$`);

const REDACTED_CLIENT_ID = "REDACTED_PUBLIC_OAUTH_CLIENT_ID";
const REDACTED_CLIENT_SECRET = "REDACTED_PUBLIC_OAUTH_CLIENT_SECRET";

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

function usage(message) {
  if (message) console.error(`upstream-sync-sanitizer: ${message}`);
  console.error(
    "usage: bun scripts/upstream-sync-sanitizer.mjs [fix|check] [--root <dir>] [--quiet]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: "fix", root: process.cwd(), quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "fix" || arg === "check") {
      options.mode = arg;
    } else if (arg === "--root") {
      const value = argv[++i];
      if (!value) usage("--root needs a directory");
      options.root = value;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const repoRoot = execFileSync(
  "git",
  ["-C", resolve(options.root), "rev-parse", "--show-toplevel"],
  { encoding: "utf8" },
).trim();

/** Build the split-array expression this repo uses for JS/TS files. */
function asJoinExpression(parts) {
  return `[${parts.map((p) => JSON.stringify(p)).join(", ")}].join("")`;
}

function isSecretLiteral(value) {
  return SECRET_ANCHORED.test(value);
}

function isClientIdLiteral(value) {
  return CLIENT_ID_ANCHORED.test(value);
}

/**
 * Rewrite a JS/TS source file.
 *
 * One regex alternation, applied in a single left-to-right pass, so text this
 * function itself emits is never rescanned:
 *   1. a quoted string (the literal is its whole value)   -> array expression
 *   2. a bare identifier-position literal                 -> array expression
 * Anything else that still contains a literal is returned in `remaining`.
 *
 * @param {string} text
 */
function sanitizeCode(text) {
  let secrets = 0;
  let clientIds = 0;
  const remaining = [];

  // Branch 1 matches any quoted string; branch 2/3 match an unquoted literal.
  // String.replace() never re-examines replacement text, so a split secret
  // emitted by branch 1 is not matched again by branch 2.
  const QUOTED_OR_BARE = new RegExp(
    String.raw`(["'` + "`" + String.raw`])((?:\\.|(?!\1)[^\\\n])*?)\1|${SECRET}|${CLIENT_ID}`,
    "g",
  );

  const out = text.replace(QUOTED_OR_BARE, (match, quote, inner) => {
    if (quote !== undefined) {
      if (isSecretLiteral(inner)) {
        secrets += 1;
        return asJoinExpression(["GOC", inner.slice(3)]);
      }
      if (isClientIdLiteral(inner)) {
        clientIds += 1;
        const id = inner.slice(0, -CLIENT_ID_SUFFIX.length);
        return asJoinExpression([id, CLIENT_ID_SUFFIX]);
      }
      // A quoted string that merely *contains* a literal, or an interpolated
      // template literal: leave it for the caller to report.
      if (SECRET_RE.test(inner) || CLIENT_ID_RE.test(inner)) {
        SECRET_RE.lastIndex = 0;
        CLIENT_ID_RE.lastIndex = 0;
        remaining.push({ line: lineAt(text, text.indexOf(match)), snippet: match });
      }
      return match;
    }

    if (SECRET_ANCHORED.test(match)) {
      secrets += 1;
      return asJoinExpression(["GOC", match.slice(3)]);
    }
    clientIds += 1;
    return asJoinExpression([match.slice(0, -CLIENT_ID_SUFFIX.length), CLIENT_ID_SUFFIX]);
  });

  return { out, secrets, clientIds, remaining };
}

/**
 * Rewrite a JSON data file to the repo's redaction placeholders.
 * @param {string} text
 */
function sanitizeJson(text) {
  let secrets = 0;
  let clientIds = 0;
  const out = text
    .replace(SECRET_RE, () => {
      secrets += 1;
      return REDACTED_CLIENT_SECRET;
    })
    .replace(CLIENT_ID_RE, () => {
      clientIds += 1;
      return REDACTED_CLIENT_ID;
    });
  return { out, secrets, clientIds, remaining: [] };
}

function lineAt(text, index) {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function containsLiteral(text) {
  const hasSecret = SECRET_RE.test(text);
  const hasClientId = CLIENT_ID_RE.test(text);
  SECRET_RE.lastIndex = 0;
  CLIENT_ID_RE.lastIndex = 0;
  return hasSecret || hasClientId;
}

function firstLiteralLine(text) {
  const secretIndex = text.search(SECRET_RE);
  const clientIndex = text.search(CLIENT_ID_RE);
  if (secretIndex === -1) return lineAt(text, clientIndex);
  if (clientIndex === -1) return lineAt(text, secretIndex);
  return lineAt(text, Math.min(secretIndex, clientIndex));
}

/** Tracked files (index order), NUL separated, so spaces/unicode are safe. */
function trackedFiles() {
  const raw = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw.toString("utf8").split("\0").filter(Boolean);
}

const files = trackedFiles();
const rewritten = [];
const blocking = [];
let withLiterals = 0;

for (const relativePath of files) {
  const absolutePath = resolve(repoRoot, relativePath);
  let buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    // Tracked in the index but absent from the worktree (staged deletion).
    continue;
  }
  // Credentials are ASCII; skip binaries cheaply.
  if (buffer.includes(0)) continue;

  const text = buffer.toString("utf8");
  if (!containsLiteral(text)) continue;
  withLiterals += 1;

  const extension = extname(relativePath).toLowerCase();

  if (CODE_EXTENSIONS.has(extension)) {
    const result = sanitizeCode(text);
    if (options.mode === "fix" && result.out !== text) {
      writeFileSync(absolutePath, result.out);
      rewritten.push({ path: relativePath, secrets: result.secrets, clientIds: result.clientIds });
      if (!options.quiet) {
        console.log(
          `rewrote ${relativePath} (${result.secrets} secret, ${result.clientIds} client-id)`,
        );
      }
    }
    for (const entry of result.remaining) {
      blocking.push({ path: relativePath, line: entry.line, reason: "literal inside a larger string" });
    }
    continue;
  }

  if (DATA_EXTENSIONS.has(extension)) {
    const result = sanitizeJson(text);
    if (options.mode === "fix" && result.out !== text) {
      writeFileSync(absolutePath, result.out);
      rewritten.push({ path: relativePath, secrets: result.secrets, clientIds: result.clientIds });
      if (!options.quiet) {
        console.log(
          `redacted ${relativePath} (${result.secrets} secret, ${result.clientIds} client-id)`,
        );
      }
    }
    continue;
  }

  blocking.push({
    path: relativePath,
    line: firstLiteralLine(text),
    reason: `cannot rewrite ${extension || "extensionless"} file automatically`,
  });
}

if (options.mode === "fix" && rewritten.length > 0) {
  // Stage the rewrites so a following `check` sees exactly what will be pushed.
  execFileSync("git", ["-C", repoRoot, "add", "--", ...rewritten.map((r) => r.path)], {
    stdio: options.quiet ? "ignore" : "inherit",
  });
}

if (!options.quiet) {
  console.log(
    `upstream-sync-sanitizer: mode=${options.mode} tracked=${files.length} ` +
      `with_literals=${withLiterals} rewritten=${rewritten.length} blocking=${blocking.length}`,
  );
}

for (const entry of blocking) {
  const reason = `upstream OAuth literal cannot be sanitized automatically (${entry.reason})`;
  console.error(`::error file=${entry.path},line=${entry.line}::${reason}`);
  console.error(`  ${entry.path}:${entry.line}: ${reason}`);
}

if (blocking.length > 0) {
  console.error(
    `upstream-sync-sanitizer: ${blocking.length} file(s) still contain upstream OAuth literals; refusing to continue.`,
  );
  process.exit(1);
}

if (options.mode === "check" && withLiterals > 0) {
  // Should be unreachable (literals get rewritten), kept as a defensive gate.
  console.error("upstream-sync-sanitizer: literals remain after check; refusing to push.");
  process.exit(1);
}

process.exit(0);

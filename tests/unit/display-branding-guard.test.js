import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as parser from "@babel/parser";

const REPO_ROOT = path.resolve(__dirname, "../../");

/**
 * ALLOWLIST for functional identifiers and upstream attribution that MUST be preserved.
 * Every entry is justified by the project contract and architectural requirements:
 *
 * 1. fs-paths:
 *    User directories ~/.9router and %APPDATA%/9router, backup extensions *.bak-9router,
 *    temp directories, and install directory path checks.
 *
 * 2. provider-keys:
 *    Upstream provider keys (e.g. model_providers.9router, providers["9router"], [model.9router...]),
 *    model prefixes ("9router/..."), and internal markers (__9router_unset__, # 9router-prev-...).
 *
 * 3. droid-custom-models:
 *    Factory Droid custom model IDs require "custom:9Router" prefix by tool protocol convention.
 *
 * 4. placeholders-and-urns:
 *    API key placeholder "sk_9router", "sk_9router (default)", and SAML SP URN "urn:9router:sp".
 *
 * 5. env-and-flags:
 *    Environment variable names NINE_ROUTER_* and JCODE_9ROUTER_API_KEY, and the CLI flag
 *    "jcode --provider-profile 9router".
 *
 * 6. external-attribution:
 *    VS Code Marketplace extension URL and name "hotrungnhan.9router-for-github-copilot",
 *    upstream repository links "decolua/9router", and third-party command names.
 *
 * 7. mitm-ca-and-certs:
 *    Installed system root CA certificate name "9Router MITM Root CA" and password keychain key.
 *
 * 8. skill-ids:
 *    Built-in skill identifiers (e.g. 9router-chat, 9router-image, 9router-tts, etc.).
 *
 * 9. internal-identifiers:
 *    Internal protocol headers (x-9router-connection-id), internal client identifiers,
 *    autostart plist domain (com.9router.autostart), and local storage preset keys.
 *
 * 10. user-agent:
 *     HTTP User-Agent header "9Router" for upstream proxy compatibility checks.
 *
 * 11. config-templates:
 *     Raw TOML/YAML config templates rendered in tool cards showing functional config syntax,
 *     and config file header marker comments checked by has9RouterConfig.
 *
 * 12. cli-internals:
 *     CLI build scripts, hook log prefixes "[9router]", and runtime directory names.
 *
 * 13. cli-tools-explanations:
 *     Help strings explicitly referring to functional provider keys (e.g. [model.9router]).
 *
 * 14. functional-code-identifiers:
 *     Code identifiers (functions, properties) like has9Router, has9RouterConfig, etc.
 */
export const ALLOWLIST = [
  // 1. Filesystem paths & directories
  {
    id: "fs-paths",
    justification: "System directories, data paths, backup extensions, log files, and install dir matching",
    pattern: /(?:^|[/\\])\.9router\b|%APPDATA%[/\\]9router\b|\b9router[/\\]db\b|\.bak-9router\b|\.9router\.(?:new|bak)\b|provider-9router\.env\b|\/9router-root-ca\.crt\b|^\/tmp\/\(9router\||[/\\]9router$|\/tmp\/9router(?:\.error)?\.log/,
  },

  // 2. Functional provider keys, model prefixes, config sections
  {
    id: "provider-keys",
    justification: "OpenAI-compatible and client tool functional provider key '9router'",
    pattern: /^9router\/?$|^model_providers\.9router$|\[(?:model_providers|providers|model)\.9router|\\?\^?# 9router-prev-|^__9router_unset__$/,
  },

  // 3. Factory Droid custom model IDs
  {
    id: "droid-custom-models",
    justification: "Factory Droid requires custom:9Router prefix for custom model routing",
    pattern: /^custom:9Router(?:-\d+)?-?$/,
  },

  // 4. Placeholder API keys & SAML URNs
  {
    id: "placeholders-and-urns",
    justification: "Contract placeholders and standard SAML SP metadata URN",
    pattern: /^sk_9router(?: \(default\))?$|^urn:9router:sp$/,
  },

  // 5. Environment variables and CLI profile flags
  {
    id: "env-and-flags",
    justification: "Backward-compatible environment variable names and CLI profile arguments",
    pattern: /NINE_ROUTER_[A-Z0-9_]+|JCODE_9ROUTER_API_KEY|--provider-profile 9router/,
  },

  // 6. External marketplace extension and upstream repo links
  {
    id: "external-attribution",
    justification: "VS Code marketplace link, extension name, and upstream GitHub repo references",
    pattern: /hotrungnhan\.9router-for-github-copilot|decolua\/9router|9router-for-github-copilot|9Router for Github Copilot|9Router: Configure Server/i,
  },

  // 7. Internal system certs, MITM CA names, and keychain commands
  {
    id: "mitm-ca",
    justification: "Root CA certificate name and system trust store keychain identifiers",
    pattern: /9Router MITM Root CA|9router-mitm-pwd/,
  },

  // 8. Skill IDs
  {
    id: "skill-ids",
    justification: "Functional skill IDs registered in skill catalog",
    pattern: /^9router(?:-(?:chat|image|tts|stt|embeddings|web-search|web-fetch))?$/,
  },

  // 9. Internal protocol headers, connection IDs, internal client names, bridges, storage keys
  {
    id: "internal-identifiers",
    justification: "Internal protocol headers, socket bridges, autostart identifiers, and preset keys",
    pattern: /^x-9router-|^grok-cli\/9router$|^9router-xmd-|^9router-pxpipe-host$|^9router-relay$|^__9router|com\.9router\.autostart|^9router\.(?:cliTool|api)|^9router:|_9router|9router bridge/,
  },

  // 10. HTTP User-Agent header
  {
    id: "user-agent",
    justification: "User-Agent string for proxy reachability testing",
    pattern: /^9Router$/,
  },

  // 11. Tool card config templates & markers
  {
    id: "config-templates",
    justification: "Templates demonstrating functional config syntax to users and config detection headers",
    pattern: /model_provider\s*=\s*"9router"|\[model_providers\.9router\]|\[providers\.9router\]|providers:\s*\\n\s*9router:|# CodeWhale config — managed by 9Router|# Forge config — managed by 9Router|managed by 9Router|# 9Router Configuration for Codex CLI|name\s*=\s*"9Router"|name\s*=\s*\\?"9Router|description\s*=\s*"Routed via 9Router gateway"|Routed via 9Router gateway/,
  },

  // 12. CLI scripts & hooks logs / package alias
  {
    id: "cli-internals",
    justification: "CLI build scripts, hook logs, and runtime package description",
    pattern: /^\[9router\]|^9router-runtime$|User-writable runtime deps for 9router|Building 9Router CLI package/,
  },

  // 13. Explanatory doc text describing functional config keys in cliTools.js and toast messages
  {
    id: "cli-tools-explanations",
    justification: "Help text and toast messages explaining functional config keys to users",
    pattern: /\[model\.9router\]|\/model 9router|providers\.9router|under the "9router" provider/,
  },

  // 14. Functional code identifiers (functions, property names)
  {
    id: "functional-code-identifiers",
    justification: "Preserved functional code identifiers like has9Router, is9RouterStt, etc.",
    pattern: /^(?:has9Router(?:Config|Stt|InYml)?|is9RouterStt|upsertStt9Router|removeStt9Router|build9RouterConfig|get9RouterEntry|stt9Router)$/,
  },

];

export function isAllowlisted(val, relPath = "") {
  for (const entry of ALLOWLIST) {
    if (entry.files && !entry.files.test(relPath.replace(/\\/g, "/"))) continue;
    if (entry.pattern.test(val)) return true;
  }
  return false;
}

export function collectSourceFiles(rootDir) {
  const dirs = ["src", "cli"];
  const out = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "tests" ||
          entry.name === "i18n" ||
          entry.name === "public" ||
          entry.name === ".next" ||
          entry.name === "dist"
        ) {
          continue;
        }
        walk(full);
      } else if (/\.(m?[jt]sx?)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }

  for (const d of dirs) {
    const fullDir = path.join(rootDir, d);
    if (fs.existsSync(fullDir)) walk(fullDir);
  }
  return out;
}

export function scanFile(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
  const violations = [];

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["jsx", "typescript"],
    });
  } catch (err) {
    throw new Error(`Failed to parse ${relPath}: ${err.message}`);
  }

  function check(val, node) {
    if (typeof val !== "string") return;
    const trimmed = val.trim();
    if (/9\s?router/i.test(trimmed)) {
      if (!isAllowlisted(trimmed, relPath)) {
        violations.push({
          file: relPath,
          line: node.loc ? node.loc.start.line : 0,
          value: trimmed,
        });
      }
    }
  }

  function traverse(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "StringLiteral" || node.type === "Literal") {
      check(node.value, node);
    } else if (node.type === "JSXText") {
      check(node.value, node);
    } else if (node.type === "TemplateElement") {
      check(node.value && node.value.raw, node);
    } else if (node.type === "Identifier") {
      // Check identifier names against allowlist
      if (/9\s?router/i.test(node.name) && !isAllowlisted(node.name, relPath)) {
        violations.push({
          file: relPath,
          line: node.loc ? node.loc.start.line : 0,
          value: node.name,
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "comments" ||
        key === "leadingComments" ||
        key === "trailingComments"
      ) {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) traverse(c);
      } else if (child && typeof child === "object") {
        traverse(child);
      }
    }
  }

  traverse(ast);
  return violations;
}

describe("Display Branding Guard", () => {
  it("runs in under 10 seconds and verifies no unallowlisted 9router display strings exist", () => {
    const start = Date.now();
    const files = collectSourceFiles(REPO_ROOT);
    const allViolations = [];

    for (const file of files) {
      const fileViolations = scanFile(file);
      allViolations.push(...fileViolations);
    }

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(10000);

    if (allViolations.length > 0) {
      const summary = allViolations
        .map((v) => `  ${v.file}:${v.line} -> ${JSON.stringify(v.value.slice(0, 80))}`)
        .join("\n");
      expect.fail(
        `Found ${allViolations.length} unallowlisted 9Router branding occurrence(s):\n${summary}`
      );
    }
  });

  it("does not allowlist the legacy 'Welcome to 9Router' docs title anywhere", () => {
    expect(isAllowlisted("Welcome to 9Router", "src/test_mutation.js")).toBe(false);
    expect(isAllowlisted("Welcome to 9Router", "src/app/page.js")).toBe(false);
    expect(isAllowlisted("Welcome to 9Router", "")).toBe(false);
  });

  it("scanFile flags a planted 'Welcome to 9Router' outside the allowed file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-guard-"));
    try {
      const planted = path.join(dir, "planted.js");
      fs.writeFileSync(planted, 'export const hello = "Welcome to 9Router";\n');
      const found = scanFile(planted);
      expect(found.length).toBe(1);
      expect(found[0].value).toBe("Welcome to 9Router");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../");
const targetDirs = ["idempotency", "auth", "usage", "resilience"];

function collectProductionFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".git", ".next", ".claude", "tests", "dist"].includes(entry.name)) {
        collectProductionFiles(full, files);
      }
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
      files.push(full);
    }
  }
  return files;
}

describe("US7 Scenario 13: Production Wiring Audit (G12)", () => {
  const prodFiles = [
    ...collectProductionFiles(path.join(root, "src")),
    ...collectProductionFiles(path.join(root, "open-sse")),
  ];

  it("ensures src/lib/idempotency/index.js is imported in the real chat request path", () => {
    const chatHandlerPath = path.join(root, "src/sse/handlers/chat.js");
    const content = fs.readFileSync(chatHandlerPath, "utf8");
    expect(content).toContain("idempotency");
    expect(content).toMatch(/handleIdempotencyPreRequest|handleIdempotencyPostRequest/);
  });

  // Stronger than "is the module name mentioned somewhere": every MODULE in these
  // subsystems must have at least one exported function with a call site outside the
  // module itself. Internal helpers and test-only exports are fine as long as the module
  // as a whole is reachable from production. This is the check that would have caught
  // the advisory auth cache and the usage fan-out being implemented but never called.
  it("every target module is reachable from production code", () => {
    const dead = [];
    for (const dirName of targetDirs) {
      const dirPath = path.join(root, "src/lib", dirName);
      if (!fs.existsSync(dirPath)) continue;
      for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith(".js"))) {
        const filePath = path.join(dirPath, file);
        const src = fs.readFileSync(filePath, "utf8");
        const names = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
        if (names.length === 0) continue;
        const reachable = prodFiles.some((pf) => {
          if (pf === filePath) return false;
          // Strip import/export statements first: importing a symbol proves nothing about
          // whether it is USED. Only a reference in real code counts (a call, or a shared
          // singleton read as a value). Verified with a negative control: deleting the only
          // call site must make this test fail.
          const c = fs
            .readFileSync(pf, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(import|export)\b[^;(]*\bfrom\b/.test(line))
            .join("\n");
          return names.some((n) => new RegExp(`\\b${n}\\b`).test(c));
        });
        if (!reachable) dead.push(`${dirName}/${file}`);
      }
    }
    expect(dead, `modules with no external call site: ${dead.join(", ")}`).toEqual([]);
  });

  // Per-module liveness is too coarse for this: apiKeyCache.js is reachable through
  // evictCachedApiKey (used on revoke), yet its READ path (authenticateApiKey) was dead,
  // so the cache was never populated on live traffic. Assert the specific entry points
  // that the full-stack smoke proved were missing. Each must be CALLED, not merely imported.
  const REQUIRED_CALLS = [
    ["src/lib/auth/apiKeyCache.js", "authenticateApiKey"],
    ["src/lib/usage/usageFanout.js", "fanoutUsageEvent"],
    ["src/lib/idempotency/index.js", "handleIdempotencyPreRequest"],
    ["src/lib/resilience/redisSemaphore.js", "globalRedisSemaphore"],
  ];
  for (const [modulePath, symbol] of REQUIRED_CALLS) {
    it(`${symbol} has a live call site outside its module`, () => {
      const abs = path.join(root, modulePath);
      const callers = prodFiles.filter((pf) => {
        if (pf === abs) return false;
        const code = fs
          .readFileSync(pf, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(import|export)\b[^;(]*\bfrom\b/.test(line))
          .join("\n");
        return new RegExp(`\\b${symbol}\\b`).test(code);
      });
      expect(callers.length, `${symbol} is exported but never used outside ${modulePath}`).toBeGreaterThan(0);
    });
  }
});

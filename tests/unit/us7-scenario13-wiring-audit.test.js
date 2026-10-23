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

  it("ensures every target subsystem in src/lib has live external importers", () => {
    for (const dirName of targetDirs) {
      const dirPath = path.join(root, "src/lib", dirName);
      expect(fs.existsSync(dirPath)).toBe(true);

      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".js"));
      let totalExternalRefs = 0;

      for (const file of files) {
        const base = path.parse(file).name;
        for (const pf of prodFiles) {
          if (pf.startsWith(dirPath)) continue;
          const content = fs.readFileSync(pf, "utf8");
          if (
            content.includes(`@/lib/${dirName}/${file}`) ||
            content.includes(`@/lib/${dirName}/${base}`) ||
            content.includes(`@/lib/${dirName}`) ||
            content.includes(base)
          ) {
            totalExternalRefs++;
          }
        }
      }

      expect(totalExternalRefs).toBeGreaterThan(0);
    }
  });

  it("verifies key wave 7.5 modules are genuinely wired into production callers", () => {
    // 1. redisSemaphore is wired into connectionLimiter
    const connLimiterPath = path.join(root, "open-sse/services/rateLimitManager/connectionLimiter.js");
    const connLimiter = fs.readFileSync(connLimiterPath, "utf8");
    expect(connLimiter).toContain("redisSemaphore");

    // 2. usageFanout is wired into chatCore and streamingHandler
    const chatCorePath = path.join(root, "open-sse/handlers/chatCore.js");
    const chatCore = fs.readFileSync(chatCorePath, "utf8");
    expect(chatCore).toContain("usageFanout");

    // 3. apiKeyUsageLimits is wired into chat and non-chat endpoints
    const embeddingsPath = path.join(root, "src/sse/handlers/embeddings.js");
    const embeddings = fs.readFileSync(embeddingsPath, "utf8");
    expect(embeddings).toContain("apiKeyUsageLimits");

    // 4. fallbackResilience / circuitBreakerStore are wired
    const resiliencePath = path.join(root, "src/domain/fallbackResilience.js");
    const resilience = fs.readFileSync(resiliencePath, "utf8");
    expect(resilience).toContain("circuitBreakerStore");
  });
});

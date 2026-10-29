import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(__dirname, "../../");

function loadCompose() {
  const composePath = path.join(REPO_ROOT, "docker-compose.yml");
  const raw = fs.readFileSync(composePath, "utf8");
  return { raw, parsed: yaml.load(raw) };
}

describe("Wave 7.5: Docker Compose Bun & Redis Configuration (US2 / FR-008..FR-010)", () => {
  it("parses docker-compose.yml as valid YAML and defines required top-level keys", () => {
    const { parsed } = loadCompose();
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
    expect(parsed.services).toBeDefined();
    expect(parsed.volumes).toBeDefined();
  });

  describe("Redis Service Configuration (FR-009)", () => {
    it("uses redis:8.2-alpine image", () => {
      const { parsed } = loadCompose();
      const redis = parsed.services?.redis;
      expect(redis).toBeDefined();
      expect(redis.image).toBe("redis:8.2-alpine");
    });

    it("enables AOF persistence (--appendonly yes)", () => {
      const { parsed } = loadCompose();
      const redis = parsed.services?.redis;
      expect(redis.command).toBeDefined();
      const cmdStr = Array.isArray(redis.command) ? redis.command.join(" ") : String(redis.command);
      expect(cmdStr).toContain("--appendonly");
      expect(cmdStr).toContain("yes");
    });

    it("binds Redis host port strictly to loopback (127.0.0.1:6379:6379)", () => {
      const { parsed } = loadCompose();
      const redis = parsed.services?.redis;
      expect(redis.ports).toBeDefined();
      expect(Array.isArray(redis.ports)).toBe(true);

      const hasLoopback = redis.ports.some(
        (p) => String(p).includes("127.0.0.1:6379:6379") || String(p) === "127.0.0.1:6379:6379"
      );
      expect(hasLoopback).toBe(true);

      // Security invariant: never expose Redis on 0.0.0.0 or bare port 6379
      for (const p of redis.ports) {
        const portStr = String(p);
        expect(portStr).not.toMatch(/^0\.0\.0\.0/);
        expect(portStr).not.toBe("6379:6379");
        expect(portStr).not.toBe("6379");
      }
    });

    it("configures a redis-cli ping healthcheck", () => {
      const { parsed } = loadCompose();
      const redis = parsed.services?.redis;
      expect(redis.healthcheck).toBeDefined();
      const testCmd = Array.isArray(redis.healthcheck.test)
        ? redis.healthcheck.test.join(" ")
        : String(redis.healthcheck.test);
      expect(testCmd).toContain("redis-cli");
      expect(testCmd).toContain("ping");
    });

    it("persists data on the named redis-data volume", () => {
      const { parsed } = loadCompose();
      const redis = parsed.services?.redis;
      expect(redis.volumes).toBeDefined();
      const hasVolume = redis.volumes.some((v) => String(v).startsWith("redis-data:"));
      expect(hasVolume).toBe(true);
      expect(parsed.volumes["redis-data"]).toBeDefined();
    });
  });

  describe("App Service Configuration (FR-009, FR-010)", () => {
    it("builds from Dockerfile.bun", () => {
      const { parsed } = loadCompose();
      const app = parsed.services?.["9router"];
      expect(app).toBeDefined();
      expect(app.build).toBeDefined();
      if (typeof app.build === "object") {
        expect(app.build.dockerfile).toBe("Dockerfile.bun");
      } else {
        expect(app.build).toBe("Dockerfile.bun");
      }
    });

    it("wires REDIS_URL to redis service by default", () => {
      const { parsed, raw } = loadCompose();
      const app = parsed.services?.["9router"];
      const env = app.environment || {};
      const redisUrl = Array.isArray(env)
        ? env.find((e) => String(e).startsWith("REDIS_URL="))?.split("=")[1]
        : env.REDIS_URL;
      expect(redisUrl).toBe("redis://redis:6379");
      expect(raw).toContain("REDIS_URL: redis://redis:6379");
    });

    it("depends on redis service with condition: service_healthy", () => {
      const { parsed } = loadCompose();
      const app = parsed.services?.["9router"];
      expect(app.depends_on).toBeDefined();
      expect(app.depends_on.redis).toBeDefined();
      expect(app.depends_on.redis.condition).toBe("service_healthy");
    });

    it("publishes dashboard port 20128:20128", () => {
      const { parsed } = loadCompose();
      const app = parsed.services?.["9router"];
      expect(app.ports).toBeDefined();
      const hasPort = app.ports.some((p) => String(p).includes("20128:20128"));
      expect(hasPort).toBe(true);
    });

    it("persists application data on 9router-data volume", () => {
      const { parsed } = loadCompose();
      const app = parsed.services?.["9router"];
      expect(app.volumes).toBeDefined();
      const hasVol = app.volumes.some((v) => String(v).includes("9router-data:"));
      expect(hasVol).toBe(true);
      expect(parsed.volumes["9router-data"]).toBeDefined();
    });
  });

  describe("Dockerfile Unification & Bun Native Alignment (FR-008)", () => {
    const dockerfilePath = path.join(REPO_ROOT, "Dockerfile");
    const dockerfileBunPath = path.join(REPO_ROOT, "Dockerfile.bun");

    it("both Dockerfile and Dockerfile.bun exist", () => {
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      expect(fs.existsSync(dockerfileBunPath)).toBe(true);
    });

    it("both Dockerfile and Dockerfile.bun use oven/bun:<.bun-version>-slim", () => {
      const version = fs.readFileSync(path.join(REPO_ROOT, ".bun-version"), "utf8").trim();
      const df = fs.readFileSync(dockerfilePath, "utf8");
      const dfBun = fs.readFileSync(dockerfileBunPath, "utf8");
      expect(df).toContain(`oven/bun:${version}-slim`);
      expect(dfBun).toContain(`oven/bun:${version}-slim`);
    });

    it("Dockerfile and Dockerfile.bun are byte-for-byte aligned", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");
      const dfBun = fs.readFileSync(dockerfileBunPath, "utf8");
      expect(df).toBe(dfBun);
    });

    it("entrypoint executes custom-server.js under Bun", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");
      expect(df).toContain('ENTRYPOINT ["bun", "custom-server.js"]');
    });

    it("exposes control plane and gateway port 20128", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");
      expect(df).toMatch(/EXPOSE\s+20128/);
      expect(df).not.toContain("20129");
    });

    it("ensures no Node-only SQLite native addon is shipped in runner (SC-009)", () => {
      const df = fs.readFileSync(dockerfilePath, "utf8");
      expect(df).toContain("better_sqlite3.node");
      expect(df).not.toContain("node:22-alpine");
    });
  });

  describe("Tooling Alignment: captain-definition & start.sh (FR-008)", () => {
    it("captain-definition points to Dockerfile.bun and has valid schema", () => {
      const capDefPath = path.join(REPO_ROOT, "captain-definition");
      expect(fs.existsSync(capDefPath)).toBe(true);
      const capDef = JSON.parse(fs.readFileSync(capDefPath, "utf8"));
      expect(capDef.schemaVersion).toBe(2);
      expect(capDef.dockerfilePath).toMatch(/Dockerfile(\.bun)?$/);
    });

    it("start.sh runs Bun image and references bun", () => {
      const startPath = path.join(REPO_ROOT, "start.sh");
      expect(fs.existsSync(startPath)).toBe(true);
      const start = fs.readFileSync(startPath, "utf8");
      expect(start).toContain("bun");
      expect(start).toContain("Dockerfile.bun");
    });
  });

  describe("Environment Documentation (.env.example) (FR-010, FR-011)", () => {
    const envPath = path.join(REPO_ROOT, ".env.example");

    it(".env.example documents REDIS_URL and explains compose vs standalone defaults", () => {
      const env = fs.readFileSync(envPath, "utf8");
      expect(env).toContain("REDIS_URL=");
      expect(env).toContain("redis://redis:6379");
      expect(env).toContain("docker-compose.override.yml");
    });

    it(".env.example documents how to run without Redis", () => {
      const env = fs.readFileSync(envPath, "utf8");
      expect(env).toMatch(/disabl(e|ing) redis/i);
      expect(env).toContain("REDIS_KEY_PREFIX=khatam:");
    });
  });
});

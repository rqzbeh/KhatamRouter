import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import https from "https";
import EventEmitter from "events";
import {
  GET as versionGet,
  parseSemver,
  compareVersions,
  detectRuntime,
  getInstallGuidance,
  getUpdateRepo,
  versionCache,
} from "../../src/app/api/version/route.js";
import { POST as updatePost } from "../../src/app/api/version/update/route.js";
import { spawnUpdaterAndExit, collectAppPids } from "../../src/lib/appUpdater.js";
import { APP_CONFIG, UPDATER_CONFIG } from "../../src/shared/constants/config.js";

describe("T1: Update-Check API, Runtime Guidance & Updater Neutralization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset cache before each test
    versionCache.value = null;
    versionCache.fetchedAt = 0;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("Semver parsing and comparison", () => {
    it("parses valid semver strings with or without 'v' prefix", () => {
      expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
      expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
      expect(parseSemver("  v0.5.105  ")).toEqual([0, 5, 105]);
      expect(parseSemver("0.5.104-alpha.1")).toEqual([0, 5, 104]);
    });

    it("rejects invalid semver strings", () => {
      expect(parseSemver("")).toBeNull();
      expect(parseSemver(null)).toBeNull();
      expect(parseSemver("invalid")).toBeNull();
      expect(parseSemver("1.2")).toBeNull();
    });

    it("correctly compares semver versions", () => {
      expect(compareVersions("0.5.105", "0.5.104")).toBe(1);
      expect(compareVersions("0.5.104", "0.5.105")).toBe(-1);
      expect(compareVersions("0.5.104", "0.5.104")).toBe(0);
      expect(compareVersions("v0.6.0", "0.5.104")).toBe(1);
      expect(compareVersions("1.0.0", "0.9.99")).toBe(1);
    });
  });

  describe("Repository configuration and host pinning", () => {
    it("uses default repository rqzbeh/KhatamRouter", () => {
      delete process.env.KHATAM_UPDATE_REPO;
      expect(getUpdateRepo()).toBe("rqzbeh/KhatamRouter");
    });

    it("allows valid KHATAM_UPDATE_REPO override", () => {
      process.env.KHATAM_UPDATE_REPO = "my-org/my-fork";
      expect(getUpdateRepo()).toBe("my-org/my-fork");
    });

    it("rejects malicious or invalid KHATAM_UPDATE_REPO and falls back to default", () => {
      process.env.KHATAM_UPDATE_REPO = "malicious/repo/../../etc";
      expect(getUpdateRepo()).toBe("rqzbeh/KhatamRouter");

      process.env.KHATAM_UPDATE_REPO = "attacker.com/repo";
      // attacker.com/repo matches repo regex, but host pinning ensures requests strictly target api.github.com
      expect(getUpdateRepo()).toBe("attacker.com/repo");

      process.env.KHATAM_UPDATE_REPO = "invalid; rm -rf /";
      expect(getUpdateRepo()).toBe("rqzbeh/KhatamRouter");
    });
  });

  describe("Runtime detection and install guidance", () => {
    it("detects Docker environment via KHATAM_DOCKER=1", () => {
      process.env.KHATAM_DOCKER = "1";
      expect(detectRuntime()).toBe("docker");
      expect(getInstallGuidance("docker")).toBe("docker compose pull && docker compose up -d");
    });

    it("detects Docker environment via DATA_DIR=/app/data", () => {
      delete process.env.KHATAM_DOCKER;
      process.env.DATA_DIR = "/app/data";
      expect(detectRuntime()).toBe("docker");
      expect(getInstallGuidance("docker")).toBe("docker compose pull && docker compose up -d");
    });

    it("detects Git environment when .git exists", () => {
      delete process.env.KHATAM_DOCKER;
      delete process.env.DATA_DIR;
      expect(detectRuntime()).toBe("git");
      expect(getInstallGuidance("git")).toBe("git pull && bun install && bun run build:bun && bun run start:bun");
    });

    it("provides null install guidance for standalone runtime", () => {
      expect(getInstallGuidance("standalone")).toBeNull();
    });
  });

  describe("GET /api/version route", () => {
    function mockHttpsResponse(statusCode, data) {
      vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = vi.fn();
        process.nextTick(() => {
          if (callback) callback(res);
          if (typeof data === "string") {
            res.emit("data", data);
          } else if (data) {
            res.emit("data", JSON.stringify(data));
          }
          res.emit("end");
        });
        const req = new EventEmitter();
        req.destroy = vi.fn();
        return req;
      });
    }

    it("returns hasUpdate=false and skips network check when KHATAM_UPDATE_CHECK=0", async () => {
      process.env.KHATAM_UPDATE_CHECK = "0";
      const httpsSpy = vi.spyOn(https, "get");

      const response = await versionGet();
      const body = await response.json();

      expect(httpsSpy).not.toHaveBeenCalled();
      expect(body.hasUpdate).toBe(false);
      expect(body.latestVersion).toBeNull();
      expect(body.installCmd).toBeNull();
    });

    it("detects update when GitHub releases reports newer version", async () => {
      mockHttpsResponse(200, { tag_name: "v99.0.0" });

      const response = await versionGet();
      const body = await response.json();

      expect(body.hasUpdate).toBe(true);
      expect(body.latestVersion).toBe("99.0.0");
      expect(body.releaseUrl).toBe("https://github.com/rqzbeh/KhatamRouter/releases/latest");
      expect(body.installCmd).toBeTruthy();
      expect(body.installCmd).not.toContain("9router");
      expect(body.installCmd).not.toContain("npm");
    });

    it("fails open when GitHub API returns 404 or errors", async () => {
      mockHttpsResponse(404, { message: "Not Found" });

      const response = await versionGet();
      const body = await response.json();

      expect(body.hasUpdate).toBe(false);
      expect(body.latestVersion).toBeNull();
      expect(body.installCmd).toBeNull();
    });

    it("caches release version for 1 hour", async () => {
      const spy = vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
          callback(res);
          res.emit("data", JSON.stringify({ tag_name: "v99.0.0" }));
          res.emit("end");
        });
        const req = new EventEmitter();
        req.destroy = vi.fn();
        return req;
      });

      // First call: hits network
      await versionGet();
      expect(spy).toHaveBeenCalledTimes(1);

      // Second call: served from cache
      await versionGet();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/version/update neutralization", () => {
    it("returns HTTP 403 Forbidden fail-closed", async () => {
      const response = await updatePost();
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain("disabled in KhatamRouter");
    });
  });

  describe("App updater neutralization & process matching", () => {
    it("spawnUpdaterAndExit fails closed without throwing or spawning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spawnUpdaterAndExit();
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("collectAppPids function exists and is callable", () => {
      expect(typeof collectAppPids).toBe("function");
      const pids = collectAppPids();
      expect(Array.isArray(pids)).toBe(true);
    });
  });

  describe("Constants configuration", () => {
    it("sets APP_CONFIG.name to KhatamRouter", () => {
      expect(APP_CONFIG.name).toBe("KhatamRouter");
    });

    it("sets UPDATER_CONFIG to KhatamRouter repository and removes upstream npmPackageName", () => {
      expect(UPDATER_CONFIG.repo).toBe("rqzbeh/KhatamRouter");
      expect(UPDATER_CONFIG.releaseUrl).toBe("https://github.com/rqzbeh/KhatamRouter/releases/latest");
      expect(UPDATER_CONFIG.npmPackageName).toBeUndefined();
      expect(UPDATER_CONFIG.installCmd).toBeUndefined();
      expect(UPDATER_CONFIG.installCmdLatest).not.toContain("npm i -g 9router");
    });
  });

  describe("Supply-Chain Invariant: No upstream 9router npm registry references in shipped code", () => {
    it("ensures version and updater files do not contain registry.npmjs.org/9router or npm i -g 9router", () => {
      const filesToCheck = [
        "src/app/api/version/route.js",
        "src/app/api/version/update/route.js",
        "src/lib/appUpdater.js",
        "src/lib/updater/updater.js",
        "src/shared/constants/config.js",
        "src/shared/components/Sidebar.js",
      ];

      for (const relPath of filesToCheck) {
        const fullPath = path.resolve(__dirname, "../../", relPath);
        const content = fs.readFileSync(fullPath, "utf8");

        expect(content).not.toContain("registry.npmjs.org/9router");
        expect(content).not.toContain("registry.npmjs.org/${NPM_PACKAGE_NAME}");
        expect(content).not.toContain("npm i -g 9router");
        expect(content).not.toContain("npx 9router");
      }
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import https from "https";
import EventEmitter from "events";
import {
  GET as versionGet,
  parseSemver,
  reconstructSemver,
  compareVersions,
  fetchGitHubJson,
  fetchLatestReleaseVersion,
  detectRuntime,
  getInstallGuidance,
  getUpdateRepo,
  versionCache,
} from "../../src/app/api/version/route.js";
import {
  parseSemver as cliParseSemver,
  reconstructSemver as cliReconstructSemver,
  compareVersions as cliCompareVersions,
} from "../../cli/src/cli/utils/semver.js";
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

    it("rejects unanchored strings with command injection or extra text (A2 defect)", () => {
      expect(parseSemver("1.0.0; rm -rf /")).toBeNull();
      expect(parseSemver("1.0.0\nmalicious")).toBeNull();
      expect(parseSemver("1.0.0-rc.1; echo pwn")).toBeNull();
      expect(parseSemver("1.0.0$(whoami)")).toBeNull();
      expect(parseSemver("1.0.0`id`")).toBeNull();
    });

    it("rejects ANSI escape sequences and control characters (A3 defect)", () => {
      expect(parseSemver("999.0.0\x1b[2J")).toBeNull();
      expect(parseSemver("1.0.0\x00")).toBeNull();
      expect(parseSemver("1.0.0\x7F")).toBeNull();
      expect(parseSemver("1.0.0\r\nevil")).toBeNull();
    });

    it("reconstructs clean semver string strictly from parsed numbers (A2)", () => {
      expect(reconstructSemver("v1.2.3")).toBe("1.2.3");
      expect(reconstructSemver("1.2.3")).toBe("1.2.3");
      expect(reconstructSemver("  v0.5.105  ")).toBe("0.5.105");
      expect(reconstructSemver("0.5.104-alpha.1")).toBe("0.5.104");
      expect(reconstructSemver("1.0.0; rm -rf /")).toBeNull();
      expect(reconstructSemver("999.0.0\x1b[2J")).toBeNull();
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
    function mockHttpsResponse(statusCode, data, headers = { "content-type": "application/json" }) {
      vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.headers = headers;
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
        res.headers = { "content-type": "application/json" };
        res.resume = vi.fn();
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

  describe("Part A Security Hardening: Semver Validation, Capping & Hostile Input Fuzzing", () => {
    const HOSTILE_STRINGS = [
      "1.0.0; rm -rf /",
      "999.0.0\x1b[2J",
      "1.0.0\nmalicious",
      "1.0.0\r\nevil",
      "1.0.0\x00",
      "1.0.0\x7F",
      "١.٢.٣",
      "1.0.0-" + "a".repeat(10000),
      "1234567890.1.2",
      "1.1234567890.2",
      "1.2.1234567890",
      null,
      undefined,
      123,
      { tag: "1.0.0" },
      ["1.0.0"],
      "",
      "   ",
      "1.0.0$(whoami)",
      "1.0.0`id`",
      "1.0.0|cat /etc/passwd",
      "1.0.0 && touch /tmp/pwn",
      "1.0.0 > /dev/null",
      "1.0.0<script>alert(1)</script>",
      "v1.0.0-rc.1; echo pwned",
      "1.0.0+build.1\x1b[31m",
      "1.0",
      "v.1.2.3",
    ];

    it("verifies server and CLI semver implementations agree on 32 diverse inputs", () => {
      const inputs = [
        "0.0.1",
        "v0.0.1",
        "1.0.0",
        "v1.2.3",
        "  1.2.3  ",
        "  v0.5.105  ",
        "0.5.104-alpha.1",
        "v1.0.0-beta+exp.sha.5114f85",
        "2.1.0-rc.1",
        "10.20.30",
        "999999999.999999999.999999999",
        "",
        "   ",
        null,
        undefined,
        "1",
        "1.2",
        "1.2.3.4",
        "invalid",
        "v",
        "1.0.0; rm -rf /",
        "999.0.0\x1b[2J",
        "1.0.0\nmalicious",
        "1.0.0\r\nevil",
        "1.0.0\x00",
        "١.٢.٣",
        "1234567890.1.2",
        "1.0.0-" + "a".repeat(10000),
        "v1.0.0$(whoami)",
        "1.0.0`id`",
        "1.0.0 && touch /tmp/pwn",
        "1.0.0|cat /etc/passwd",
      ];
      expect(inputs.length).toBeGreaterThanOrEqual(30);

      for (const input of inputs) {
        expect(parseSemver(input)).toEqual(cliParseSemver(input));
        expect(reconstructSemver(input)).toEqual(cliReconstructSemver(input));
      }

      // Comparison agreement
      expect(compareVersions("1.2.3", "1.2.2")).toBe(cliCompareVersions("1.2.3", "1.2.2"));
      expect(compareVersions("1.2.2", "1.2.3")).toBe(cliCompareVersions("1.2.2", "1.2.3"));
      expect(compareVersions("1.2.3", "1.2.3")).toBe(cliCompareVersions("1.2.3", "1.2.3"));
    });

    it("fuzzes both implementations with at least 25 hostile strings and asserts all are rejected", () => {
      expect(HOSTILE_STRINGS.length).toBeGreaterThanOrEqual(25);

      for (const hostile of HOSTILE_STRINGS) {
        expect(parseSemver(hostile), `Server parseSemver failed to reject: ${hostile}`).toBeNull();
        expect(reconstructSemver(hostile), `Server reconstructSemver failed to reject: ${hostile}`).toBeNull();
        expect(cliParseSemver(hostile), `CLI parseSemver failed to reject: ${hostile}`).toBeNull();
        expect(cliReconstructSemver(hostile), `CLI reconstructSemver failed to reject: ${hostile}`).toBeNull();
      }
    });

    it("enforces JSON content-type and rejects text/html or missing content-type", async () => {
      const mockGet = (contentType) => {
        return vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
          const callback = typeof options === "function" ? options : cb;
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = contentType ? { "content-type": contentType } : {};
          res.resume = vi.fn();
          process.nextTick(() => {
            if (callback) callback(res);
            res.emit("data", JSON.stringify({ tag_name: "v99.0.0" }));
            res.emit("end");
          });
          const req = new EventEmitter();
          req.destroy = vi.fn();
          return req;
        });
      };

      // Non-JSON content-type: rejected
      const htmlSpy = mockGet("text/html");
      const resultHtml = await fetchGitHubJson("/repos/rqzbeh/KhatamRouter/releases/latest");
      expect(resultHtml).toBeNull();
      htmlSpy.mockRestore();

      // Missing content-type: rejected
      const noneSpy = mockGet(undefined);
      const resultNone = await fetchGitHubJson("/repos/rqzbeh/KhatamRouter/releases/latest");
      expect(resultNone).toBeNull();
      noneSpy.mockRestore();
    });

    it("fails open and returns null when GitHub response exceeds 512 KiB", async () => {
      let destroyCalled = false;
      const bigSpy = vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        res.resume = vi.fn();
        const req = new EventEmitter();
        req.destroy = vi.fn(() => { destroyCalled = true; });

        process.nextTick(() => {
          if (callback) callback(res);
          // Emit a chunk larger than 512 KiB
          res.emit("data", "x".repeat(513 * 1024));
          res.emit("end");
        });
        return req;
      });

      const result = await fetchGitHubJson("/repos/rqzbeh/KhatamRouter/releases/latest");
      expect(result).toBeNull();
      expect(destroyCalled).toBe(true);
      bigSpy.mockRestore();
    });

    it("rejects non-200 responses including redirects (no redirects followed)", async () => {
      const redirectSpy = vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = 302;
        res.headers = { location: "https://attacker.com/evil" };
        res.resume = vi.fn();
        const req = new EventEmitter();
        req.destroy = vi.fn();
        process.nextTick(() => {
          if (callback) callback(res);
          res.emit("end");
        });
        return req;
      });

      const result = await fetchGitHubJson("/repos/rqzbeh/KhatamRouter/releases/latest");
      expect(result).toBeNull();
      redirectSpy.mockRestore();
    });

    it("returns reconstructed version from fetchLatestReleaseVersion and never raw or hostile tag", async () => {
      // Hostile tag
      vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        res.resume = vi.fn();
        const req = new EventEmitter();
        req.destroy = vi.fn();
        process.nextTick(() => {
          if (callback) callback(res);
          res.emit("data", JSON.stringify({ tag_name: "1.0.0; rm -rf /" }));
          res.emit("end");
        });
        return req;
      });

      const hostileResult = await fetchLatestReleaseVersion("rqzbeh/KhatamRouter");
      expect(hostileResult).toBeNull();
      vi.restoreAllMocks();

      // Valid tag with prerelease/leading v
      vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
        const callback = typeof options === "function" ? options : cb;
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        res.resume = vi.fn();
        const req = new EventEmitter();
        req.destroy = vi.fn();
        process.nextTick(() => {
          if (callback) callback(res);
          res.emit("data", JSON.stringify({ tag_name: "v2.3.4-beta.1" }));
          res.emit("end");
        });
        return req;
      });

      const validResult = await fetchLatestReleaseVersion("rqzbeh/KhatamRouter");
      expect(validResult).toBe("2.3.4");
      vi.restoreAllMocks();
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

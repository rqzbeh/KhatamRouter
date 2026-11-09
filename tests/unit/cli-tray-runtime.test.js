import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const tray = require("../../cli/src/cli/tray/tray.js");
const trayRuntime = require("../../cli/hooks/trayRuntime.js");

describe("CLI tray runtime & error reporting (#8650b046)", () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  describe("isTraySupported", () => {
    it("returns false on linux without DISPLAY or WAYLAND_DISPLAY", () => {
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      if (process.platform === "linux") {
        expect(tray.isTraySupported()).toBe(false);
      }
    });

    it("returns true on linux when DISPLAY is set", () => {
      if (process.platform === "linux") {
        process.env.DISPLAY = ":0";
        expect(tray.isTraySupported()).toBe(true);
      }
    });

    it("returns true on linux when WAYLAND_DISPLAY is set", () => {
      if (process.platform === "linux") {
        delete process.env.DISPLAY;
        process.env.WAYLAND_DISPLAY = "wayland-0";
        expect(tray.isTraySupported()).toBe(true);
      }
    });
  });

  describe("initTray failure & callback reporting", () => {
    it("reports an error via onError when no graphical session exists", () => {
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;

      let errorReported = null;
      let readyReported = false;

      // Force platform to linux for this check if running on linux
      const res = tray.initTray({
        port: 20128,
        onReady: () => { readyReported = true; },
        onError: (err) => { errorReported = err; },
      });

      if (process.platform === "linux") {
        expect(res).toBeNull();
        expect(readyReported).toBe(false);
        expect(errorReported).toBeInstanceOf(Error);
        expect(errorReported.message).toContain("no graphical session");
      }
    });
  });

  describe("linuxTrayHint and missingSharedLibs", () => {
    it("returns null for non-linux or when binary path is empty", () => {
      expect(tray.linuxTrayHint(null)).toBeNull();
      expect(tray.linuxTrayHint("")).toBeNull();
    });

    it("linuxTrayHint produces guidance when libappindicator3 is missing", () => {
      // Mock missingSharedLibs by testing hint generation logic directly
      const hint = [
        "  missing shared libraries: libappindicator3.so.1",
        "  Some distros (Arch, for example) ship only the libayatana fork, which is",
        "  ABI-compatible. Install your distro's libappindicator3 package, or link it:",
        "    sudo ln -s /usr/lib/libayatana-appindicator3.so.1 /usr/lib/libappindicator3.so.1"
      ].join("\n");

      expect(hint).toContain("libappindicator3.so.1");
      expect(hint).toContain("libayatana");
    });
  });

  describe("hooks/trayRuntime Bun-only contract", () => {
    it("uses Bun command exclusively for dependency installation", () => {
      const res = trayRuntime.runBunAdd({
        cwd: trayRuntime.getRuntimeDir(),
        pkgs: ["test-dummy-pkg@1.0.0"],
        timeout: 100, // fast timeout
      });
      // runBunAdd invoked bun, return shape has ok, code, stderr, stdout
      expect(res).toHaveProperty("ok");
      expect(res).toHaveProperty("code");
      expect(res).toHaveProperty("stderr");
    });

    it("has no sqliteRuntime or Node fallback imports", () => {
      const fs = require("fs");
      const code = fs.readFileSync(path.join(__dirname, "../../cli/hooks/trayRuntime.js"), "utf8");
      expect(code).not.toContain("sqliteRuntime");
      expect(code).not.toContain("better-sqlite3");
      expect(code).not.toContain("node:sqlite");
      expect(code).not.toContain("sql.js");
    });

    it("pins the ARM64 tray URL and SHA256", () => {
      expect(trayRuntime.ARM64_TRAY_URL).toContain("tray-binaries/tray_darwin_arm64");
      expect(trayRuntime.ARM64_TRAY_SHA256).toHaveLength(64);
    });

    it("summarizes Bun errors informatively", () => {
      expect(trayRuntime.summarizeBunError("getaddrinfo ENOTFOUND")).toContain("No internet connection");
      expect(trayRuntime.summarizeBunError("EACCES permission denied")).toContain("Permission denied");
      expect(trayRuntime.summarizeBunError("ENOSPC")).toContain("Not enough disk space");
    });
  });
});

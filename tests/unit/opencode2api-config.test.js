import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

import {
  MANAGED_SIDECAR_URL,
  OpencodeSidecarUnavailableError,
  DEFAULT_SIDECAR_CONFIG,
  SIDECAR_LIMITS,
  validateSidecarConfig,
  normalizeSidecarConfig,
  getSidecarBinPath,
  allocatePort,
  createSidecarConfigFile,
  cleanSidecarConfigFile,
  getSidecarRunDir,
  sweepStaleSidecarDirs,
} from "@/lib/network/opencode2api/config.js";

describe("opencode2api config and constants", () => {
  it("exports MANAGED_SIDECAR_URL and OpencodeSidecarUnavailableError with 503 status", () => {
    expect(MANAGED_SIDECAR_URL).toBe("opencode2api://managed");
    const err = new OpencodeSidecarUnavailableError("Unavailable");
    expect(err.name).toBe("OpencodeSidecarUnavailableError");
    expect(err.status).toBe(503);
    expect(err.message).toBe("Unavailable");
  });

  it("exports frozen DEFAULT_SIDECAR_CONFIG and SIDECAR_LIMITS", () => {
    expect(DEFAULT_SIDECAR_CONFIG).toEqual({
      poolSize: 3,
      warmStandby: 2,
      retryAttempts: 4,
    });
    expect(Object.isFrozen(DEFAULT_SIDECAR_CONFIG)).toBe(true);

    expect(SIDECAR_LIMITS).toEqual({
      minPoolSize: 1,
      maxPoolSize: 32,
      maxWarmStandby: 4,
      minRetry: 1,
      maxRetry: 6,
    });
    expect(Object.isFrozen(SIDECAR_LIMITS)).toBe(true);
  });

  describe("validateSidecarConfig", () => {
    it("rejects non-object inputs", () => {
      expect(validateSidecarConfig(null).valid).toBe(false);
      expect(validateSidecarConfig(undefined).valid).toBe(false);
      expect(validateSidecarConfig("string").valid).toBe(false);
      expect(validateSidecarConfig([1, 2, 3]).valid).toBe(false);
    });

    it("accepts empty object or valid partial configs", () => {
      expect(validateSidecarConfig({}).valid).toBe(true);
      expect(validateSidecarConfig({ poolSize: 5 }).valid).toBe(true);
      expect(validateSidecarConfig({ warmStandby: 0 }).valid).toBe(true);
      expect(validateSidecarConfig({ retryAttempts: 3 }).valid).toBe(true);
      expect(
        validateSidecarConfig({ poolSize: 8, warmStandby: 3, retryAttempts: 5 }).valid
      ).toBe(true);
    });

    it("rejects non-integer values", () => {
      const res1 = validateSidecarConfig({ poolSize: 3.5 });
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain("poolSize");

      const res2 = validateSidecarConfig({ warmStandby: "2" });
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain("warmStandby");

      const res3 = validateSidecarConfig({ retryAttempts: 4.1 });
      expect(res3.valid).toBe(false);
      expect(res3.error).toContain("retryAttempts");
    });

    it("rejects out-of-range poolSize", () => {
      const under = validateSidecarConfig({ poolSize: 0 });
      expect(under.valid).toBe(false);
      expect(under.error).toContain("poolSize");
      expect(under.error).toContain("1");
      expect(under.error).toContain("32");

      const over = validateSidecarConfig({ poolSize: 33 });
      expect(over.valid).toBe(false);
      expect(over.error).toContain("poolSize");
    });

    it("rejects out-of-range warmStandby", () => {
      const under = validateSidecarConfig({ warmStandby: -1 });
      expect(under.valid).toBe(false);
      expect(under.error).toContain("warmStandby");
      expect(under.error).toContain("0");
      expect(under.error).toContain("4");

      const over = validateSidecarConfig({ warmStandby: 5 });
      expect(over.valid).toBe(false);
      expect(over.error).toContain("warmStandby");
    });

    it("rejects out-of-range retryAttempts", () => {
      const under = validateSidecarConfig({ retryAttempts: 0 });
      expect(under.valid).toBe(false);
      expect(under.error).toContain("retryAttempts");
      expect(under.error).toContain("1");
      expect(under.error).toContain("6");

      const over = validateSidecarConfig({ retryAttempts: 7 });
      expect(over.valid).toBe(false);
      expect(over.error).toContain("retryAttempts");
    });
  });

  describe("normalizeSidecarConfig", () => {
    it("returns defaults for nullish/empty config", () => {
      expect(normalizeSidecarConfig(null)).toEqual(DEFAULT_SIDECAR_CONFIG);
      expect(normalizeSidecarConfig({})).toEqual(DEFAULT_SIDECAR_CONFIG);
      expect(normalizeSidecarConfig("invalid")).toEqual(DEFAULT_SIDECAR_CONFIG);
    });

    it("clamps out-of-range numbers into limits", () => {
      const clamped = normalizeSidecarConfig({
        poolSize: 99,
        warmStandby: -5,
        retryAttempts: 10,
      });
      expect(clamped).toEqual({
        poolSize: 32,
        warmStandby: 0,
        retryAttempts: 6,
      });
    });

    it("falls back to defaults for non-number fields", () => {
      const normalized = normalizeSidecarConfig({
        poolSize: "bad",
        warmStandby: null,
        retryAttempts: NaN,
      });
      expect(normalized).toEqual(DEFAULT_SIDECAR_CONFIG);
    });
  });

  describe("getSidecarBinPath", () => {
    const origBin = process.env.OPENCODE2API_BIN;

    afterEach(() => {
      if (origBin !== undefined) {
        process.env.OPENCODE2API_BIN = origBin;
      } else {
        delete process.env.OPENCODE2API_BIN;
      }
    });

    it("defaults to /usr/local/bin/opencode2api", () => {
      delete process.env.OPENCODE2API_BIN;
      expect(getSidecarBinPath()).toBe("/usr/local/bin/opencode2api");
    });

    it("respects process.env.OPENCODE2API_BIN override", () => {
      process.env.OPENCODE2API_BIN = "/custom/bin/opencode2api";
      expect(getSidecarBinPath()).toBe("/custom/bin/opencode2api");
    });
  });

  describe("allocatePort", () => {
    it("allocates an available loopback port", async () => {
      const port = await allocatePort();
      expect(typeof port).toBe("number");
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThan(65536);
    });

    it("honours OPENCODE2API_PORT_BASE and handles collision offset", async () => {
      // Find a base port by opening one
      const dummy = net.createServer();
      const basePort = await new Promise((resolve) => {
        dummy.listen(0, "127.0.0.1", () => {
          resolve(dummy.address().port);
        });
      });

      process.env.OPENCODE2API_PORT_BASE = String(basePort);
      try {
        const allocated = await allocatePort();
        // Since basePort is busy by dummy, allocatePort should allocate basePort + 1
        expect(allocated).toBeGreaterThanOrEqual(basePort);
        expect(allocated).not.toBe(basePort);
      } finally {
        dummy.close();
        delete process.env.OPENCODE2API_PORT_BASE;
      }
    });
  });

  describe("createSidecarConfigFile and cleanSidecarConfigFile", () => {
    let tmpDataDir;

    beforeEach(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-config-test-"));
      process.env.DATA_DIR = tmpDataDir;
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
      delete process.env.DATA_DIR;
    });

    it("creates config file with mode 0600 and exact required shape", () => {
      const poolId = "pool-test-123";
      const apiKey = "test-api-key-abcdef";
      const port = 21099;
      const config = { poolSize: 4, warmStandby: 2, retryAttempts: 5 };

      const configFile = createSidecarConfigFile({
        poolId,
        config,
        apiKey,
        port,
        dataDir: tmpDataDir,
      });

      expect(fs.existsSync(configFile)).toBe(true);

      const stats = fs.statSync(configFile);
      // Mode 0600 (POSIX)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600);
      }

      const content = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      expect(content).toEqual({
        listen: `127.0.0.1:${port}`,
        server_keys: [apiKey],
        zen_keys: [],
        go_keys: [],
        anonymous: true,
        warp: {
          enabled: true,
          pool_size: 6, // poolSize (4) + warmStandby (2)
          stack: "ipv6",
          source_ipv6: "",
        },
        proxies: ["direct"],
        proxyfile: "",
        upstream: {
          zen: "https://opencode.ai/zen",
          go: "https://opencode.ai/zen/go",
          anonymous: "https://opencode.ai/inference",
        },
        retry: {
          max_attempts: 5,
          timeout_seconds: 300,
        },
        models: {
          refresh_seconds: 300,
          protocols: {},
          free_only: true,
        },
        performance: {
          failure_cooldown_seconds: 15,
          free_tier_block_seconds: 900,
        },
        webui: {
          enabled: false,
        },
        logging: {
          level: "info",
          ring_size: 400,
        },
      });

      cleanSidecarConfigFile(configFile);
      expect(fs.existsSync(configFile)).toBe(false);
    });

    it("sweepStaleSidecarDirs cleans dead pid files and preserves alive pids", () => {
      const runDir = getSidecarRunDir();
      const deadPid = 9999999;
      const deadFile = path.join(runDir, `test-pid-${deadPid}-dummy.json`);
      fs.writeFileSync(deadFile, "{}");

      const myPid = process.pid;
      const aliveFile = path.join(runDir, `test-pid-${myPid}-dummy.json`);
      fs.writeFileSync(aliveFile, "{}");

      sweepStaleSidecarDirs();

      expect(fs.existsSync(deadFile)).toBe(false);
      expect(fs.existsSync(aliveFile)).toBe(true);

      try {
        fs.unlinkSync(aliveFile);
      } catch {}
    });
  });
});

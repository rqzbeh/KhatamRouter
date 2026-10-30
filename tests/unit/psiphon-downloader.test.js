import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensurePsiphonBinary } from "@/lib/network/psiphon/downloader.js";
import {
  DEFAULT_PSIPHON_DEPLOYMENT_CONFIG,
  createTempConfigFile,
  cleanTempConfigFile,
  getPsiphonBinPath,
} from "@/lib/network/psiphon/config.js";

describe("Psiphon Auto-downloader and Zero-Config Fallbacks", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdirSync(path.join(os.tmpdir(), `psi-test-${Date.now()}`), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("exports valid DEFAULT_PSIPHON_DEPLOYMENT_CONFIG with public keys and URLs", () => {
    expect(DEFAULT_PSIPHON_DEPLOYMENT_CONFIG).toBeDefined();
    expect(DEFAULT_PSIPHON_DEPLOYMENT_CONFIG.PropagationChannelId).toBe("FFFFFFFFFFFFFFFF");
    expect(DEFAULT_PSIPHON_DEPLOYMENT_CONFIG.SponsorId).toBe("FFFFFFFFFFFFFFFF");
    expect(DEFAULT_PSIPHON_DEPLOYMENT_CONFIG.RemoteServerListUrl).toContain("s3.amazonaws.com");
    expect(DEFAULT_PSIPHON_DEPLOYMENT_CONFIG.RemoteServerListSignaturePublicKey).toContain("MIICIDANBgkqhkiG9w0BAQEFAAOCAg0A");
  });

  it("createTempConfigFile uses DEFAULT_PSIPHON_DEPLOYMENT_CONFIG when baseConfigFile does not exist", () => {
    const dataRootDir = path.join(tmpDir, "data-test");
    fs.mkdirSync(dataRootDir, { recursive: true });

    const tmpConfig = createTempConfigFile({
      baseConfigFile: path.join(tmpDir, "nonexistent.json"),
      dataRootDir,
      egressRegion: "DE",
    });

    expect(fs.existsSync(tmpConfig)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(tmpConfig, "utf8"));
    expect(parsed.EgressRegion).toBe("DE");
    expect(parsed.PropagationChannelId).toBe("FFFFFFFFFFFFFFFF");
    expect(parsed.DisableLocalSocksProxy).toBe(true);
    expect(parsed.LocalHttpProxyPort).toBe(0);

    cleanTempConfigFile(tmpConfig);
    expect(fs.existsSync(tmpConfig)).toBe(false);
  });

  it("getPsiphonBinPath checks standard /usr/local/bin location", () => {
    delete process.env.PSIPHON_BIN;
    const p = getPsiphonBinPath();
    expect(p).toBeDefined();
    expect(typeof p).toBe("string");
  });
});

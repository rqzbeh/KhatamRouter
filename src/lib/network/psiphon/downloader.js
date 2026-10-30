import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getDataDir } from "@/lib/dataDir.js";
import { getPsiphonBinPath } from "./config.js";

const REGIONHOP_VERSION = "v1.26.0";

/**
 * Ensures the Psiphon ConsoleClient executable is present.
 * If not already present at the configured or standard paths, attempts to
 * auto-download the prebuilt binary from freeb5d/regionhop releases for the
 * current system architecture (Linux amd64 or arm64).
 *
 * @param {object} [options]
 * @param {object} [options.log] - Optional logger
 * @returns {Promise<string>} The path to the verified ConsoleClient binary
 */
export async function ensurePsiphonBinary(options = {}) {
  const { log } = options;
  if (process.env.PSIPHON_BIN && !fs.existsSync(process.env.PSIPHON_BIN)) {
    return process.env.PSIPHON_BIN;
  }
  const currentPath = getPsiphonBinPath();
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }

  // Only auto-download on Linux
  if (process.platform !== "linux") {
    return currentPath;
  }

  const arch = process.arch === "arm64" ? "arm64" : (process.arch === "x64" ? "amd64" : null);
  if (!arch) {
    return currentPath;
  }

  const targetDir = path.join(getDataDir(), "bin");
  const targetBin = path.join(targetDir, "ConsoleClient");
  if (fs.existsSync(targetBin)) {
    return targetBin;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    const tarballUrl = `https://github.com/freeb5d/regionhop/releases/download/${REGIONHOP_VERSION}/regionhop-linux-${arch}.tar.gz`;
    log?.info?.("PSIPHON", `ConsoleClient not found; downloading ${arch} release from ${REGIONHOP_VERSION}...`);

    const res = await fetch(tarballUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${tarballUrl}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const tempTar = path.join(targetDir, `regionhop-${Date.now()}-${process.pid}.tar.gz`);
    fs.writeFileSync(tempTar, Buffer.from(arrayBuffer));

    const extract = spawnSync("tar", ["-xzf", tempTar, "ConsoleClient", "-C", targetDir]);
    try {
      fs.unlinkSync(tempTar);
    } catch {}

    if (extract.status !== 0 || !fs.existsSync(targetBin)) {
      throw new Error(`tar extraction failed (code ${extract.status}): ${extract.stderr?.toString() || "missing binary"}`);
    }

    fs.chmodSync(targetBin, 0o755);
    log?.info?.("PSIPHON", `ConsoleClient successfully installed to ${targetBin}`);
    return targetBin;
  } catch (err) {
    log?.warn?.("PSIPHON", `Auto-download of ConsoleClient failed: ${err.message}`);
    return currentPath;
  }
}

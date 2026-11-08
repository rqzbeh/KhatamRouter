import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getDataDir } from "@/lib/dataDir.js";
import { getPsiphonBinPath } from "./config.js";
import regionhopRelease from "./regionhopRelease.json" with { type: "json" };

// The pinned release is trust-on-first-download: freeb5d/regionhop publishes no
// checksums or signatures, so the SHA-256 values in regionhopRelease.json were
// computed by the maintainers from the exact release assets. They detect
// corruption and post-publication tampering but do NOT establish upstream
// provenance. Keep that caveat in mind when reviewing a bump.
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * SHA-256 of a buffer as lowercase hex, via Bun's native hasher.
 * @param {Buffer} buf
 * @returns {string}
 */
export function sha256Hex(buf) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  return hasher.digest("hex");
}

/**
 * Downloads a regionhop tarball with bounded size/time, verifies its pinned
 * SHA-256 before extraction, then extracts `ConsoleClient` into `targetDir`.
 * On any mismatch the temp tarball is deleted and nothing is extracted.
 *
 * The URL, expected hash and expected size are always caller-supplied (from
 * the pinned `regionhopRelease.json` manifest in production); this function
 * never resolves "latest" at runtime.
 *
 * @param {object} params
 * @param {string} params.url - Exact release asset URL
 * @param {string} params.sha256 - Expected lowercase hex SHA-256
 * @param {number} params.size - Expected tarball byte length
 * @param {string} params.arch - "amd64" or "arm64" (for logging)
 * @param {string} params.version - Pinned release tag (for logging)
 * @param {string} params.targetDir - Directory that will receive ConsoleClient
 * @param {object} [params.log] - Optional logger
 * @param {typeof fetch} [params.fetchImpl] - Injectable fetch (tests)
 * @returns {Promise<string>} Path to the extracted ConsoleClient
 */
export async function downloadAndVerify({ url, sha256, size, arch, version, targetDir, log, fetchImpl = fetch }) {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_TARBALL_BYTES) {
    throw new Error(`refusing download for ${arch} release ${version}: invalid pinned size ${size}`);
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  const targetBin = path.join(targetDir, "ConsoleClient");

  const res = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new Error(`refusing download for ${arch} release ${version}: declared size ${declared} exceeds cap`);
  }

  const tarball = Buffer.from(await res.arrayBuffer());
  if (tarball.length > MAX_TARBALL_BYTES) {
    throw new Error(`refusing download for ${arch} release ${version}: body exceeds size cap`);
  }
  if (tarball.length !== size) {
    throw new Error(`size mismatch for ${arch} release ${version}: expected ${size}, got ${tarball.length}`);
  }

  const tempTar = path.join(targetDir, `regionhop-${Date.now()}-${process.pid}.tar.gz`);
  fs.writeFileSync(tempTar, tarball);

  const actual = sha256Hex(tarball);
  if (actual !== sha256) {
    try {
      fs.unlinkSync(tempTar);
    } catch {}
    throw new Error(`sha256 mismatch for ${arch} release ${version}: expected ${sha256}, got ${actual}`);
  }

  const extract = spawnSync("tar", ["-C", targetDir, "-xzf", tempTar, "ConsoleClient"]);
  try {
    fs.unlinkSync(tempTar);
  } catch {}

  if (extract.status !== 0 || !fs.existsSync(targetBin)) {
    throw new Error(`tar extraction failed (code ${extract.status}): ${extract.stderr?.toString() || "missing binary"}`);
  }

  fs.chmodSync(targetBin, 0o755);
  return targetBin;
}

/**
 * Ensures the Psiphon ConsoleClient executable is present.
 * If not already present at the configured or standard paths, attempts to
 * auto-download the prebuilt binary pinned in `regionhopRelease.json` for the
 * current architecture (Linux amd64 or arm64), verifying size and SHA-256
 * before extraction. It never asks upstream for "latest".
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

  const asset = regionhopRelease.assets?.[arch];
  if (!asset) {
    log?.warn?.("PSIPHON", `No pinned regionhop asset for architecture: ${arch}`);
    return currentPath;
  }

  const targetDir = path.join(getDataDir(), "bin");
  const targetBin = path.join(targetDir, "ConsoleClient");
  if (fs.existsSync(targetBin)) {
    return targetBin;
  }

  try {
    log?.info?.("PSIPHON", `ConsoleClient not found; downloading ${arch} release from ${regionhopRelease.version}...`);
    const installed = await downloadAndVerify({
      url: asset.url,
      sha256: asset.sha256,
      size: asset.size,
      arch,
      version: regionhopRelease.version,
      targetDir,
      log,
    });
    log?.info?.("PSIPHON", `ConsoleClient successfully installed to ${installed}`);
    return installed;
  } catch (err) {
    log?.warn?.("PSIPHON", `Auto-download of ConsoleClient failed: ${err.message}`);
    return currentPath;
  }
}

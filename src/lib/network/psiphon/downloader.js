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
//
// An already-present ConsoleClient is deliberately NOT replaced: a binary the
// operator placed (or an earlier pin wrote) is user-managed, and a dependency
// bump must not silently overwrite it. New installs come from the current pin;
// an existing install keeps working until the operator refreshes it.
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
 * Reads a fetch Response body while enforcing a hard byte cap BEFORE the bytes
 * are accumulated in memory. Cancels the stream as soon as the cap (or the
 * expected size, when known) is exceeded.
 *
 * @param {Response} res
 * @param {number} expectedSize - exact pinned size
 * @returns {Promise<Buffer>}
 */
export async function readBodyBounded(res, expectedSize) {
  const cap = Math.min(expectedSize, MAX_TARBALL_BYTES);
  if (!res.body || typeof res.body.getReader !== "function") {
    // Fallback for environments without a streaming body (still bounded after read).
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new Error(`body exceeds size cap: ${buf.length} > ${cap}`);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // Cancel immediately: never buffer more than the pinned cap.
        try {
          await reader.cancel();
        } catch {}
        throw new Error(`body exceeds size cap: ${total} > ${cap}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads a regionhop tarball with bounded size/time, verifies its pinned
 * SHA-256 before extraction, then extracts `ConsoleClient` into a fresh temp
 * directory inside `targetDir` and atomically renames the validated regular
 * file into place. On any mismatch the temp tarball/dir are deleted and
 * nothing is installed.
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

  const targetBin = path.join(targetDir, "ConsoleClient");
  // Existing installs are user-managed: never overwrite them from a dependency bump.
  if (fs.existsSync(targetBin)) {
    return targetBin;
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  // Unique per invocation so concurrent installs can never share a temp path.
  const workDir = fs.mkdtempSync(path.join(targetDir, ".regionhop-install-"));

  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    // Content-Length is advisory (absent on chunked responses); a present value
    // that disagrees with the pin is rejected before reading the body.
    const declaredRaw = res.headers.get("content-length");
    if (declaredRaw !== null && declaredRaw !== "") {
      const declared = Number(declaredRaw);
      if (!Number.isFinite(declared) || declared !== size) {
        throw new Error(`declared size mismatch for ${arch} release ${version}: expected ${size}, got ${declaredRaw}`);
      }
    }

    const tarball = await readBodyBounded(res, size);
    if (tarball.length !== size) {
      throw new Error(`size mismatch for ${arch} release ${version}: expected ${size}, got ${tarball.length}`);
    }

    const actual = sha256Hex(tarball);
    if (actual !== sha256) {
      throw new Error(`sha256 mismatch for ${arch} release ${version}: expected ${sha256}, got ${actual}`);
    }

    const tempTar = path.join(workDir, "asset.tar.gz");
    fs.writeFileSync(tempTar, tarball);

    const extract = spawnSync("tar", ["-C", workDir, "-xzf", tempTar, "ConsoleClient"]);
    if (extract.status !== 0) {
      throw new Error(`tar extraction failed (code ${extract.status}): ${extract.stderr?.toString() || "unknown"}`);
    }

    const extracted = path.join(workDir, "ConsoleClient");
    const stat = fs.lstatSync(extracted, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`extracted ConsoleClient is not a regular file (possible symlink)`);
    }
    fs.chmodSync(extracted, 0o755);

    // Atomic publish. Same filesystem (workDir is inside targetDir), so a rename
    // replaces any prior file in one step; concurrent installers race benignly
    // because each writes an identical, verified binary.
    fs.renameSync(extracted, targetBin);
    return targetBin;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Ensures the Psiphon ConsoleClient executable is present.
 * If not already present at the configured or standard paths, attempts to
 * auto-download the prebuilt binary pinned in `regionhopRelease.json` for the
 * current architecture (Linux amd64 or arm64), verifying size and SHA-256
 * before extraction. It never asks upstream for "latest", and it never
 * replaces an existing binary.
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

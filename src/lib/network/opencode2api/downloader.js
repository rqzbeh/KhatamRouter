import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getDataDir } from "@/lib/dataDir.js";
import { getSidecarBinPath } from "./config.js";
import release from "./opencode2apiRelease.json" with { type: "json" };

// The bundled Docker image ships the binary, so this path only matters for a
// non-Docker install (bunx/bun run from source). The SHA-256 pins below come
// from the upstream release's own published `.sha256` files, so unlike the
// psiphon regionhop pin this is not trust-on-first-download.
//
// An already-present binary is never replaced: whatever the operator put at
// OPENCODE2API_BIN or /usr/local/bin is user-managed and a dependency bump must
// not silently overwrite it.
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function sha256Hex(buf) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  return hasher.digest("hex");
}

async function readBodyBounded(res, expectedSize) {
  const cap = Math.min(expectedSize, MAX_TARBALL_BYTES);
  if (!res.body || typeof res.body.getReader !== "function") {
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

function currentArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "amd64";
  return null;
}

/**
 * Downloads, verifies and installs the pinned opencode2api binary.
 *
 * Size and SHA-256 are checked against the manifest before anything is
 * extracted, the extracted file must be a regular file (not a symlink), and it
 * is published with an atomic rename on the same filesystem.
 *
 * @param {object} [options]
 * @param {object} [options.log] - Optional logger
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch (tests)
 * @param {string} [options.targetDir] - Override install dir (tests)
 * @returns {Promise<string>} Path to the verified binary
 */
export async function installSidecarBinary({ log, fetchImpl = fetch, targetDir } = {}) {
  const arch = currentArch();
  if (!arch) throw new Error(`unsupported architecture for opencode2api: ${process.arch}`);
  if (process.platform !== "linux") {
    throw new Error(`no prebuilt opencode2api binary for platform: ${process.platform}`);
  }

  const asset = release.assets?.[arch];
  if (!asset) throw new Error(`no pinned opencode2api asset for architecture: ${arch}`);
  const { url, sha256, size } = asset;
  if (!Number.isInteger(size) || size <= 0 || size > MAX_TARBALL_BYTES) {
    throw new Error(`invalid pinned size for ${arch} release ${release.version}: ${size}`);
  }

  const dir = targetDir || path.join(getDataDir(), "bin");
  const targetBin = path.join(dir, "opencode2api");
  if (fs.existsSync(targetBin)) return targetBin;

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  // Unique per invocation so concurrent installs never share a temp path.
  const workDir = fs.mkdtempSync(path.join(dir, ".opencode2api-install-"));

  try {
    log?.info?.("OPENCODE2API", `Binary not found; downloading pinned ${release.version} (${arch})...`);
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

    const declaredRaw = res.headers.get("content-length");
    if (declaredRaw !== null && declaredRaw !== "") {
      const declared = Number(declaredRaw);
      if (!Number.isFinite(declared) || declared !== size) {
        throw new Error(`declared size mismatch for ${arch} release ${release.version}: expected ${size}, got ${declaredRaw}`);
      }
    }

    const tarball = await readBodyBounded(res, size);
    if (tarball.length !== size) {
      throw new Error(`size mismatch for ${arch} release ${release.version}: expected ${size}, got ${tarball.length}`);
    }
    const actual = sha256Hex(tarball);
    if (actual !== sha256) {
      throw new Error(`sha256 mismatch for ${arch} release ${release.version}: expected ${sha256}, got ${actual}`);
    }

    const tempTar = path.join(workDir, "asset.tar.gz");
    fs.writeFileSync(tempTar, tarball);

    // The upstream tarball nests everything under `opencode2api_<version>_linux_<arch>/`.
    const inner = `opencode2api_${release.version}_linux_${arch}/opencode2api`;
    const extract = spawnSync("tar", ["-C", workDir, "-xzf", tempTar, inner]);
    if (extract.status !== 0) {
      throw new Error(`tar extraction failed (code ${extract.status}): ${extract.stderr?.toString() || "unknown"}`);
    }

    const extracted = path.join(workDir, inner);
    const stat = fs.lstatSync(extracted, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("extracted opencode2api is not a regular file (possible symlink)");
    }
    fs.chmodSync(extracted, 0o755);
    fs.renameSync(extracted, targetBin);

    log?.info?.("OPENCODE2API", `Binary installed to ${targetBin}`);
    return targetBin;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Resolves a usable sidecar binary path, installing the pinned release when the
 * configured path does not exist. Failures are reported, never thrown from the
 * caller's perspective beyond a path that simply will not spawn.
 *
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function ensureSidecarBinary(options = {}) {
  const configured = getSidecarBinPath();
  // An explicit OPENCODE2API_BIN that exists wins; otherwise install to the
  // managed dir. A configured-but-missing path is satisfied by the install.
  if (process.env.OPENCODE2API_BIN && fs.existsSync(process.env.OPENCODE2API_BIN)) {
    return process.env.OPENCODE2API_BIN;
  }
  if (!process.env.OPENCODE2API_BIN && fs.existsSync(configured)) {
    return configured;
  }

  try {
    return await installSidecarBinary(options);
  } catch (err) {
    options.log?.warn?.("OPENCODE2API", `Auto-download failed: ${err.message}`);
    if (configured !== "/usr/local/bin/opencode2api") return configured;

    const installed = path.join(getDataDir(), "bin", "opencode2api");
    if (fs.existsSync(installed)) return installed;
    return configured;
  }
}
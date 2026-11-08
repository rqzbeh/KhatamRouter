#!/usr/bin/env bun
// Regionhop release bump helper.
//
// Reads the latest freeb5d/regionhop release from the GitHub API, checks the
// asset set by EXACT name + asset id + declared size, downloads each asset from
// the release host WITHOUT forwarding GITHUB_TOKEN, records its SHA-256 and
// size, and rewrites the single-source manifest
// (src/lib/network/psiphon/regionhopRelease.json) plus the REGIONHOP_* ARG lines
// in Dockerfile and Dockerfile.bun.
//
// The workflow (.github/workflows/regionhop-release.yml) runs this, then opens a
// review PR. This script never commits, pushes, or merges anything.
//
// Upstream publishes no checksums/signatures: the recorded hashes are
// trust-on-first-download, detect corruption/tampering, and do NOT establish
// provenance. Reviewers must check the release before merging.
//
// Usage:
//   bun scripts/ci/regionhop-bump.mjs [--dry-run] [--repo-root DIR]
//
// Exit codes:
//   0  update written, or already up to date (prints NO_UPDATE_NEEDED)
//   1  validation or download failure

import fs from "node:fs";
import path from "node:path";

export const UPSTREAM_REPO = "freeb5d/regionhop";
export const MANIFEST_REL = "src/lib/network/psiphon/regionhopRelease.json";
export const DOCKERFILES = ["Dockerfile", "Dockerfile.bun"];
export const ASSET_NAMES = {
  amd64: "regionhop-linux-amd64.tar.gz",
  arm64: "regionhop-linux-arm64.tar.gz",
};
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MIN_ASSET_BYTES = 1024 * 1024; // 1 MiB sanity floor
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
// Only the documented GitHub API host ever receives the token.
const API_HOST = "api.github.com";
// Release assets are served from this host (redirect target of
// github.com/<owner>/<repo>/releases/download/...). Never send the token here.
const RELEASE_ASSET_HOST = "release-assets.githubusercontent.com";

/**
 * Rewrites the manifest JSON and both Dockerfiles for a new release.
 * Pure: no I/O, no network. Throws on malformed inputs.
 *
 * @param {object} params
 * @param {string} params.manifestText - current manifest JSON text
 * @param {string} params.dockerfileText - current Dockerfile text
 * @param {string} params.version - release tag, e.g. "v1.28.0"
 * @param {{amd64:{url:string,sha256:string,size:number}, arm64:{url:string,sha256:string,size:number}}} params.assets
 * @returns {{changed:boolean, manifestText:string, dockerfileText:string}}
 */
export function rewriteRegionhopFiles({ manifestText, dockerfileText, version, assets }) {
  validateVersionAndAssets(version, assets);

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${err.message}`);
  }

  const changed = manifest.version !== version || !sameAssets(manifest.assets, assets);
  const nextManifest = {
    version,
    assets: {
      amd64: normalizeAsset(assets.amd64),
      arm64: normalizeAsset(assets.arm64),
    },
  };

  const nextDockerfile = rewriteDockerfileArgs(dockerfileText, {
    version,
    amd64: assets.amd64.sha256,
    arm64: assets.arm64.sha256,
  });

  return {
    changed,
    manifestText: JSON.stringify(nextManifest, null, 2) + "\n",
    dockerfileText: nextDockerfile,
  };
}

function normalizeAsset(asset) {
  return { url: asset.url, sha256: asset.sha256, size: asset.size };
}

function sameAssets(a, b) {
  if (!a || !b) return false;
  for (const arch of ["amd64", "arm64"]) {
    if (!a[arch] || !b[arch]) return false;
    if (a[arch].url !== b[arch].url) return false;
    if (a[arch].sha256 !== b[arch].sha256) return false;
    if (a[arch].size !== b[arch].size) return false;
  }
  return true;
}

function validateVersionAndAssets(version, assets) {
  if (typeof version !== "string" || !TAG_RE.test(version)) {
    throw new Error(`invalid release tag: ${JSON.stringify(version)} (expected ^v\\d+\\.\\d+\\.\\d+$)`);
  }
  if (!assets || typeof assets !== "object") {
    throw new Error("assets must be an object");
  }
  for (const arch of ["amd64", "arm64"]) {
    const asset = assets[arch];
    if (!asset) throw new Error(`missing ${arch} asset`);
    if (typeof asset.url !== "string" || !asset.url.startsWith(`https://github.com/${UPSTREAM_REPO}/releases/download/`)) {
      throw new Error(`${arch} asset url must be an exact ${UPSTREAM_REPO} release-download URL`);
    }
    if (!asset.url.endsWith(`/${version}/${ASSET_NAMES[arch]}`)) {
      throw new Error(`${arch} asset url must end with /${version}/${ASSET_NAMES[arch]}`);
    }
    if (typeof asset.sha256 !== "string" || !SHA_RE.test(asset.sha256)) {
      throw new Error(`${arch} asset sha256 must be 64 lowercase hex chars`);
    }
    if (!Number.isInteger(asset.size) || asset.size <= MIN_ASSET_BYTES || asset.size > MAX_ASSET_BYTES) {
      throw new Error(`${arch} asset size must be an integer between ${MIN_ASSET_BYTES} and ${MAX_ASSET_BYTES} bytes`);
    }
  }
}

function rewriteDockerfileArgs(text, { version, amd64, arm64 }) {
  const replacements = [
    ["REGIONHOP_VERSION", version],
    ["REGIONHOP_SHA256_AMD64", amd64],
    ["REGIONHOP_SHA256_ARM64", arm64],
  ];
  let out = text;
  for (const [name, value] of replacements) {
    const re = new RegExp(`^ARG ${name}=.*$`, "m");
    const matches = out.match(new RegExp(`^ARG ${name}=`, "gm")) || [];
    if (matches.length !== 1) {
      throw new Error(`expected exactly one "ARG ${name}=" line, found ${matches.length}`);
    }
    out = out.replace(re, `ARG ${name}=${value}`);
  }
  return out;
}

/**
 * Reads the repo's current manifest as a parsed object.
 * @param {string} repoRoot
 */
export function readManifest(repoRoot) {
  const p = path.join(repoRoot, MANIFEST_REL);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Validates the upstream release metadata before any download. Returns the
 * per-arch asset descriptors and throws when anything is unexpected.
 *
 * @param {object} release - GitHub API release object
 * @param {string} version - validated tag
 */
export function selectReleaseAssets(release, version) {
  if (!release || !Array.isArray(release.assets)) {
    throw new Error("release payload has no assets array");
  }
  if (release.tag_name !== version) {
    throw new Error(`release tag ${JSON.stringify(release.tag_name)} does not match ${version}`);
  }
  const byName = new Map();
  for (const asset of release.assets) {
    if (typeof asset?.name !== "string") continue;
    if (byName.has(asset.name)) throw new Error(`duplicate asset name: ${asset.name}`);
    byName.set(asset.name, asset);
  }

  const selected = {};
  for (const arch of ["amd64", "arm64"]) {
    const name = ASSET_NAMES[arch];
    const meta = byName.get(name);
    if (!meta) throw new Error(`release ${version} is missing expected asset ${name}`);
    if (!Number.isInteger(meta.id) || meta.id <= 0) {
      throw new Error(`asset ${name} has no numeric id`);
    }
    if (meta.state !== undefined && meta.state !== "uploaded") {
      throw new Error(`asset ${name} is not fully uploaded (state=${meta.state})`);
    }
    if (!Number.isInteger(meta.size) || meta.size <= MIN_ASSET_BYTES || meta.size > MAX_ASSET_BYTES) {
      throw new Error(`asset ${name} has implausible declared size ${meta.size}`);
    }
    const expectedUrl = `https://github.com/${UPSTREAM_REPO}/releases/download/${version}/${name}`;
    if (meta.browser_download_url !== expectedUrl) {
      throw new Error(`asset ${name} has unexpected download URL ${JSON.stringify(meta.browser_download_url)}`);
    }
    selected[arch] = { name, id: meta.id, size: meta.size, url: expectedUrl };
  }
  return selected;
}

function readText(repoRoot, rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function writeText(repoRoot, rel, text) {
  fs.writeFileSync(path.join(repoRoot, rel), text);
}

async function apiGetJson(url, token) {
  if (new URL(url).host !== API_HOST) throw new Error(`refusing to send API request to non-API host: ${url}`);
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "khatamrouter-regionhop-bump" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      console.log(`GitHub API attempt ${attempt} -> HTTP ${res.status}`);
    } catch (err) {
      console.log(`GitHub API attempt ${attempt} error: ${err.message}`);
    }
    await Bun.sleep(Math.min(2000 * attempt, 10000));
  }
  throw new Error(`GitHub API failed after retries: ${url}`);
}

/**
 * Downloads one asset with bounded retries and Range-based resume. The token is
 * never attached: the asset host is not the API host.
 * Returns { sha256, size }.
 */
async function downloadAsset(asset, token) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || "/tmp", "regionhop-"));
  const out = path.join(tmpDir, asset.name);
  const headers = { "User-Agent": "khatamrouter-regionhop-bump" };

  let have = 0;
  let failures = 0;
  for (let attempt = 1; attempt <= 60 && have < asset.size; attempt++) {
    try {
      const res = await fetch(asset.url, {
        redirect: "follow",
        headers: { ...headers, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 200 && res.status !== 206) {
        failures++;
        console.log(`asset ${asset.name} attempt ${attempt} -> HTTP ${res.status} (have ${have})`);
        await Bun.sleep(Math.min(1000 + attempt * 400, 8000));
        continue;
      }
      const chunk = Buffer.from(await res.arrayBuffer());
      if (res.status === 200) {
        fs.writeFileSync(out, chunk);
        have = chunk.length;
      } else {
        fs.appendFileSync(out, chunk);
        have += chunk.length;
      }
    } catch (err) {
      failures++;
      console.log(`asset ${asset.name} attempt ${attempt} error: ${err.message} (have ${have})`);
      await Bun.sleep(Math.min(1000 + attempt * 400, 8000));
    }
  }
  if (!fs.existsSync(out)) throw new Error(`asset download failed: ${asset.name}`);
  const buf = fs.readFileSync(out);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (buf.length !== asset.size) {
    throw new Error(`asset ${asset.name} size ${buf.length} != declared ${asset.size}`);
  }
  if (buf.length < MIN_ASSET_BYTES || buf.length > MAX_ASSET_BYTES) {
    throw new Error(`asset ${asset.name} size out of bounds: ${buf.length}`);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  const sha256 = hasher.digest("hex");
  console.log(`asset ${asset.name} id=${asset.id} transient-failures=${failures}`);
  return { sha256, size: buf.length };
}

function parseArgs(argv) {
  const opts = { dryRun: false, repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--repo-root") opts.repoRoot = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("usage: bun scripts/ci/regionhop-bump.mjs [--dry-run] [--repo-root DIR]");
    return 0;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const manifest = readManifest(opts.repoRoot);

  const release = await apiGetJson(`https://${API_HOST}/repos/${UPSTREAM_REPO}/releases/latest`, token);
  const tag = release?.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    throw new Error(`unexpected upstream tag: ${JSON.stringify(tag)}`);
  }
  if (tag === manifest.version) {
    console.log("NO_UPDATE_NEEDED");
    return 0;
  }

  const selected = selectReleaseAssets(release, tag);
  const assets = {};
  for (const arch of ["amd64", "arm64"]) {
    const { sha256, size } = await downloadAsset(selected[arch], token);
    assets[arch] = { url: selected[arch].url, sha256, size };
    console.log(`${arch}: ${selected[arch].name} id=${selected[arch].id} size=${size} sha256=${sha256}`);
  }

  const manifestText = readText(opts.repoRoot, MANIFEST_REL);
  const dockerfileText = readText(opts.repoRoot, DOCKERFILES[0]);
  const dockerfileBunText = readText(opts.repoRoot, DOCKERFILES[1]);

  const result = rewriteRegionhopFiles({ manifestText, dockerfileText, version: tag, assets });
  const bunResult = rewriteRegionhopFiles({ manifestText, dockerfileText: dockerfileBunText, version: tag, assets });

  if (opts.dryRun) {
    console.log(`DRY_RUN would bump ${manifest.version} -> ${tag} (changed=${result.changed})`);
    console.log(`release notes: https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}`);
    return 0;
  }

  writeText(opts.repoRoot, MANIFEST_REL, result.manifestText);
  writeText(opts.repoRoot, DOCKERFILES[0], result.dockerfileText);
  writeText(opts.repoRoot, DOCKERFILES[1], bunResult.dockerfileText);

  console.log(`BUMPED ${manifest.version} -> ${tag}`);
  console.log(`BRANCH=deps/regionhop-${tag}`);
  console.log(`TITLE=deps: bump regionhop to ${tag}`);
  console.log(`NOTES=https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`regionhop-bump failed: ${err.message}`);
      process.exit(1);
    });
}

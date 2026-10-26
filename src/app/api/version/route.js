import https from "https";
import fs from "fs";
import path from "path";
import pkg from "../../../../package.json" with { type: "json" };

const PINNED_HOST = "api.github.com";
const DEFAULT_REPO = "rqzbeh/KhatamRouter";
const REPO_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const VERSION_CACHE_TTL_MS = 3600000; // cache latest lookup for 1h

// Survive hot reload; one cache per process
export const versionCache = (global.__khatamVersionCache ??= { value: null, fetchedAt: 0 });

export function getUpdateRepo() {
  const custom = process.env.KHATAM_UPDATE_REPO;
  if (custom && REPO_REGEX.test(custom)) {
    return custom;
  }
  return DEFAULT_REPO;
}

function hasGitDir() {
  let curr = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(curr, ".git"))) return true;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return false;
}

export function detectRuntime() {
  if (
    process.env.KHATAM_DOCKER === "1" ||
    process.env.DATA_DIR === "/app/data" ||
    fs.existsSync("/.dockerenv")
  ) {
    return "docker";
  }
  if (hasGitDir()) {
    return "git";
  }
  return "standalone";
}

export function getInstallGuidance(runtime) {
  if (runtime === "docker") {
    return "docker compose pull && docker compose up -d";
  }
  if (runtime === "git") {
    return "git pull && bun install && bun run build:bun && bun run start:bun";
  }
  return null;
}

const SEMVER_STRICT_REGEX = /^v?([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v) {
  if (!v || typeof v !== "string" || v.length > 64) return null;
  if (/[\x00-\x1F\x7F]/.test(v)) return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  const match = trimmed.match(SEMVER_STRICT_REGEX);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

export function reconstructSemver(v) {
  const parts = parseSemver(v);
  if (!parts) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function fetchGitHubJson(pathStr) {
  return new Promise((resolve) => {
    const urlStr = `https://${PINNED_HOST}${pathStr}`;
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
      if (parsedUrl.hostname !== PINNED_HOST) {
        return resolve(null);
      }
    } catch {
      return resolve(null);
    }

    const options = {
      hostname: PINNED_HOST,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        "User-Agent": "KhatamRouter-UpdateCheck",
        "Accept": "application/vnd.github.v3+json",
      },
      timeout: 4000,
    };

    const req = https.get(urlStr, options, (res) => {
      if (res.statusCode !== 200) {
        if (typeof res.resume === "function") res.resume();
        return resolve(null);
      }
      const contentType = res.headers?.["content-type"] || "";
      if (!contentType.includes("application/json")) {
        if (typeof res.resume === "function") res.resume();
        return resolve(null);
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 512 * 1024) {
          req.destroy();
          resolve(null);
        }
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function fetchLatestReleaseVersion(repo) {
  // 1. Try releases/latest
  const release = await fetchGitHubJson(`/repos/${repo}/releases/latest`);
  if (release && typeof release.tag_name === "string" && release.tag_name.length <= 64) {
    const reconstructed = reconstructSemver(release.tag_name);
    if (reconstructed) {
      return reconstructed;
    }
  }

  // 2. Fallback to tags if releases/latest is 404 or missing tag
  const tags = await fetchGitHubJson(`/repos/${repo}/tags`);
  if (Array.isArray(tags) && tags.length > 0 && typeof tags[0]?.name === "string" && tags[0].name.length <= 64) {
    const reconstructed = reconstructSemver(tags[0].name);
    if (reconstructed) {
      return reconstructed;
    }
  }

  return null;
}

export async function getLatestVersionCached(repo) {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestReleaseVersion(repo);
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const runtime = detectRuntime();
  const installCmd = getInstallGuidance(runtime);
  const repo = getUpdateRepo();
  const releaseUrl = `https://github.com/${repo}/releases/latest`;
  const currentVersion = pkg.version;

  if (process.env.KHATAM_UPDATE_CHECK === "0") {
    return Response.json({
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      runtime,
      installCmd: null,
      releaseUrl: null,
    });
  }

  const latestVersion = await getLatestVersionCached(repo);
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    runtime,
    installCmd: hasUpdate ? installCmd : null,
    releaseUrl,
  });
}

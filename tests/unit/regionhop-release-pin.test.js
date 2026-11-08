import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import regionhopRelease from "@/lib/network/psiphon/regionhopRelease.json" with { type: "json" };
import { downloadAndVerify, sha256Hex } from "@/lib/network/psiphon/downloader.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHA_RE = /^[0-9a-f]{64}$/;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const MIN_ASSET_BYTES = 1024 * 1024;

function readDockerfileArg(name) {
  const results = [];
  for (const file of ["Dockerfile", "Dockerfile.bun"]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const matches = [...text.matchAll(new RegExp(`^ARG ${name}=(.*)$`, "gm"))];
    expect(matches, `${file} must declare ARG ${name} exactly once`).toHaveLength(1);
    results.push({ file, value: matches[0][1].trim() });
  }
  return results;
}

describe("regionhop release pin (single source of truth)", () => {
  it("manifest pins a semver tag with both amd64 and arm64 assets", () => {
    expect(regionhopRelease.version).toMatch(TAG_RE);
    expect(Object.keys(regionhopRelease.assets).sort()).toEqual(["amd64", "arm64"]);
  });

  it("manifest hashes are 64-hex and sizes are plausible tarballs", () => {
    for (const arch of ["amd64", "arm64"]) {
      const asset = regionhopRelease.assets[arch];
      expect(asset.sha256, `${arch} sha256`).toMatch(SHA_RE);
      expect(Number.isInteger(asset.size), `${arch} size`).toBe(true);
      expect(asset.size).toBeGreaterThan(MIN_ASSET_BYTES);
      expect(asset.url).toBe(
        `https://github.com/freeb5d/regionhop/releases/download/${regionhopRelease.version}/regionhop-linux-${arch}.tar.gz`
      );
    }
  });

  it("manifest URL and hashes are self-consistent (no per-arch copy/paste)", () => {
    expect(regionhopRelease.assets.amd64.sha256).not.toBe(regionhopRelease.assets.arm64.sha256);
    expect(regionhopRelease.assets.amd64.url).not.toBe(regionhopRelease.assets.arm64.url);
  });

  it("both Dockerfiles ARG-pin exactly the manifest version and hashes", () => {
    const versionArgs = readDockerfileArg("REGIONHOP_VERSION");
    const amd64Args = readDockerfileArg("REGIONHOP_SHA256_AMD64");
    const arm64Args = readDockerfileArg("REGIONHOP_SHA256_ARM64");

    for (const { file, value } of versionArgs) {
      expect(value, `${file} REGIONHOP_VERSION`).toBe(regionhopRelease.version);
    }
    for (const { file, value } of amd64Args) {
      expect(value, `${file} REGIONHOP_SHA256_AMD64`).toBe(regionhopRelease.assets.amd64.sha256);
    }
    for (const { file, value } of arm64Args) {
      expect(value, `${file} REGIONHOP_SHA256_ARM64`).toBe(regionhopRelease.assets.arm64.sha256);
    }
  });

  it("Dockerfiles verify the checksum before extracting", () => {
    for (const file of ["Dockerfile", "Dockerfile.bun"]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const shaCheck = text.indexOf("sha256sum -c -");
      const tarExtract = text.indexOf("tar -C /usr/local/bin -xzf");
      expect(shaCheck, `${file} runs sha256sum -c -`).toBeGreaterThan(-1);
      expect(tarExtract, `${file} extracts the tarball`).toBeGreaterThan(-1);
      expect(shaCheck, `${file} verifies before extracting`).toBeLessThan(tarExtract);
      expect(text, `${file} retries flaky release downloads`).toContain("--retry-all-errors");
    }
  });
});

describe("downloader hash/size verification (loopback, no external network)", () => {
  function makeFixtureTarball(dir) {
    const src = path.join(dir, "ConsoleClient");
    fs.writeFileSync(src, "#!/bin/sh\necho fake-console-client\n", { mode: 0o755 });
    const tarPath = path.join(dir, "fixture.tar.gz");
    const res = spawnSync("tar", ["-czf", tarPath, "-C", dir, "ConsoleClient"]);
    expect(res.status, res.stderr?.toString()).toBe(0);
    return fs.readFileSync(tarPath);
  }

  async function withServer(bytes, fn) {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      },
    });
    try {
      return await fn(`http://127.0.0.1:${server.port}/asset.tar.gz`);
    } finally {
      server.stop(true);
    }
  }

  it("rejects a tarball whose sha256 does not match and extracts nothing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-hash-"));
    try {
      const bytes = makeFixtureTarball(tmp);
      const targetDir = path.join(tmp, "bin");
      await withServer(bytes, async (url) => {
        await expect(
          downloadAndVerify({
            url,
            sha256: "0".repeat(64),
            size: bytes.length,
            arch: "amd64",
            version: "v9.9.9",
            targetDir,
          })
        ).rejects.toThrow(/sha256 mismatch/);
      });
      expect(fs.existsSync(path.join(targetDir, "ConsoleClient"))).toBe(false);
      // The temp tarball must be cleaned up on mismatch.
      const leftovers = fs.existsSync(targetDir)
        ? fs.readdirSync(targetDir).filter((f) => f.endsWith(".tar.gz"))
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a body whose size does not match the pinned size", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-size-"));
    try {
      const bytes = makeFixtureTarball(tmp);
      await withServer(bytes, async (url) => {
        await expect(
          downloadAndVerify({
            url,
            sha256: sha256Hex(bytes),
            size: bytes.length + 1,
            arch: "arm64",
            version: "v9.9.9",
            targetDir: path.join(tmp, "bin"),
          })
        ).rejects.toThrow(/size mismatch/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts ConsoleClient when size and sha256 both match", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ok-"));
    try {
      const bytes = makeFixtureTarball(tmp);
      const targetDir = path.join(tmp, "bin");
      let installed;
      await withServer(bytes, async (url) => {
        installed = await downloadAndVerify({
          url,
          sha256: sha256Hex(bytes),
          size: bytes.length,
          arch: "amd64",
          version: "v9.9.9",
          targetDir,
        });
      });
      expect(installed).toBe(path.join(targetDir, "ConsoleClient"));
      expect(fs.existsSync(installed)).toBe(true);
      expect(fs.statSync(installed).mode & 0o111).toBeTruthy();
      // Every ConsoleClient must land inside its own target dir: never the
      // repository root, tests/, or any other CWD-relative location.
      expect(path.dirname(installed)).toBe(targetDir);
      expect(installed.startsWith(REPO_ROOT + path.sep)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

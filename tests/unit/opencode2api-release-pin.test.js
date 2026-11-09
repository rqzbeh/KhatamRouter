import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opencode2apiRelease from "@/lib/network/opencode2api/opencode2apiRelease.json" with { type: "json" };

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

describe("opencode2api release pin (single source of truth)", () => {
  it("manifest pins a semver tag with both amd64 and arm64 assets and license GPL-3.0", () => {
    expect(opencode2apiRelease.version).toMatch(TAG_RE);
    expect(opencode2apiRelease.license).toBe("GPL-3.0");
    expect(Object.keys(opencode2apiRelease.assets).sort()).toEqual(["amd64", "arm64"]);
  });

  it("manifest hashes are 64-hex and sizes are plausible tarballs", () => {
    for (const arch of ["amd64", "arm64"]) {
      const asset = opencode2apiRelease.assets[arch];
      expect(asset.sha256, `${arch} sha256`).toMatch(SHA_RE);
      expect(Number.isInteger(asset.size), `${arch} size`).toBe(true);
      expect(asset.size).toBeGreaterThan(MIN_ASSET_BYTES);
      expect(asset.url).toBe(
        `https://github.com/jasonxu114514/opencode2api/releases/download/${opencode2apiRelease.version}/opencode2api_${opencode2apiRelease.version}_linux_${arch}.tar.gz`
      );
    }
  });

  it("manifest URL and hashes are distinct (no per-arch copy/paste)", () => {
    expect(opencode2apiRelease.assets.amd64.sha256).not.toBe(opencode2apiRelease.assets.arm64.sha256);
    expect(opencode2apiRelease.assets.amd64.url).not.toBe(opencode2apiRelease.assets.arm64.url);
  });

  it("both Dockerfiles ARG-pin exactly the manifest version and hashes, verify and install binary", () => {
    const versionArgs = readDockerfileArg("OPENCODE2API_VERSION");
    const amd64Args = readDockerfileArg("OPENCODE2API_SHA256_AMD64");
    const arm64Args = readDockerfileArg("OPENCODE2API_SHA256_ARM64");

    for (const { file, value } of versionArgs) {
      expect(value, `${file} OPENCODE2API_VERSION`).toBe(opencode2apiRelease.version);
    }
    for (const { file, value } of amd64Args) {
      expect(value, `${file} OPENCODE2API_SHA256_AMD64`).toBe(opencode2apiRelease.assets.amd64.sha256);
    }
    for (const { file, value } of arm64Args) {
      expect(value, `${file} OPENCODE2API_SHA256_ARM64`).toBe(opencode2apiRelease.assets.arm64.sha256);
    }

    for (const file of ["Dockerfile", "Dockerfile.bun"]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(text.includes("sha256sum -c -"), `${file} runs sha256sum -c -`).toBe(true);
      expect(
        text.includes("COPY --from=builder /usr/local/bin/opencode2api /usr/local/bin/opencode2api"),
        `${file} copies opencode2api into runner`
      ).toBe(true);
      expect(
        text.includes("test -x /usr/local/bin/opencode2api"),
        `${file} verifies opencode2api executable`
      ).toBe(true);
    }
  });
});

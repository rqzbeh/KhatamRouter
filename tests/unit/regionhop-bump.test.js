import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import regionhopRelease from "@/lib/network/psiphon/regionhopRelease.json" with { type: "json" };
import { rewriteRegionhopFiles, selectReleaseAssets, ASSET_NAMES, MANIFEST_REL } from "../../scripts/ci/regionhop-bump.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MANIFEST_TEXT = fs.readFileSync(path.join(REPO_ROOT, MANIFEST_REL), "utf8");
const DOCKERFILE_TEXT = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const V2 = "v1.28.0";

function assetsFor(version, { amd64 = SHA_A, arm64 = SHA_B } = {}) {
  return {
    amd64: {
      url: `https://github.com/freeb5d/regionhop/releases/download/${version}/regionhop-linux-amd64.tar.gz`,
      sha256: amd64,
      size: 36_000_000,
    },
    arm64: {
      url: `https://github.com/freeb5d/regionhop/releases/download/${version}/regionhop-linux-arm64.tar.gz`,
      sha256: arm64,
      size: 33_000_000,
    },
  };
}

describe("regionhop-bump pure rewrite", () => {
  it("reports no change when the manifest already pins the release", () => {
    const result = rewriteRegionhopFiles({
      manifestText: MANIFEST_TEXT,
      dockerfileText: DOCKERFILE_TEXT,
      version: regionhopRelease.version,
      assets: regionhopRelease.assets,
    });
    expect(result.changed).toBe(false);
    expect(JSON.parse(result.manifestText)).toEqual(regionhopRelease);
    expect(result.dockerfileText).toBe(DOCKERFILE_TEXT);
  });

  it("rewrites manifest and Dockerfile ARGs for a new release", () => {
    const result = rewriteRegionhopFiles({
      manifestText: MANIFEST_TEXT,
      dockerfileText: DOCKERFILE_TEXT,
      version: V2,
      assets: assetsFor(V2),
    });
    expect(result.changed).toBe(true);

    const manifest = JSON.parse(result.manifestText);
    expect(manifest.version).toBe(V2);
    expect(manifest.assets.amd64.sha256).toBe(SHA_A);
    expect(manifest.assets.arm64.sha256).toBe(SHA_B);
    expect(manifest.assets.amd64.url).toContain(`/${V2}/regionhop-linux-amd64.tar.gz`);

    expect(result.dockerfileText).toContain(`ARG REGIONHOP_VERSION=${V2}`);
    expect(result.dockerfileText).toContain(`ARG REGIONHOP_SHA256_AMD64=${SHA_A}`);
    expect(result.dockerfileText).toContain(`ARG REGIONHOP_SHA256_ARM64=${SHA_B}`);
    // ARG rewrites must not disturb unrelated lines.
    expect(result.dockerfileText).toContain("sha256sum -c -");
  });

  it("rejects a malformed tag before touching anything", () => {
    for (const bad of ["1.28.0", "v1.28", "v1.28.0-rc1", "v1.28.0; rm -rf /", ""]) {
      expect(() =>
        rewriteRegionhopFiles({
          manifestText: MANIFEST_TEXT,
          dockerfileText: DOCKERFILE_TEXT,
          version: bad,
          assets: assetsFor(V2),
        })
      ).toThrow(/invalid release tag/);
    }
  });

  it("rejects assets with non-hex hashes or implausible sizes", () => {
    expect(() =>
      rewriteRegionhopFiles({
        manifestText: MANIFEST_TEXT,
        dockerfileText: DOCKERFILE_TEXT,
        version: V2,
        assets: assetsFor(V2, { amd64: "nothex" }),
      })
    ).toThrow(/sha256/);

    const small = assetsFor(V2);
    small.amd64.size = 10;
    expect(() =>
      rewriteRegionhopFiles({ manifestText: MANIFEST_TEXT, dockerfileText: DOCKERFILE_TEXT, version: V2, assets: small })
    ).toThrow(/size/);
  });

  it("rejects asset URLs that point at a different host or asset name", () => {
    const evil = assetsFor(V2);
    evil.amd64.url = "https://evil.example.com/regionhop-linux-amd64.tar.gz";
    expect(() =>
      rewriteRegionhopFiles({ manifestText: MANIFEST_TEXT, dockerfileText: DOCKERFILE_TEXT, version: V2, assets: evil })
    ).toThrow(/url/);

    const wrongName = assetsFor(V2);
    wrongName.arm64.url = `https://github.com/freeb5d/regionhop/releases/download/${V2}/regionhop-linux-amd64.tar.gz`;
    expect(() =>
      rewriteRegionhopFiles({ manifestText: MANIFEST_TEXT, dockerfileText: DOCKERFILE_TEXT, version: V2, assets: wrongName })
    ).toThrow(/url/);
  });

  it("rejects a Dockerfile missing one of the ARG pins", () => {
    const broken = DOCKERFILE_TEXT.replace(/^ARG REGIONHOP_SHA256_ARM64=.*$/m, "");
    expect(() =>
      rewriteRegionhopFiles({
        manifestText: MANIFEST_TEXT,
        dockerfileText: broken,
        version: V2,
        assets: assetsFor(V2),
      })
    ).toThrow(/REGIONHOP_SHA256_ARM64/);
  });
});

describe("regionhop bump workflow shape", () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/regionhop-release.yml"), "utf8");

  it("never writes a secret into $GITHUB_OUTPUT or a command line", () => {
    expect(workflow).not.toMatch(/echo\s+"?(value|token)=\$\{?\{?\s*secrets\./i);
    expect(workflow).not.toMatch(/GITHUB_OUTPUT[\s\S]{0,80}secrets\.REGIONHOP_BUMP_TOKEN/);
    expect(workflow).not.toMatch(/https:\/\/[^"'\s]*\$\{?\{?\s*secrets\./);
    // The token only reaches steps as an env value.
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.REGIONHOP_BUMP_TOKEN || github.token }}");
  });

  it("does not force-push over an existing bump branch", () => {
    expect(workflow).not.toMatch(/git push\s+--force/);
    expect(workflow).toContain('existing=true');
  });

  it("declares workflow_dispatch so a maintainer can start Verify manually", () => {
    expect(workflow).toMatch(/^  workflow_dispatch:$/m);
    expect(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify.yml"), "utf8")).toMatch(
      /^  workflow_dispatch:$/m
    );
  });

  it("carries the required attribution footer on generated PR content", () => {
    expect(workflow).toContain("Generated with [Claude Code](https://claude.com/claude-code)");
    expect(workflow).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
  });

  it("keeps least-privilege workflow permissions", () => {
    const block = workflow.slice(workflow.indexOf("permissions:"));
    const perms = block.slice(0, block.indexOf("\n\n"));
    expect(perms).toContain("contents: write");
    expect(perms).toContain("pull-requests: write");
    expect(perms).toContain("actions: write");
    expect(workflow).not.toContain("permissions: write-all");
    // Only the three needed scopes, each declared once.
    const scopes = [...perms.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
    expect(scopes.sort()).toEqual(["actions", "contents", "pull-requests"]);
  });
});

describe("regionhop-bump release asset selection", () => {
  function releaseFor(version, { missing, size = 36_000_000 } = {}) {
    const assets = Object.entries(ASSET_NAMES)
      .filter(([arch]) => arch !== missing)
      .map(([arch, name], i) => ({
        id: 1000 + i,
        name,
        state: "uploaded",
        size,
        browser_download_url: `https://github.com/freeb5d/regionhop/releases/download/${version}/${name}`,
      }));
    return { tag_name: version, assets };
  }

  it("selects both expected assets by exact name, id and size", () => {
    const selected = selectReleaseAssets(releaseFor(V2), V2);
    expect(selected.amd64.name).toBe(ASSET_NAMES.amd64);
    expect(selected.arm64.name).toBe(ASSET_NAMES.arm64);
    expect(selected.amd64.id).toBe(1000);
    expect(selected.amd64.size).toBe(36_000_000);
  });

  it("throws when an expected asset is missing", () => {
    expect(() => selectReleaseAssets(releaseFor(V2, { missing: "arm64" }), V2)).toThrow(/missing expected asset/);
  });

  it("throws when an asset has an implausible declared size", () => {
    expect(() => selectReleaseAssets(releaseFor(V2, { size: 5 }), V2)).toThrow(/implausible declared size/);
  });

  it("throws when an asset URL is not the exact upstream release URL", () => {
    const release = releaseFor(V2);
    release.assets[0].browser_download_url = "https://evil.example.com/x.tar.gz";
    expect(() => selectReleaseAssets(release, V2)).toThrow(/unexpected download URL/);
  });

  it("throws when the release tag does not match the validated tag", () => {
    expect(() => selectReleaseAssets(releaseFor(V2), "v1.29.0")).toThrow(/does not match/);
  });

  it("throws on a not-fully-uploaded asset", () => {
    const release = releaseFor(V2);
    release.assets[0].state = "starter";
    expect(() => selectReleaseAssets(release, V2)).toThrow(/not fully uploaded/);
  });
});

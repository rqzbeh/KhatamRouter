import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
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

// The container path is pinned above. The runtime path (a non-Docker install)
// actually downloads, verifies and extracts, so it needs real coverage rather
// than relying on whatever the network did during another suite.
describe("opencode2api downloader", async () => {
  const { installSidecarBinary, ensureSidecarBinary, __sha256Hex } = await import(
    "@/lib/network/opencode2api/downloader.js"
  );
  const { execSync } = await import("node:child_process");

  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = opencode2apiRelease.assets[arch];

  function makeTarball(payload) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-tar-"));
    const inner = `opencode2api_${opencode2apiRelease.version}_linux_${arch}`;
    fs.mkdirSync(path.join(work, inner));
    fs.writeFileSync(path.join(work, inner, "opencode2api"), payload);
    const tarPath = path.join(work, "asset.tar.gz");
    execSync(`tar -C ${work} -czf ${tarPath} ${inner}`);
    return fs.readFileSync(tarPath);
  }

  function fakeResponse(buf, { omitLength = false } = {}) {
    const headers = new Map();
    if (!omitLength) headers.set("content-length", String(buf.length));
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(buf));
          c.close();
        },
      }),
    };
  }

  function stubManifest(t, sha256, size) {
    const original = opencode2apiRelease.assets[arch];
    opencode2apiRelease.assets[arch] = { ...original, sha256, size };
    t.onTestFinished(() => {
      opencode2apiRelease.assets[arch] = original;
    });
  }

  it("installs a verified tarball atomically with an executable bit", async (t) => {
    const tarball = makeTarball("#!/bin/sh\necho sidecar\n");
    stubManifest(t, __sha256Hex(tarball), tarball.length);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-"));

    const installed = await installSidecarBinary({
      fetchImpl: async () => fakeResponse(tarball),
      targetDir,
    });

    expect(installed).toBe(path.join(targetDir, "opencode2api"));
    expect(fs.readFileSync(installed, "utf8")).toBe("#!/bin/sh\necho sidecar\n");
    expect(fs.statSync(installed).mode & 0o111).toBeTruthy();
    // The per-invocation work dir is swept.
    expect(fs.readdirSync(targetDir).filter((n) => n.startsWith(".opencode2api-install-"))).toEqual([]);
  });

  it("rejects a sha256 mismatch instead of installing", async (t) => {
    const tarball = makeTarball("payload");
    stubManifest(t, "0".repeat(64), tarball.length);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-"));

    await expect(
      installSidecarBinary({ fetchImpl: async () => fakeResponse(tarball), targetDir })
    ).rejects.toThrow(/sha256 mismatch/);
    expect(fs.existsSync(path.join(targetDir, "opencode2api"))).toBe(false);
  });

  it("rejects a size mismatch before extracting", async (t) => {
    const tarball = makeTarball("payload");
    stubManifest(t, __sha256Hex(tarball), tarball.length + 1);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-"));

    await expect(
      installSidecarBinary({ fetchImpl: async () => fakeResponse(tarball, { omitLength: true }), targetDir })
    ).rejects.toThrow(/size mismatch/);
  });

  it("rejects a non-OK HTTP status", async (t) => {
    stubManifest(t, "0".repeat(64), 64);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-"));

    await expect(
      installSidecarBinary({
        fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }),
        targetDir,
      })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("never replaces an already-installed binary", async (t) => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-"));
    const existing = path.join(targetDir, "opencode2api");
    fs.writeFileSync(existing, "operator-managed");
    let fetched = 0;

    const installed = await installSidecarBinary({
      fetchImpl: async () => {
        fetched++;
        return fakeResponse(makeTarball("new"));
      },
      targetDir,
    });

    expect(fetched).toBe(0);
    expect(fs.readFileSync(installed, "utf8")).toBe("operator-managed");
  });

  it("ensureSidecarBinary prefers an existing OPENCODE2API_BIN and falls back on failure", async (t) => {
    const originalBin = process.env.OPENCODE2API_BIN;
    t.onTestFinished(() => {
      if (originalBin === undefined) delete process.env.OPENCODE2API_BIN;
      else process.env.OPENCODE2API_BIN = originalBin;
    });

    const existing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "o2a-bin-")), "opencode2api");
    fs.writeFileSync(existing, "x");
    process.env.OPENCODE2API_BIN = existing;
    await expect(ensureSidecarBinary({})).resolves.toBe(existing);

    // Configured-but-missing installs; a failed download still yields a path so
    // the spawn error names what was expected rather than throwing here.
    process.env.OPENCODE2API_BIN = path.join(os.tmpdir(), "o2a-missing-never-exists");
    const warns = [];
    const result = await ensureSidecarBinary({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      targetDir: fs.mkdtempSync(path.join(os.tmpdir(), "o2a-install-")),
      log: { warn: (tag, msg) => warns.push(`${tag}:${msg}`) },
    });
    expect(warns.join()).toMatch(/Auto-download failed: offline/);
    expect(typeof result).toBe("string");
  });
});

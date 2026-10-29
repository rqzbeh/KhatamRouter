// Bun version single source of truth: root `.bun-version`.
// Every pin (Dockerfiles, packageManager, engines, CI setup-bun) must agree with it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(__dirname, "../../");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const VERSION = read(".bun-version").trim();
const DEPENDABOT_HINT =
  "Dependabot bumps only the Dockerfile base image: update .bun-version, package.json packageManager and engines in the same PR";
const EDIT_HINT = "Edit .bun-version as the single source of truth, then align the pin below";

// Previous pin, reported (not asserted) as stray mentions. Update on the next bump.
const PREVIOUS_VERSION = "1.4.3";
// Historical or measured-result text that legitimately names an older Bun version.
const STRAY_ALLOWLIST = [
  /^CHANGELOG\.md$/,
  /^specs\//,
  /^\.unlazy\//,
  /^tests\/__baseline__\/current\.json$/,
  /^tests\/unit\/bun-version-consistency\.test\.js$/,
];

describe("Bun version consistency (.bun-version is the single source of truth)", () => {
  it(".bun-version holds a plain semver with a trailing newline", () => {
    expect(read(".bun-version")).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("Dockerfile and Dockerfile.bun use oven/bun:<version>-slim at every FROM line", () => {
    for (const rel of ["Dockerfile", "Dockerfile.bun"]) {
      // Filter out internal multi-stage alias targets (e.g. `FROM base AS builder`)
      const froms = read(rel)
        .split("\n")
        .filter((l) => /^\s*FROM\s+(?!base\b)\S+/i.test(l));
      expect(froms.length, `${rel} has no external FROM lines`).toBeGreaterThan(0);
      for (const line of froms) {
        expect(
          line,
          `${rel}: FROM line must use oven/bun:${VERSION}-slim. ${EDIT_HINT} in ${rel}. ${DEPENDABOT_HINT}`
        ).toContain(`oven/bun:${VERSION}-slim`);
      }
    }
  });

  it("package.json packageManager matches .bun-version", () => {
    expect(
      readJson("package.json").packageManager,
      `package.json: set "packageManager" to bun@${VERSION}. ${EDIT_HINT} in package.json. ${DEPENDABOT_HINT}`
    ).toBe(`bun@${VERSION}`);
  });

  it.each(["package.json", "cli/package.json", "tests/package.json"])(
    "%s engines.bun is >=<version>",
    (rel) => {
      expect(
        readJson(rel).engines?.bun,
        `${rel}: set "engines.bun" to ">=${VERSION}". ${EDIT_HINT} in ${rel}. ${DEPENDABOT_HINT}`
      ).toBe(`>=${VERSION}`);
    }
  );

  it("every oven-sh/setup-bun step reads .bun-version or pins the exact version", () => {
    const wfDir = path.join(REPO_ROOT, ".github/workflows");
    const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
    let steps = 0;
    for (const f of files) {
      const rel = `.github/workflows/${f}`;
      const doc = yaml.load(read(rel));
      for (const job of Object.values(doc?.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          if (!String(step?.uses ?? "").startsWith("oven-sh/setup-bun@")) continue;
          steps++;
          const w = step.with ?? {};
          const fromFile = w["bun-version-file"] === ".bun-version";
          const exact = String(w["bun-version"] ?? "") === VERSION;
          expect(
            fromFile || exact,
            `${rel}: setup-bun step must use "bun-version-file: .bun-version" (or bun-version: ${VERSION}). ${EDIT_HINT} in ${rel}. ${DEPENDABOT_HINT}`
          ).toBe(true);
        }
      }
    }
    expect(steps, "no oven-sh/setup-bun steps found; check the workflow scan").toBeGreaterThan(0);
  });

  it("reports stray tracked mentions of the previous version outside the allowlist (informational)", () => {
    const res = spawnSync("git", ["-C", REPO_ROOT, "ls-files"], { encoding: "utf8" });
    if (res.status !== 0) return; // not a git checkout; nothing to report
    const needle = new RegExp(`(?<![\\d.])${PREVIOUS_VERSION.replace(/\./g, "\\.")}(?![\\d])`);
    const strays = [];
    for (const rel of res.stdout.split("\n").filter(Boolean)) {
      if (STRAY_ALLOWLIST.some((re) => re.test(rel))) continue;
      if (/\.(png|jpe?g|gif|ico|woff2?|zip|gz|sqlite|lock)$/i.test(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (needle.test(line)) strays.push(`${rel}:${i + 1}`);
      });
    }
    if (strays.length) {
      console.log(`[bun-version] stray ${PREVIOUS_VERSION} mentions (review, not asserted):\n  ${strays.join("\n  ")}`);
    }
    expect(Array.isArray(strays)).toBe(true);
  });
});

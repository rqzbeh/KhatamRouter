import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Transitive import closure of src/lib/db/driver.js (static + dynamic, '@/' resolved via jsconfig.json).
// custom-server.js's primary runs migrations through this graph before forking workers.
const DRIVER_CLOSURE = [
  "jsconfig.json",
  "src/lib/dataDir.js",
  "src/lib/db/adapters/bunSqliteAdapter.js",
  "src/lib/db/backup.js",
  "src/lib/db/driver.js",
  "src/lib/db/helpers/jsonCol.js",
  "src/lib/db/helpers/metaStore.js",
  "src/lib/db/migrate.js",
  "src/lib/db/migrationRunner.js",
  "src/lib/db/migrations/001-initial.js",
  "src/lib/db/migrations/002-wave2-storage-quota.js",
  "src/lib/db/migrations/003-wave4-circuit-breaker.js",
  "src/lib/db/migrations/004-wave6-model-capabilities.js",
  "src/lib/db/migrations/index.js",
  "src/lib/db/paths.js",
  "src/lib/db/schema.js",
  "src/lib/db/version.js",
];

function createBuildFixture(distDir) {
  const projectRoot = mkdtempSync(join(tmpdir(), "9router-standalone-assets-"));
  const buildRoot = join(projectRoot, distDir);
  mkdirSync(join(buildRoot, "standalone"), { recursive: true });
  mkdirSync(join(buildRoot, "static", "chunks"), { recursive: true });
  mkdirSync(join(projectRoot, "public"), { recursive: true });
  writeFileSync(join(buildRoot, "static", "chunks", "app.js"), "static asset");
  writeFileSync(join(projectRoot, "public", "favicon.svg"), "public asset");
  return projectRoot;
}

describe("standalone build assets", () => {
  it("copies static and public assets into the default standalone layout", () => {
    const projectRoot = createBuildFixture(".next");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
    expect(readFileSync(join(projectRoot, ".next", "standalone", "public", "favicon.svg"), "utf8"))
      .toBe("public asset");
  });

  it("uses a custom Next dist directory", () => {
    const projectRoot = createBuildFixture(".next-cli-build");

    copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });

    expect(readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
  });

  // Without the wrapper beside server.js nothing can prove a request is local.
  it("copies the request-sanitizing server wrapper into the standalone output", () => {
    const projectRoot = createBuildFixture(".next");
    writeFileSync(join(projectRoot, "custom-server.js"), "wrapper");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", "custom-server.js"), "utf8"))
      .toBe("wrapper");
  });

  it("does not modify workspace-traced CLI builds", () => {
    const projectRoot = createBuildFixture(".next-cli-build");
    const previousMode = process.env.NEXT_TRACING_ROOT_MODE;
    process.env.NEXT_TRACING_ROOT_MODE = "workspace";

    try {
      copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_TRACING_ROOT_MODE;
      else process.env.NEXT_TRACING_ROOT_MODE = previousMode;
    }

    expect(() => readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js")))
      .toThrow();
  });
});

// Regression: Dockerfile.bun runner had no src/lib/db on disk, so custom-server.js
// runMigrationsOnce() returned false and KHATAM_WORKERS=2 fell back to single-process.
describe("standalone migration driver closure", () => {
  it("copies the driver.js import closure and jsconfig.json into the standalone output", () => {
    const projectRoot = createBuildFixture(".next");
    for (const rel of DRIVER_CLOSURE) {
      const dest = join(projectRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(REPO, rel), dest);
    }

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    const standalone = join(projectRoot, ".next", "standalone");
    for (const rel of DRIVER_CLOSURE) {
      expect(existsSync(join(standalone, rel)), rel).toBe(true);
    }
  });

  it("standalone child process imports driver.js and applies migrations via getAdapter()", () => {
    const projectRoot = createBuildFixture(".next");
    for (const rel of DRIVER_CLOSURE) {
      const dest = join(projectRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(REPO, rel), dest);
    }
    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    const standalone = join(projectRoot, ".next", "standalone");
    // Next emits package.json into standalone; version.js reads it from cwd (the standalone dir).
    cpSync(join(REPO, "package.json"), join(standalone, "package.json"));
    const dataDir = mkdtempSync(join(tmpdir(), "khatam-standalone-data-"));
    try {
      const driverUrl = pathToFileURL(join(standalone, "src", "lib", "db", "driver.js")).href;
      const script = `
        const { getAdapter } = await import(${JSON.stringify(driverUrl)});
        const adapter = await getAdapter();
        const tables = adapter.all("SELECT name FROM sqlite_master WHERE type='table' AND name='_khatam_migrations'");
        const applied = adapter.all("SELECT version FROM _khatam_migrations");
        console.log(JSON.stringify({ tables: tables.length, applied: applied.length }));
        adapter.close?.();
      `;
      const result = spawnSync("bun", ["-e", script], {
        cwd: standalone,
        env: { ...process.env, DATA_DIR: dataDir, DATA_DIR_ALLOW_TEMP: "1", NODE_ENV: "test", KHATAM_WORKERS: "", KHATAM_MIGRATIONS_DONE: "" },
        encoding: "utf8",
        timeout: 60000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout.trim().split("\n").pop());
      expect(report.tables).toBe(1);
      expect(report.applied).toBeGreaterThan(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);
});

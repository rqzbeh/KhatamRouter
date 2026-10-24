#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const isDryRun = process.argv.includes("--dry-run");

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

// 1. Verify package.json contains no pruned SQLite drivers
const pkgPath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const allDeps = {
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
  ...(pkg.optionalDependencies || {}),
};

assert(!allDeps["better-sqlite3"], "package.json still contains better-sqlite3 in dependencies");
assert(!allDeps["sql.js"], "package.json still contains sql.js in dependencies");

// 2. Verify next.config.mjs does not include pruned drivers in serverExternalPackages
const nextConfigPath = path.join(repoRoot, "next.config.mjs");
const nextConfigContent = fs.readFileSync(nextConfigPath, "utf8");
const externalMatch = nextConfigContent.match(/serverExternalPackages:\s*\[([^\]]+)\]/);
if (externalMatch) {
  const list = externalMatch[1];
  assert(!list.includes("better-sqlite3"), "next.config.mjs serverExternalPackages includes better-sqlite3");
  assert(!list.includes("sql.js"), "next.config.mjs serverExternalPackages includes sql.js");
  assert(!list.includes("node:sqlite"), "next.config.mjs serverExternalPackages includes node:sqlite");
  assert(list.includes("bun:sqlite"), "next.config.mjs serverExternalPackages missing bun:sqlite");
} else {
  failures.push("next.config.mjs does not declare serverExternalPackages");
}

// 3. Verify obsolete adapter files are deleted
const deletedAdapters = [
  "src/lib/db/adapters/betterSqliteAdapter.js",
  "src/lib/db/adapters/nodeSqliteAdapter.js",
  "src/lib/db/adapters/sqljsAdapter.js",
];
for (const rel of deletedAdapters) {
  const full = path.join(repoRoot, rel);
  assert(!fs.existsSync(full), `Obsolete adapter file still exists: ${rel}`);
}

// 4. Verify bun:sqlite adapter exists
const bunAdapterPath = path.join(repoRoot, "src/lib/db/adapters/bunSqliteAdapter.js");
assert(fs.existsSync(bunAdapterPath), "src/lib/db/adapters/bunSqliteAdapter.js does not exist");

// 5. Verify direct readers do not reference better-sqlite3 or node:sqlite
const directReaders = [
  "src/lib/oauth/utils/zedCredentials.js",
  "src/app/api/oauth/cursor/auto-import/route.js",
  "src/app/api/cli-tools/omp-settings/route.js",
  "open-sse/shared/mimoAccount.js",
];
for (const rel of directReaders) {
  const full = path.join(repoRoot, rel);
  const content = fs.readFileSync(full, "utf8");
  assert(!content.includes("better-sqlite3"), `Direct consumer ${rel} still contains 'better-sqlite3'`);
  assert(!content.includes("node:sqlite"), `Direct consumer ${rel} still contains 'node:sqlite'`);
}

// 6. Verify driver.js and migrationRunner do not contain pruned drivers
const dbSourceFiles = [
  "src/lib/db/driver.js",
  "src/lib/db/migrationRunner.js",
];
for (const rel of dbSourceFiles) {
  const full = path.join(repoRoot, rel);
  const content = fs.readFileSync(full, "utf8");
  assert(!content.includes("better-sqlite3"), `${rel} contains 'better-sqlite3'`);
  assert(!content.includes("sql.js"), `${rel} contains 'sql.js'`);
}

// 7. Verify driver.js fail-closed check and MIGRATED_MARKER
const driverContent = fs.readFileSync(path.join(repoRoot, "src/lib/db/driver.js"), "utf8");
assert(driverContent.includes("process.versions.bun"), "src/lib/db/driver.js missing fail-closed process.versions.bun check");
assert(driverContent.includes("MIGRATED_MARKER"), "src/lib/db/driver.js missing MIGRATED_MARKER reference");

if (failures.length > 0) {
  console.error("FAIL: Static driver pruning verification failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (isDryRun) {
  console.log("PASS: Static driver pruning verification passed (dry-run)");
} else {
  console.log("PASS: Static driver pruning verification passed");
}

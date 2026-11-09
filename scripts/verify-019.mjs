#!/usr/bin/env bun
/**
 * scripts/verify-019.mjs
 * Authoritative verification oracle for Spec 019: 9router 0.5.112..0.5.116 Parity.
 *
 * Invariants checked:
 * 1. Exact 43 immutable SHA identities in exact order from rev-list 3a978a63..1339107e.
 * 2. All commits have allowed FINAL terminal dispositions (no pending/applicable statuses).
 * 3. Every referenced source and unit test file path in localEvidence exists on disk within root.
 * 4. Package versions: root package.json === 0.5.116 and cli/package.json === 0.5.116.
 * 5. Supplemental source markers checking key security/architecture touchpoints.
 * 6. Includes self-test mode (--self-test) testing positive and negative control mutations.
 *
 * Emits "SPEC_019_VERIFIED" on success.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

export const ALLOWED_FINAL_DISPOSITIONS = new Set([
  "PORTED",
  "PORTED_HARDENED",
  "ALREADY_EQUIVALENT",
  "ALREADY_EQUIVALENT_SUPERIOR",
  "ADAPT",
  "ADAPTED",
  "ADAPT_WITH_SECURITY_HARDENING",
  "ADAPTED_WITH_SECURITY_HARDENING",
  "ARCHITECTURALLY_INAPPLICABLE",
  "RELEASE_BOUNDARY",
]);

export const EXPECTED_TOTAL_COMMITS = 43;
export const EXPECTED_PRIOR_COMMITS = 14;
export const EXPECTED_NEW_COMMITS = 29;
export const EXPECTED_VERSION = "0.5.116";

export const ORDERED_43_SHAS = [
  "e70ea24d4e2399f59680bbdc71159195ffbdc500",
  "acb3c080ddcafc9e32971af8b8240214b5950952",
  "3fd925abfabb7cbe95e602cddff67a62246a13e6",
  "f3e1f716a3bf522ed74e6566f9049e52c28d2f93",
  "b1effa03c12b76e1df6c6014fe274044f7b46b17",
  "a199d777d6e304f560777aecb10c74d0e058e17e",
  "ced0cf6e6c5583e82d7d66e2555712b5dbbf7809",
  "f7f6f5ed11e6c10f3c7a2a90c4cc6f6fe4859561",
  "8db1f4ae58429a9d0c13449d3a9a72d9aafa89dc",
  "56dbf466f10787d284b09bd28e35c0f7171b6d06",
  "3b7acf72a5611705b9a5f5923430175ad159d3c1",
  "d7bb71ced4bd9aac1fcb53a91cb3776144ebedb7",
  "85d73bd60ebd3950f8a0bc603f4b79a2856cc141",
  "1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d",
  "736be95716147a5cf8f1e99f9a2e8e8481d9c688",
  "f0938ea7151545837ae24e33577607a8cee0f90e",
  "633c82f565807dca3d7ba51c03e8dde0aa7f7e82",
  "783c9325f37e32d9a9121146a58ed3e833f16264",
  "cff5328b89d0974d89c8c911e5464cbb026ee49b",
  "95dafae3ad3e9fd8e4b4ec0f6aa8567f285086ff",
  "a4069daf0dc36299db7c869c8049cfa41a9e83ca",
  "a61b5a6f39cb65ab709d65fa20851c3c9af10a51",
  "9506a59c7f8b138cbeb1a8d2789a39252823dbbd",
  "7ba1d1ca21ab61fd8e867bea99e2e1f783e5986e",
  "ef2af4defaf5b72af93964c0d565b5fca43b0aee",
  "a6d3cdbf7ece0de79671f4890f3d0a9ac5c035fc",
  "64a23dc2b63cd71ed234ca51bee5a29a13a215c1",
  "8a83363109886d7c4f836ec5c315c6095709cfb6",
  "93bec5d8bf818276a09a896ad280825130ae5fcd",
  "333d249dfb63c29c20a12131279a07a40892f5af",
  "626a0684a7a76fd9925f189dcc859735efbbb1de",
  "896ef10ce63be264b457765015d3a0ed9c9e6872",
  "8650b04611e98f6415853c8930953219e8ef1711",
  "b9c34543b4d6cf833bbe47b59ca7b768bc5b4e14",
  "963787f73fe00bd068b786cf93f69c4c4fea96c2",
  "3ca0463989976a311302869bdc25684c37b56468",
  "b114fa9f6fd50e7b2405fed9b01a09eed3e5cfa2",
  "7ef6df5615118fcf041aaeb588618e233a8446a6",
  "69d51c0c3f2d85b3f9aee10fd5f1e1ff5b1d30ef",
  "e3139a43033d5947cd8e24a554644144150a3325",
  "a3039ab141c4dfc71aab434cdd2c94579bceaa42",
  "eaeb54a66a4ff0f4aa5e933cfa41f5cb25952441",
  "1339107e624d1ab150c6a0c2c2ee22caa7e9db2f",
];

export const TARGETED_019_TEST_FILES = [
  // Leaf 2.1 (Translator & CommandCode)
  "tests/translator/thinking-tool-result-turns.test.js",
  "tests/unit/provider-thinking-config.test.js",
  "tests/unit/dashscope-claude-cache.test.js",
  "tests/unit/deepseek-thinking-budget.test.js",
  "tests/unit/gemini-request-tool-results.test.js",
  "tests/unit/tool-dedupe.test.js",
  "tests/unit/commandcode-headers.test.js",
  "tests/unit/commandcode-usage.test.js",
  "tests/unit/commandcode-to-openai.test.js",
  "tests/unit/openai-to-commandcode.test.js",
  "tests/unit/oauth-commandcode-auto-import.test.js",
  "tests/unit/commandcode-import-guard.test.js",
  // Leaf 2.2 (Transport & OpenCode Go)
  "tests/unit/econnreset-repro.test.js",
  "tests/unit/proxy-keepalive-dead-socket.test.js",
  "tests/unit/kiro-api-key-endpoint-routing.test.js",
  "tests/unit/codebuddy-intl-system-prompt.test.js",
  "tests/unit/opencode-go-deepseek-thinking-injection.test.js",
  "tests/unit/opencode-go-models.test.js",
  "tests/unit/opencode-go-muse-spark-responses.test.js",
  "tests/unit/opencode-go-session.test.js",
  "tests/unit/opencode-go-transport-routing.test.js",
  "tests/unit/opencode-go-usage.test.js",
  "tests/unit/strict-proxy-enforcement.test.js",
  "tests/unit/transport-019-safety.test.js",
  // Leaf 2.3 (Media, Argon Quota & Format Forwarding)
  "tests/unit/codex-native-image-generation.test.js",
  "tests/unit/image-generation.test.js",
  "tests/unit/multimodal-drop-lock.test.js",
  "tests/unit/antigravity-quota-routing.test.js",
  "tests/unit/antigravity-weekly-dashboard.test.js",
  "tests/unit/antigravity-weekly-quota.test.js",
  "tests/unit/jina-reader-fetch.test.js",
  "tests/unit/web-fetch-formats.test.js",
  "tests/unit/media-019-security.test.js",
  // Leaf 2.4 (CLI & Audio Voices)
  "tests/unit/cli-build-artifacts.test.js",
  "tests/unit/cli-launcher-process.test.js",
  "tests/unit/cli-tray-runtime.test.js",
  "tests/unit/cli-tools-add-all-active-models.test.js",
  "tests/unit/audio-voices-internal-auth.test.js",
  "tests/unit/cli-019-bun.test.js",
  // Packaging & Cross-Regressions
  "tests/unit/transport-019-packaging.test.js",
  "tests/translator/agent-client-fixes.test.js",
  "tests/unit/opencode-test-no-probe.test.js",
  "tests/unit/qoder-proxy-replay.test.js",
  "tests/unit/qoder.test.js",
];

export function verifyManifestData(data, rootDir = REPO_ROOT) {
  const errors = [];

  if (!data || typeof data !== "object") {
    throw new Error("Manifest data must be a valid JSON object");
  }

  const commits = data.commits;
  if (!Array.isArray(commits)) {
    throw new Error("Manifest missing commits array");
  }

  if (commits.length !== EXPECTED_TOTAL_COMMITS) {
    errors.push(
      `Expected exactly ${EXPECTED_TOTAL_COMMITS} commits in manifest, got ${commits.length}`
    );
  }

  let priorCount = 0;
  let newCount = 0;

  for (let idx = 0; idx < commits.length; idx++) {
    const c = commits[idx];
    const expectedSha = ORDERED_43_SHAS[idx];
    const prefix = `Commit #${idx + 1} (${c.shortSha || c.sha || "unknown"})`;

    if (!c.sha || c.sha !== expectedSha) {
      errors.push(
        `${prefix}: SHA mismatch at index ${idx}. Expected ${expectedSha}, got ${c.sha}`
      );
    }

    if (!ALLOWED_FINAL_DISPOSITIONS.has(c.disposition)) {
      errors.push(
        `${prefix}: invalid disposition "${c.disposition}" (must be one of: ${[...ALLOWED_FINAL_DISPOSITIONS].join(", ")})`
      );
    }

    if (c.range === "prior_v0.5.112") {
      priorCount++;
    } else if (c.range === "new_v0.5.112_to_v0.5.116") {
      newCount++;
    } else {
      errors.push(`${prefix}: unknown or missing range "${c.range}"`);
    }

    if (!c.localEvidence || typeof c.localEvidence !== "string" || !c.localEvidence.trim()) {
      errors.push(`${prefix}: missing or empty localEvidence`);
    } else {
      const paths = c.localEvidence
        .split(";")
        .map((part) => part.trim().split(":")[0].trim())
        .filter(Boolean);

      for (const p of paths) {
        const fullPath = path.resolve(rootDir, p);
        // Guard against path traversal outside root
        if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== rootDir) {
          errors.push(`${prefix}: path traversal outside repository root: ${p}`);
        } else if (!fs.existsSync(fullPath)) {
          errors.push(`${prefix}: evidence path not found on disk: ${p}`);
        }
      }
    }
  }

  if (priorCount !== EXPECTED_PRIOR_COMMITS) {
    errors.push(
      `Expected ${EXPECTED_PRIOR_COMMITS} prior commits, found ${priorCount}`
    );
  }
  if (newCount !== EXPECTED_NEW_COMMITS) {
    errors.push(
      `Expected ${EXPECTED_NEW_COMMITS} new commits, found ${newCount}`
    );
  }

  // Boundaries verification
  const boundaries = data.boundaries;
  if (!boundaries || typeof boundaries !== "object") {
    errors.push("Missing boundaries object in manifest");
  } else {
    if (boundaries.v0_5_112?.sha !== ORDERED_43_SHAS[13]) {
      errors.push(
        `Boundary v0_5_112 sha mismatch: expected ${ORDERED_43_SHAS[13]}, got ${boundaries.v0_5_112?.sha}`
      );
    }
    if (boundaries.v0_5_116?.sha !== ORDERED_43_SHAS[42]) {
      errors.push(
        `Boundary v0_5_116 sha mismatch: expected ${ORDERED_43_SHAS[42]}, got ${boundaries.v0_5_116?.sha}`
      );
    }
    if (boundaries.v0_5_116?.changelog_sha !== ORDERED_43_SHAS[41]) {
      errors.push(
        `Boundary v0_5_116 changelog_sha mismatch: expected ${ORDERED_43_SHAS[41]}, got ${boundaries.v0_5_116?.changelog_sha}`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Manifest verification failed with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`);
  }

  return true;
}

export function verifyPackageVersions(rootDir = REPO_ROOT) {
  const rootPkgPath = path.resolve(rootDir, "package.json");
  const cliPkgPath = path.resolve(rootDir, "cli/package.json");

  if (!fs.existsSync(rootPkgPath)) throw new Error(`Missing ${rootPkgPath}`);
  if (!fs.existsSync(cliPkgPath)) throw new Error(`Missing ${cliPkgPath}`);

  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));

  if (rootPkg.version !== EXPECTED_VERSION) {
    throw new Error(
      `Root package.json version is ${rootPkg.version}, expected ${EXPECTED_VERSION}`
    );
  }

  if (cliPkg.version !== EXPECTED_VERSION) {
    throw new Error(
      `CLI package.json version is ${cliPkg.version}, expected ${EXPECTED_VERSION}`
    );
  }

  return true;
}

export function verifyLeafTestFiles(rootDir = REPO_ROOT) {
  const missing = [];
  for (const relPath of TARGETED_019_TEST_FILES) {
    const fullPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} targeted 019 test file(s):\n  - ${missing.join("\n  - ")}`
    );
  }
  return true;
}

export function verifySourceMarkers(rootDir = REPO_ROOT) {
  const assertions = [
    {
      file: "src/app/api/oauth/commandcode/auto-import/route.js",
      contains: [
        "isLocalRequest",
        "verifyDashboardAuthToken",
        "MAX_AUTH_FILE_SIZE",
        "READ_LIMIT",
        "handle.read",
        "NO_STORE_HEADERS",
      ],
      description: "CommandCode auto-import route security guards and bounded descriptor reads",
    },
    {
      file: "open-sse/config/runtimeConfig.js",
      contains: ["FETCH_FRESH_RETRY"],
      description: "Transport fresh-retry runtime config opt-out",
    },
    {
      file: "open-sse/utils/proxyFetch.js",
      contains: ["stale keep-alive socket"],
      description: "ProxyFetch fresh-socket retry recovery",
    },
    {
      file: "open-sse/executors/codebuddy-intl.js",
      contains: ["AGENT_PATTERN", "NEUTRAL_PROMPT"],
      description: "CodeBuddy CLI system identity neutralization and prompt handling",
    },
    {
      file: "open-sse/translator/formats/gemini.js",
      contains: ["image/"],
      description: "Gemini remote image concrete MIME detection",
    },
    {
      file: "src/lib/ttsVoices.js",
      contains: ["listTtsVoices"],
      description: "Shared in-process TTS voice listing without self-fetch",
    },
    {
      file: "next.config.mjs",
      contains: [
        "undici",
        "outputFileTracingIncludes",
      ],
      description: "Next.js undici external packaging and output tracing",
    },
    {
      file: "cli/cli.js",
      notContains: ["--dns-result-order=ipv4first", "--dns-result-order"],
      description: "CLI DNS order override removed for HappyEyeballs",
    },
  ];

  for (const a of assertions) {
    const fullPath = path.resolve(rootDir, a.file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Marker assertion failed: file not found: ${a.file}`);
    }
    const content = fs.readFileSync(fullPath, "utf8");

    if (a.contains) {
      for (const needle of a.contains) {
        if (!content.includes(needle)) {
          throw new Error(
            `Marker assertion failed in ${a.file} (${a.description}): missing expected string "${needle}"`
          );
        }
      }
    }

    if (a.notContains) {
      for (const needle of a.notContains) {
        if (content.includes(needle)) {
          throw new Error(
            `Marker assertion failed in ${a.file} (${a.description}): prohibited string "${needle}" found`
          );
        }
      }
    }
  }

  return true;
}

export function runSelfTest(rootDir = REPO_ROOT) {
  console.log("=== Running verify-019.mjs Self-Tests (Positive & Negative Controls) ===");

  const manifestPath = path.resolve(rootDir, "specs/019-upstream-05116/upstream-commits.json");
  const baselineData = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // 1. Positive control: pristine manifest must pass
  try {
    verifyManifestData(baselineData, rootDir);
    console.log("  [PASS] Positive control: pristine manifest passes");
  } catch (err) {
    throw new Error(`Positive control failed on pristine manifest: ${err.message}`);
  }

  // 2. Negative control: missing SHA (length 42 instead of 43)
  {
    const mutated = JSON.parse(JSON.stringify(baselineData));
    mutated.commits.pop();
    let rejected = false;
    try {
      verifyManifestData(mutated, rootDir);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Negative control failed: accepted truncated commit list");
    console.log("  [PASS] Negative control 1: truncated commit list correctly rejected");
  }

  // 3. Negative control: replaced SHA with arbitrary 40-char hex
  {
    const mutated = JSON.parse(JSON.stringify(baselineData));
    mutated.commits[5].sha = "1111222233334444555566667777888899990000";
    let rejected = false;
    try {
      verifyManifestData(mutated, rootDir);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Negative control failed: accepted replaced 40-hex SHA");
    console.log("  [PASS] Negative control 2: replaced 40-hex SHA correctly rejected");
  }

  // 4. Negative control: pending/applicable disposition
  {
    const mutated = JSON.parse(JSON.stringify(baselineData));
    mutated.commits[16].disposition = "APPLICABLE";
    let rejected = false;
    try {
      verifyManifestData(mutated, rootDir);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Negative control failed: non-final disposition accepted");
    console.log("  [PASS] Negative control 3: non-final APPLICABLE disposition correctly rejected");
  }

  // 5. Negative control: non-existent local evidence path
  {
    const mutated = JSON.parse(JSON.stringify(baselineData));
    mutated.commits[0].localEvidence = "non/existent/path/for/sure.js";
    let rejected = false;
    try {
      verifyManifestData(mutated, rootDir);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Negative control failed: non-existent evidence path accepted");
    console.log("  [PASS] Negative control 4: missing evidence path correctly rejected");
  }

  // 6. Negative control: path traversal outside root
  {
    const mutated = JSON.parse(JSON.stringify(baselineData));
    mutated.commits[0].localEvidence = "../../etc/passwd";
    let rejected = false;
    try {
      verifyManifestData(mutated, rootDir);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Negative control failed: path traversal outside root accepted");
    console.log("  [PASS] Negative control 5: path traversal outside root correctly rejected");
  }

  console.log("  [OK] All self-test controls passed.\n");
  return true;
}

export function main() {
  const args = process.argv.slice(2);
  const isSelfTest = args.includes("--self-test");

  console.log("=== KhatamRouter Spec 019 Verification Oracle ===");

  if (isSelfTest) {
    runSelfTest(REPO_ROOT);
  }

  const manifestPath = path.resolve(REPO_ROOT, "specs/019-upstream-05116/upstream-commits.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`ERROR: Manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  console.log("1. Verifying manifest immutable SHAs, counts, boundaries & dispositions...");
  verifyManifestData(data, REPO_ROOT);
  console.log("   [OK] All 43 immutable SHA identities validated in order.");

  console.log("2. Verifying independent package versions (0.5.116)...");
  verifyPackageVersions(REPO_ROOT);
  console.log("   [OK] Root & CLI package versions match 0.5.116.");

  console.log("3. Verifying existence of targeted 019 unit test files...");
  verifyLeafTestFiles(REPO_ROOT);
  console.log(`   [OK] All ${TARGETED_019_TEST_FILES.length} targeted test files present.`);

  console.log("4. Verifying security and architectural supplemental source markers...");
  verifySourceMarkers(REPO_ROOT);
  console.log("   [OK] Supplemental source markers verified.");

  console.log("\n==============================================");
  console.log("SPEC_019_VERIFIED");
  console.log("==============================================");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

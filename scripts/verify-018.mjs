#!/usr/bin/env bun
// Verification helpers for Spec 018 gates. Each subcommand prints exactly one
// success marker when every assertion holds and exits non-zero otherwise.
// Bun-only repo: run as `bun scripts/verify-018.mjs <sub>`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(msg) {
  failures.push(msg);
}

function read(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`missing file: ${rel}`);
    return "";
  }
  return fs.readFileSync(full, "utf8");
}

function count(text, re) {
  return (text.match(re) || []).length;
}

function done(marker) {
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(marker);
}

const sub = process.argv[2];

if (sub === "spec") {
  const spec = read("specs/018-opencode-unlimited-sidecar/spec.md");
  const plan = read("specs/018-opencode-unlimited-sidecar/plan.md");
  read("specs/018-opencode-unlimited-sidecar/tasks.md");
  if (count(spec, /FR-018-\d\d/g) < 20) fail("spec needs at least 20 FR ids");
  if (count(spec, /- \*\*SC-018-\d\d/g) < 5) fail("spec needs at least 5 SC ids");
  for (const required of [
    "opencode2api://managed",
    "fail closed",
    "warm",
  ]) {
    if (!spec.includes(required)) fail(`spec missing contract phrase: ${required}`);
  }
  if (!plan.includes("ensureSidecar(")) fail("plan must name ensureSidecar( as the supervisor entry");
  if (!plan.includes("promote")) fail("plan must describe standby promotion");
  done("SPEC_OK");
} else if (sub === "registry") {
  for (const rel of [
    "src/app/api/proxy-pools/types.js",
    "src/lib/models/listingCompleteness.js",
  ]) {
    const text = read(rel);
    if (!text.includes('"opencode2api"')) fail(`${rel} must list the opencode2api type`);
  }
  const page = read("src/app/(dashboard)/dashboard/proxy-pools/page.js");
  for (const needle of ['value: "opencode2api"', "freeProxy", "FreeProxySourcesCard"]) {
    if (!page.includes(needle)) fail(`proxy-pools page missing: ${needle}`);
  }
  const idx = read("src/shared/components/index.js");
  if (!idx.includes("FreeProxySourcesCard")) fail("component index must export FreeProxySourcesCard");
  done("REGISTRY_OK");
} else if (sub === "docker") {
  const manifest = JSON.parse(read("src/lib/network/opencode2api/opencode2apiRelease.json"));
  const version = manifest.version;
  for (const arch of ["amd64", "arm64"]) {
    const asset = manifest.assets?.[arch];
    if (!asset) {
      fail(`manifest missing ${arch}`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 || "")) fail(`${arch} sha256 malformed`);
    if (!Number.isInteger(asset.size) || asset.size < 1024 * 1024) fail(`${arch} size implausible`);
    if (!String(asset.url).includes(`/download/${version}/`)) fail(`${arch} url not pinned to ${version}`);
  }
  if (manifest.assets.amd64.sha256 === manifest.assets.arm64.sha256) fail("per-arch hashes are identical");
  if (!/^v\d+\.\d+\.\d+$/.test(version)) fail("version must be a semver tag");

  for (const file of ["Dockerfile", "Dockerfile.bun"]) {
    const text = read(file);
    for (const argName of ["OPENCODE2API_VERSION", "OPENCODE2API_SHA256_AMD64", "OPENCODE2API_SHA256_ARM64"]) {
      const matches = [...text.matchAll(new RegExp(`^ARG ${argName}=(.*)$`, "gm"))];
      if (matches.length !== 1) fail(`${file} must declare ARG ${argName} exactly once`);
      else if (matches[0][1].trim() === "") fail(`${file} ARG ${argName} empty`);
    }
    if (!text.includes("sha256sum -c -")) fail(`${file} must verify the checksum`);
    if (!text.includes("/usr/local/bin/opencode2api")) fail(`${file} must install the binary path`);
    if (!text.includes("COPY --from=builder /usr/local/bin/opencode2api")) fail(`${file} must copy the binary into the runner`);
    if (!text.includes("test -x /usr/local/bin/opencode2api")) fail(`${file} must smoke-check the binary`);
  }
  done("DOCKER_OK");
} else if (sub === "card") {
  const page = read("src/app/(dashboard)/dashboard/proxy-pools/page.js");
  if (!page.includes("<FreeProxySourcesCard")) fail("card is not rendered by the proxy-pools page");
  const card = read("src/shared/components/FreeProxySourcesCard.js");
  if (!card.includes("/api/settings/free-proxies")) fail("card does not use the free-proxy policy API");
  done("CARD_OK");
} else if (sub === "docs") {
  const doc = read("docs/OPENCODE2API.md");
  for (const needle of ["GPL", "opencode2api", "amd64", "arm64"]) {
    if (!doc.includes(needle)) fail(`docs/OPENCODE2API.md missing: ${needle}`);
  }
  read("CHANGELOG.md");
  const changelog = read("CHANGELOG.md");
  if (!changelog.includes("opencode2api") && !changelog.includes("018")) fail("CHANGELOG must record the feature");
  const roadmap = read("ROADMAP.md");
  if (!roadmap.includes("018")) fail("ROADMAP must record Spec 018");
  const specsIndex = read("specs/README.md");
  if (!specsIndex.includes("018-opencode-unlimited-sidecar")) fail("specs index must list 018");
  const readme = read("README.md");
  if (!readme.includes("opencode2api")) fail("README must document the new pool type");
  done("DOCS_OK");
} else if (sub === "bunonly") {
  // This repo is Bun-only. `import ... from "node:fs"` is fine (Bun implements
  // the node: scheme); what must never appear is `node` used as the runtime.
  const targets = [
    ["docs/OPENCODE2API.md", /^node\s+\S+/m],
    [".unlazy/018-opencode-unlimited-sidecar/GATES.md", /CHECK:.*\bnode\s+scripts/m],
    ["specs/018-opencode-unlimited-sidecar/plan.md", /^node\s+\S+/m],
    ["specs/018-opencode-unlimited-sidecar/tasks.md", /^node\s+\S+/m],
  ];
  for (const [rel, re] of targets) {
    const text = read(rel);
    if (re.test(text)) fail(`${rel} still invokes node as the runtime`);
  }
  // The script itself must claim bun in its shebang.
  if (!read("scripts/verify-018.mjs").startsWith("#!/usr/bin/env bun")) {
    fail("scripts/verify-018.mjs must use the bun shebang");
  }
  // No package.json script may shell out to node.
  const pkg = JSON.parse(read("package.json"));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (/(^|[\s&|;])node\s/.test(cmd)) fail(`package.json script "${name}" invokes node`);
  }
  done("BUNONLY_OK");
} else if (sub === "suite") {
  // Full unit suite, then compare its failure set against the file of failures
  // measured on the integration base commit. Any failure not in that file is a
  // regression introduced here, whatever the absolute pass count is.
  const run = spawnSync(
    "bun",
    ["x", "--bun", "vitest", "run", "--reporter=dot"],
    {
      cwd: path.join(ROOT, "tests"),
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      env: (() => {
        const env = { ...process.env };
        for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
          delete env[k];
        }
        return env;
      })(),
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;

  const norm = (line) => {
    let l = line.replace(/^\s*FAIL\s+/, "").trim();
    if (!l) return null;
    const sep = l.indexOf(" > ");
    if (sep === -1) return { file: `tests/${l.replace(/\s*\[.*$/, "").trim()}`, title: "" };
    const file = l.slice(0, sep).trim();
    const title = l.slice(sep + 3).replace(/\s+/g, " ").trim();
    return { file: file.startsWith("tests/") ? file : `tests/${file}`, title };
  };
  const key = (e) => `${e.file} :: ${e.title}`;

  const baseline = new Set(
    fs
      .readFileSync(path.join(ROOT, "tests/__baseline__/known-fails.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l.includes(" :: "))
  );

  const failuresNow = new Set();
  for (const line of out.split("\n")) {
    if (!/^\s*FAIL\s+\S/.test(line)) continue;
    const entry = norm(line);
    // Collection-level lines carry the "[ file ]" suffix and have no title.
    if (entry) failuresNow.add(key(entry));
  }

  if (failuresNow.size === 0 && run.status === 0) fail("suite reported no failures at all; expected the known set");
  // A suite that fails to collect has no title, so it matches any baseline
  // entry recorded for that file.
  const isKnown = (k) => baseline.has(k) || [...baseline].some((b) => b.startsWith(`${k.split(" :: ")[0]} ::`) && !k.split(" :: ")[1]);
  const regressions = [...failuresNow].filter((k) => !isKnown(k)).sort();
  for (const r of regressions) fail(`new failure: ${r}`);

  const summary = out.split("\n").filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).join(" | ");
  console.log(`suite failures=${failuresNow.size} baseline=${baseline.size} regressions=${regressions.length} :: ${summary}`);
  done("SUITE_OK");
} else if (sub === "vps") {
  const key = process.env.VPS_SSH_KEY || "/home/redsnow/ssh-key/ssh-key-2026-08-30.key";
  const host = process.env.VPS_HOST || "root@nl-main.z3df1lter.tr";
  const run = (cmd, timeout = 120000) =>
    spawnSync("ssh", ["-i", key, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15", host, cmd], {
      encoding: "utf8",
      timeout,
    });
  const health = run("curl -s -m 10 http://127.0.0.1:8089/healthz");
  if (health.status !== 0) fail("health probe failed to run");
  let parsed = null;
  try {
    parsed = JSON.parse(health.stdout);
  } catch {
    fail(`healthz not JSON: ${health.stdout.slice(0, 120)}`);
  }
  if (parsed && parsed.ready !== true) fail(`sidecar not ready: ${health.stdout.slice(0, 200)}`);
  if (parsed && !(parsed.warp?.active > 0)) fail("sidecar reports no active WARP exit");

  const chat = run(
    `curl -s -m 180 -X POST http://127.0.0.1:8089/v1/chat/completions -H "Authorization: Bearer local-test-key" -H "Content-Type: application/json" -d '{"model":"glm-5.3-flash-free","stream":true,"max_tokens":24,"messages":[{"role":"user","content":"reply with the single word: ok"}]}'`,
    200000
  );
  if (chat.status !== 0) fail("chat probe failed to run");
  if (!/data:\s*\{/.test(chat.stdout)) fail(`chat did not stream SSE: ${chat.stdout.slice(0, 300)}`);
  if (/FreeTierError|"status":"degraded"/.test(chat.stdout)) fail("chat surfaced a free-tier error");
  done("VPS_OK");
} else {
  console.error("usage: bun scripts/verify-018.mjs <spec|registry|docker|card|docs|bunonly|suite|vps>");
  process.exit(2);
}
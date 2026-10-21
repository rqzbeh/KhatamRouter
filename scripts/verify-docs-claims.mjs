#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, "..");

function findMarkdownFiles(dir, excludeDirs = []) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.includes(entry.name)) {
        results.push(...findMarkdownFiles(full, excludeDirs));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

export function resolveDefaultDocFiles(rootDir) {
  const files = [];

  // 1. Root docs: README.md, ROADMAP.md
  for (const f of ["README.md", "ROADMAP.md"]) {
    const p = path.join(rootDir, f);
    if (fs.existsSync(p)) files.push(p);
  }

  // 2. i18n/*.md (10 translation files)
  const i18nDir = path.join(rootDir, "i18n");
  if (fs.existsSync(i18nDir)) {
    const entries = fs.readdirSync(i18nDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(i18nDir, entry.name));
      }
    }
  }

  // 3. docs/**/*.md (exclude docs/images)
  const docsDir = path.join(rootDir, "docs");
  files.push(...findMarkdownFiles(docsDir, ["images"]));

  // 4. gitbook/**/*.md (if any)
  const gitbookDir = path.join(rootDir, "gitbook");
  files.push(...findMarkdownFiles(gitbookDir));

  return files;
}

function parseArgs(args) {
  const options = {
    offline: false,
    json: false,
    rootDir: defaultRepoRoot,
    allowlistPath: null,
    files: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--offline") {
      options.offline = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root" && i + 1 < args.length) {
      options.rootDir = path.resolve(args[++i]);
    } else if (arg.startsWith("--root=")) {
      options.rootDir = path.resolve(arg.slice(7));
    } else if (arg === "--allowlist" && i + 1 < args.length) {
      options.allowlistPath = path.resolve(args[++i]);
    } else if (arg.startsWith("--allowlist=")) {
      options.allowlistPath = path.resolve(arg.slice(12));
    } else if (!arg.startsWith("-")) {
      options.files.push(arg);
    }
  }

  if (!options.allowlistPath) {
    options.allowlistPath = path.join(options.rootDir, "scripts", "docs-claims-allowlist.json");
  }

  return options;
}

function loadAllowlist(allowlistPath) {
  if (!fs.existsSync(allowlistPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  } catch (err) {
    console.error(`Warning: Failed to parse allowlist at ${allowlistPath}:`, err.message);
    return {};
  }
}

// ── CLAIM CLASS 1: Docker image references ──────────────────────────────────
async function checkDockerImageReference(imageRef, allowlist, offline, cache, registryBaseUrl = "https://ghcr.io") {
  // imageRef format: ghcr.io/<owner>/<name>:<tag>
  const match = imageRef.match(/^ghcr\.io\/([^/:]+)\/([^/:]+):([^/:]+)$/);
  if (!match) {
    return { ok: false, warn: false, reason: "Malformed ghcr.io image reference" };
  }
  const [, owner, name, tag] = match;
  const repoTag = `${owner}/${name}:${tag}`;
  const fullRef = `ghcr.io/${repoTag}`;

  // Check allowlist
  const allowlistReason = allowlist[fullRef] || allowlist[repoTag] || allowlist[`:${tag}`];

  if (cache.has(fullRef)) {
    const cached = cache.get(fullRef);
    if (!cached.ok && allowlistReason) {
      return { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason}` };
    }
    return cached;
  }

  if (offline) {
    if (allowlistReason) {
      const res = { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason}` };
      cache.set(fullRef, res);
      return res;
    }
    const res = { ok: true, warn: false, reason: "Skipped registry check (--offline)" };
    cache.set(fullRef, res);
    return res;
  }

  try {
    const base = registryBaseUrl.replace(/\/+$/, "");
    const tokenUrl = `${base}/token?scope=repository:${encodeURIComponent(`${owner}/${name}`)}:pull&service=ghcr.io`;
    const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(6000) });
    if (!tokenRes.ok) {
      if (allowlistReason) {
        const res = { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason} (auth HTTP ${tokenRes.status})` };
        cache.set(fullRef, res);
        return res;
      }
      const res = { ok: false, warn: false, reason: `Failed to acquire GHCR pull token (HTTP ${tokenRes.status})` };
      cache.set(fullRef, res);
      return res;
    }

    const tokenJson = await tokenRes.json();
    const token = tokenJson.token;
    if (!token) {
      if (allowlistReason) {
        const res = { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason} (empty token)` };
        cache.set(fullRef, res);
        return res;
      }
      const res = { ok: false, warn: false, reason: "No token returned from GHCR auth" };
      cache.set(fullRef, res);
      return res;
    }

    const manifestUrl = `${base}/v2/${owner}/${name}/manifests/${tag}`;
    const manifestRes = await fetch(manifestUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, */*",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (manifestRes.status >= 200 && manifestRes.status < 400) {
      const res = { ok: true, warn: false, reason: `Resolved on ghcr.io (HTTP ${manifestRes.status})` };
      cache.set(fullRef, res);
      return res;
    }

    if (allowlistReason) {
      const res = { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason} (HTTP ${manifestRes.status})` };
      cache.set(fullRef, res);
      return res;
    }

    const res = { ok: false, warn: false, reason: `Image tag does not resolve on ghcr.io (HTTP ${manifestRes.status})` };
    cache.set(fullRef, res);
    return res;
  } catch (err) {
    if (allowlistReason) {
      const res = { ok: true, warn: true, reason: `Allowlisted: ${allowlistReason} (network error: ${err.message})` };
      cache.set(fullRef, res);
      return res;
    }
    const res = { ok: false, warn: false, reason: `Failed to query registry: ${err.message}` };
    cache.set(fullRef, res);
    return res;
  }
}

// ── CLAIM CLASS 2: Cited source constants ───────────────────────────────────
function checkCitedSourceConstants(docPath, repoRoot) {
  const content = fs.readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const results = [];

  lines.forEach((line, lineIdx) => {
    // Matches: 10 MiB, 512 KiB, 64 MB, etc.
    const sizeMatches = [...line.matchAll(/\b(\d+)\s*(MiB|KiB|MB)\b/gi)];
    if (!sizeMatches.length) return;

    // Matches backticked strings on the same line
    const backtickMatches = [...line.matchAll(/`([^`]+)`/g)];
    const fileMatches = [];

    for (const b of backtickMatches) {
      const candidate = b[1].trim();
      const resolved = path.resolve(repoRoot, candidate);
      const relativeDoc = path.resolve(path.dirname(docPath), candidate);

      let targetPath = null;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        targetPath = resolved;
      } else if (fs.existsSync(relativeDoc) && fs.statSync(relativeDoc).isFile()) {
        targetPath = relativeDoc;
      }

      if (targetPath) {
        fileMatches.push({
          rawPath: candidate,
          targetPath,
          index: b.index,
        });
      }
    }

    // Skip rather than guess when a translation cites a constant without a valid file path
    if (!fileMatches.length) return;

    for (const sm of sizeMatches) {
      const num = sm[1];
      const unit = sm[2];
      const sIdx = sm.index;

      // Find closest backticked file path on the line
      let closestFile = null;
      let minDistance = Infinity;

      for (const fm of fileMatches) {
        const dist = Math.abs(sIdx - fm.index);
        if (dist < minDistance) {
          minDistance = dist;
          closestFile = fm;
        }
      }

      // Associate only if within reasonable proximity (120 chars)
      if (closestFile && minDistance <= 120) {
        const targetContent = fs.readFileSync(closestFile.targetPath, "utf8");
        const numRegex = new RegExp(`\\b${num}\\b`);
        const found = numRegex.test(targetContent);

        results.push({
          doc: path.relative(repoRoot, docPath),
          line: lineIdx + 1,
          num,
          unit,
          targetFile: closestFile.rawPath,
          ok: found,
          reason: found
            ? `Found constant '${num}' in ${closestFile.rawPath}`
            : `Constant '${num}' (${num} ${unit}) claimed in docs but not found in ${closestFile.rawPath}`,
        });
      }
    }
  });

  return results;
}

// ── CLAIM CLASS 3: Banned adjectives against RTK / token saver ──────────────
const BANNED_ADJECTIVE_PATTERNS = [
  { lang: "en", pattern: /\blossless\b/i, term: "lossless" },
  { lang: "zh", pattern: /无损|無損/, term: "无损|無損" },
  { lang: "fr", pattern: /\bsans\s+perte\b/i, term: "sans perte" },
  { lang: "es", pattern: /\bsin\s+p[eé]rdida\b/i, term: "sin pérdida" },
  { lang: "pt", pattern: /\bsem\s+perda\b/i, term: "sem perda" },
  { lang: "fa", pattern: /بدون\s+(?:افت|تلف)/, term: "بدون افت|بدون تلف" },
  { lang: "th", pattern: /ไม่สูญเสีย/, term: "ไม่สูญเสีย" },
  { lang: "ja", pattern: /ロスレス|無損失/, term: "ロスレス|無損失" },
  { lang: "ko", pattern: /무손실/, term: "무손실" },
  { lang: "ru", pattern: /без\s+потерь/i, term: "без потерь" },
  { lang: "vi", pattern: /kh[oô]ng\s+m[aấ]t\s+d[uữ]\s+li[eệ]u/i, term: "không mất dữ liệu" },
];

const RTK_NEARBY_REGEX =
  /\b(?:rtk|token[\s-]saver(?:s)?)\b|ahorrador\s+de\s+tokens|économiseur\s+de\s+tokens|économiseur\s+de\s+jetons|economizador\s+de\s+tokens?|ذخیره‌ساز\s+توکن|ประหยัดโทเค็น/i;

function checkBannedAdjectives(docPath, repoRoot) {
  const content = fs.readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const results = [];

  lines.forEach((line, lineIdx) => {
    for (const b of BANNED_ADJECTIVE_PATTERNS) {
      if (b.pattern.test(line)) {
        // Check within 3 lines (before and after)
        const start = Math.max(0, lineIdx - 3);
        const end = Math.min(lines.length - 1, lineIdx + 3);

        let nearRtk = false;
        let matchedLine = -1;
        for (let j = start; j <= end; j++) {
          if (RTK_NEARBY_REGEX.test(lines[j])) {
            nearRtk = true;
            matchedLine = j + 1;
            break;
          }
        }

        if (nearRtk) {
          results.push({
            doc: path.relative(repoRoot, docPath),
            line: lineIdx + 1,
            term: b.term,
            lang: b.lang,
            ok: false,
            reason: `Banned adjective '${b.term}' (${b.lang}) appears near RTK/token saver (line ${matchedLine}) in ${path.relative(repoRoot, docPath)}`,
          });
        }
      }
    }
  });

  return results;
}

// ── CLAIM CLASS 4: Config env var names ─────────────────────────────────────
function collectCodebaseText(repoRoot) {
  let combined = "";

  const envExamplePath = path.join(repoRoot, ".env.example");
  if (fs.existsSync(envExamplePath)) {
    combined += fs.readFileSync(envExamplePath, "utf8") + "\n";
  }

  function readDirRecursive(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        readDirRecursive(full);
      } else if (/\.(js|mjs|cjs|ts|tsx|json|sh|sql)$/.test(entry.name)) {
        combined += fs.readFileSync(full, "utf8") + "\n";
      }
    }
  }

  readDirRecursive(path.join(repoRoot, "src"));
  readDirRecursive(path.join(repoRoot, "open-sse"));
  readDirRecursive(path.join(repoRoot, "scripts"));
  return combined;
}

function checkEnvVarNames(docPath, repoRoot, codebaseText) {
  const content = fs.readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const results = [];
  const seen = new Set();

  let inCodeBlock = false;
  let codeBlockLang = "";
  let inVarTable = false;

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      codeBlockLang = trimmed.slice(3).toLowerCase();
      return;
    }

    // Detect environment variable tables
    if (trimmed.startsWith("|") && /\|\s*(Variable|Environment\s*Variable|Config\s*Var)\s*\|/i.test(trimmed)) {
      inVarTable = true;
      return;
    }

    if (inVarTable) {
      if (!trimmed.startsWith("|")) {
        inVarTable = false;
      } else {
        const cols = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
        if (cols.length >= 2) {
          const varMatches = [...cols[0].matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)];
          for (const m of varMatches) {
            const varName = m[1];
            if (!seen.has(varName)) {
              seen.add(varName);
              const exists = codebaseText.includes(varName);
              results.push({
                doc: path.relative(repoRoot, docPath),
                line: lineIdx + 1,
                varName,
                ok: exists,
                warn: !exists, // WARN only per spec
                reason: exists
                  ? `Config env var '${varName}' found in codebase`
                  : `Config env var '${varName}' not found in .env.example, src/, or open-sse/`,
              });
            }
          }
        }
      }
    }

    // Code blocks with shell / env commands
    if (inCodeBlock && ["bash", "sh", "shell", "env", ""].includes(codeBlockLang)) {
      const envMatches = [...trimmed.matchAll(/(?:-e\s+|export\s+|^|\s)([A-Z][A-Z0-9_]{2,})=(?:[^\s]+)/g)];
      for (const m of envMatches) {
        const varName = m[1];
        if (!seen.has(varName)) {
          seen.add(varName);
          const exists = codebaseText.includes(varName);
          results.push({
            doc: path.relative(repoRoot, docPath),
            line: lineIdx + 1,
            varName,
            ok: exists,
            warn: !exists, // WARN only per spec
            reason: exists
              ? `Config env var '${varName}' found in codebase`
              : `Config env var '${varName}' not found in .env.example, src/, or open-sse/`,
          });
        }
      }
    }
  });

  return results;
}

// ── CLAIM CLASS 5: Port 20129 operational drift guard ───────────────────────
function checkEndpointPortBound(repoRoot) {
  // 1. Check if cmd/khatam-gateway exists (binary / package directory)
  const gatewayCmd = path.join(repoRoot, "cmd", "khatam-gateway");
  if (fs.existsSync(gatewayCmd)) return true;

  // 2. Check for .listen( near ENDPOINT_PORT in custom-server.js or src/
  const filesToCheck = [];
  const customServer = path.join(repoRoot, "custom-server.js");
  if (fs.existsSync(customServer)) filesToCheck.push(customServer);

  function findSrcFiles(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findSrcFiles(full);
      else if (/\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) filesToCheck.push(full);
    }
  }
  findSrcFiles(path.join(repoRoot, "src"));

  for (const f of filesToCheck) {
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("ENDPOINT_PORT")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("ENDPOINT_PORT")) {
          const window = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 6)).join("\n");
          if (/\.listen\s*\(/.test(window)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function checkPort20129Claims(docPath, repoRoot, isBound) {
  const content = fs.readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const results = [];

  const opKeywords = /\b(?:serving|listening|live|ready|available|running)\b/i;
  const curl20129 = /\bcurl\b[^\n]*\b20129\b/i;
  const nonOpMarkers =
    /\b(?:no\s+(?:process|service)\s+is\s+(?:currently\s+)?listening|refuses\s+connections|reserved(?:\s+for)?|status:\s*🔵?\s*planned|upcoming|roadmap)\b/i;

  let currentHeading = "";

  lines.forEach((line, lineIdx) => {
    if (/^#{1,6}\s+/.test(line)) {
      currentHeading = line;
    }

    if (line.includes("20129")) {
      const windowStart = Math.max(0, lineIdx - 3);
      const windowEnd = Math.min(lines.length - 1, lineIdx + 3);
      const windowText = lines.slice(windowStart, windowEnd + 1).join("\n");

      const hasOp = opKeywords.test(windowText) || curl20129.test(windowText);
      if (!hasOp) return;

      const inPlannedSection = /\b(?:planned|roadmap|upcoming)\b/i.test(currentHeading);
      const wideWindow = lines
        .slice(Math.max(0, lineIdx - 10), Math.min(lines.length, lineIdx + 11))
        .join("\n");
      const hasNonOpMarker = nonOpMarkers.test(windowText) || nonOpMarkers.test(wideWindow);

      if (inPlannedSection || hasNonOpMarker) {
        return;
      }

      results.push({
        doc: path.relative(repoRoot, docPath),
        line: lineIdx + 1,
        ok: isBound,
        reason: isBound
          ? `Port 20129 claimed operational and ENDPOINT_PORT listener is verified in codebase`
          : `Doc claims gateway is operational on 20129 (line ${lineIdx + 1}) but nothing binds ENDPOINT_PORT in src/, custom-server.js, or cmd/khatam-gateway`,
      });
    }
  });

  return results;
}

// ── CLAIM CLASS 6: Shipped-claim mapping ────────────────────────────────────
function identifierExists(id, repoRoot, codebaseText) {
  const cleanId = id.trim();
  if (!cleanId) return false;

  // 1. Path in repo
  const candidatePath = path.resolve(repoRoot, cleanId.replace(/^@\//, "src/"));
  if (fs.existsSync(candidatePath)) return true;

  const directPath = path.resolve(repoRoot, cleanId);
  if (fs.existsSync(directPath)) return true;

  // 2. Git commit hash
  if (/^[a-f0-9]{7,40}$/i.test(cleanId)) {
    try {
      execSync(`git -C "${repoRoot}" rev-parse --quiet --verify "${cleanId}^{commit}"`, { stdio: "ignore" });
      return true;
    } catch {
      // not a local commit, continue
    }
  }

  // 3. Codebase text search (symbol, table, env var, function)
  if (codebaseText.includes(cleanId)) return true;

  return false;
}

function checkShippedClaims(docPath, repoRoot, codebaseText) {
  const content = fs.readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const results = [];

  const STOP_WORDS = new Set([
    "the", "and", "with", "for", "from", "wave", "shipped", "delivery",
    "status", "feature", "capability", "target", "pure", "defense",
    "token", "modes", "core", "today"
  ]);

  lines.forEach((line, lineIdx) => {
    if (!line.includes("🟢 Shipped")) return;
    if (/^#{1,6}\s+/.test(line.trim())) return;
    if (line.includes("Nothing in this document")) return;

    const backticks = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

    if (backticks.length > 0) {
      let foundBacktick = null;
      for (const b of backticks) {
        if (identifierExists(b, repoRoot, codebaseText)) {
          foundBacktick = b;
          break;
        }
      }
      if (foundBacktick) {
        results.push({
          doc: path.relative(repoRoot, docPath),
          line: lineIdx + 1,
          ok: true,
          reason: `Verified backticked identifier \`${foundBacktick}\` in repo`,
        });
      } else {
        results.push({
          doc: path.relative(repoRoot, docPath),
          line: lineIdx + 1,
          ok: false,
          reason: `Shipped row cites backticked identifier(s) that do not exist in repo: ${backticks.map((b) => "`" + b + "`").join(", ")}`,
        });
      }
      return;
    }

    // Row has no backticks: check if it names verifiable terms from codebase
    const cleaned = line.replace(/[|*#`:,()\-]/g, " ");
    const words = cleaned
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w.toLowerCase()));

    let foundTerm = null;
    for (const w of words) {
      if (codebaseText.includes(w)) {
        foundTerm = w;
        break;
      }
    }

    if (foundTerm) {
      results.push({
        doc: path.relative(repoRoot, docPath),
        line: lineIdx + 1,
        ok: true,
        reason: `Verified identifier '${foundTerm}' in codebase`,
      });
    } else {
      results.push({
        doc: path.relative(repoRoot, docPath),
        line: lineIdx + 1,
        ok: false,
        reason: `Shipped row cites nothing verifiable in repo`,
      });
    }
  });

  return results;
}

// ── MAIN RUNNER ─────────────────────────────────────────────────────────────
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allowlist = loadAllowlist(options.allowlistPath);
  const cache = new Map();

  const report = {
    class1_docker: [],
    class2_constants: [],
    class3_adjectives: [],
    class4_envVars: [],
    class5_port20129: [],
    class6_shipped: [],
    totalChecks: 0,
    failures: 0,
    warnings: 0,
  };

  // Resolve doc paths
  let docPaths = [];
  if (options.files.length === 0) {
    docPaths = resolveDefaultDocFiles(options.rootDir);
  } else {
    for (const f of options.files) {
      const p = path.isAbsolute(f) ? f : path.resolve(options.rootDir, f);
      if (fs.existsSync(p)) {
        docPaths.push(p);
      }
    }
  }

  if (docPaths.length === 0) {
    console.error("No valid documentation files found to verify.");
    process.exit(1);
  }

  // Pre-load codebase state
  const codebaseText = collectCodebaseText(options.rootDir);
  const isEndpointPortBound = checkEndpointPortBound(options.rootDir);

  const registryBaseUrl = process.env.GHCR_REGISTRY_BASE_URL || "https://ghcr.io";

  for (const docPath of docPaths) {
    const docRelative = path.relative(options.rootDir, docPath);
    const content = fs.readFileSync(docPath, "utf8");
    const lines = content.split("\n");

    // CLAIM CLASS 1: Find docker image references
    const dockerRegex = /ghcr\.io\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+/g;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const matches = [...line.matchAll(dockerRegex)];
      for (const m of matches) {
        const ref = m[0];
        const res = await checkDockerImageReference(ref, allowlist, options.offline, cache, registryBaseUrl);
        report.totalChecks++;
        if (!res.ok) {
          report.failures++;
        } else if (res.warn) {
          report.warnings++;
        }
        report.class1_docker.push({
          doc: docRelative,
          line: lineIdx + 1,
          ref,
          status: !res.ok ? "FAIL" : res.warn ? "WARN" : "OK",
          reason: res.reason,
        });
      }
    }

    // CLAIM CLASS 2: Cited source constants
    const constResults = checkCitedSourceConstants(docPath, options.rootDir);
    for (const r of constResults) {
      report.totalChecks++;
      if (!r.ok) report.failures++;
      report.class2_constants.push({
        doc: r.doc,
        line: r.line,
        claim: `${r.num} ${r.unit} in ${r.targetFile}`,
        status: r.ok ? "OK" : "FAIL",
        reason: r.reason,
      });
    }

    // CLAIM CLASS 3: Banned adjectives
    const adjResults = checkBannedAdjectives(docPath, options.rootDir);
    for (const r of adjResults) {
      report.totalChecks++;
      if (!r.ok) report.failures++;
      report.class3_adjectives.push({
        doc: r.doc,
        line: r.line,
        term: r.term,
        lang: r.lang,
        status: r.ok ? "OK" : "FAIL",
        reason: r.reason,
      });
    }

    // CLAIM CLASS 4: Config env vars
    const envResults = checkEnvVarNames(docPath, options.rootDir, codebaseText);
    for (const r of envResults) {
      report.totalChecks++;
      if (r.warn) report.warnings++;
      report.class4_envVars.push({
        doc: r.doc,
        line: r.line,
        varName: r.varName,
        status: r.warn ? "WARN" : "OK",
        reason: r.reason,
      });
    }

    // CLAIM CLASS 5: Port 20129 operational drift guard
    const portResults = checkPort20129Claims(docPath, options.rootDir, isEndpointPortBound);
    for (const r of portResults) {
      report.totalChecks++;
      if (!r.ok) report.failures++;
      report.class5_port20129.push({
        doc: r.doc,
        line: r.line,
        status: r.ok ? "OK" : "FAIL",
        reason: r.reason,
      });
    }

    // CLAIM CLASS 6: Shipped-claim mapping
    const shippedResults = checkShippedClaims(docPath, options.rootDir, codebaseText);
    for (const r of shippedResults) {
      report.totalChecks++;
      if (!r.ok) report.failures++;
      report.class6_shipped.push({
        doc: r.doc,
        line: r.line,
        status: r.ok ? "OK" : "FAIL",
        reason: r.reason,
      });
    }
  }

  // Format output
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: report.failures === 0,
          failures: report.failures,
          warnings: report.warnings,
          totalChecks: report.totalChecks,
          filesScanned: docPaths.length,
          claims: {
            dockerImages: report.class1_docker,
            sourceConstants: report.class2_constants,
            bannedAdjectives: report.class3_adjectives,
            envVars: report.class4_envVars,
            port20129: report.class5_port20129,
            shippedClaims: report.class6_shipped,
          },
        },
        null,
        2
      )
    );
  } else {
    console.log("=== KhatamRouter Documentation Claims Verification ===");
    console.log(`Files scanned: ${docPaths.length}`);
    console.log("");

    console.log(`[CLAIM CLASS 1] Docker image references (${report.class1_docker.length} found):`);
    if (report.class1_docker.length === 0) {
      console.log("  (none)");
    } else {
      for (const item of report.class1_docker) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.ref} (${item.reason})`);
      }
    }
    console.log("");

    console.log(`[CLAIM CLASS 2] Cited source constants (${report.class2_constants.length} found):`);
    if (report.class2_constants.length === 0) {
      console.log("  (none)");
    } else {
      for (const item of report.class2_constants) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.claim} (${item.reason})`);
      }
    }
    console.log("");

    console.log(`[CLAIM CLASS 3] Banned adjectives (${report.class3_adjectives.length} findings):`);
    if (report.class3_adjectives.length === 0) {
      console.log("  [OK] No banned adjectives ('lossless' or translations near RTK/token saver) found.");
    } else {
      for (const item of report.class3_adjectives) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.reason}`);
      }
    }
    console.log("");

    console.log(`[CLAIM CLASS 4] Config environment variables (${report.class4_envVars.length} checked):`);
    const warnEnv = report.class4_envVars.filter((e) => e.status === "WARN");
    if (warnEnv.length === 0) {
      console.log(`  [OK] All ${report.class4_envVars.length} config environment variables confirmed in codebase.`);
    } else {
      for (const item of warnEnv) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.varName} (${item.reason})`);
      }
    }
    console.log("");

    console.log(`[CLAIM CLASS 5] Port 20129 operational drift guard (${report.class5_port20129.length} operational claims):`);
    if (report.class5_port20129.length === 0) {
      console.log("  [OK] No doc claims gateway is operational on 20129 while unlistenable (reserved/planned correctly).");
    } else {
      for (const item of report.class5_port20129) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.reason}`);
      }
    }
    console.log("");

    console.log(`[CLAIM CLASS 6] Shipped-claim mapping (${report.class6_shipped.length} shipped rows verified):`);
    const failShipped = report.class6_shipped.filter((s) => s.status === "FAIL");
    if (failShipped.length === 0) {
      console.log(`  [OK] All ${report.class6_shipped.length} shipped rows cite verifiable identifiers in repo.`);
    } else {
      for (const item of failShipped) {
        console.log(`  [${item.status}] ${item.doc}:${item.line} -> ${item.reason}`);
      }
    }
    console.log("");

    console.log("------------------------------------------------------");
    console.log(`Summary: ${report.failures} failed, ${report.warnings} warnings, ${report.totalChecks} checks total across ${docPaths.length} files.`);
  }

  process.exit(report.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error during claims verification:", err);
  process.exit(1);
});

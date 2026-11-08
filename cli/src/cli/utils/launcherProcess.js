// Fast previous-instance detection for the launcher.
//
// The launcher records its own PID, its server's PID, and their entrypoints in
// <dataDir>/launcher.pid. The next launch stops exactly those processes instead
// of scanning every process on the machine (a PowerShell WMI query costs ~0.5s per
// call on Windows), and only falls back to the full scan when the port is still
// occupied.
//
// Guards against PID reuse: before issuing SIGKILL, processMatchesExe verifies
// both the executable identity and that the process commandline / script matches
// the exact canonical recorded entrypoint. If identity cannot be verified (e.g.
// legacy records with only exe), it fails closed to never terminate unrelated
// processes.
//
// Limitation: A tiny window remains if an unrelated process is launched with
// the exact same canonical script entrypoint path after a PID wrap, but verifying
// exact canonical script identity eliminates arbitrary process kills.

const { execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const PID_FILE_NAME = "launcher.pid";
const PORT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const EXE_LOOKUP_TIMEOUT_MS = 2000;

function getPidFilePath(dataDir) {
  return path.join(dataDir, PID_FILE_NAME);
}

function toPid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * @param {string} file
 * @param {{ cliPid: number, serverPid: number|null, port: number, exe: string, cliEntry?: string, serverEntry?: string }} record
 */
function writePidRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

/** @returns {{ cliPid: number, serverPid: number|null, port: number|null, exe: string, cliEntry?: string, serverEntry?: string } | null} */
function readPidRecord(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cliPid = toPid(parsed.cliPid);
  if (!cliPid || typeof parsed.exe !== "string" || !parsed.exe) return null;
  const result = {
    cliPid,
    serverPid: toPid(parsed.serverPid),
    port: Number.isSafeInteger(parsed.port) ? parsed.port : null,
    exe: parsed.exe,
  };
  if (typeof parsed.cliEntry === "string" && parsed.cliEntry) {
    result.cliEntry = parsed.cliEntry;
  }
  if (typeof parsed.serverEntry === "string" && parsed.serverEntry) {
    result.serverEntry = parsed.serverEntry;
  }
  return result;
}

function removePidRecordIfOwner(file, ownerPid) {
  const record = readPidRecord(file);
  if (!record || record.cliPid !== ownerPid) return;
  try { fs.unlinkSync(file); } catch { /* already removed */ }
}

function isPidAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!toPid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function normalizeExeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\.exe$/, "");
}

function lookupExeName(pid) {
  if (process.platform === "win32") {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
    const match = out.match(/^"([^"]+)","(\d+)"/m);
    return match && Number(match[2]) === pid ? match[1] : "";
  }
  // /proc/<pid>/comm is rewritten by process.title (Next sets "next-server (v…)"),
  // so resolve the real executable instead.
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
  }
}

function getProcessArgvAndCwd(pid) {
  if (!toPid(pid)) return { argv: [], cwd: null };

  // Linux: read virtual /proc/<pid>/cmdline (instantaneous) and /proc/<pid>/cwd
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const argv = raw.toString("utf8").split("\0").filter(Boolean);
      let cwd = null;
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      if (argv.length > 0) return { argv, cwd };
    } catch {
      // Fall through to ps
    }
  }

  // Windows / macOS fallback
  let rawCmd = "";
  if (process.platform === "win32") {
    try {
      const cmd = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
      rawCmd = execFileSync("powershell", ["-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: EXE_LOOKUP_TIMEOUT_MS,
      }).trim();
    } catch {}
  } else {
    try {
      rawCmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: EXE_LOOKUP_TIMEOUT_MS,
      }).trim();
    } catch {}
  }

  if (!rawCmd) return { argv: [], cwd: null };

  // Parse quoted command string conservatively into exact tokens
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < rawCmd.length; i++) {
    const char = rawCmd[i];
    if (inQuotes) {
      if (char === quoteChar) inQuotes = false;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);

  return { argv: tokens, cwd: null };
}

// Known no-value (boolean) runtime flags that take no following argument
const KNOWN_BOOLEAN_FLAGS = new Set([
  "--bun",
  "--smol",
  "--inspect",
  "--inspect-brk",
  "--no-warnings",
  "--trace-warnings",
  "--expose-gc",
  "-h",
  "--help",
  "-v",
  "--version",
]);

// Known runtime flags that consume the next argument as their value
const KNOWN_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--preload",
  "-c",
  "--config",
  "--loader",
  "--import",
  "--conditions",
  "--env-file",
  "--origin",
  "--port",
  "-p",
  "--host",
  "-H",
]);

function extractScriptArg(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--eval") return null;
    if (arg === "run") continue;
    if (arg.startsWith("-")) {
      // Flag with inline value: e.g. --name=value or --max-old-space-size=4096
      if (arg.includes("=")) {
        continue;
      }
      // Known boolean flag taking no value
      if (KNOWN_BOOLEAN_FLAGS.has(arg)) {
        continue;
      }
      // Known flag that consumes the next argument as its value
      if (KNOWN_VALUE_FLAGS.has(arg)) {
        i++; // skip the flag's value argument
        continue;
      }
      // Unknown flag without '=': fail closed to avoid mistaking its argument for the script entrypoint
      return null;
    }
    return arg;
  }
  return null;
}

// Exact canonical entrypoint matching: no substring or parent basename fallbacks.
// Fails closed if the script cannot be extracted or canonical paths do not match.
// If scriptArg is relative and procCwd is missing (e.g. unprovable on macOS/Windows),
// fails closed instead of guessing with process.cwd().
function verifyExactScriptEntry(argv, expectedEntry, procCwd = null) {
  if (!Array.isArray(argv) || !expectedEntry || typeof expectedEntry !== "string") {
    return false;
  }
  const scriptArg = extractScriptArg(argv);
  if (!scriptArg) return false;

  const canonicalExpected = path.resolve(expectedEntry);
  let canonicalScript;
  if (!path.isAbsolute(scriptArg)) {
    if (!procCwd) return false; // Fail closed if working directory cannot be proven
    canonicalScript = path.resolve(procCwd, scriptArg);
  } else {
    canonicalScript = path.resolve(scriptArg);
  }

  if (process.platform === "win32") {
    return canonicalScript.toLowerCase() === canonicalExpected.toLowerCase();
  }
  return canonicalScript === canonicalExpected;
}

// Guards against PID reuse: a stale record must not kill an unrelated program.
// Verifies BOTH executable name AND exact canonical script entrypoint.
// Fails closed if expected entry is missing (legacy records) or identity cannot be proven.
function processMatchesExe(pid, exe, expectedEntry = null) {
  const expected = normalizeExeName(exe);
  if (!expected || !toPid(pid)) return false;

  // Fail-closed on missing entrypoint (e.g. legacy records with only exe)
  if (!expectedEntry || typeof expectedEntry !== "string") return false;

  try {
    if (normalizeExeName(path.basename(lookupExeName(pid))) !== expected) {
      return false;
    }
    const { argv, cwd } = getProcessArgvAndCwd(pid);
    if (!argv || argv.length === 0) return false;

    return verifyExactScriptEntry(argv, expectedEntry, cwd);
  } catch {
    return false;
  }
}

function defaultKillPid(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * Stops the processes named in a launcher record. Returns the PIDs it killed.
 * Server first so the port is released even if the CLI kill fails.
 * Fails closed if process identity cannot be confirmed.
 */
function stopRecordedInstance(record, {
  selfPid = process.pid,
  isAlive = isPidAlive,
  matchesExe = processMatchesExe,
  killPid = defaultKillPid,
} = {}) {
  if (!record) return [];
  const candidates = [
    { pid: record.serverPid, entry: record.serverEntry },
    { pid: record.cliPid, entry: record.cliEntry },
  ].filter((c) => toPid(c.pid) && c.pid !== selfPid);

  const killed = [];
  for (const c of candidates) {
    if (!isAlive(c.pid) || !matchesExe(c.pid, record.exe, c.entry)) continue;
    try {
      killPid(c.pid);
      killed.push(c.pid);
    } catch { /* already gone or not permitted — the port check decides what's next */ }
  }
  return killed;
}

function isPortInUse(port, host = "127.0.0.1", timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function pollUntil(check, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function waitForPortFree(port, opts = {}) {
  return pollUntil(async () => !(await isPortInUse(port)), opts);
}

function waitForPidsExit(pids, { isAlive = isPidAlive, ...opts } = {}) {
  return pollUntil(() => pids.every((pid) => !isAlive(pid)), opts);
}

module.exports = {
  getPidFilePath,
  writePidRecord,
  readPidRecord,
  removePidRecordIfOwner,
  isPidAlive,
  lookupExeName,
  getProcessArgvAndCwd,
  extractScriptArg,
  verifyExactScriptEntry,
  processMatchesExe,
  stopRecordedInstance,
  isPortInUse,
  waitForPortFree,
  waitForPidsExit,
};

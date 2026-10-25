import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const KILL_TIMEOUT_MS = 5000;
const PROCESS_WAIT_MS = 1500;

// Kill MITM server by PID file (MITM may run as admin/sudo)
function killMitmByPidFile() {
  try {
    const mitmPidFile = path.join(
      process.platform === "win32"
        ? path.join(process.env.APPDATA || "", "9router")
        : path.join(os.homedir(), ".9router"),
      "mitm",
      ".mitm.pid"
    );
    if (!fs.existsSync(mitmPidFile)) return;
    const pid = parseInt(fs.readFileSync(mitmPidFile, "utf8").trim(), 10);
    if (!pid) return;

    if (process.platform === "win32") {
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch {
        try { execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { /* best effort */ }
      }
    } else {
      try {
        execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
      }
    }
    try { fs.unlinkSync(mitmPidFile); } catch { /* best effort */ }
  } catch { /* best effort */ }
}

// Collect PIDs of all KhatamRouter/9router-related processes (excluding current)
export function collectAppPids() {
  const pids = [];
  const platform = process.platform;

  if (platform === "win32") {
    try {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"node.exe\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
      const output = execSync(psCmd, { encoding: "utf8", windowsHide: true, timeout: KILL_TIMEOUT_MS });
      const lines = output.split("\n").slice(1).filter(l => l.trim());
      lines.forEach(line => {
        const lower = line.toLowerCase();
        // Match anything running from 9router/khatamrouter install dir or wrapper cli.js
        const isAppProcess = lower.includes("khatamrouter") ||
          lower.includes("9router") ||
          lower.includes("next-server") ||
          lower.includes("\\bin\\app\\") ||
          lower.includes("/bin/app/") ||
          lower.includes("cli.js");
        if (isAppProcess) {
          const match = line.match(/^"(\d+)"/);
          if (match && match[1] && match[1] !== process.pid.toString()) pids.push(match[1]);
        }
      });
    } catch { /* no processes */ }

    // Kill cloudflared + tray binaries (hold app dir lock)
    for (const procName of ["cloudflared", "tray_windows_release"]) {
      try {
        const cmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-Process ${procName} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`;
        const out = execSync(cmd, { encoding: "utf8", windowsHide: true, timeout: KILL_TIMEOUT_MS });
        out.split("\n").forEach(l => {
          const pid = l.trim();
          if (pid && !isNaN(pid)) pids.push(pid);
        });
      } catch { /* not running */ }
    }
  } else {
    try {
      const output = execSync("ps aux 2>/dev/null", { encoding: "utf8", timeout: KILL_TIMEOUT_MS });
      output.split("\n").forEach(line => {
        const isAppProcess = line.includes("khatamrouter") ||
          line.includes("9router") ||
          line.includes("next-server") ||
          line.includes("cloudflared") ||
          line.includes("/bin/app/") ||
          line.includes("tray_darwin") ||
          line.includes("tray_linux");
        if (isAppProcess) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[1];
          if (pid && !isNaN(pid) && pid !== process.pid.toString()) pids.push(pid);
        }
      });
    } catch { /* no processes */ }
  }

  return pids;
}

export function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

// Kill all app-related processes to release file locks (esp. on Windows)
export async function killAppProcesses() {
  killMitmByPidFile();
  const pids = collectAppPids();
  const platform = process.platform;

  pids.forEach(pid => {
    try {
      if (platform === "win32") {
        execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
      }
    } catch { /* already dead */ }
  });

  if (pids.length > 0) {
    await new Promise(r => setTimeout(r, PROCESS_WAIT_MS));
  }
}

// In-place auto-updater neutralized fail-closed
export function spawnUpdaterAndExit() {
  console.warn("[appUpdater] In-place package updater is disabled in KhatamRouter. Update via Docker or git pull.");
  return false;
}

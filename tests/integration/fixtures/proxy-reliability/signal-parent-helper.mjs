#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureTunnel,
  __getActiveChildForTests,
} from "../../../../src/lib/network/psiphon/psiphonManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args: --mode=<mode> --scratch=<dir> --config=<config> --bin=<bin>
const args = process.argv.slice(2);
let mode = "stubborn-exit-on-sigterm";
let scratchDir = "";
let baseConfigFile = "";
let binPath = path.resolve(__dirname, "../../../fixtures/fake-psiphon.mjs");

for (const arg of args) {
  if (arg.startsWith("--mode=")) mode = arg.slice("--mode=".length);
  else if (arg.startsWith("--scratch=")) scratchDir = arg.slice("--scratch=".length);
  else if (arg.startsWith("--config=")) baseConfigFile = arg.slice("--config=".length);
  else if (arg.startsWith("--bin=")) binPath = arg.slice("--bin=".length);
}

if (!scratchDir) {
  process.stderr.write("Missing --scratch=<dir> argument\n");
  process.exit(1);
}

fs.mkdirSync(scratchDir, { recursive: true });

const dataDir = path.join(scratchDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.PSIPHON_BIN = binPath;
process.env.PSIPHON_CONFIG_FILE = baseConfigFile;
process.env.PSIPHON_READY_TIMEOUT_MS = "4000";
process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS = "0";
process.env.PSIPHON_PROBE_URL = "http://cp.cloudflare.com/generate_204";
process.env.PSIPHON_IP_URL = "http://cp.cloudflare.com/trace";

if (mode === "stubborn-exit-on-sigterm") {
  process.env.FAKE_PSIPHON_IGNORE_SIGTERM = "1";
}

const pool = {
  id: `pool-signal-${mode}-${process.pid}`,
  type: "psiphon",
  data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
};

try {
  await ensureTunnel(pool);
  const child = __getActiveChildForTests(pool.id);
  if (!child || !child.pid) {
    throw new Error("Tunnel ready but activeChild PID is missing");
  }

  const childInfo = {
    childPid: child.pid,
    parentPid: process.pid,
    dataDir,
    mode,
  };
  fs.writeFileSync(
    path.join(scratchDir, "child-info.json"),
    JSON.stringify(childInfo, null, 2)
  );

  if (mode === "stubborn-exit-on-sigterm") {
    // Another SIGTERM listener that exits immediately synchronously.
    // When SIGTERM is sent:
    // 1. Manager onSignal begins teardownAllTunnels() awaiting terminateProcess(child).
    // 2. Child ignores SIGTERM, so terminateProcess is in 1500ms timeout.
    // 3. This listener runs synchronously and calls process.exit(0).
    // 4. Synchronous process "exit" hook in manager must find retained state.activeChild
    //    and send SIGKILL to the stubborn child.
    process.once("SIGTERM", () => {
      fs.writeFileSync(
        path.join(scratchDir, "second-listener-fired.marker"),
        String(Date.now())
      );
      process.exit(0);
    });
  } else if (mode === "graceful-drain-sigterm") {
    const drainMarker = path.join(scratchDir, "drain-completed.marker");
    process.on("SIGTERM", async () => {
      // Simulate real server drain work before exiting
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(
        drainMarker,
        JSON.stringify({ drainedAt: Date.now(), success: true })
      );
      process.exit(0);
    });
  } else if (mode === "graceful-drain-sigint") {
    const drainMarker = path.join(scratchDir, "drain-int-completed.marker");
    process.on("SIGINT", async () => {
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(
        drainMarker,
        JSON.stringify({ drainedAt: Date.now(), success: true })
      );
      process.exit(0);
    });
  } else if (mode === "default-signal-exit") {
    // No other signal listeners registered.
    // The manager onSignal handler must execute teardownAllTunnels and then exit
    // with 143 (for SIGTERM) or 130 (for SIGINT) when remainingListeners === 0.
  }

  // Notify test runner that setup is complete and tunnel is established
  process.stdout.write(`READY:${child.pid}\n`);

  // Keep process alive awaiting signals
  const keepAlive = setInterval(() => {}, 1000);
  process.on("exit", () => clearInterval(keepAlive));
} catch (err) {
  process.stderr.write(`Helper error establishing tunnel: ${err?.stack || err}\n`);
  process.exit(1);
}

#!/usr/bin/env bun
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ensureTunnel,
  rotate,
  getStatus,
  stopAll,
  terminateProcess,
  PsiphonUnavailableError,
  __resetForTests,
} from "../../src/lib/network/psiphon/psiphonManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-psiphon.mjs");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPidDeadOrZombie(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return true;
    throw err;
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/State:\s+([A-Z])/);
    if (m && m[1] === "Z") return true;
  } catch (err) {
    if (err.code === "ENOENT") return true;
  }
  return false;
}

async function waitForPidGone(pid, maxWaitMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    if (isPidDeadOrZombie(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return isPidDeadOrZombie(pid);
}

function spawnHelper({ mode, scratchDir, baseConfigFile }) {
  const helperScript = path.resolve(
    __dirname,
    "fixtures/proxy-reliability/signal-parent-helper.mjs"
  );
  return spawn(
    "bun",
    [
      helperScript,
      `--mode=${mode}`,
      `--scratch=${scratchDir}`,
      `--config=${baseConfigFile}`,
      `--bin=${FAKE_BIN}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.resolve(__dirname, "../.."),
    }
  );
}

function waitForHelperReady(helperProc, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errOutput = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for helper readiness (${timeoutMs}ms). Output: ${output} Stderr: ${errOutput}`
        )
      );
    }, timeoutMs);

    helperProc.stdout.on("data", (data) => {
      output += data.toString();
      const match = output.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });

    helperProc.stderr.on("data", (data) => {
      errOutput += data.toString();
    });

    helperProc.on("exit", (code, sig) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Helper process exited prematurely (code=${code}, sig=${sig}). Output: ${output} Stderr: ${errOutput}`
        )
      );
    });
  });
}

function waitForProcessExit(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      reject(new Error(`Timed out waiting for process ${proc.pid} to exit after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function run() {
  console.log("=== Starting G2: Tunnel Lifecycle Reliability Integration Test ===");

  const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "psiphon-lifecycle-"));
  const baseConfigFile = path.join(tmpTestDir, "client.config.json");
  fs.writeFileSync(
    baseConfigFile,
    JSON.stringify({ PropagationChannelId: "TEST", SponsorId: "TEST" })
  );

  process.env.DATA_DIR = tmpTestDir;
  process.env.PSIPHON_BIN = FAKE_BIN;
  process.env.PSIPHON_CONFIG_FILE = baseConfigFile;
  process.env.PSIPHON_READY_TIMEOUT_MS = "4000";
  process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS = "0";

  try {
    // --------------------------------------------------------------------------
    // Test 1: Real OS Process Clean Termination Awaited Before Directory Cleanup
    // --------------------------------------------------------------------------
    console.log("Testing Step 1: Real OS process clean termination awaited before directory cleanup...");
    const dir1 = path.join(tmpTestDir, "proc-clean");
    fs.mkdirSync(dir1, { recursive: true });
    const markerFile1 = path.join(dir1, "active.lock");
    fs.writeFileSync(markerFile1, String(process.pid));

    const cleanChild = spawn("node", [
      "-e",
      "setInterval(() => {}, 1000);"
    ]);

    assert.ok(isPidAlive(cleanChild.pid), "Process must be alive after spawn");
    const termPromise = terminateProcess(cleanChild, 1000);
    await termPromise;

    assert.equal(isPidAlive(cleanChild.pid), false, "Process must be dead after terminateProcess");
    // Only delete directory after termination is verified
    fs.rmSync(dir1, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir1), false, "Directory cleanly deleted after process dead");
    console.log("Step 1 passed: Clean process termination awaited before cleanup.");

    // --------------------------------------------------------------------------
    // Test 2: Real Stubborn OS Process - Escalation to SIGKILL Awaited
    // --------------------------------------------------------------------------
    console.log("Testing Step 2: Real stubborn OS process SIGKILL escalation...");
    const dir2 = path.join(tmpTestDir, "proc-stubborn");
    fs.mkdirSync(dir2, { recursive: true });

    const stubbornChild = spawn("node", [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    ]);

    // Give child time to boot and register SIGTERM listener
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(isPidAlive(stubbornChild.pid), "Stubborn child must be running");

    const t0 = Date.now();
    await terminateProcess(stubbornChild, 350);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed >= 300, `Must have waited for sigkill escalation timeout (took ${elapsed}ms)`);
    assert.equal(isPidAlive(stubbornChild.pid), false, "Stubborn child must be terminated by SIGKILL");
    assert.equal(stubbornChild.signalCode, "SIGKILL", "Child signalCode must be SIGKILL");

    fs.rmSync(dir2, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir2), false, "Directory deleted only after stubborn process killed");
    console.log("Step 2 passed: Stubborn process killed via SIGKILL escalation before cleanup.");

    // --------------------------------------------------------------------------
    // Test 3: Missing Egress Evidence CANNOT be Reported Ready (Fails Closed)
    // --------------------------------------------------------------------------
    console.log("Testing Step 3: Missing egress evidence fails closed (no unverified readiness)...");
    await __resetForTests();

    // Point IP URL to invalid port where probe will fail
    process.env.PSIPHON_PROBE_URL = "http://cp.cloudflare.com/generate_204";
    process.env.PSIPHON_IP_URL = "http://127.0.0.1:59999/nonexistent";

    const unverifiedPool = {
      id: "pool-unverified-egress",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    let readinessFailed = false;
    try {
      await ensureTunnel(unverifiedPool);
    } catch (err) {
      readinessFailed = true;
      assert.ok(
        err instanceof PsiphonUnavailableError,
        `Expected PsiphonUnavailableError, got ${err.name}: ${err.message}`
      );
      assert.ok(
        err.message.includes("egress") || err.message.includes("missing"),
        `Error message must mention egress failure: ${err.message}`
      );
    }
    assert.ok(readinessFailed, "ensureTunnel must throw when egress probe fails");

    const poolStatus = getStatus("pool-unverified-egress");
    assert.equal(poolStatus.state, "failed", "Pool state must be failed, NOT ready");
    assert.equal(poolStatus.egressVerified, false, "Egress must not be verified");
    console.log("Step 3 passed: Missing egress evidence correctly failed closed.");

    // --------------------------------------------------------------------------
    // Test 4: No Identical-IP False Success on Final Attempt
    // --------------------------------------------------------------------------
    console.log("Testing Step 4: No identical-IP false success on final rotation attempt...");
    await __resetForTests();

    // Set static IP so every attempt receives the identical egress IP
    process.env.FAKE_PSIPHON_STATIC_IP = "198.51.100.99";
    process.env.PSIPHON_IP_URL = "http://cp.cloudflare.com/trace";

    const staticIpPool = {
      id: "pool-same-ip-final",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL"], probeCandidates: 1 } },
    };

    const initial = await ensureTunnel(staticIpPool);
    assert.equal(initial.exitIp, "198.51.100.99");
    assert.equal(initial.generation, 1);

    let sameIpRotationFailed = false;
    try {
      await rotate("pool-same-ip-final", { reason: "force" });
    } catch (err) {
      sameIpRotationFailed = true;
      assert.ok(
        err instanceof PsiphonUnavailableError,
        `Expected PsiphonUnavailableError, got ${err.name}: ${err.message}`
      );
      assert.ok(
        err.message.includes("identical") || err.message.includes("remained"),
        `Error message must report identical IP: ${err.message}`
      );
    }
    assert.ok(sameIpRotationFailed, "Rotation must fail when egress IP remains identical after 3 attempts");

    const failedStatus = getStatus("pool-same-ip-final");
    assert.equal(failedStatus.state, "failed", "Pool state must be failed on identical IP");
    delete process.env.FAKE_PSIPHON_STATIC_IP;
    console.log("Step 4 passed: Identical-IP final attempt correctly fails closed with zero false success.");

    // --------------------------------------------------------------------------
    // Test 5: Clean Successful Rotation with Dynamic Distinct IP
    // --------------------------------------------------------------------------
    console.log("Testing Step 5: Successful rotation with distinct egress IP...");
    await __resetForTests();

    const distinctPool = {
      id: "pool-distinct-rotation",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL", "DE"], probeCandidates: 1 } },
    };

    const initialTunnel = await ensureTunnel(distinctPool);
    assert.equal(initialTunnel.generation, 1);
    const firstIp = initialTunnel.exitIp;
    assert.ok(firstIp, "First tunnel must have exitIp");

    const rotResult = await rotate("pool-distinct-rotation", { reason: "force" });
    assert.equal(rotResult.rotated, true, "Rotation must succeed");
    assert.equal(rotResult.generation, 2, "Generation must be incremented to 2");
    assert.notEqual(rotResult.exitIp, firstIp, "New exit IP must be distinct from first IP");
    console.log(`Step 5 passed: Tunnel rotated successfully to new distinct IP ${rotResult.exitIp}.`);

    // --------------------------------------------------------------------------
    // Test 6: Subprocess Acceptance: Child Ignores SIGTERM, Synchronous Exit Hook SIGKILLs Retained Child
    // --------------------------------------------------------------------------
    console.log("Testing Step 6: Subprocess acceptance: stubborn child ignores SIGTERM, exit hook sends SIGKILL to retained child...");
    const scratch6 = path.join(tmpTestDir, "subproc-stubborn-exit");
    fs.mkdirSync(scratch6, { recursive: true });

    const helper6 = spawnHelper({
      mode: "stubborn-exit-on-sigterm",
      scratchDir: scratch6,
      baseConfigFile,
    });

    let childPid6 = null;
    try {
      childPid6 = await waitForHelperReady(helper6, 8000);
      assert.ok(childPid6 > 0, `Valid child PID expected, got ${childPid6}`);
      assert.ok(!isPidDeadOrZombie(childPid6), "Child process must be running initially");

      // Verify child-info was written to scratch
      const infoPath6 = path.join(scratch6, "child-info.json");
      assert.ok(fs.existsSync(infoPath6), "child-info.json must exist in scratch dir");
      const info6 = JSON.parse(fs.readFileSync(infoPath6, "utf8"));
      assert.equal(info6.childPid, childPid6);

      // Send SIGTERM to parent helper
      // Helper starts teardownAllTunnels, child ignores SIGTERM (1500ms timeout),
      // second SIGTERM listener triggers process.exit(0) immediately.
      // Manager's synchronous exit hook must find retained state.activeChild and SIGKILL it.
      process.kill(helper6.pid, "SIGTERM");

      const exitResult6 = await waitForProcessExit(helper6, 6000);
      assert.equal(exitResult6.code, 0, `Parent helper must exit 0, got ${exitResult6.code}`);

      // Verify the second listener actually ran
      const marker6 = path.join(scratch6, "second-listener-fired.marker");
      assert.ok(fs.existsSync(marker6), "Second SIGTERM listener must have fired");

      // Bounded wait for stubborn child to be terminated via SIGKILL
      const childDead6 = await waitForPidGone(childPid6, 3000);
      assert.ok(childDead6, `Stubborn child ${childPid6} must be dead/killed by synchronous exit hook`);
      console.log("Step 6 passed: Retained child killed by synchronous exit hook on early parent exit.");
    } finally {
      if (childPid6 && !isPidDeadOrZombie(childPid6)) {
        try {
          process.kill(childPid6, "SIGKILL");
        } catch {}
      }
      try {
        helper6.kill("SIGKILL");
      } catch {}
    }

    // --------------------------------------------------------------------------
    // Test 7: Subprocess Acceptance: Graceful SIGTERM with Server Drain Listener Remaining Does Not Exit Prematurely
    // --------------------------------------------------------------------------
    console.log("Testing Step 7: Subprocess acceptance: graceful SIGTERM with server drain listener finishes drain contract...");
    const scratch7 = path.join(tmpTestDir, "subproc-drain-sigterm");
    fs.mkdirSync(scratch7, { recursive: true });

    const helper7 = spawnHelper({
      mode: "graceful-drain-sigterm",
      scratchDir: scratch7,
      baseConfigFile,
    });

    let childPid7 = null;
    try {
      childPid7 = await waitForHelperReady(helper7, 8000);
      assert.ok(childPid7 > 0, `Valid child PID expected, got ${childPid7}`);
      assert.ok(!isPidDeadOrZombie(childPid7), "Child process must be running initially");

      const t0_7 = Date.now();
      process.kill(helper7.pid, "SIGTERM");

      const exitResult7 = await waitForProcessExit(helper7, 6000);
      const elapsed7 = Date.now() - t0_7;

      assert.equal(exitResult7.code, 0, `Parent helper must exit 0 on drain completion, got ${exitResult7.code}`);
      assert.ok(elapsed7 >= 150, `Drain listener must have performed bounded work before exit (took ${elapsed7}ms)`);

      const drainMarker7 = path.join(scratch7, "drain-completed.marker");
      assert.ok(fs.existsSync(drainMarker7), "drain-completed.marker must be written by drain listener");
      const drainData7 = JSON.parse(fs.readFileSync(drainMarker7, "utf8"));
      assert.equal(drainData7.success, true);

      const childDead7 = await waitForPidGone(childPid7, 3000);
      assert.ok(childDead7, `Tunnel child ${childPid7} must be cleanly terminated on shutdown`);
      console.log(`Step 7 passed: Graceful SIGTERM allowed drain listener to complete contract (${elapsed7}ms).`);
    } finally {
      if (childPid7 && !isPidDeadOrZombie(childPid7)) {
        try {
          process.kill(childPid7, "SIGKILL");
        } catch {}
      }
      try {
        helper7.kill("SIGKILL");
      } catch {}
    }

    // --------------------------------------------------------------------------
    // Test 8: Subprocess Acceptance: Graceful SIGINT with Server Drain Listener Remaining Does Not Exit Prematurely
    // --------------------------------------------------------------------------
    console.log("Testing Step 8: Subprocess acceptance: graceful SIGINT with server drain listener finishes drain contract...");
    const scratch8 = path.join(tmpTestDir, "subproc-drain-sigint");
    fs.mkdirSync(scratch8, { recursive: true });

    const helper8 = spawnHelper({
      mode: "graceful-drain-sigint",
      scratchDir: scratch8,
      baseConfigFile,
    });

    let childPid8 = null;
    try {
      childPid8 = await waitForHelperReady(helper8, 8000);
      assert.ok(childPid8 > 0, `Valid child PID expected, got ${childPid8}`);
      assert.ok(!isPidDeadOrZombie(childPid8), "Child process must be running initially");

      const t0_8 = Date.now();
      process.kill(helper8.pid, "SIGINT");

      const exitResult8 = await waitForProcessExit(helper8, 6000);
      const elapsed8 = Date.now() - t0_8;

      assert.equal(exitResult8.code, 0, `Parent helper must exit 0 on drain completion, got ${exitResult8.code}`);
      assert.ok(elapsed8 >= 150, `Drain listener must have performed bounded work before exit (took ${elapsed8}ms)`);

      const drainMarker8 = path.join(scratch8, "drain-int-completed.marker");
      assert.ok(fs.existsSync(drainMarker8), "drain-int-completed.marker must be written by drain listener");
      const drainData8 = JSON.parse(fs.readFileSync(drainMarker8, "utf8"));
      assert.equal(drainData8.success, true);

      const childDead8 = await waitForPidGone(childPid8, 3000);
      assert.ok(childDead8, `Tunnel child ${childPid8} must be cleanly terminated on shutdown`);
      console.log(`Step 8 passed: Graceful SIGINT allowed drain listener to complete contract (${elapsed8}ms).`);
    } finally {
      if (childPid8 && !isPidDeadOrZombie(childPid8)) {
        try {
          process.kill(childPid8, "SIGKILL");
        } catch {}
      }
      try {
        helper8.kill("SIGKILL");
      } catch {}
    }

    // --------------------------------------------------------------------------
    // Test 9: Subprocess Acceptance: Default Signal Exit Code with Zero Other Listeners
    // --------------------------------------------------------------------------
    console.log("Testing Step 9: Subprocess acceptance: default exit handler exits with standard signal code (143)...");
    const scratch9 = path.join(tmpTestDir, "subproc-default-exit");
    fs.mkdirSync(scratch9, { recursive: true });

    const helper9 = spawnHelper({
      mode: "default-signal-exit",
      scratchDir: scratch9,
      baseConfigFile,
    });

    let childPid9 = null;
    try {
      childPid9 = await waitForHelperReady(helper9, 8000);
      assert.ok(childPid9 > 0, `Valid child PID expected, got ${childPid9}`);
      assert.ok(!isPidDeadOrZombie(childPid9), "Child process must be running initially");

      process.kill(helper9.pid, "SIGTERM");

      const exitResult9 = await waitForProcessExit(helper9, 6000);
      assert.equal(exitResult9.code, 143, `Parent helper must exit 143 (standard SIGTERM code), got ${exitResult9.code}`);

      const childDead9 = await waitForPidGone(childPid9, 3000);
      assert.ok(childDead9, `Tunnel child ${childPid9} must be cleanly terminated on default exit`);
      console.log("Step 9 passed: Default exit handler cleanly torn down tunnel and exited 143.");
    } finally {
      if (childPid9 && !isPidDeadOrZombie(childPid9)) {
        try {
          process.kill(childPid9, "SIGKILL");
        } catch {}
      }
      try {
        helper9.kill("SIGKILL");
      } catch {}
    }

    console.log("\n=======================================================");
    console.log("TUNNEL_LIFECYCLE_RELIABILITY_PASS");
    console.log("=======================================================");
    process.exit(0);
  } finally {
    await stopAll();
    await __resetForTests();
    try {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("G2 TEST FAILURE:", err);
  process.exit(1);
});

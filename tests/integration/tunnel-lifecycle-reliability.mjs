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

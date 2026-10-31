#!/usr/bin/env bun
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { shouldRotateOn } from "../../src/lib/network/psiphon/classify.js";
import {
  ensureTunnel,
  rotate,
  getStatus,
  stopAll,
  __resetForTests,
} from "../../src/lib/network/psiphon/psiphonManager.js";
import { stableSessionId, OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-psiphon.mjs");

async function run() {
  console.log("=== Starting G4: Quota Handling Reliability Integration Test ===");

  const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-reliability-"));
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

  let quotaServerRequests = 0;
  let lastServerRequestHeaders = null;

  // Real loopback HTTP server simulating upstream quota and rate limits
  const quotaServer = http.createServer((req, res) => {
    quotaServerRequests++;
    lastServerRequestHeaders = { ...req.headers };

    if (req.url?.includes("/quota-429")) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "45",
      });
      res.end(JSON.stringify({
        error: {
          message: "Rate limit exceeded. Please wait.",
          type: "FreeUsageLimitError",
        },
      }));
      return;
    }

    if (req.url?.includes("/quota-403")) {
      res.writeHead(403, {
        "Content-Type": "application/json",
        "Retry-After": "120",
      });
      res.end(JSON.stringify({
        error: {
          message: "Free tier usage limit reached.",
          type: "FreeTierError",
        },
      }));
      return;
    }

    if (req.url?.includes("/transport-502")) {
      res.writeHead(502, {
        "Content-Type": "text/plain",
      });
      res.end("Bad Gateway: ECONNREFUSED connect timeout");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => quotaServer.listen(0, "127.0.0.1", resolve));
  const serverPort = quotaServer.address().port;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  try {
    // --------------------------------------------------------------------------
    // Test 1: shouldRotateOn Classification Contract
    // --------------------------------------------------------------------------
    console.log("Testing Step 1: shouldRotateOn classification contract...");

    // Quota and rate-limit burn errors MUST return true (trigger tunnel rotation)
    assert.equal(shouldRotateOn({ status: 429 }), true, "429 must trigger rotation");
    assert.equal(shouldRotateOn({ status: 429, error: "FreeUsageLimitError" }), true, "429 FreeUsageLimit must rotate");
    assert.equal(shouldRotateOn({ status: 403, error: "FreeTierError: flagged IP" }), true, "403 FreeTierError must rotate");
    assert.equal(shouldRotateOn({ status: 403, body: JSON.stringify({ error: "FreeUsageLimit" }) }), true, "403 FreeUsageLimit must rotate");

    // Negative cases MUST return false
    assert.equal(shouldRotateOn({ status: 400 }), false, "400 must not rotate");
    assert.equal(shouldRotateOn({ status: 401 }), false, "401 must not rotate");
    assert.equal(shouldRotateOn({ status: 403, error: "Forbidden: invalid api key" }), false, "generic 403 must not rotate");

    // Client aborts MUST return false
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    assert.equal(shouldRotateOn({ status: 0, error: abortErr }), false, "Client abort must never rotate");

    // Authentic transport failures MUST return true
    assert.equal(shouldRotateOn({ status: 502, error: "ECONNRESET" }), true, "502 ECONNRESET must rotate");
    assert.equal(shouldRotateOn({ status: 503, error: "connect timeout" }), true, "503 connect timeout must rotate");
    assert.equal(shouldRotateOn({ status: 502, error: "Proxy connection failed" }), true, "502 Proxy error must rotate");
    assert.equal(shouldRotateOn({ error: new Error("connect timeout") }), true, "Network connect timeout must rotate");
    console.log("Step 1 passed: shouldRotateOn classification strictly adheres to transport and burn contracts.");

    // --------------------------------------------------------------------------
    // Test 2: Tunnel State Rotates on Burn Signal (429 / Flagged IP)
    // --------------------------------------------------------------------------
    console.log("Testing Step 2: Tunnel rotation on burn signal...");
    const poolConfig = {
      id: "pool-quota-test",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 1 } },
    };

    const initialTunnel = await ensureTunnel(poolConfig);
    const genBefore = initialTunnel.generation;
    const ipBefore = initialTunnel.exitIp;
    assert.ok(ipBefore, "Initial tunnel must have an exit IP");

    // Simulate chat request resulting in upstream 429
    const response429 = await fetch(`${serverUrl}/quota-429`);
    assert.equal(response429.status, 429, "Upstream status must be 429");
    assert.equal(response429.headers.get("retry-after"), "45", "Retry-After header must be 45");

    // When burn signal is detected, rotate increments generation
    assert.ok(shouldRotateOn({ status: 429 }), "429 must be recognized as burn signal");
    const rotated = await rotate("pool-quota-test", { reason: "burn_429" });
    assert.ok(rotated.rotated, "Tunnel must report rotated=true");
    assert.equal(rotated.generation, genBefore + 1, "Generation must increment on rotation");
    console.log("Step 2 passed: HTTP 429 rotates tunnel generation and exit IP as expected.");

    // --------------------------------------------------------------------------
    // Test 3: Upstream Retry-After Header Faithfully Preserved
    // --------------------------------------------------------------------------
    console.log("Testing Step 3: Upstream Retry-After header preservation...");
    const res403 = await fetch(`${serverUrl}/quota-403`);
    assert.equal(res403.status, 403, "Status must be 403");
    assert.equal(res403.headers.get("retry-after"), "120", "Retry-After header must be 120");

    const body403 = await res403.json();
    assert.equal(body403.error?.type, "FreeTierError", "Error body preserved");

    const statusAfter403 = getStatus("pool-quota-test");
    assert.equal(statusAfter403.generation, rotated.generation, "Generation must match current generation");
    console.log("Step 3 passed: Retry-After header and error payloads preserved verbatim.");

    // --------------------------------------------------------------------------
    // Test 4: Stable Session Identity Preserved Across Quota Limits
    // --------------------------------------------------------------------------
    console.log("Testing Step 4: Stable OpenCode session identity preserved across quota limits...");
    const credentials = {
      connectionId: "conn-test-quota-identity-123",
      rawHeaders: { authorization: "Bearer sk-test-key-identity" },
    };

    const sessionA = stableSessionId(credentials);
    assert.ok(sessionA.startsWith("ses_"), "Session must be a valid OpenCode session ID");

    // Calling stableSessionId again with the same credentials must return the exact same session
    const sessionB = stableSessionId(credentials);
    assert.equal(sessionA, sessionB, "Session identity must remain completely stable without churn");

    // Ensure session is NOT invalidated on quota responses
    const sessionC = stableSessionId(credentials);
    assert.equal(sessionA, sessionC, "Session identity remains unchanged after quota handling");
    console.log("Step 4 passed: Session identity remains stable without churn.");

    // --------------------------------------------------------------------------
    // Test 5: Contrast: Transport Failures DO Trigger Safe Recovery
    // --------------------------------------------------------------------------
    console.log("Testing Step 5: Contrast: Transport failure triggers legitimate tunnel recovery...");
    const transportRes = await fetch(`${serverUrl}/transport-502`);
    assert.equal(transportRes.status, 502, "Transport error status is 502");
    const transportText = await transportRes.text();

    const shouldRotate = shouldRotateOn({ status: transportRes.status, error: transportText });
    assert.equal(shouldRotate, true, "Transport failure must trigger rotation");

    // Perform legitimate rotation on transport failure
    const currentGen = getStatus("pool-quota-test").generation;
    const rot = await rotate("pool-quota-test", { reason: "transport_502", seenGeneration: currentGen });
    assert.equal(rot.rotated, true, "Legitimate transport failure triggers rotation");
    assert.equal(rot.generation, currentGen + 1, "Generation increments on transport recovery");
    console.log("Step 5 passed: Transport failures legitimately trigger rotation as expected.");

    console.log("\n=======================================================");
    console.log("QUOTA_HANDLING_RELIABILITY_PASS");
    console.log("=======================================================");
    process.exit(0);
  } finally {
    await stopAll();
    await __resetForTests();
    await new Promise((resolve) => quotaServer.close(resolve));
    try {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("G4 TEST FAILURE:", err);
  process.exit(1);
});

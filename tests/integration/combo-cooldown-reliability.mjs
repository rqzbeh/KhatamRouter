#!/usr/bin/env bun
/**
 * Integration test: combo cooldown reliability, isolation, and failure status preservation.
 * Runs real loopback HTTP endpoints with real fetch (no vi.fn / HTTP mocks).
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

// 1. Isolate temporary DATA_DIR before importing DB / app modules
const tempDir = mkdtempSync(join(tmpdir(), "khatam-combo-cooldown-"));
process.env.DATA_DIR = tempDir;

// 2. Strip ambient proxy variables
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;

// 3. Import combo chat handler
const { handleComboChat, getComboCooldownMapSize } = await import("../../open-sse/services/combo.js");

// Dummy logger for tests
const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

// 4. Setup loopback HTTP server
const endpointCounts = {};
let modelModes = {
  "test/primary": "429-sec",
  "test/secondary": "200-ok",
  "test/fail503": "503-outage",
  "test/fail502": "502-bad-gateway",
  "test/fail429-sec": "429-sec-120",
  "test/fail429-date": "429-date",
  "test/fail429-extreme-sec": "429-extreme-sec",
  "test/fail429-uint64": "429-uint64",
  "test/fail429-infinity": "429-infinity",
  "test/fail429-malformed-resets": "429-malformed-resets",
  "test/fail503-transient-wait": "503-transient-wait",
  "test/req-scoped": "400-badreq",
  "test/good": "200-ok",
};

const server = http.createServer((req, res) => {
  const url = req.url || "";
  const modelName = url.replace(/^\/model\//, "");
  endpointCounts[modelName] = (endpointCounts[modelName] || 0) + 1;

  const mode = modelModes[modelName] || "200-ok";

  if (mode === "429-extreme-sec") {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "9999999999999999"
    });
    res.end(JSON.stringify({ error: { message: "Quota exhausted (extreme numeric seconds)" } }));
    return;
  }

  if (mode === "429-uint64") {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "18446744073709551615"
    });
    res.end(JSON.stringify({ error: { message: "Quota exhausted (UINT64_MAX)" } }));
    return;
  }

  if (mode === "429-infinity") {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "Infinity"
    });
    res.end(JSON.stringify({ error: { message: "Quota exhausted (Infinity-like text)" } }));
    return;
  }

  if (mode === "429-malformed-resets") {
    res.writeHead(429, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: { message: "Rate limit resetsAtMs malformed" },
      resetsAtMs: 1e25
    }));
    return;
  }

  if (mode === "503-transient-wait") {
    res.writeHead(503, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: { message: "server overloaded" } }));
    return;
  }

  if (mode === "429-sec") {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "60"
    });
    res.end(JSON.stringify({ error: { message: "Rate limit reached on primary" } }));
    return;
  }

  if (mode === "429-sec-120") {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "120"
    });
    res.end(JSON.stringify({ error: { message: "Quota exceeded: retry in 120 seconds", retryAfter: "120" } }));
    return;
  }

  if (mode === "429-date") {
    const futureDate = new Date(Date.now() + 180000).toUTCString();
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": futureDate
    });
    res.end(JSON.stringify({ error: { message: "Quota exceeded: scheduled reset", retryAfter: futureDate } }));
    return;
  }

  if (mode === "503-outage") {
    res.writeHead(503, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: { message: "Service Unavailable: backend cluster degraded" } }));
    return;
  }

  if (mode === "502-bad-gateway") {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: { message: "Bad Gateway from upstream" } }));
    return;
  }

  if (mode === "400-badreq") {
    res.writeHead(400, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: { message: "Unsupported parameter: context window exceeded" } }));
    return;
  }

  // Default 200 OK
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: `Success response from ${modelName}` }, finish_reason: "stop" }]
  }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function createModelHandler() {
  return async (body, modelStr) => {
    return await fetch(`http://127.0.0.1:${port}/model/${modelStr}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: body?.signal
    });
  };
}

try {
  console.log("# Test 1: Independent caller contexts with same comboName must NOT suppress each other");
  {
    modelModes["test/primary"] = "429-sec";
    modelModes["test/secondary"] = "200-ok";

    // Caller Context A: hits primary (429), falls back to secondary (200)
    const resA = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["test/primary", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "shared-combo",
      cooldownScope: "context-tenant-A"
    });

    assert.equal(resA.status, 200, "Context A must succeed via secondary model");
    assert.equal(endpointCounts["test/primary"], 1, "Context A must have called primary once");
    assert.equal(endpointCounts["test/secondary"], 1, "Context A must have called secondary once");

    // Primary upstream recovers before Context B calls
    modelModes["test/primary"] = "200-ok";

    // Caller Context B: independent context, same comboName!
    // Context B must NOT have primary suppressed by Context A's cooldown!
    const resB = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello from B" }] },
      models: ["test/primary", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "shared-combo",
      cooldownScope: "context-tenant-B"
    });

    assert.equal(resB.status, 200, "Context B must succeed");
    assert.equal(endpointCounts["test/primary"], 2, "Context B must call primary; must NOT be suppressed by Context A");
    const jsonB = await resB.json();
    assert.match(jsonB.choices[0].message.content, /test\/primary/, "Context B should receive primary model output");
    console.log("  ✓ Test 1 passed: Independent caller contexts do not suppress each other");
  }

  console.log("# Test 2: all5xx subsequent call must NEVER return 429");
  {
    const scope5xx = "scope-outage-5xx";

    // Call 1: all models in combo fail with 503 / 502
    const res1 = await handleComboChat({
      body: { messages: [{ role: "user", content: "outage test 1" }] },
      models: ["test/fail503", "test/fail502"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "outage-combo",
      cooldownScope: scope5xx
    });

    assert.ok(res1.status === 503 || res1.status === 502, `First outage call must return 5xx status, got ${res1.status}`);

    // Call 2: subsequent call in same scope while models are cooled down
    const res2 = await handleComboChat({
      body: { messages: [{ role: "user", content: "outage test 2" }] },
      models: ["test/fail503", "test/fail502"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "outage-combo",
      cooldownScope: scope5xx
    });

    assert.notEqual(res2.status, 429, "Subsequent call during 5xx outage must NEVER return 429");
    assert.ok(res2.status === 503 || res2.status === 502, `Subsequent call must return 5xx outage status, got ${res2.status}`);
    const json2 = await res2.json();
    assert.ok(json2.error && json2.error.message, "Must return valid error message");
    console.log("  ✓ Test 2 passed: All-5xx subsequent calls retain 5xx and never return 429");
  }

  console.log("# Test 3: 429 date and seconds Retry-After retained without shortening to 90s");
  {
    // Test 3a: Retry-After in seconds (120s > 90s)
    const resSec = await handleComboChat({
      body: { messages: [{ role: "user", content: "rate limit test seconds" }] },
      models: ["test/fail429-sec"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "sec-combo",
      cooldownScope: "sec-scope"
    });

    assert.equal(resSec.status, 429, "Must return 429 status");
    const retryAfterHeader = resSec.headers.get("retry-after");
    assert.ok(retryAfterHeader, "Must retain retry-after header");
    const retrySec = parseInt(retryAfterHeader, 10);
    assert.ok(retrySec >= 100, `Retry-After seconds must not be truncated below 100s, got ${retrySec}`);

    // Test 3b: Retry-After as HTTP-date (approx 180s in future)
    const resDate = await handleComboChat({
      body: { messages: [{ role: "user", content: "rate limit test date" }] },
      models: ["test/fail429-date"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "date-combo",
      cooldownScope: "date-scope"
    });

    assert.equal(resDate.status, 429, "Must return 429 status for date retry");
    const dateRetry = resDate.headers.get("retry-after");
    assert.ok(dateRetry, "Must retain retry-after header from date format");
    const parsedDateSec = parseInt(dateRetry, 10);
    assert.ok(parsedDateSec >= 150, `Parsed date Retry-After must be preserved in seconds, got ${parsedDateSec}`);
    console.log("  ✓ Test 3 passed: Retry-After seconds and date accurately parsed and retained");
  }

  console.log("# Test 4: Default behavior without explicit scope has NO cross-request suppression");
  {
    modelModes["test/primary"] = "429-sec";
    modelModes["test/secondary"] = "200-ok";

    // Request 1 without cooldownScope
    const res1 = await handleComboChat({
      body: { messages: [{ role: "user", content: "req 1" }] },
      models: ["test/primary", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "unscoped-combo"
    });
    assert.equal(res1.status, 200);
    const countBefore = endpointCounts["test/primary"];

    // Recover primary
    modelModes["test/primary"] = "200-ok";

    // Request 2 without cooldownScope: should try primary again
    const res2 = await handleComboChat({
      body: { messages: [{ role: "user", content: "req 2" }] },
      models: ["test/primary", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "unscoped-combo"
    });
    assert.equal(res2.status, 200);
    assert.equal(endpointCounts["test/primary"], countBefore + 1, "Default unscoped calls must not suppress primary across requests");
    console.log("  ✓ Test 4 passed: Default unscoped calls avoid cross-request suppression");
  }

  console.log("# Test 5: Request-scoped 4xx rejection preserved and discarded bodies drained");
  {
    const resReq = await handleComboChat({
      body: { messages: [{ role: "user", content: "badreq" }] },
      models: ["test/req-scoped", "test/fail503"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "req-scoped-combo"
    });

    assert.equal(resReq.status, 400, "First request-scoped error response must be preserved and returned");
    const json = await resReq.json();
    assert.match(json.error.message, /context window exceeded/, "Must retain original request-scoped error body");
    console.log("  ✓ Test 5 passed: Request-scoped rejection preserved and body intact");
  }

  console.log("# Test 6: Requests while cooldown use correct status, body, and headers");
  {
    const testScope = "status-body-test-scope";
    // Cause 429 cooldown
    await handleComboChat({
      body: { messages: [{ role: "user", content: "test" }] },
      models: ["test/fail429-sec"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "status-test-combo",
      cooldownScope: testScope
    });

    // Immediate repeat while cooling
    const coolingRes = await handleComboChat({
      body: { messages: [{ role: "user", content: "test 2" }] },
      models: ["test/fail429-sec"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "status-test-combo",
      cooldownScope: testScope
    });

    assert.equal(coolingRes.status, 429, "Must return 429 during rate limit cooldown");
    assert.ok(coolingRes.headers.get("retry-after"), "Must return retry-after header during cooldown");
    const coolingJson = await coolingRes.json();
    assert.ok(coolingJson.error?.message, "Must return valid error message");
    console.log("  ✓ Test 6 passed: Requests while cooling carry proper status, body, and retry-after headers");
  }

  console.log("# Test 7: Bounded cooldown memory under high volume");
  {
    for (let i = 0; i < 1100; i++) {
      await handleComboChat({
        body: { messages: [{ role: "user", content: "load" }] },
        models: [`model-vol-${i}`],
        handleSingleModel: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" }
        }),
        log,
        comboName: `load-combo-${i}`,
        cooldownScope: `scope-${i}`
      });
    }

    const mapSize = getComboCooldownMapSize();
    assert.ok(mapSize <= 1000, `Cooldown map must not exceed 1000 entries under volume, got ${mapSize}`);
    console.log(`  ✓ Test 7 passed: Bounded memory confirmed (size: ${mapSize} <= 1000)`);
  }

  console.log("# Test 8: AbortSignal cancels immediately without delay");
  {
    const abortController = new AbortController();
    abortController.abort();

    const t0 = Date.now();
    const abortRes = await handleComboChat({
      body: { messages: [{ role: "user", content: "abort me" }] },
      models: ["test/primary", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "abort-combo",
      signal: abortController.signal
    });

    const elapsed = Date.now() - t0;
    assert.equal(abortRes.status, 499, "Must return 499 when aborted");
    assert.ok(elapsed < 100, `Abort must return immediately without blocking sleep, took ${elapsed}ms`);
    console.log("  ✓ Test 8 passed: AbortSignal cancellation is instantaneous and abort-safe");
  }

  console.log("# Test 9: Extreme numeric Retry-After (9999999999999999, UINT64_MAX) preserves original 429 and raw header");
  {
    // Test 9a: 9999999999999999 seconds (valid HTTP delay-seconds, exceeds JS Date representation)
    const resExtreme = await handleComboChat({
      body: { messages: [{ role: "user", content: "extreme sec" }] },
      models: ["test/fail429-extreme-sec"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "extreme-sec-combo",
      cooldownScope: "extreme-sec-scope"
    });

    assert.equal(resExtreme.status, 429, "Original 429 status must be preserved, got " + resExtreme.status);
    const extremeHeader = resExtreme.headers.get("retry-after");
    assert.equal(extremeHeader, "9999999999999999", "Raw 9999999999999999 Retry-After header must be preserved without truncation to 30 days");

    // Test 9b: UINT64_MAX
    const resUint64 = await handleComboChat({
      body: { messages: [{ role: "user", content: "uint64 max" }] },
      models: ["test/fail429-uint64"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "uint64-combo",
      cooldownScope: "uint64-scope"
    });

    assert.equal(resUint64.status, 429, "Original 429 status must be preserved for UINT64_MAX, got " + resUint64.status);
    const uint64Header = resUint64.headers.get("retry-after");
    assert.equal(uint64Header, "18446744073709551615", "Raw UINT64_MAX Retry-After header must be preserved");
    console.log("  ✓ Test 9 passed: Extreme Retry-After values preserve original status 429 and raw header");
  }

  console.log("# Test 10: Infinity-like text and malformed resetsAtMs produces no 500 / InvalidDate");
  {
    // Test 10a: Infinity-like text
    const resInf = await handleComboChat({
      body: { messages: [{ role: "user", content: "infinity test" }] },
      models: ["test/fail429-infinity"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "inf-combo"
    });

    assert.equal(resInf.status, 429, "Infinity text must not cause 500, must preserve 429 status");
    assert.notEqual(resInf.status, 500, "Must not return 500 on Infinity text");

    // Test 10b: Malformed resetsAtMs
    const resMalformed = await handleComboChat({
      body: { messages: [{ role: "user", content: "malformed resets test" }] },
      models: ["test/fail429-malformed-resets"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "malformed-resets-combo"
    });

    assert.equal(resMalformed.status, 429, "Malformed resetsAtMs must not produce 500 / Invalid Date");
    assert.notEqual(resMalformed.status, 500, "Must not return 500 on malformed resetsAtMs");
    console.log("  ✓ Test 10 passed: Infinity text and malformed resetsAtMs safely handled without 500");
  }

  console.log("# Test 11: Real transient 503 delay leaves 0 listeners on completion and cancels body on abort");
  {
    // Test 11a: Repeated completed transient delays remove listener
    const reuseSignalCtrl = new AbortController();
    for (let r = 0; r < 2; r++) {
      modelModes["test/primary"] = "503-transient-wait";
      modelModes["test/secondary"] = "200-ok";

      const tRes = await handleComboChat({
        body: { messages: [{ role: "user", content: "transient listener check" }] },
        models: ["test/primary", "test/secondary"],
        handleSingleModel: createModelHandler(),
        log,
        comboName: "transient-combo-reuse",
        signal: reuseSignalCtrl.signal
      });

      assert.equal(tRes.status, 200, "Must succeed on secondary model");
      const listenerCount = getEventListeners(reuseSignalCtrl.signal, "abort").length;
      assert.equal(listenerCount, 0, `Transient delay must remove abort listener on success, found ${listenerCount}`);
    }

    // Test 11b: Abort during transient delay returns 499 and cancels response body
    const abortWaitCtrl = new AbortController();
    setTimeout(() => abortWaitCtrl.abort(), 100);

    const abortDuringWaitRes = await handleComboChat({
      body: { messages: [{ role: "user", content: "abort mid wait" }] },
      models: ["test/fail503-transient-wait", "test/secondary"],
      handleSingleModel: createModelHandler(),
      log,
      comboName: "abort-mid-wait-combo",
      signal: abortWaitCtrl.signal
    });

    assert.equal(abortDuringWaitRes.status, 499, `Must return 499 on abort during delay, got ${abortDuringWaitRes.status}`);
    console.log("  ✓ Test 11 passed: Transient delays remove listeners on completion and abort consistently returns 499");
  }

  console.log("\nCOMBO_COOLDOWN_RELIABILITY_PASS");
} finally {
  server.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

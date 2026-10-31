#!/usr/bin/env bun
import assert from "node:assert/strict";
import {
  createEphemeralCA,
  createTestOriginServer,
  createUntrustedOriginServer,
  createTestConnectProxy,
} from "./fixtures/proxy-reliability/testServer.js";
import {
  opencodeAdapterFetch,
  opencodeTlsFetch,
  resetOpencodeTlsSession,
  isOpencodeHost,
  __test__ as tlsTest,
} from "../../open-sse/services/opencodeTlsClient.js";
import { proxyAwareFetch, scrubProxyCredentials } from "../../open-sse/utils/proxyFetch.js";

async function run() {
  console.log("=== Starting G1: Proxy Transport Reliability Integration Test ===");

  // Create ephemeral local CA and set SSL_CERT_FILE for native BoringSSL validation
  const ca = await createEphemeralCA();
  const origin = await createTestOriginServer({
    hostname: "opencode.ai",
    caCert: ca.caCert,
    caKey: ca.caKey,
  });
  const proxy = await createTestConnectProxy({ targetPort: origin.port, targetHostname: "opencode.ai" });

  try {
    // --------------------------------------------------------------------------
    // Test 0: Untrusted Certificate Rejection (Enforce Certificate Validation)
    // --------------------------------------------------------------------------
    console.log("Testing Step 0: Untrusted certificate rejection (certificate validation enforced)...");
    const untrustedOrigin = await createUntrustedOriginServer({ hostname: "opencode.ai" });
    const untrustedProxy = await createTestConnectProxy({
      targetPort: untrustedOrigin.port,
      targetHostname: "opencode.ai",
    });

    let untrustedRejected = false;
    try {
      await opencodeAdapterFetch("https://opencode.ai/test", {}, {
        proxyUrl: untrustedProxy.url,
        strictProxy: true,
      });
    } catch (err) {
      untrustedRejected = true;
      assert.ok(
        err.message.includes("CERTIFICATE_VERIFY_FAILED") ||
        err.message.includes("certificate") ||
        err.message.includes("handshake"),
        `Expected certificate verification failure, got: ${err.message}`
      );
    }
    assert.ok(untrustedRejected, "Untrusted certificate must be rejected with TLS verification error");
    await untrustedProxy.close();
    await untrustedOrigin.close();
    console.log("Step 0 passed: Untrusted certificate was rejected (no insecure:true bypass).");

    // --------------------------------------------------------------------------
    // Test 1: Direct Native wreq-js Session with Trusted Ephemeral CA
    // --------------------------------------------------------------------------
    console.log("Testing Step 1: Direct native wreq-js session through CONNECT proxy with trusted CA...");
    const { createSession } = await import("wreq-js");
    const nativeSession = await createSession({
      proxy: proxy.url,
      emulation: { tlsOptions: { cipherList: tlsTest.OPENCODE_CIPHER_LIST } },
    });

    const nativeRes = await nativeSession.fetch("https://opencode.ai/test", { method: "GET" });
    assert.equal(nativeRes.status, 200, "Native wreq-js status must be 200");
    const nativeJson = await nativeRes.json();
    assert.equal(nativeJson.ok, true, "Response body ok must be true");
    await nativeSession.close();
    assert.equal(proxy.getConnectCount(), 1, "Proxy CONNECT count must be 1 for test 1");
    console.log("Step 1 passed: Native wreq-js successfully traversed CONNECT proxy with verified CA.");

    // --------------------------------------------------------------------------
    // Test 2: opencodeAdapterFetch through CONNECT Proxy (No insecure:true)
    // --------------------------------------------------------------------------
    console.log("Testing Step 2: Full opencodeAdapterFetch path through proxy...");
    const connectBefore = proxy.getConnectCount();
    const adapterRes = await opencodeAdapterFetch("https://opencode.ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    }, {
      proxyUrl: proxy.url,
      strictProxy: true,
    });

    assert.equal(adapterRes.status, 200, "Adapter status must be 200");
    const adapterJson = await adapterRes.json();
    assert.equal(adapterJson.ok, true, "Adapter response must be ok");
    assert.equal(proxy.getConnectCount(), connectBefore + 1, "Proxy CONNECT count must increment by 1");
    console.log("Step 2 passed: opencodeAdapterFetch routed through CONNECT proxy with valid TLS.");

    // --------------------------------------------------------------------------
    // Test 3: Streaming Transfer Isolation through Proxy
    // --------------------------------------------------------------------------
    console.log("Testing Step 3: Streaming transfer through proxy...");
    const streamRes = await opencodeAdapterFetch("https://opencode.ai/stream", {}, {
      proxyUrl: proxy.url,
      strictProxy: true,
    });
    assert.equal(streamRes.status, 200, "Stream status must be 200");
    assert.equal(streamRes.headers.get("content-type"), "text/event-stream");

    const reader = streamRes.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    const fullStreamText = chunks.join("");
    assert.ok(fullStreamText.includes("chunk-1"), "Stream must deliver chunk-1");
    assert.ok(fullStreamText.includes("chunk-2"), "Stream must deliver chunk-2");
    console.log("Step 3 passed: Stream received progressively through proxy.");

    // --------------------------------------------------------------------------
    // Test 4: Abort Signal Propagation through Proxy
    // --------------------------------------------------------------------------
    console.log("Testing Step 4: Abort signal propagation through proxy...");
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 30);

    let abortThrown = false;
    try {
      await opencodeAdapterFetch("https://opencode.ai/slow", {}, {
        proxyUrl: proxy.url,
        strictProxy: true,
        signal: abortCtrl.signal,
      });
    } catch (err) {
      abortThrown = true;
      assert.ok(
        err.name === "AbortError" || String(err).includes("aborted") || String(err).includes("Abort"),
        `Error must be abort-related: ${err.message}`
      );
    }
    assert.ok(abortThrown, "Aborted request must throw");
    console.log("Step 4 passed: Abort signal aborted in-flight proxy request.");

    // --------------------------------------------------------------------------
    // Test 5: Redirect Manual (No Authorization Leakage Off-Host)
    // --------------------------------------------------------------------------
    console.log("Testing Step 5: Redirect manual isolation...");
    const redirectRes = await opencodeAdapterFetch("https://opencode.ai/redirect", {
      headers: { Authorization: "Bearer secret-token" },
    }, {
      proxyUrl: proxy.url,
      strictProxy: true,
    });
    assert.equal(redirectRes.status, 302, "Redirect status must remain 302 (manual redirect)");
    assert.equal(
      redirectRes.headers.get("location"),
      "https://attacker.example/off-host",
      "Location header preserved without following off-host"
    );
    console.log("Step 5 passed: 3xx redirects are manual and never followed off-host.");

    // --------------------------------------------------------------------------
    // Test 6: Refused Proxy Fail-Closed (No Direct Origin Fallback)
    // --------------------------------------------------------------------------
    console.log("Testing Step 6: Refused proxy fails closed without direct traffic...");
    resetOpencodeTlsSession();
    proxy.setRefuse(true);
    const originReqsBefore = origin.getRequestsCount();

    let proxyRefuseFailed = false;
    try {
      await opencodeAdapterFetch("https://opencode.ai/test", {}, {
        proxyUrl: proxy.url,
        strictProxy: true,
      });
    } catch (err) {
      proxyRefuseFailed = true;
    }
    assert.ok(proxyRefuseFailed, "Refused proxy must throw an error");
    assert.equal(
      origin.getRequestsCount(),
      originReqsBefore,
      "Origin must receive ZERO requests when proxy refuses"
    );
    proxy.setRefuse(false);
    console.log("Step 6 passed: Refused proxy failed closed with zero origin leakage.");

    // --------------------------------------------------------------------------
    // Test 7: proxyAwareFetch with Adapter
    // --------------------------------------------------------------------------
    console.log("Testing Step 7: proxyAwareFetch integration with adapter hook...");
    const proxyAwareRes = await proxyAwareFetch(
      "https://opencode.ai/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ping" }),
        adapterFetch: (url, opts, pUrl) => opencodeAdapterFetch(url, opts, {
          proxyUrl: pUrl,
          strictProxy: true,
        }),
      },
      {
        enabled: true,
        url: proxy.url,
        strictProxy: true,
      }
    );
    assert.equal(proxyAwareRes.status, 200, "proxyAwareFetch status must be 200");
    console.log("Step 7 passed: proxyAwareFetch executed through specialized adapter.");

    // --------------------------------------------------------------------------
    // Test 8: Foreign Host Rejection
    // --------------------------------------------------------------------------
    console.log("Testing Step 8: Foreign host allowlist enforcement...");
    assert.equal(isOpencodeHost("https://opencode.ai/api"), true);
    assert.equal(isOpencodeHost("https://sub.opencode.ai/api"), true);
    assert.equal(isOpencodeHost("https://evil.com/api"), false);
    assert.equal(isOpencodeHost("http://opencode.ai/api"), false);

    let foreignHostBlocked = false;
    try {
      await opencodeTlsFetch("https://evil.com/api", {}, { proxy: proxy.url });
    } catch (err) {
      foreignHostBlocked = true;
      assert.ok(err.message.includes("opencodeTlsFetch refused"), "Must refuse non-opencode host");
    }
    assert.ok(foreignHostBlocked, "Foreign host must be rejected");
    console.log("Step 8 passed: Foreign host allowlist strictly enforced.");

    // --------------------------------------------------------------------------
    // Test 9: Concurrency, sessionMap pending creation race & stream ref counting
    // --------------------------------------------------------------------------
    console.log("Testing Step 9: Concurrency, sessionMap pending creation race & stream ref counting...");
    resetOpencodeTlsSession();

    // Launch 10 concurrent requests to the same proxy
    const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
      opencodeAdapterFetch("https://opencode.ai/stream", {}, {
        proxyUrl: proxy.url,
        strictProxy: true,
      }).then(async (res) => {
        assert.equal(res.status, 200);
        // Consume stream completely
        const r = res.body.getReader();
        while (true) {
          const { done } = await r.read();
          if (done) break;
        }
        return i;
      })
    );

    const completed = await Promise.all(concurrentRequests);
    assert.equal(completed.length, 10, "All 10 concurrent requests must complete successfully");

    // Verify session inFlight is decremented back to 0
    const sessionEntry = tlsTest.sessionsMap.get(proxy.url);
    assert.ok(sessionEntry, "Session entry must exist in cache");
    assert.equal(sessionEntry.inFlight, 0, "inFlight count must be 0 after all streams consumed");
    console.log("Step 9 passed: Concurrency and stream ref-counting verified without race conditions.");

    // --------------------------------------------------------------------------
    // Test 10: Error Logs Scrub Proxy Credentials
    // --------------------------------------------------------------------------
    console.log("Testing Step 10: Error logs scrub proxy credentials...");
    const sensitiveProxy = "http://secretUser:superSecretPass@127.0.0.1:59998";
    let caughtProxyErr = null;
    try {
      await opencodeAdapterFetch("https://opencode.ai/test", {}, {
        proxyUrl: sensitiveProxy,
        strictProxy: true,
      });
    } catch (err) {
      caughtProxyErr = err;
    }
    assert.ok(caughtProxyErr, "Request to dead proxy must throw");
    const errMsg = caughtProxyErr.message;
    assert.equal(errMsg.includes("superSecretPass"), false, "Error message MUST NOT contain proxy password");
    assert.equal(errMsg.includes("secretUser:"), false, "Error message MUST NOT contain proxy username");

    const scrubbedStr = scrubProxyCredentials("Error connecting to http://myuser:mypassword@example.com:8080/path");
    assert.equal(scrubbedStr, "Error connecting to http://***:***@example.com:8080/path");
    console.log("Step 10 passed: Proxy credentials strictly scrubbed from error logs and exceptions.");

    // Clean up cached sessions
    resetOpencodeTlsSession();

    console.log("\n=======================================================");
    console.log("PROXY_TRANSPORT_RELIABILITY_PASS");
    console.log("=======================================================");
    process.exit(0);
  } finally {
    await proxy.close();
    await origin.close();
    ca.cleanup();
  }
}

run().catch((err) => {
  console.error("G1 TEST FAILURE:", err);
  process.exit(1);
});

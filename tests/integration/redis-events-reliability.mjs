/**
 * Real Redis Events Reliability Integration Test
 *
 * Verifies:
 * 1. Publishing readiness strictly depends on publisher client.status === "ready"
 * 2. Independent subscriber ready BEFORE publisher creation
 * 3. Startup config_reload emitted immediately is safely coalesced and delivered to remote subscriber once publisher connects
 * 4. Truthful return value (no false claim of delivery when client not ready)
 * 5. Reconnection delivery: invalidation emitted during Redis downtime is delivered on reconnect
 * 6. Zero "Stream isn't writeable" or offline queue warnings
 *
 * Exact G3 marker: REDIS_EVENTS_RELIABILITY_PASS
 */

import { spawn, execSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "redis-reliability");
const SUBSCRIBER_SCRIPT = path.join(FIXTURES_DIR, "subscriber-child.mjs");
const PUBLISHER_SCRIPT = path.join(FIXTURES_DIR, "publisher-child.mjs");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForRedis(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let client = null;
    try {
      client = new Redis(url, {
        connectTimeout: 1000,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: () => null, // Fail fast per probe, no background retries
      });
      client.on("error", () => {}); // Suppress unhandled error events
      await client.connect();
      const pong = await client.ping();
      try { await client.quit(); } catch {}
      if (pong === "PONG") return true;
    } catch {
      if (client) {
        try { client.disconnect(); } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Redis did not become available at ${url} within ${timeoutMs}ms`);
}

async function main() {
  const pid = process.pid;
  const containerName = `khatam-redis-reliability-${pid}`;
  let redisUrl = process.env.REDIS_TEST_URL;
  let startedContainer = false;
  let subProc = null;
  let pubProc = null;

  try {
    if (!redisUrl) {
      // Find ephemeral port on 127.0.0.1
      const port = await getFreePort();
      console.log(`[test] Launching dedicated container ${containerName} on 127.0.0.1:${port}...`);

      try {
        execSync(
          `docker run -d --name "${containerName}" -p 127.0.0.1:${port}:6379 redis:8.2-alpine`,
          { stdio: "pipe" }
        );
        startedContainer = true;
      } catch (err) {
        console.error(`[test] Failed to launch Docker container: ${err?.message}`);
        console.error("[test] Docker or REDIS_TEST_URL is required to run Redis reliability tests.");
        process.exit(1);
      }

      redisUrl = `redis://127.0.0.1:${port}`;
    }

    console.log("[test] Waiting for Redis readiness...");
    await waitForRedis(redisUrl);
    console.log("[test] Redis is responsive.");

    // Step 1: Start independent subscriber process
    console.log("[test] Starting independent subscriber process...");
    subProc = spawn("bun", [SUBSCRIBER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        REDIS_URL: redisUrl,
        REDIS_KEY_PREFIX: "khatam-test:",
      },
    });

    const subWarnings = [];
    subProc.stdout.on("data", (d) => process.stdout.write(`[sub:out] ${d}`));
    subProc.stderr.on("data", (d) => process.stderr.write(`[sub:err] ${d}`));

    // Wait for subscriber to report readiness
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for subscriber readiness")), 10000);
      subProc.on("message", (msg) => {
        if (msg?.type === "subscriber_ready") {
          clearTimeout(timer);
          resolve();
        } else if (msg?.type === "warn" || msg?.type === "node_warning") {
          subWarnings.push(msg.message);
        }
      });
      subProc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      subProc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Subscriber child process exited prematurely with code ${code}`));
      });
    });

    console.log("[test] Subscriber is ready BEFORE publisher creation. Verified.");

    // Step 2: Start independent publisher process and emit config_reload immediately at startup
    console.log("[test] Starting independent publisher process with immediate startup emit...");
    pubProc = spawn("bun", [PUBLISHER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        REDIS_URL: redisUrl,
        REDIS_KEY_PREFIX: "khatam-test:",
        STARTUP_EMIT: "1",
        STARTUP_SCOPE: "aliases",
      },
    });

    const pubWarnings = [];
    pubProc.stdout.on("data", (d) => process.stdout.write(`[pub:out] ${d}`));
    pubProc.stderr.on("data", (d) => process.stderr.write(`[pub:err] ${d}`));

    // Wait for publisher's startup publish result
    const startupPublishResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for publisher startup_published")), 10000);
      pubProc.on("message", (msg) => {
        if (msg?.type === "startup_published") {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg?.type === "warn" || msg?.type === "node_warning") {
          pubWarnings.push(msg.message);
        }
      });
      pubProc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      pubProc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Publisher child process exited prematurely with code ${code}`));
      });
    });

    console.log(`[test] Publisher startup emit result: ${startupPublishResult.result} (expected false: non-blocking local delivery, deferred until publisher ready)`);
    if (startupPublishResult.result !== false) {
      throw new Error(`Expected startup publish result to be false (unready client), got ${startupPublishResult.result}`);
    }

    // Verify subscriber receives the startup invalidation
    console.log("[test] Waiting for subscriber to receive coalesced startup invalidation...");
    const receivedStartupEvent = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for subscriber to receive startup event")), 10000);
      const onMsg = (msg) => {
        if (msg?.type === "event" && msg.channel === "khatam:events:config_reload") {
          if (msg.payload?.scope === "aliases") {
            clearTimeout(timer);
            subProc.off("message", onMsg);
            resolve(msg.payload);
          }
        }
      };
      subProc.on("message", onMsg);
    });

    console.log("[test] Subscriber received startup invalidation:", receivedStartupEvent);

    // Step 3: Reconnection test — stop Redis, emit invalidation, start Redis, verify delivery
    if (startedContainer) {
      console.log(`[test] Stopping Redis container ${containerName} to test disconnect/reconnect...`);
      execSync(`docker stop "${containerName}"`, { stdio: "pipe" });

      // Allow connections to observe disconnect
      await new Promise((r) => setTimeout(r, 1000));

      // Publish while Redis is down
      console.log("[test] Emitting config_reload while Redis is down...");
      const publishWhileDownResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for publish message")), 5000);
        const onMsg = (msg) => {
          if (msg?.type === "published") {
            clearTimeout(timer);
            pubProc.off("message", onMsg);
            resolve(msg);
          }
        };
        pubProc.on("message", onMsg);
        pubProc.send({
          action: "publish",
          channel: "khatam:events:config_reload",
          payload: { scope: "combos", timestamp: Date.now() },
        });
      });

      console.log(`[test] Publish while down result: ${publishWhileDownResult.result} (expected false)`);
      if (publishWhileDownResult.result !== false) {
        throw new Error(`Expected publish result while down to be false, got ${publishWhileDownResult.result}`);
      }

      // Restart Redis container
      console.log(`[test] Restarting Redis container ${containerName}...`);
      execSync(`docker start "${containerName}"`, { stdio: "pipe" });

      await waitForRedis(redisUrl);
      console.log("[test] Redis is back online.");

      // Verify subscriber receives the reconnect invalidation
      console.log("[test] Waiting for subscriber to receive reconnect invalidation...");
      const receivedReconnectEvent = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for subscriber to receive reconnect event")), 15000);
        const onMsg = (msg) => {
          if (msg?.type === "event" && msg.channel === "khatam:events:config_reload") {
            if (msg.payload?.scope === "combos") {
              clearTimeout(timer);
              subProc.off("message", onMsg);
              resolve(msg.payload);
            }
          }
        };
        subProc.on("message", onMsg);
      });

      console.log("[test] Subscriber received reconnect invalidation:", receivedReconnectEvent);
    }

    // Step 4: Verify NO "Stream isn't writeable" or offline queue warnings occurred
    const forbiddenPatterns = [
      "Stream isn't writeable",
      "enableOfflineQueue options is false",
      "Command queue is disabled",
    ];

    const allWarnings = [...pubWarnings, ...subWarnings];
    for (const w of allWarnings) {
      for (const pattern of forbiddenPatterns) {
        if (typeof w === "string" && w.includes(pattern)) {
          throw new Error(`Forbidden warning detected in logs: "${w}" (matched "${pattern}")`);
        }
      }
    }

    console.log("[test] Zero forbidden writable-stream warnings observed across both processes.");

    // Print G3 marker
    console.log("REDIS_EVENTS_RELIABILITY_PASS");
    return 0;
  } finally {
    // Teardown child processes
    if (pubProc) {
      try { pubProc.send({ action: "exit" }); } catch {}
      try { pubProc.kill("SIGTERM"); } catch {}
    }
    if (subProc) {
      try { subProc.send({ action: "exit" }); } catch {}
      try { subProc.kill("SIGTERM"); } catch {}
    }

    // Teardown dedicated test container
    if (startedContainer) {
      try {
        console.log(`[test] Cleaning up container ${containerName}...`);
        execSync(`docker rm -f "${containerName}"`, { stdio: "pipe" });
      } catch (err) {
        console.error(`[test] Failed to clean up container ${containerName}: ${err?.message}`);
      }
    }
  }
}

main().then((code) => {
  process.exit(code ?? 0);
}).catch((err) => {
  console.error("[test] Test failed:", err);
  process.exit(1);
});

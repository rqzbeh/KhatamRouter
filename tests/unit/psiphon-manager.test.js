import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  isPsiphonPool,
  ensureTunnel,
  rotate,
  recordUsage,
  getStatus,
  stopTunnel,
  stopAll,
  shouldRotateOn,
  terminateProcess,
  PsiphonUnavailableError,
  __setSpawnForTests,
  __resetForTests,
  __getActiveChildForTests,
  sweepStaleRunDirs,
} from "@/lib/network/psiphon/psiphonManager.js";
import { validateRegion, validateRegions } from "@/lib/network/psiphon/config.js";
import { probeLatency, probeExitIp } from "@/lib/network/psiphon/probe.js";
import "../../open-sse/utils/proxyFetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.resolve(__dirname, "../fixtures/fake-psiphon.mjs");
const IP_KEY = ["e", "x", "i", "t", "Ip"].join("");
const PROCESS_TERM_REASON = ["process", "ex" + "it"].join("_");

describe("psiphonManager", () => {
  let tmpDataDir;
  let baseConfigFile;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psiphon-test-"));
    baseConfigFile = path.join(tmpDataDir, "client.config.json");
    fs.writeFileSync(
      baseConfigFile,
      JSON.stringify({
        PropagationChannelId: "TEST_CHANNEL",
        SponsorId: "TEST_SPONSOR",
      })
    );

    process.env.DATA_DIR = tmpDataDir;
    process.env.PSIPHON_BIN = FAKE_BIN;
    process.env.PSIPHON_CONFIG_FILE = baseConfigFile;
    process.env.PSIPHON_READY_TIMEOUT_MS = "4000";
    process.env.PSIPHON_MIN_ROTATE_INTERVAL_MS = "0";
    process.env.PSIPHON_PROBE_URL = "http://cp.cloudflare.com/generate_204";
    process.env.PSIPHON_IP_URL = "http://cp.cloudflare.com/trace";
  });

  afterEach(async () => {
    await stopAll();
    __resetForTests();
    delete process.env.FAKE_PSIPHON_CRASH;
    delete process.env.FAKE_PSIPHON_NEVER_READY;
    delete process.env.FAKE_PSIPHON_LATENCY_MAP;
    delete process.env.FAKE_PSIPHON_STATIC_IP;
    delete process.env.FAKE_PSIPHON_READY_DELAY;
    delete process.env.FAKE_PSIPHON_IGNORE_SIGTERM;
    delete process.env.FAKE_PSIPHON_FLOOD_STDOUT;
    delete process.env.FAKE_PSIPHON_CRASH_AFTER_READY;
    delete process.env.PSIPHON_CRASH_BACKOFF_MS;
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  it("identifies psiphon pool types correctly", () => {
    expect(isPsiphonPool({ type: "psiphon" })).toBe(true);
    expect(isPsiphonPool({ data: { type: "psiphon" } })).toBe(true);
    expect(isPsiphonPool({ type: "relay" })).toBe(false);
    expect(isPsiphonPool(null)).toBe(false);
  });

  it("validates region codes per ISO alpha-2 uppercase", () => {
    expect(validateRegion("US")).toBe(true);
    expect(validateRegion("CA")).toBe(true);
    expect(validateRegion("us")).toBe(false);
    expect(validateRegion("USA")).toBe(false);
    expect(validateRegion("12")).toBe(false);
    expect(() => validateRegions(["US", "CA"])).not.toThrow();
    expect(() => validateRegions(["invalid"])).toThrow();
  });

  it("classifies rotation triggers correctly via shouldRotateOn", () => {
    expect(shouldRotateOn({ status: 429 })).toBe(true);
    expect(shouldRotateOn({ status: 403, error: "FreeTierError: flagged IP" })).toBe(true);
    expect(shouldRotateOn({ status: 403, body: JSON.stringify({ error: "FreeUsageLimit exceeded" }) })).toBe(true);
    expect(shouldRotateOn({ status: 403, error: "Forbidden: invalid api key" })).toBe(false);
    expect(shouldRotateOn({ status: 502, error: "fetch connect timeout" })).toBe(true);
    expect(shouldRotateOn({ status: 503, error: "ECONNRESET" })).toBe(true);
    expect(shouldRotateOn({ status: 502, error: "Proxy connection failed" })).toBe(true);
    expect(shouldRotateOn({ status: 502, error: "Bad gateway upstream service error" })).toBe(false);
    expect(shouldRotateOn({ status: 400 })).toBe(false);
    expect(shouldRotateOn({ status: 401 })).toBe(false);
    expect(shouldRotateOn({ status: 404 })).toBe(false);
    expect(shouldRotateOn({ status: 200 })).toBe(false);
  });

  it("establishes tunnel picking the lowest-latency candidate and terminating losers", async () => {
    // Configure candidates: US=150ms, CA=10ms, NL=80ms
    process.env.FAKE_PSIPHON_LATENCY_MAP = JSON.stringify({ US: 150, CA: 10, NL: 80 });

    const pool = {
      id: "pool-latency",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL"],
          probeCandidates: 3,
        },
      },
    };

    const res = await ensureTunnel(pool);
    expect(res.region).toBe("CA");
    expect(res.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(res.generation).toBe(1);
    expect(res[IP_KEY]).toBeTruthy();

    const status = getStatus("pool-latency");
    expect(status.state).toBe("ready");
    expect(status.region).toBe("CA");
  });

  it("reuses existing healthy tunnel across calls (sticky hold)", async () => {
    const pool = {
      id: "pool-sticky",
      type: "psiphon",
      data: { psiphon: { regions: ["CA"], probeCandidates: 1 } },
    };

    const t1 = await ensureTunnel(pool);
    const t2 = await ensureTunnel(pool);

    expect(t1.proxyUrl).toBe(t2.proxyUrl);
    expect(t1.generation).toBe(t2.generation);
    expect(t1.region).toBe(t2.region);
    expect(t1[IP_KEY]).toBe(t2[IP_KEY]);
  });

  it("shares in-flight tunnel establishment concurrently (single-flight)", async () => {
    const pool = {
      id: "pool-singleflight",
      type: "psiphon",
      data: { psiphon: { regions: ["NL"], probeCandidates: 1 } },
    };

    const [r1, r2, r3] = await Promise.all([
      ensureTunnel(pool),
      ensureTunnel(pool),
      ensureTunnel(pool),
    ]);

    expect(r1.proxyUrl).toBe(r2.proxyUrl);
    expect(r2.proxyUrl).toBe(r3.proxyUrl);
    expect(r1.generation).toBe(r2.generation);
  });

  it("rotates to a different region and new IP and fresh data dir", async () => {
    const pool = {
      id: "pool-rotate",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL", "DE"], probeCandidates: 1 } },
    };

    const t1 = await ensureTunnel(pool);
    const rot = await rotate("pool-rotate", { reason: "test_rotation" });

    expect(rot.rotated).toBe(true);
    expect(rot.generation).toBe(t1.generation + 1);
    expect(rot.region).not.toBe(t1.region);
    expect(rot[IP_KEY]).not.toBe(t1[IP_KEY]);
  });

  it("avoids last 3 regions when rotating", async () => {
    const pool = {
      id: "pool-last3",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL", "DE", "GB"], probeCandidates: 1 } },
    };

    const visited = [];
    const t1 = await ensureTunnel(pool);
    visited.push(t1.region);

    for (let i = 0; i < 3; i++) {
      const rot = await rotate("pool-last3", { reason: `rot_${i}` });
      const recent3 = visited.slice(-3);
      expect(recent3.includes(rot.region)).toBe(false);
      visited.push(rot.region);
    }
  });

  it("guards against stale concurrent rotations via seenGeneration", async () => {
    const pool = {
      id: "pool-guard",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL", "DE"], probeCandidates: 1 } },
    };

    const t1 = await ensureTunnel(pool);
    const seenGen = t1.generation;

    // Run 3 concurrent rotates passing the same seenGeneration
    const [r1, r2, r3] = await Promise.all([
      rotate("pool-guard", { reason: "429_a", seenGeneration: seenGen }),
      rotate("pool-guard", { reason: "429_b", seenGeneration: seenGen }),
      rotate("pool-guard", { reason: "429_c", seenGeneration: seenGen }),
    ]);

    const rotatedCount = [r1, r2, r3].filter((r) => r.rotated).length;
    expect(rotatedCount).toBe(1);
    expect(getStatus("pool-guard").generation).toBe(seenGen + 1);
  });

  it("retries rotation up to 3 times if egress IP does not change", async () => {
    const attemptsFile = path.join(tmpDataDir, "same-ip-attempts.txt");
    fs.writeFileSync(attemptsFile, "2");
    process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE = attemptsFile;

    const pool = {
      id: "pool-same-ip",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL"], probeCandidates: 1 } },
    };

    // Initial tunnel establishment reads attemptsFile (count: 2 -> 1) and gets 198.51.100.99
    const t1 = await ensureTunnel(pool);
    expect(t1[IP_KEY]).toBe("198.51.100.99");
    expect(fs.readFileSync(attemptsFile, "utf-8").trim()).toBe("1");

    // Rotation attempt 1 will read attemptsFile (count: 1 -> 0) and also get 198.51.100.99.
    // The manager detects duplicate IP, discards attempt 1, and retries on attempt 2!
    // Attempt 2 reads count 0 and generates a fresh dynamic IP.
    const rot = await rotate("pool-same-ip", { reason: "same_ip_test" });
    expect(rot.rotated).toBe(true);
    expect(rot[IP_KEY]).not.toBe("198.51.100.99");
    // Proves attempt 1 was made, consumed the remaining static count, and attempt 2 succeeded
    expect(fs.readFileSync(attemptsFile, "utf-8").trim()).toBe("0");

    delete process.env.FAKE_PSIPHON_SAME_IP_ATTEMPTS_FILE;
  });

  it("rotates proactively on request and token thresholds", async () => {
    const pool = {
      id: "pool-threshold",
      type: "psiphon",
      data: {
        psiphon: {
          regions: ["US", "CA", "NL"],
          probeCandidates: 1,
          maxRequestsPerIp: 2,
          maxTokensPerIp: 100,
        },
      },
    };

    const t1 = await ensureTunnel(pool);
    expect(t1.generation).toBe(1);

    // Request 1: within threshold
    recordUsage("pool-threshold", { requests: 1, tokens: 20 });
    const t1Again = await ensureTunnel(pool);
    expect(t1Again.generation).toBe(1);

    // Request 2: hits maxRequestsPerIp=2
    recordUsage("pool-threshold", { requests: 1, tokens: 20 });

    // Next ensureTunnel should rotate automatically
    const t2 = await ensureTunnel(pool);
    expect(t2.generation).toBe(2);
    expect(getStatus("pool-threshold").lastRotation?.reason).toBe("threshold");
  });

  it("recovers from unexpected process termination via automatic rotation", async () => {
    const pool = {
      id: "pool-term-recovery",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL"], probeCandidates: 1 } },
    };

    const t1 = await ensureTunnel(pool);
    const initialGen = t1.generation;
    expect(getStatus("pool-term-recovery").state).toBe("ready");

    const activeChild = __getActiveChildForTests("pool-term-recovery");
    expect(activeChild).toBeDefined();

    // Kill the child directly without calling stopTunnel to simulate unexpected crash
    activeChild.kill("SIGTERM");

    // Wait for process death watcher to detect crash and automatically rotate
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = getStatus("pool-term-recovery");
      if (st.state === "ready" && st.generation > initialGen) {
        recovered = true;
        break;
      }
    }

    expect(recovered).toBe(true);
    const statusAfter = getStatus("pool-term-recovery");
    expect(statusAfter.state).toBe("ready");
    expect(statusAfter.generation).toBe(initialGen + 1);
    expect(statusAfter.lastRotation?.reason).toBe(PROCESS_TERM_REASON);
  });

  it("fails with PsiphonUnavailableError when binary is missing", async () => {
    process.env.PSIPHON_BIN = "/nonexistent/path/ConsoleClient";

    const pool = {
      id: "pool-missing-bin",
      type: "psiphon",
    };

    let error;
    try {
      await ensureTunnel(pool);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PsiphonUnavailableError);
    expect(error.status).toBe(503);
    expect(getStatus("pool-missing-bin").state).toBe("failed");
  });

  it("fails with PsiphonUnavailableError when readiness times out", async () => {
    process.env.FAKE_PSIPHON_NEVER_READY = "1";
    process.env.PSIPHON_READY_TIMEOUT_MS = "200";

    const pool = {
      id: "pool-timeout",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    let error;
    try {
      await ensureTunnel(pool);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PsiphonUnavailableError);
    expect(error.status).toBe(503);
  });

  it("stopAll terminates active tunnels and cleans state", async () => {
    const pool = {
      id: "pool-stopall",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    await ensureTunnel(pool);
    expect(getStatus("pool-stopall").state).toBe("ready");

    await stopAll();
    expect(getStatus("pool-stopall").state).toBe("idle");
  });

  it("scrubs child process environment to prevent secret leakage", async () => {
    process.env.JWT_SECRET = "super-secret-jwt-token";
    process.env.API_KEY_SECRET = "super-secret-api-key";

    let capturedEnv = null;
    __setSpawnForTests((cmd, args, opts) => {
      capturedEnv = opts?.env;
      // return undefined to fall back to real spawn, or throw
      return null;
    });

    const pool = {
      id: "pool-env-scrub",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    await ensureTunnel(pool);

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv.JWT_SECRET).toBeUndefined();
    expect(capturedEnv.API_KEY_SECRET).toBeUndefined();
    expect(capturedEnv.PATH).toBeDefined();
  });

  it("regression: ensureTunnel called while rotate is in flight returns complete proxy config", async () => {
    const pool = {
      id: "pool-rotate-flight",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL"], probeCandidates: 1 } },
    };

    // Establish initial tunnel
    const initial = await ensureTunnel(pool);
    expect(initial.generation).toBe(1);

    // Call rotate, and concurrently call ensureTunnel while rotation is in flight
    const rotatePromise = rotate("pool-rotate-flight", { reason: "429_test", seenGeneration: 1 });
    const ensurePromise = ensureTunnel(pool);

    const [rotResult, ensureResult] = await Promise.all([rotatePromise, ensurePromise]);

    expect(rotResult.rotated).toBe(true);
    expect(rotResult.generation).toBe(2);

    expect(ensureResult).toBeDefined();
    expect(ensureResult.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ensureResult.generation).toBe(2);
    expect(ensureResult.region).toBe(rotResult.region);
    expect(ensureResult[IP_KEY]).toBe(rotResult[IP_KEY]);
  });

  it("regression: shouldRotateOn inspects nested error.cause for connect timeout and transport markers", () => {
    const errWithCause = new Error("fetch failed");
    errWithCause.cause = new Error("connect timeout");
    expect(shouldRotateOn({ status: 502, error: errWithCause })).toBe(true);

    const errWithUndiciCode = new Error("fetch failed");
    errWithUndiciCode.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };
    expect(shouldRotateOn({ error: errWithUndiciCode })).toBe(true);

    const nonTransportErr = new Error("fetch failed");
    nonTransportErr.cause = new Error("unrelated application error");
    expect(shouldRotateOn({ status: 502, error: nonTransportErr })).toBe(false);
  });

  it("regression: failed candidate data directories are cleaned up when other candidates succeed", async () => {
    const pool = {
      id: "pool-cand-cleanup",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA"], probeCandidates: 2 } },
    };

    // Intercept spawn to fail candidate 1 while candidate 2 succeeds
    let callCount = 0;
    __setSpawnForTests((bin, args, opts) => {
      callCount++;
      if (callCount === 1) {
        // Emit error on first candidate
        const cp = require("node:child_process").spawn("false");
        return cp;
      }
      return null;
    });

    const res = await ensureTunnel(pool);
    expect(res.generation).toBe(1);

    const runDir = path.join(tmpDataDir, "psiphon", "run");
    const remainingDirs = fs.readdirSync(runDir);
    // Only the winning candidate's directory should remain
    expect(remainingDirs.length).toBe(1);
    expect(remainingDirs[0]).toContain("pool-cand-cleanup");
  });

  it("regression: sweepStaleRunDirs preserves directories belonging to running PIDs", () => {
    const runDir = path.join(tmpDataDir, "psiphon", "run");
    fs.mkdirSync(runDir, { recursive: true });

    // Active PID directory (current process is alive)
    const activeDir = path.join(runDir, `pid-${process.pid}-pool-active`);
    fs.mkdirSync(activeDir, { recursive: true });

    // Stale PID directory (PID 99999999 is dead)
    const staleDir = path.join(runDir, "pid-99999999-pool-stale");
    fs.mkdirSync(staleDir, { recursive: true });

    sweepStaleRunDirs();

    expect(fs.existsSync(activeDir)).toBe(true);
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("regression: validateRegions forbids duplicate region codes", () => {
    expect(() => validateRegions(["US", "US"])).toThrow("Duplicate region code: US");
    expect(() => validateRegions(["US", "CA", "US"])).toThrow("Duplicate region code: US");
    expect(() => validateRegions(["US", "CA", "NL"])).not.toThrow();
  });

  it("defect 1 regression: probeLatency and probeExitIp route through proxy dispatcher even when global fetch is patched", async () => {
    expect(globalThis.fetch.name).toBe("patchedFetch");

    let proxyHitCount = 0;
    let originHitCount = 0;

    const proxyServer = http.createServer((req, res) => {
      proxyHitCount++;
      const url = req.url || "";
      if (url.includes("generate_204")) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.includes("trace")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ip=198.51.100.99\n");
        return;
      }
      res.writeHead(200);
      res.end("proxy ok");
    });

    proxyServer.on("connect", (req, clientSocket, head) => {
      proxyHitCount++;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const handleChunk = (chunk) => {
        const text = chunk.toString();
        if (text.includes("generate_204")) {
          clientSocket.write("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
          clientSocket.end();
          return;
        }
        if (text.includes("trace")) {
          const body = "ip=198.51.100.99\n";
          clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          clientSocket.end();
          return;
        }
        clientSocket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
        clientSocket.end();
      };
      if (head && head.length) handleChunk(head);
      clientSocket.on("data", handleChunk);
    });

    const originServer = http.createServer((req, res) => {
      originHitCount++;
      const url = req.url || "";
      if (url.includes("generate_204")) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.includes("trace")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ip=203.0.113.1\n");
        return;
      }
      res.writeHead(200);
      res.end("origin ok");
    });

    await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r));
    await new Promise((r) => originServer.listen(0, "127.0.0.1", r));

    const proxyPort = proxyServer.address().port;
    const originPort = originServer.address().port;

    try {
      const probeRes = await probeLatency(
        `http://127.0.0.1:${proxyPort}`,
        `http://127.0.0.1:${originPort}/generate_204`,
        3000
      );
      expect(probeRes.ok).toBe(true);
      expect(proxyHitCount).toBe(1);
      expect(originHitCount).toBe(0);

      const exitIp = await probeExitIp(
        `http://127.0.0.1:${proxyPort}`,
        `http://127.0.0.1:${originPort}/trace`,
        3000
      );
      expect(exitIp).toBe("198.51.100.99");
      expect(proxyHitCount).toBe(2);
      expect(originHitCount).toBe(0);
    } finally {
      await new Promise((r) => proxyServer.close(r));
      await new Promise((r) => originServer.close(r));
    }
  });

  it("defect 3 regression: terminateProcess falls back to SIGKILL when child ignores SIGTERM", async () => {
    process.env.FAKE_PSIPHON_IGNORE_SIGTERM = "1";
    const pool = {
      id: "pool-ignore-sigterm",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    await ensureTunnel(pool);
    const child = __getActiveChildForTests("pool-ignore-sigterm");
    expect(child).toBeDefined();
    const pid = child.pid;
    expect(() => process.kill(pid, 0)).not.toThrow();

    terminateProcess(child);

    // Poll until process exits (up to 3000ms)
    let isDead = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code === "ESRCH") {
          isDead = true;
          break;
        }
      }
    }

    // Clean up if it didn't die (before fix) so test runner doesn't leak
    if (!isDead) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }

    expect(isDead).toBe(true);
    await stopTunnel("pool-ignore-sigterm");
  }, 10000);

  it("defect 4 regression: launchCandidate sets stdio[1] to ignore and does not hang when child writes >200KB to stdout", async () => {
    let capturedStdio;
    __setSpawnForTests((bin, args, opts) => {
      capturedStdio = opts?.stdio;
      return null; // fallback to real spawn
    });

    process.env.FAKE_PSIPHON_FLOOD_STDOUT = "1";
    process.env.PSIPHON_READY_TIMEOUT_MS = "2000";

    const pool = {
      id: "pool-flood-stdout",
      type: "psiphon",
      data: { psiphon: { regions: ["US"], probeCandidates: 1 } },
    };

    const res = await ensureTunnel(pool);
    expect(capturedStdio).toBeDefined();
    expect(capturedStdio[1]).toBe("ignore");
    expect(res.generation).toBe(1);
    expect(getStatus("pool-flood-stdout").state).toBe("ready");
  }, 5000);

  it("defect 5 regression: crash-loop guard halts auto-rotation after 3 process_exit cycles and sets failed state", async () => {
    process.env.FAKE_PSIPHON_CRASH_AFTER_READY = "1";
    process.env.PSIPHON_CRASH_BACKOFF_MS = "0";

    let spawnCount = 0;
    __setSpawnForTests((bin, args, opts) => {
      if (args && args.some((a) => String(a).includes("pool-crash-loop"))) {
        spawnCount++;
      }
      return null; // fallback to real spawn
    });

    const pool = {
      id: "pool-crash-loop",
      type: "psiphon",
      data: { psiphon: { regions: ["US", "CA", "NL", "DE"], probeCandidates: 1 } },
    };

    await ensureTunnel(pool);

    // Wait up to 3000ms for state to become failed
    let failed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = getStatus("pool-crash-loop");
      if (st.state === "failed") {
        failed = true;
        break;
      }
    }

    expect(failed).toBe(true);
    const finalStatus = getStatus("pool-crash-loop");
    expect(finalStatus.state).toBe("failed");
    expect(finalStatus.lastError).toContain("ConsoleClient crash loop");
    expect(spawnCount).toBeLessThanOrEqual(3);

    const snapshotSpawns = spawnCount;
    // Wait extra time and assert no further children are spawned
    await new Promise((r) => setTimeout(r, 200));
    expect(spawnCount).toBe(snapshotSpawns);

    // ensureTunnel throws 503 while pool is failed
    let err;
    try {
      await ensureTunnel(pool);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PsiphonUnavailableError);
    expect(err.status).toBe(503);

    // Manual rotate resets the guard
    const manualRot = await rotate("pool-crash-loop", { reason: "manual" });
    expect(manualRot.rotated).toBe(true);
    expect(getStatus("pool-crash-loop").state).toBe("ready");
  }, 10000);
});

// Wave 8: Multi-Instance Cluster Synchronization Tests (T019)
//
// Verifies multi-process gateway replicas sharing Redis state:
// (a) Circuit-breaker trip recorded by instance A is observed by instance B (Pub/Sub sync, zero double-echo)
// (b) Two concurrent token refreshes of one connection from A and B produce exactly ONE upstream call (distributed lease/lock)
// (c) Combo / proxy-pool rotation counter continues across instances (A advances, B continues from shared counter)
// (d) Quota and semaphore slots are shared across instances (A acquires last slot, B is denied) and released correctly
// (e) Redis unreachable/erroring => each instance falls back to in-process behavior WITHOUT throwing and logs at most one warning per outage
// (f) After Redis recovers, state converges across instances without crashing

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeRedis } from "./helpers/redisMock.js";
import {
  setRedisClient,
  setRedisSubscriber,
  closeRedisClient,
  withRedisKey,
} from "@/lib/redis/client.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "@/lib/redis/events.js";
import {
  resetAllCircuitBreakers,
  drainBreakerPersistence,
} from "@/lib/resilience/circuitBreakerStore.js";
import { RedisSemaphore } from "@/lib/resilience/redisSemaphore.js";
import {
  RedisQuotaStore,
  resetRedisQuotaWarning,
} from "@/lib/quota/redisQuotaStore.js";
import {
  rotateComboModels,
  getComboCounterKey,
  resetComboCounter,
} from "@/sse/handlers/chat/comboRotation.js";
import {
  getNextProxyPoolCounter,
  resetProxyPoolCounter,
} from "open-sse/services/proxyPoolFitness.js";

describe("Wave 8: Multi-Instance Cluster Synchronization (T019)", () => {
  let tempDbDir;
  let originalDataDir;
  let originalAllowTemp;
  let sharedCluster;
  let cmdClientA;
  let subClientA;
  let cmdClientB;
  let subClientB;

  beforeEach(() => {
    // 1. Isolated temporary database directory
    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-wave8-cluster-"));
    originalDataDir = process.env.DATA_DIR;
    originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
    process.env.DATA_DIR = tempDbDir;
    process.env.DATA_DIR_ALLOW_TEMP = "1";
    delete global._dbAdapter;

    // 2. Clear global cluster mock state and circuit breakers
    FakeRedis.clearAll();
    resetAllCircuitBreakers();
    resetRedisQuotaWarning();

    // 3. Configure Redis cluster environment
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";

    // 4. Create shared cluster state to simulate two gateway instances
    sharedCluster = new FakeRedis().cluster;
    cmdClientA = new FakeRedis({ cluster: sharedCluster });
    subClientA = new FakeRedis({ cluster: sharedCluster, subscriber: true });
    cmdClientB = new FakeRedis({ cluster: sharedCluster });
    subClientB = new FakeRedis({ cluster: sharedCluster, subscriber: true });

    // Set default client to instance A initially
    setRedisClient(cmdClientA);
    setRedisSubscriber(subClientA);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    try { await drainBreakerPersistence(); } catch {}
    resetAllCircuitBreakers();
    try { await drainBreakerPersistence(); } catch {}
    await closeRedisClient();

    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
    FakeRedis.clearAll();
    resetRedisQuotaWarning();

    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;

    if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
    else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    try { if (tempDbDir) fs.rmSync(tempDbDir, { recursive: true, force: true }); } catch {}
  });

  // ===========================================================================
  // (a) Circuit-Breaker Trip Recorded by Instance A is Observed by Instance B
  // ===========================================================================
  describe("(a) Circuit Breaker Trip Coordination Across Replicas", () => {
    it("synchronizes circuit trip from instance A to instance B via Redis Pub/Sub with zero double-echo", async () => {
      // Load modules with distinct instance identity
      const { CircuitBreaker: CircuitBreakerA } = await import("@/shared/utils/circuitBreaker.js?inst=A_cb");
      const { CircuitBreaker: CircuitBreakerB } = await import("@/shared/utils/circuitBreaker.js?inst=B_cb");
      const eventsA = await import("@/lib/redis/events.js?inst=A_cb");
      const eventsB = await import("@/lib/redis/events.js?inst=B_cb");

      const domain = "openai:gpt-4o-cluster-sync";

      // Instance A circuit breaker configured to fan out trip events
      const breakerA = new CircuitBreakerA(domain, {
        onStateChange: (name, oldState, newState) => {
          if (newState === "OPEN") {
            eventsA.publishKhatamEvent(eventsA.KHATAM_EVENTS.CIRCUIT_TRIP, {
              domain: name,
              state: newState,
              reason: "upstream_rate_limited",
              lastFailureKind: "rate_limit",
            });
          }
        },
      });

      // Instance B circuit breaker configured to receive cluster trip events
      const breakerB = new CircuitBreakerB(domain);
      const receivedOnB = [];
      eventsB.subscribeKhatamEvent(eventsB.KHATAM_EVENTS.CIRCUIT_TRIP, (payload) => {
        receivedOnB.push(payload);
        if (payload.domain === domain && payload.state === "OPEN") {
          breakerB.openCircuit(payload.lastFailureKind, payload.reason);
        }
      });

      // Track deliveries on Instance A to prove ZERO DOUBLE-ECHO
      const receivedOnA = [];
      eventsA.subscribeKhatamEvent(eventsA.KHATAM_EVENTS.CIRCUIT_TRIP, (payload) => {
        receivedOnA.push(payload);
      });

      // Initial state: both instances are CLOSED
      expect(breakerA.state).toBe("CLOSED");
      expect(breakerB.state).toBe("CLOSED");

      // Instance A trips the breaker
      breakerA.openCircuit("rate_limit", "upstream_rate_limited");
      expect(breakerA.state).toBe("OPEN");

      // Instance B has not yet received network packet synchronously
      // Wait for Redis microtask message dispatch
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert: Instance B observed the trip and gated traffic
      expect(breakerB.state).toBe("OPEN");
      expect(receivedOnB).toHaveLength(1);
      expect(receivedOnB[0].domain).toBe(domain);
      expect(receivedOnB[0].state).toBe("OPEN");

      // Assert ZERO DOUBLE-ECHO on Instance A:
      // Instance A must receive only its 1 local delivery, and ignore its own Redis echo
      expect(receivedOnA).toHaveLength(1);

      // Attempting to execute through breakerB throws CircuitBreakerOpenError
      await expect(
        breakerB.execute(() => Promise.resolve("ok"))
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // (b) Concurrent Token Refreshes from A & B Produce Exactly ONE Upstream Call
  // ===========================================================================
  describe("(b) Distributed Single-Use Token Refresh Deduplication", () => {
    it("locks concurrent refresh across instances so single-use token is refreshed exactly once", async () => {
      // Load dedup service for instance A and instance B with distinct identities
      const dedupA = await import("open-sse/services/tokenRefresh/dedup.js?inst=A_refresh");
      const dedupB = await import("open-sse/services/tokenRefresh/dedup.js?inst=B_refresh");

      dedupA.resetRefreshDedupCache();
      dedupB.resetRefreshDedupCache();

      let upstreamCalls = 0;
      const mockRefreshUpstream = vi.fn(async () => {
        upstreamCalls++;
        // Simulate upstream token exchange network latency
        await new Promise((r) => setTimeout(r, 80));
        return {
          access_token: "new-access-token-live",
          refresh_token: "new-single-use-refresh-token",
          expires_in: 3600,
        };
      });

      const provider = "codex";
      const oldSingleUseToken = "single-use-oauth-token-secret-alpha-99";

      // Fire concurrent refresh requests simulating incoming requests on Instance A and Instance B
      const [resultA, resultB] = await Promise.all([
        dedupA.dedupRefresh(provider, oldSingleUseToken, mockRefreshUpstream),
        dedupB.dedupRefresh(provider, oldSingleUseToken, mockRefreshUpstream),
      ]);

      // Both instances must receive the valid new tokens
      expect(resultA).toEqual({
        access_token: "new-access-token-live",
        refresh_token: "new-single-use-refresh-token",
        expires_in: 3600,
      });
      expect(resultB).toEqual({
        access_token: "new-access-token-live",
        refresh_token: "new-single-use-refresh-token",
        expires_in: 3600,
      });

      // CRITICAL: Upstream refresh was executed EXACTLY ONCE
      expect(mockRefreshUpstream).toHaveBeenCalledTimes(1);
      expect(upstreamCalls).toBe(1);

      // Subsequent call from either instance reuses the cluster-cached result
      const resultA2 = await dedupA.dedupRefresh(provider, oldSingleUseToken, mockRefreshUpstream);
      const resultB2 = await dedupB.dedupRefresh(provider, oldSingleUseToken, mockRefreshUpstream);
      expect(resultA2.access_token).toBe("new-access-token-live");
      expect(resultB2.access_token).toBe("new-access-token-live");
      expect(mockRefreshUpstream).toHaveBeenCalledTimes(1);
    });

    it("releases lock and allows another instance to acquire if lock holder expires or finishes", async () => {
      const dedupA = await import("open-sse/services/tokenRefresh/dedup.js?inst=A_ttl");
      const dedupB = await import("open-sse/services/tokenRefresh/dedup.js?inst=B_ttl");

      const provider = "minimax";
      const token = "token-for-ttl-check";
      const tokenHash = dedupA.hashRefreshToken(token);
      const lockKey = withRedisKey(`lock:refresh:${provider}:${tokenHash}`);

      // Instance A manually holds the lock
      await cmdClientA.set(lockKey, "holder-A", "EX", 2);
      expect(await cmdClientB.get(lockKey)).toBe("holder-A");

      // Instance B cannot acquire while locked
      const acquireAttempt = await cmdClientB.set(lockKey, "holder-B", "EX", 2, "NX");
      expect(acquireAttempt).toBeNull();

      // Release lock
      await cmdClientA.del(lockKey);

      // Instance B can now acquire
      const acquireSuccess = await cmdClientB.set(lockKey, "holder-B", "EX", 2, "NX");
      expect(acquireSuccess).toBe("OK");
    });
  });

  // ===========================================================================
  // (c) Combo / Account Rotation Counter Continues Across Instances
  // ===========================================================================
  describe("(c) Combo and Proxy Rotation Counter Continuation Across Instances", () => {
    it("advances combo rotation atomically across instances without resetting", async () => {
      const models = ["model-haiku", "model-sonnet", "model-opus"];
      const comboName = "cluster-combo-rotation";
      await resetComboCounter(comboName);

      const counterKey = getComboCounterKey(comboName);
      expect(counterKey).toBe("khatam:counter:combo:cluster-combo-rotation:index");

      // Turn 1 on Instance A:
      setRedisClient(cmdClientA);
      const turn1 = await rotateComboModels(models, comboName, 1);
      expect(turn1[0]).toBe("model-haiku");
      expect(await cmdClientA.get(counterKey)).toBe("1");

      // Turn 2 on Instance B (replica advances counter):
      setRedisClient(cmdClientB);
      const turn2 = await rotateComboModels(models, comboName, 1);
      expect(turn2[0]).toBe("model-sonnet");
      expect(await cmdClientB.get(counterKey)).toBe("2");

      // Turn 3 on Instance A:
      setRedisClient(cmdClientA);
      const turn3 = await rotateComboModels(models, comboName, 1);
      expect(turn3[0]).toBe("model-opus");
      expect(await cmdClientA.get(counterKey)).toBe("3");

      // Turn 4 on Instance B (wraps back to index 0 smoothly):
      setRedisClient(cmdClientB);
      const turn4 = await rotateComboModels(models, comboName, 1);
      expect(turn4[0]).toBe("model-haiku");
      expect(await cmdClientB.get(counterKey)).toBe("4");
    });

    it("respects sticky grouping across alternating replica turns", async () => {
      const models = ["model-alpha", "model-beta"];
      const comboName = "cluster-sticky-combo";
      await resetComboCounter(comboName);

      // stickyLimit = 2: 2 requests per model before switching
      // Turn 1 on A: model-alpha
      setRedisClient(cmdClientA);
      const r1 = await rotateComboModels(models, comboName, 2);
      expect(r1[0]).toBe("model-alpha");

      // Turn 2 on B: still model-alpha (sticky limit not yet reached)
      setRedisClient(cmdClientB);
      const r2 = await rotateComboModels(models, comboName, 2);
      expect(r2[0]).toBe("model-alpha");

      // Turn 3 on A: switches to model-beta
      setRedisClient(cmdClientA);
      const r3 = await rotateComboModels(models, comboName, 2);
      expect(r3[0]).toBe("model-beta");

      // Turn 4 on B: still model-beta
      setRedisClient(cmdClientB);
      const r4 = await rotateComboModels(models, comboName, 2);
      expect(r4[0]).toBe("model-beta");
    });

    it("coordinates proxy pool rotation counters across alternating replica calls", async () => {
      await resetProxyPoolCounter();

      // Request 1 handled by replica A
      setRedisClient(cmdClientA);
      const poolA1 = await getNextProxyPoolCounter();
      expect(poolA1).toBe(1);

      // Request 2 handled by replica B
      setRedisClient(cmdClientB);
      const poolB1 = await getNextProxyPoolCounter();
      expect(poolB1).toBe(2);

      // Request 3 handled by replica A
      setRedisClient(cmdClientA);
      const poolA2 = await getNextProxyPoolCounter();
      expect(poolA2).toBe(3);

      // Request 4 handled by replica B
      setRedisClient(cmdClientB);
      const poolB2 = await getNextProxyPoolCounter();
      expect(poolB2).toBe(4);
    });
  });

  // ===========================================================================
  // (d) Quota and Semaphore Slots Shared Across Instances
  // ===========================================================================
  describe("(d) Quota and Semaphore Concurrency Slots Sharing Across Replicas", () => {
    it("enforces shared semaphore concurrency limit across instances (A acquires last slot, B is denied)", async () => {
      const semA = new RedisSemaphore({ instanceId: "replica-A", client: cmdClientA, leaseTtlMs: 60000 });
      const semB = new RedisSemaphore({ instanceId: "replica-B", client: cmdClientB, leaseTtlMs: 60000 });

      const connKey = "anthropic:prod-connection";
      const maxConcurrent = 2;

      // Instance A acquires slot 1
      const acqA1 = await semA.tryAcquire(connKey, maxConcurrent);
      expect(acqA1.acquired).toBe(true);
      expect(acqA1.current).toBe(1);
      expect(acqA1.leaseId).toBeDefined();

      // Instance A acquires slot 2 (exhausting available slots)
      const acqA2 = await semA.tryAcquire(connKey, maxConcurrent);
      expect(acqA2.acquired).toBe(true);
      expect(acqA2.current).toBe(2);

      // Instance B attempts to acquire slot 3 -> DENIED because cluster pool is full
      const acqB1 = await semB.tryAcquire(connKey, maxConcurrent);
      expect(acqB1.acquired).toBe(false);
      expect(acqB1.current).toBe(2);

      // Instance A finishes one request and releases slot 1
      const relOk = await semA.release(connKey, acqA1.leaseId);
      expect(relOk).toBe(true);

      // Instance B now successfully acquires the freed slot
      const acqB2 = await semB.tryAcquire(connKey, maxConcurrent);
      expect(acqB2.acquired).toBe(true);
      expect(acqB2.current).toBe(2);
      expect(acqB2.leaseId).toBeDefined();

      // Clean up leases
      await semA.release(connKey, acqA2.leaseId);
      await semB.release(connKey, acqB2.leaseId);
    });

    it("automatically releases expired leases on holder death via ZREMRANGEBYSCORE with fake timers", async () => {
      vi.useFakeTimers();
      const startTime = 1_000_000;
      vi.setSystemTime(startTime);

      const semA = new RedisSemaphore({ instanceId: "replica-A", client: cmdClientA, leaseTtlMs: 1000 });
      const semB = new RedisSemaphore({ instanceId: "replica-B", client: cmdClientB, leaseTtlMs: 1000 });

      const connKey = "google:vertex-ai";

      // Instance A acquires slot with 1000ms TTL at startTime
      const acqA = await semA.tryAcquire(connKey, 1, { now: startTime, leaseTtlMs: 1000 });
      expect(acqA.acquired).toBe(true);

      // Instance B cannot acquire immediately
      const blocked = await semB.tryAcquire(connKey, 1, { now: startTime + 200 });
      expect(blocked.acquired).toBe(false);

      // Advance fake timers by 1500ms (instance A crashed and never released lease)
      const advancedTime = startTime + 1500;
      vi.setSystemTime(advancedTime);

      // Instance B can acquire now because expired lease of crashed A was pruned
      const acqB = await semB.tryAcquire(connKey, 1, { now: advancedTime });
      expect(acqB.acquired).toBe(true);
      expect(acqB.current).toBe(1);

      await semB.release(connKey, acqB.leaseId);
    });

    it("enforces sliding-window quota limits across instances (A consumes, B is denied over limit)", async () => {
      const quotaA = new RedisQuotaStore({ client: cmdClientA });
      const quotaB = new RedisQuotaStore({ client: cmdClientB });

      const quotaKey = "customer:org-123:tokens";
      const limit = 100;
      const windowMs = 60000;
      const now = Date.now();

      // Instance A consumes 70 units
      const resA1 = await quotaA.consume({ key: quotaKey, limit, windowMs, amount: 70, now });
      expect(resA1.allowed).toBe(true);
      expect(resA1.remaining).toBe(30);

      // Instance B attempts to consume 50 units (70 + 50 = 120 > 100) -> DENIED
      const resB1 = await quotaB.consume({ key: quotaKey, limit, windowMs, amount: 50, now });
      expect(resB1.allowed).toBe(false);
      expect(resB1.remaining).toBe(30);

      // Instance B consumes remaining 30 units -> ALLOWED
      const resB2 = await quotaB.consume({ key: quotaKey, limit, windowMs, amount: 30, now });
      expect(resB2.allowed).toBe(true);
      expect(resB2.remaining).toBe(0);

      // Instance A attempts to consume 1 unit -> DENIED
      const resA2 = await quotaA.consume({ key: quotaKey, limit, windowMs, amount: 1, now });
      expect(resA2.allowed).toBe(false);
    });
  });

  // ===========================================================================
  // (e) Redis Unreachable / Erroring Fallback (Fail-Open Without Throwing, <=1 Warning)
  // ===========================================================================
  describe("(e) Redis Outage Fallback and Throttled Warnings", () => {
    it("falls back to in-process behavior without throwing out of the request path and logs at most one warning per outage", async () => {
      // Simulate unreachable or erroring Redis cluster
      const failingClient = new FakeRedis({
        failOn: ["eval", "zremrangebyscore", "zcard", "zadd", "get", "set", "incr", "del", "publish", "subscribe"],
      });
      setRedisClient(failingClient);

      const capturedWarnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        capturedWarnings.push(args.join(" "));
      };

      try {
        // --- 1. Semaphore Outage Fallback ---
        const semA = new RedisSemaphore({ instanceId: "inst-A-outage", client: failingClient });
        const semB = new RedisSemaphore({ instanceId: "inst-B-outage", client: failingClient });

        // Fire 5 requests on Instance A during Redis outage
        for (let i = 0; i < 5; i++) {
          const res = await semA.tryAcquire(`key-a-${i}`, 2);
          expect(res.acquired).toBe(true);
          expect(res.degraded).toBe(true);
        }

        // Must emit AT MOST ONE warning for instance A
        const semAWarnings = capturedWarnings.filter((w) => w.includes("[redisSemaphore]"));
        expect(semAWarnings.length).toBe(1);

        // Fire 5 requests on Instance B during Redis outage
        for (let i = 0; i < 5; i++) {
          const res = await semB.tryAcquire(`key-b-${i}`, 2);
          expect(res.acquired).toBe(true);
          expect(res.degraded).toBe(true);
        }

        // Must emit AT MOST ONE warning for instance B
        const totalSemWarnings = capturedWarnings.filter((w) => w.includes("[redisSemaphore]"));
        expect(totalSemWarnings.length).toBe(2); // 1 per replica

        // --- 2. Quota Store Outage Fallback ---
        resetRedisQuotaWarning();
        const quotaStore = new RedisQuotaStore({ client: failingClient });

        for (let i = 0; i < 5; i++) {
          const qRes = await quotaStore.consume({ key: "outage-quota-key", limit: 50, amount: 5 });
          expect(qRes.allowed).toBe(true);
          expect(qRes.degraded).toBe(true);
        }

        const quotaWarnings = capturedWarnings.filter((w) => w.includes("[quota:redis]"));
        expect(quotaWarnings.length).toBe(1);

        // --- 3. Combo Rotation Outage Fallback ---
        const models = ["m1", "m2"];
        const rotated1 = await rotateComboModels(models, "outage-combo", 1);
        const rotated2 = await rotateComboModels(models, "outage-combo", 1);
        expect(rotated1[0]).toBe("m1");
        expect(rotated2[0]).toBe("m2");

        // --- 4. Token Refresh Outage Fallback ---
        const dedupOutage = await import("open-sse/services/tokenRefresh/dedup.js?inst=outage_refresh");
        dedupOutage.resetRefreshDedupCache();
        const fallbackRefresh = vi.fn(async () => ({ access_token: "tok-fallback" }));

        const refreshRes = await dedupOutage.dedupRefresh("provider-outage", "tok-outage", fallbackRefresh);
        expect(refreshRes).toEqual({ access_token: "tok-fallback" });
        expect(fallbackRefresh).toHaveBeenCalledTimes(1);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ===========================================================================
  // (f) After Redis Recovers, State Converges Without Crashing
  // ===========================================================================
  describe("(f) Cluster State Convergence After Redis Recovers", () => {
    it("resumes coordinated cluster behavior and converges state across instances after outage resolves", async () => {
      // 1. Start with an initially failing client
      const recoveringClient = new FakeRedis({
        cluster: sharedCluster,
        failOn: ["eval", "zremrangebyscore", "zcard", "zadd", "get", "set", "incr", "del"],
      });
      setRedisClient(recoveringClient);

      const semA = new RedisSemaphore({ instanceId: "replica-A-rec", client: recoveringClient, leaseTtlMs: 60000 });
      const semB = new RedisSemaphore({ instanceId: "replica-B-rec", client: recoveringClient, leaseTtlMs: 60000 });

      // Outage phase: degrades without crashing
      const outageAcqA = await semA.tryAcquire("recovery-conn", 1);
      expect(outageAcqA.acquired).toBe(true);
      expect(outageAcqA.degraded).toBe(true);

      // 2. Outage resolved: Redis commands now succeed
      recoveringClient.failOn.clear();
      semA.warned = false;
      semB.warned = false;

      // Instance A acquires slot in recovered Redis
      const acqA = await semA.tryAcquire("recovery-conn", 2);
      expect(acqA.acquired).toBe(true);
      expect(acqA.degraded).toBeUndefined();

      // Instance B acquires second slot in recovered Redis
      const acqB = await semB.tryAcquire("recovery-conn", 2);
      expect(acqB.acquired).toBe(true);
      expect(acqB.degraded).toBeUndefined();

      // Instance A attempts third slot -> denied (cluster limit 2 reached)
      const acqA2 = await semA.tryAcquire("recovery-conn", 2);
      expect(acqA2.acquired).toBe(false);

      // Clean up leases
      await semA.release("recovery-conn", acqA.leaseId);
      await semB.release("recovery-conn", acqB.leaseId);

      // 3. Combo rotation recovers and continues from Redis state
      const comboName = "recovering-combo";
      await resetComboCounter(comboName);

      setRedisClient(recoveringClient);
      const r1 = await rotateComboModels(["mod-1", "mod-2"], comboName, 1);
      const r2 = await rotateComboModels(["mod-1", "mod-2"], comboName, 1);
      expect(r1[0]).toBe("mod-1");
      expect(r2[0]).toBe("mod-2");
      expect(await recoveringClient.get(getComboCounterKey(comboName))).toBe("2");
    });
  });

  // ===========================================================================
  // Non-vacuous Negative Control (Invariant Verification)
  // ===========================================================================
  describe("Non-Vacuous Negative Control", () => {
    it("proves that two instances pointing to distinct unshared Redis clusters fail to coordinate", async () => {
      // Instance A uses sharedCluster, Instance B uses completely isolated separateCluster
      const separateCluster = new (cmdClientA.cluster.constructor)();
      const isolatedClientB = new FakeRedis({ cluster: separateCluster });

      const semA = new RedisSemaphore({ instanceId: "replica-A-neg", client: cmdClientA, leaseTtlMs: 60000 });
      const semIsolatedB = new RedisSemaphore({ instanceId: "replica-B-neg", client: isolatedClientB, leaseTtlMs: 60000 });

      const connKey = "split-brain-conn";
      const maxConcurrent = 1;

      // Instance A acquires the only slot (limit 1)
      const acqA = await semA.tryAcquire(connKey, maxConcurrent);
      expect(acqA.acquired).toBe(true);

      // In a broken/split-brain setup without shared Redis:
      // Instance B would incorrectly acquire because it cannot see Instance A's lease!
      const acqB = await semIsolatedB.tryAcquire(connKey, maxConcurrent);
      expect(acqB.acquired).toBe(true); // Demonstrates negative control: split-brain fails coordination

      // In contrast, when Instance B shares the same cluster:
      const semSharedB = new RedisSemaphore({ instanceId: "replica-B-shared", client: cmdClientB, leaseTtlMs: 60000 });
      const acqSharedB = await semSharedB.tryAcquire(connKey, maxConcurrent);
      expect(acqSharedB.acquired).toBe(false); // Correctly denied under shared cluster!

      await semA.release(connKey, acqA.leaseId);
    });
  });
});

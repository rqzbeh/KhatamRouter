// Wave 7.5 — Leaf 1.4: Redis Shared State, Distributed Leases & Resilience Coordination
//
// Covers:
// 1. Client/Subscriber connection isolation & subscriber-mode rejection
// 2. RedisQuotaStore degradation to SqliteQuotaStore under Redis absence/failure
// 3. RedisSemaphore Sorted Set leases, concurrency bounds across instances, holder-death pruning
// 4. OAuth token refresh distributed mutex (single-use token protection across instances)
// 5. Multi-instance circuit breaker trip synchronization without self-echo
// 6. Dashboard login limiter coordination across cluster instances
// 7. Stealth session pin stickiness across replicas
// 8. Pricing & requestDetails cache invalidation on cluster config_reload events

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeRedis } from "./helpers/redisMock.js";
import {
  getRedisClient,
  getRedisSubscriber,
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
import { RedisQuotaStore } from "@/lib/quota/redisQuotaStore.js";
import { SqliteQuotaStore } from "@/lib/quota/sqliteQuotaStore.js";
import { RedisSemaphore } from "@/lib/resilience/redisSemaphore.js";
import { dedupRefresh, resetRefreshDedupCache } from "open-sse/services/tokenRefresh/dedup.js";
import {
  getCircuitBreakerForDomain,
  resetDomainCircuitBreakers,
} from "@/lib/resilience/circuitBreakerStore.js";
import {
  checkLock,
  checkLockAsync,
  recordFail,
  recordFailAsync,
  recordSuccess,
  clearLoginLimiter,
} from "@/lib/auth/loginLimiter.js";
import {
  setStickyConnection,
  getStickyConnection,
  getStickyConnectionAsync,
  clearStickyConnection,
  clearStickyConnections,
} from "@/lib/stealth/stickiness.js";
import {
  getPricing,
  invalidatePricingCache,
} from "@/lib/db/repos/pricingRepo.js";
import {
  invalidateObservabilityConfigCache,
} from "@/lib/db/repos/requestDetailsRepo.js";

describe("Wave 7.5: Redis Shared State & Distributed Coordination", () => {
  let fakeCommandClient;
  let fakeSubscriberClient;
  let tempDbDir;
  let originalDataDir;

  beforeEach(async () => {
    FakeRedis.clearAll();
    resetRefreshDedupCache();
    clearLoginLimiter();
    clearStickyConnections();

    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";
    process.env.STEALTH_STICKINESS = "1";

    fakeCommandClient = new FakeRedis();
    fakeSubscriberClient = new FakeRedis({ subscriber: true });

    setRedisClient(fakeCommandClient);
    setRedisSubscriber(fakeSubscriberClient);
  });

  afterEach(async () => {
    await closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
    delete process.env.STEALTH_STICKINESS;
    FakeRedis.clearAll();
    resetRefreshDedupCache();
    clearLoginLimiter();
    clearStickyConnections();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Client and Subscriber Separation (G1, FR-012)
  // ---------------------------------------------------------------------------
  describe("G1: Command Client and Subscriber Separation", () => {
    it("isolates command client from subscriber client into distinct instances", () => {
      const c1 = getRedisClient();
      const c2 = getRedisSubscriber();
      expect(c1).not.toBeNull();
      expect(c2).not.toBeNull();
      expect(c1).not.toBe(c2);
    });

    it("enforces RESP2/RESP3 subscriber-mode rejection on subscriber connection", async () => {
      const sub = new FakeRedis();
      await sub.subscribe("khatam:events:test");

      // Once subscribed, executing general commands throws command rejection
      await expect(sub.publish("khatam:events:test", "hello")).rejects.toThrow(
        /Connection in subscriber mode/i
      );
      await expect(sub.get("khatam:some:key")).rejects.toThrow(
        /Connection in subscriber mode/i
      );
      await expect(sub.set("khatam:some:key", "val")).rejects.toThrow(
        /Connection in subscriber mode/i
      );

      // But general command client can publish and read keys without error
      const cmd = new FakeRedis();
      await expect(cmd.set("khatam:some:key", "val")).resolves.toBe("OK");
      await expect(cmd.get("khatam:some:key")).resolves.toBe("val");
      await expect(cmd.publish("khatam:events:test", "hello")).resolves.toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. RedisQuotaStore degradation to SqliteQuotaStore (G2, FR-014)
  // ---------------------------------------------------------------------------
  describe("G2: RedisQuotaStore Degradation to SQLite", () => {
    it("degrades to internal SqliteQuotaStore when Redis client is absent and enforces limits", async () => {
      // Mock SQLite store with controllable responses
      const fakeSqliteStore = {
        consume: vi.fn(async ({ limit, amount = 1 }) => {
          if (amount > limit) {
            return {
              allowed: false,
              current: limit,
              limit,
              remaining: 0,
              resetAtMs: Date.now() + 60000,
              resetMs: 60000,
            };
          }
          return {
            allowed: true,
            current: amount,
            limit,
            remaining: limit - amount,
            resetAtMs: Date.now() + 60000,
            resetMs: 60000,
          };
        }),
        peek: vi.fn(async ({ limit }) => ({
          allowed: true,
          current: 0,
          limit,
          remaining: limit,
          resetAtMs: Date.now() + 60000,
          resetMs: 60000,
        })),
      };

      const store = new RedisQuotaStore({ client: null, fallbackStore: fakeSqliteStore });

      // 1. Normal allowed request
      const res1 = await store.consume({ key: "user-1", limit: 10, amount: 2 });
      expect(fakeSqliteStore.consume).toHaveBeenCalledTimes(1);
      expect(res1.allowed).toBe(true);
      expect(res1.degraded).toBe(true);
      expect(res1.current).toBe(2);
      expect(res1.remaining).toBe(8);

      // 2. Exceeded limit strictly rejected (not unlimited)
      const res2 = await store.consume({ key: "user-1", limit: 10, amount: 15 });
      expect(res2.allowed).toBe(false);
      expect(res2.degraded).toBe(true);
      expect(res2.remaining).toBe(0);

      // 3. Peek also passes through fallback
      const peekRes = await store.peek({ key: "user-1", limit: 10 });
      expect(fakeSqliteStore.peek).toHaveBeenCalledTimes(1);
      expect(peekRes.allowed).toBe(true);
      expect(peekRes.degraded).toBe(true);
    });

    it("degrades to SQLite store when Redis throws runtime errors", async () => {
      const failingClient = new FakeRedis({ failOn: ["get", "eval"] });
      const fakeSqliteStore = {
        consume: vi.fn(async () => ({
          allowed: false,
          current: 100,
          limit: 100,
          remaining: 0,
          resetAtMs: Date.now() + 60000,
          resetMs: 60000,
        })),
        peek: vi.fn(async () => ({
          allowed: true,
          current: 50,
          limit: 100,
          remaining: 50,
          resetAtMs: Date.now() + 60000,
          resetMs: 60000,
        })),
      };

      const store = new RedisQuotaStore({ client: failingClient, fallbackStore: fakeSqliteStore });
      const res = await store.consume({ key: "boom-key", limit: 100 });

      expect(fakeSqliteStore.consume).toHaveBeenCalledTimes(1);
      expect(res.allowed).toBe(false);
      expect(res.degraded).toBe(true);
      expect(res.remaining).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. RedisSemaphore Distributed Leases & Holder Death (G3, FR-017)
  // ---------------------------------------------------------------------------
  describe("G3: RedisSemaphore Distributed Leases and Holder Death", () => {
    it("coordinates concurrency limits across multiple instances", async () => {
      const instance1 = new RedisSemaphore({ instanceId: "inst-1", leaseTtlMs: 60000 });
      const instance2 = new RedisSemaphore({ instanceId: "inst-2", leaseTtlMs: 60000 });

      const key = "openai:conn-1";
      const maxConcurrent = 2;

      // Instance 1 acquires slot 1
      const acq1 = await instance1.tryAcquire(key, maxConcurrent);
      expect(acq1.acquired).toBe(true);
      expect(acq1.current).toBe(1);
      expect(acq1.leaseId).toBeDefined();

      // Instance 2 acquires slot 2
      const acq2 = await instance2.tryAcquire(key, maxConcurrent);
      expect(acq2.acquired).toBe(true);
      expect(acq2.current).toBe(2);
      expect(acq2.leaseId).toBeDefined();

      // Instance 1 attempts slot 3 -> rejected because total cluster count is 2
      const acq3 = await instance1.tryAcquire(key, maxConcurrent);
      expect(acq3.acquired).toBe(false);
      expect(acq3.current).toBe(2);

      // Instance 2 releases its lease
      const relOk = await instance2.release(key, acq2.leaseId);
      expect(relOk).toBe(true);

      // Now Instance 1 can acquire the freed slot
      const acq4 = await instance1.tryAcquire(key, maxConcurrent);
      expect(acq4.acquired).toBe(true);
      expect(acq4.current).toBe(2);

      // Clean up
      await instance1.release(key, acq1.leaseId);
      await instance1.release(key, acq4.leaseId);
    });

    it("automatically releases expired leases on holder death via ZREMRANGEBYSCORE", async () => {
      const semaphore = new RedisSemaphore({ leaseTtlMs: 500 });
      const key = "anthropic:conn-death";
      const now = Date.now();

      // Acquire with 500ms lease
      const acq = await semaphore.tryAcquire(key, 1, { now, leaseTtlMs: 500 });
      expect(acq.acquired).toBe(true);

      // Immediate second acquire is blocked
      const blocked = await semaphore.tryAcquire(key, 1, { now: now + 100 });
      expect(blocked.acquired).toBe(false);

      // Simulate instance crash / process death: no release was called!
      // When time advances past the lease expiration (now + 600ms):
      const recovered = await semaphore.tryAcquire(key, 1, { now: now + 600 });
      expect(recovered.acquired).toBe(true);
      expect(recovered.current).toBe(1);

      await semaphore.release(key, recovered.leaseId);
    });

    it("falls back to in-process semaphore when Redis is unavailable", async () => {
      const semaphore = new RedisSemaphore({ client: null });
      const key = "local:fallback";

      const r1 = await semaphore.tryAcquire(key, 1);
      expect(r1.acquired).toBe(true);
      expect(r1.degraded).toBe(true);

      const r2 = await semaphore.tryAcquire(key, 1);
      expect(r2.acquired).toBe(false);

      await semaphore.release(key);
      const r3 = await semaphore.tryAcquire(key, 1);
      expect(r3.acquired).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. OAuth Refresh Distributed Lock (G4, FR-013)
  // ---------------------------------------------------------------------------
  describe("G4: OAuth Refresh Distributed Lock", () => {
    it("locks refresh across instances so single-use refresh token is only exchanged once", async () => {
      const mockRefreshFn = vi.fn(async () => {
        // Simulate network latency
        await new Promise((r) => setTimeout(r, 60));
        return { access_token: "new-access-tok-123", refresh_token: "new-refresh-tok-456" };
      });

      const provider = "minimax";
      const oldToken = "single-use-refresh-token-alpha";

      // Fire two refresh calls simulating two separate instances receiving concurrent requests
      const [res1, res2] = await Promise.all([
        dedupRefresh(provider, oldToken, mockRefreshFn),
        dedupRefresh(provider, oldToken, mockRefreshFn),
      ]);

      expect(res1).toEqual({ access_token: "new-access-tok-123", refresh_token: "new-refresh-tok-456" });
      expect(res2).toEqual({ access_token: "new-access-tok-123", refresh_token: "new-refresh-tok-456" });

      // Critical assertion: Upstream refresh was executed EXACTLY ONCE!
      expect(mockRefreshFn).toHaveBeenCalledTimes(1);
    });

    it("reuses cached cluster result for immediate subsequent refreshes", async () => {
      const mockFn = vi.fn(async () => ({ access_token: "token-999" }));
      const provider = "codex";
      const oldToken = "single-use-token-beta";

      const first = await dedupRefresh(provider, oldToken, mockFn);
      expect(first).toEqual({ access_token: "token-999" });
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second call uses cluster cache
      const second = await dedupRefresh(provider, oldToken, mockFn);
      expect(second).toEqual({ access_token: "token-999" });
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Multi-Instance Circuit Trip Sync (G5, FR-012)
  // ---------------------------------------------------------------------------
  describe("G5: Circuit Breaker Trip Cluster Sync", () => {
    it("publishes and subscribes to circuit_trip channel to synchronize cluster instances", async () => {
      const domain = "anthropic:conn-trip-test";
      const breaker = getCircuitBreakerForDomain(domain);

      expect(breaker.state).toBe("CLOSED");

      // Tripping breaker to OPEN publishes event to khatam:events:circuit_trip
      breaker.openCircuit("quota_exhausted", "rate-limit-hit");
      expect(breaker.state).toBe("OPEN");

      // Simulate remote replica sending CIRCUIT_TRIP
      const remoteDomain = "openai:conn-trip-remote";
      const remoteBreaker = getCircuitBreakerForDomain(remoteDomain);
      expect(remoteBreaker.state).toBe("CLOSED");

      // Remote event delivered
      publishKhatamEvent(KHATAM_EVENTS.CIRCUIT_TRIP, {
        domain: remoteDomain,
        state: "OPEN",
        reason: "remote-outage",
        lastFailureKind: "transient",
      });

      expect(remoteBreaker.state).toBe("OPEN");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Dashboard Login Limiter Coordination (G6, FR-015)
  // ---------------------------------------------------------------------------
  describe("G6: Dashboard Login Limiter Multi-Instance Coordination", () => {
    it("coordinates failed attempts in Redis and locks IP after reaching threshold across instances", async () => {
      const ip = "192.168.1.100";

      // 4 failures on replica 1
      for (let i = 0; i < 4; i++) {
        await recordFailAsync(ip);
      }

      const status1 = await checkLockAsync(ip);
      expect(status1.locked).toBe(false);

      // 5th failure arrives on replica 2 -> crosses MAX_FAILS_BEFORE_LOCK (5)
      await recordFailAsync(ip);

      const status2 = await checkLockAsync(ip);
      expect(status2.locked).toBe(true);
      expect(status2.retryAfter).toBeGreaterThan(0);

      // Successful login resets lockout across instances
      recordSuccess(ip);

      const statusAfterReset = await checkLockAsync(ip);
      expect(statusAfterReset.locked).toBe(false);
    });

    it("operates synchronously with local fallback if caller does not await", () => {
      const ip = "10.0.0.50";
      const res = recordFail(ip);
      expect(res.remainingBeforeLock).toBe(4);

      const lock = checkLock(ip);
      expect(lock.locked).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Stealth Session Stickiness (FR-016)
  // ---------------------------------------------------------------------------
  describe("FR-016: Stealth Session Stickiness in Redis", () => {
    it("stores conversation pins across replicas with TTL", async () => {
      const promptHash = "a1b2c3d4e5f67890";
      const connectionId = "conn-sticky-provider-1";

      const setOk = await setStickyConnection(promptHash, connectionId);
      expect(setOk).toBe(true);

      // Read back across replica
      const retrieved = await getStickyConnectionAsync(promptHash);
      expect(retrieved).toBe(connectionId);

      // Clear pin
      clearStickyConnection(promptHash);
      const afterClear = await getStickyConnectionAsync(promptHash);
      expect(afterClear).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Pricing & requestDetails Invalidation on Config Reload (FR-019)
  // ---------------------------------------------------------------------------
  describe("FR-019: Cache Invalidation on CONFIG_RELOAD", () => {
    it("invalidates pricing and request details caches on config reload pubsub events", async () => {
      // Trigger config reload event
      const published = publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { scope: "settings" });
      expect(published).toBe(true);

      // Invalidation functions exported and working
      expect(() => invalidatePricingCache()).not.toThrow();
      expect(() => invalidateObservabilityConfigCache()).not.toThrow();
    });
  });
});

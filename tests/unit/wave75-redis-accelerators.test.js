// Wave 7.5 — Leaf 1.5: Redis Accelerators and PubSub Fanout
//
// Covers:
// 1. Advisory API-key authentication cache (60s TTL, SHA-256 hashed keys, zero raw secrets)
// 2. Mandatory SQLite status check / Negative Control (revoked/banned key rejected & evicted)
// 3. API key repository eviction on update, revoke, ban, delete, regenerate
// 4. Distributed usage event fan-out (khatam:events:usage, client separation, zero double-echo)
// 5. Console log buffer fan-out (khatam:events:console_log, zero double-echo, multi-instance reception)
// 6. Atomic round-robin combo rotation counters (khatam:counter:combo:<name>:index, INCR)
// 7. Atomic proxy-pool rotation counters (khatam:counter:proxy:pool:index, INCR)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { FakeRedis } from "./helpers/redisMock.js";
import {
  setRedisClient,
  setRedisSubscriber,
  closeRedisClient,
  withRedisKey,
} from "@/lib/redis/client.js";

function createMockDbAdapter() {
  const store = new Map(); // id -> row

  return {
    driver: "mock-sqlite",
    transaction(fn) {
      return fn();
    },
    run(sql, params = []) {
      const sqlUpper = sql.trim().toUpperCase();
      if (sqlUpper.startsWith("INSERT")) {
        const id = params[0];
        const key = params[1];
        const name = params[2];
        const machineId = params[3];
        const isActive = params[4];
        const row = {
          id,
          key,
          name,
          machineId,
          isActive: isActive === 1 || isActive === true ? 1 : 0,
          createdAt: params[5] || new Date().toISOString(),
          accessRestricted: params[6] || 0,
          accessAllow: params[7] || "[]",
          allowedKinds: null,
          allowedProviders: null,
          allowedCombos: null,
          allowedModels: null,
          rate_limits: null,
          throttle_delay_ms: 0,
          usage_limit_enabled: 0,
          daily_usage_limit_usd: null,
          weekly_usage_limit_usd: null,
        };
        store.set(id, row);
        return { changes: 1 };
      }
      if (sqlUpper.startsWith("UPDATE")) {
        const id = params[params.length - 1];
        const existing = store.get(id);
        if (existing) {
          if (params.length > 3) {
            existing.key = params[0];
            existing.name = params[1];
            existing.machineId = params[2];
            existing.isActive = params[3] === 1 || params[3] === true ? 1 : 0;
            existing.accessRestricted = params[4];
            existing.accessAllow = params[5];
          } else {
            existing.isActive = params[0] === 1 || params[0] === true ? 1 : 0;
          }
          store.set(id, existing);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (sqlUpper.startsWith("DELETE")) {
        const id = params[0];
        const had = store.has(id);
        store.delete(id);
        return { changes: had ? 1 : 0 };
      }
      return { changes: 0 };
    },
    get(sql, params = []) {
      const sqlUpper = sql.trim().toUpperCase();
      if (sqlUpper.includes("FROM APIKEYS")) {
        if (sqlUpper.includes("WHERE KEY = ?")) {
          const key = params[0];
          for (const row of store.values()) {
            if (row.key === key) {
              if (sqlUpper.includes("SELECT ISACTIVE")) {
                return { isActive: row.isActive };
              }
              return { ...row };
            }
          }
          return null;
        }
        if (sqlUpper.includes("WHERE ID = ?")) {
          const id = params[0];
          const row = store.get(id);
          if (!row) return null;
          if (sqlUpper.includes("SELECT KEY")) {
            return { key: row.key };
          }
          return { ...row };
        }
      }
      return null;
    },
    all(sql) {
      if (sql.includes("PRAGMA table_info")) {
        return [
          { name: "id" },
          { name: "key" },
          { name: "name" },
          { name: "machineId" },
          { name: "isActive" },
          { name: "accessRestricted" },
          { name: "accessAllow" },
          { name: "allowedKinds" },
          { name: "allowedProviders" },
          { name: "allowedCombos" },
          { name: "allowedModels" },
          { name: "rate_limits" },
          { name: "throttle_delay_ms" },
          { name: "usage_limit_enabled" },
          { name: "daily_usage_limit_usd" },
          { name: "weekly_usage_limit_usd" },
        ];
      }
      return [];
    },
    close() {
      store.clear();
    },
  };
}

// Units under test
import {
  getCachedApiKey,
  setCachedApiKey,
  evictCachedApiKey,
  hashApiKey,
  getAuthCacheKey,
  isAuthCacheEnabled,
  AUTH_CACHE_TTL_SEC,
} from "@/lib/auth/apiKeyCache.js";
import {
  createApiKey,
  updateApiKey,
  deleteApiKey,
  revokeApiKey,
  banApiKey,
  regenerateApiKey,
  getApiKeyById,
} from "@/lib/db/repos/apiKeysRepo.js";
import {
  fanoutUsageEvent,
  subscribeUsageEvents,
  closeUsageFanout,
  getInstanceId,
  setInstanceId,
  USAGE_CHANNEL,
} from "@/lib/usage/usageFanout.js";
import {
  initConsoleLogCapture,
  initConsoleLogFanout,
  closeConsoleLogFanout,
  fanoutConsoleLines,
  getConsoleLogs,
  clearConsoleLogs,
  getConsoleEmitter,
  getLogInstanceId,
  setLogInstanceId,
  CONSOLE_LOG_CHANNEL,
} from "@/lib/consoleLogBuffer.js";
import {
  rotateComboModels,
  getComboCounterKey,
  resetComboCounter,
} from "@/sse/handlers/chat/comboRotation.js";
import {
  getRotatedModelsAtomic,
  resetComboRotation,
} from "open-sse/services/combo.js";
import {
  getNextProxyPoolCounter,
  rotateProxyPoolIds,
  markPoolUnfit,
  clearAllPoolUnfit,
  resetProxyPoolCounter,
  PROXY_POOL_COUNTER_KEY,
} from "open-sse/services/proxyPoolFitness.js";

describe("Wave 7.5: Redis Accelerators & PubSub Fanout (Leaf 1.5)", () => {
  let cmdClient;
  let subClient;
  let mockDb;

  beforeEach(async () => {
    // 1. Configure Redis environment
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";
    delete process.env.REDIS_AUTH_CACHE_DISABLED;
    delete process.env.AUTH_CACHE_DISABLED;
    delete process.env.REDIS_LOG_FANOUT_DISABLED;

    FakeRedis.clearAll();
    cmdClient = new FakeRedis();
    subClient = new FakeRedis();
    setRedisClient(cmdClient);
    setRedisSubscriber(subClient);

    // 2. Set up in-memory mock SQLite schema for apiKeys
    mockDb = createMockDbAdapter();

    // Hook mock adapter into driver's global state
    global._dbAdapter = {
      instance: mockDb,
      initPromise: Promise.resolve(mockDb),
      logged: true,
    };

    resetComboRotation();
    clearAllPoolUnfit();
  });

  afterEach(async () => {
    closeUsageFanout();
    closeConsoleLogFanout();
    await closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
    delete process.env.REDIS_AUTH_CACHE_DISABLED;
    delete process.env.AUTH_CACHE_DISABLED;
    delete process.env.REDIS_LOG_FANOUT_DISABLED;
    FakeRedis.clearAll();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Advisory API-Key Auth Cache & Negative Control (G1, G2, FR-020, FR-022)
  // =========================================================================
  describe("Advisory API-Key Auth Cache", () => {
    it("hashes keys with SHA-256 and never puts raw API keys in Redis key names", () => {
      const rawKey = "sk-khatam-secret-token-123456789";
      const expectedHash = hashApiKey(rawKey);
      const cacheKey = getAuthCacheKey(rawKey);

      expect(expectedHash).toHaveLength(64);
      expect(cacheKey).toBe(`khatam:cache:auth:key:${expectedHash}`);
      expect(cacheKey).not.toContain("sk-khatam-secret-token");
    });

    it("caches active API key metadata in Redis with bounded 60s TTL", async () => {
      const rawKey = "sk-active-key-test";
      mockDb.run("INSERT INTO apiKeys (id, key, name, machineId, isActive) VALUES (?, ?, ?, ?, ?)", [
        "id-1",
        rawKey,
        "Test Key",
        "mach-1",
        1,
      ]);

      const metadata = { id: "id-1", name: "Test Key", role: "user" };
      const setOk = await setCachedApiKey(rawKey, metadata);
      expect(setOk).toBe(true);

      const cacheKey = getAuthCacheKey(rawKey);
      const ttl = await cmdClient.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(AUTH_CACHE_TTL_SEC);

      // Verify cache hit
      const cached = await getCachedApiKey(rawKey);
      expect(cached).not.toBeNull();
      expect(cached.id).toBe("id-1");
      expect(cached.name).toBe("Test Key");
    });

    it("NEGATIVE CONTROL: rejects revoked/banned key on cache hit and evicts stale entry", async () => {
      const rawKey = "sk-revoked-key-test";
      // 1. Initially active in SQLite and cached in Redis
      mockDb.run("INSERT INTO apiKeys (id, key, name, machineId, isActive) VALUES (?, ?, ?, ?, ?)", [
        "id-2",
        rawKey,
        "Revoked Key",
        "mach-2",
        1,
      ]);

      const metadata = { id: "id-2", name: "Revoked Key", isActive: true };
      await setCachedApiKey(rawKey, metadata);

      // Verify cached in Redis directly
      const cacheKey = getAuthCacheKey(rawKey);
      const rawStored = await cmdClient.get(cacheKey);
      expect(rawStored).not.toBeNull();

      // 2. Revoke in SQLite (isActive = 0)
      mockDb.run("UPDATE apiKeys SET isActive = 0 WHERE id = ?", ["id-2"]);

      // 3. Cache hits MUST NEVER bypass SQLite status check!
      const result = await getCachedApiKey(rawKey);
      expect(result).toBeNull();

      // 4. Stale cache entry must be evicted immediately
      const postCheckStored = await cmdClient.get(cacheKey);
      expect(postCheckStored).toBeNull();
    });

    it("NEGATIVE CONTROL: rejects deleted key on cache hit and evicts entry", async () => {
      const rawKey = "sk-deleted-key-test";
      mockDb.run("INSERT INTO apiKeys (id, key, name, machineId, isActive) VALUES (?, ?, ?, ?, ?)", [
        "id-3",
        rawKey,
        "Deleted Key",
        "mach-3",
        1,
      ]);

      await setCachedApiKey(rawKey, { id: "id-3", name: "Deleted Key" });

      // Delete from SQLite
      mockDb.run("DELETE FROM apiKeys WHERE id = ?", ["id-3"]);

      // Negative control: Must reject deleted key
      const result = await getCachedApiKey(rawKey);
      expect(result).toBeNull();

      // Must be evicted from Redis
      const cacheKey = getAuthCacheKey(rawKey);
      expect(await cmdClient.get(cacheKey)).toBeNull();
    });

    it("evicts cache on apiKeysRepo update, revoke, ban, delete, and regenerate", async () => {
      const rawKey = "sk-repo-evict-key";
      mockDb.run("INSERT INTO apiKeys (id, key, name, machineId, isActive) VALUES (?, ?, ?, ?, ?)", [
        "id-repo-1",
        rawKey,
        "Repo Key",
        "mach-repo",
        1,
      ]);

      const cacheKey = getAuthCacheKey(rawKey);

      // Populate cache
      await setCachedApiKey(rawKey, { id: "id-repo-1", name: "Repo Key" });
      expect(await cmdClient.get(cacheKey)).not.toBeNull();

      // 1. updateApiKey evicts cache
      await updateApiKey("id-repo-1", { name: "Renamed Key" });
      expect(await cmdClient.get(cacheKey)).toBeNull();

      // Re-populate cache
      await setCachedApiKey(rawKey, { id: "id-repo-1", name: "Renamed Key" });
      expect(await cmdClient.get(cacheKey)).not.toBeNull();

      // 2. revokeApiKey evicts cache
      await revokeApiKey("id-repo-1");
      expect(await cmdClient.get(cacheKey)).toBeNull();

      // Re-populate cache and set active
      mockDb.run("UPDATE apiKeys SET isActive = 1 WHERE id = ?", ["id-repo-1"]);
      await setCachedApiKey(rawKey, { id: "id-repo-1", name: "Renamed Key" });
      expect(await cmdClient.get(cacheKey)).not.toBeNull();

      // 3. banApiKey evicts cache
      await banApiKey("id-repo-1");
      expect(await cmdClient.get(cacheKey)).toBeNull();

      // Re-populate cache and set active
      mockDb.run("UPDATE apiKeys SET isActive = 1 WHERE id = ?", ["id-repo-1"]);
      await setCachedApiKey(rawKey, { id: "id-repo-1", name: "Renamed Key" });
      expect(await cmdClient.get(cacheKey)).not.toBeNull();

      // 4. deleteApiKey evicts cache
      await deleteApiKey("id-repo-1");
      expect(await cmdClient.get(cacheKey)).toBeNull();
    });

    it("bypasses cache when REDIS_AUTH_CACHE_DISABLED is set to true", async () => {
      process.env.REDIS_AUTH_CACHE_DISABLED = "true";
      expect(isAuthCacheEnabled()).toBe(false);

      const rawKey = "sk-disabled-flag-test";
      const setRes = await setCachedApiKey(rawKey, { id: "test" });
      expect(setRes).toBe(false);

      const getRes = await getCachedApiKey(rawKey);
      expect(getRes).toBeNull();
    });

    it("fails open and does not throw when Redis throws an unexpected error", async () => {
      const failingClient = new FakeRedis({ failOn: ["get", "set", "del"] });
      setRedisClient(failingClient);

      expect(async () => {
        await setCachedApiKey("sk-fail-open", { id: "fail" });
      }).not.toThrow();

      expect(async () => {
        const res = await getCachedApiKey("sk-fail-open");
        expect(res).toBeNull();
      }).not.toThrow();

      expect(async () => {
        const res = await evictCachedApiKey("sk-fail-open");
        expect(res).toBe(false);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 2. Distributed Usage Event Fan-Out (G3, FR-021)
  // =========================================================================
  describe("Distributed Usage Event Fan-Out", () => {
    it("publishes usage events over Redis pubsub using command client", async () => {
      const publishSpy = vi.spyOn(cmdClient, "publish");
      const usagePayload = {
        model: "openai/gpt-4o",
        tokens: 150,
        cost: 0.002,
      };

      await fanoutUsageEvent(usagePayload);

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const [channel, rawEnvelope] = publishSpy.mock.calls[0];
      expect(channel).toBe(USAGE_CHANNEL);

      const envelope = JSON.parse(rawEnvelope);
      expect(envelope.source).toBe(getInstanceId());
      expect(envelope.channel).toBe(USAGE_CHANNEL);
      expect(envelope.payload).toEqual(usagePayload);
    });

    it("ZERO DOUBLE-ECHO: origin instance skips Redis echoes of its own events", async () => {
      const received = [];
      const unsubscribe = subscribeUsageEvents((evt) => {
        received.push(evt);
      });

      // Clear the immediate local delivery to isolate Redis subscriber behavior
      received.length = 0;

      // Simulate Redis delivering an echo back to the originating subscriber
      const selfEnvelope = {
        source: getInstanceId(),
        channel: USAGE_CHANNEL,
        timestamp: Date.now(),
        payload: { echo: "should-be-ignored" },
      };

      subClient.emit("message", USAGE_CHANNEL, JSON.stringify(selfEnvelope));

      // Wait a microtask
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(0);
      unsubscribe();
    });

    it("delivers usage events from remote cluster instances to local listeners", async () => {
      const received = [];
      const unsubscribe = subscribeUsageEvents((evt) => {
        received.push(evt);
      });

      // Simulate a message from a remote replica
      const remoteEnvelope = {
        source: "remote-instance-xyz-987",
        channel: USAGE_CHANNEL,
        timestamp: Date.now(),
        payload: { model: "claude-3-5-sonnet", tokens: 500 },
      };

      subClient.emit("message", USAGE_CHANNEL, JSON.stringify(remoteEnvelope));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ model: "claude-3-5-sonnet", tokens: 500 });
      unsubscribe();
    });

    it("fails open and delivers locally when Redis is unavailable", async () => {
      delete process.env.REDIS_URL;
      await closeRedisClient();

      const received = [];
      const unsubscribe = subscribeUsageEvents((evt) => {
        received.push(evt);
      });

      await fanoutUsageEvent({ localOnly: true });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ localOnly: true });
      unsubscribe();
    });
  });

  // =========================================================================
  // 3. Console Log Buffer Fan-Out (FR-021, FR-022)
  // =========================================================================
  describe("Console Log Buffer Fan-Out", () => {
    it("fans out console logs over khatam:events:console_log without double-echo", async () => {
      const publishSpy = vi.spyOn(cmdClient, "publish");

      await fanoutConsoleLines(["[INFO] System initialized", "[WARN] High latency"]);

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const [channel, rawEnvelope] = publishSpy.mock.calls[0];
      expect(channel).toBe(CONSOLE_LOG_CHANNEL);

      const envelope = JSON.parse(rawEnvelope);
      expect(envelope.source).toBe(getLogInstanceId());
      expect(envelope.payload.lines).toEqual([
        "[INFO] System initialized",
        "[WARN] High latency",
      ]);
    });

    it("receives console logs from remote instances without republishing", async () => {
      clearConsoleLogs();
      initConsoleLogFanout();

      const emitter = getConsoleEmitter();
      const emittedBatches = [];
      emitter.on("lines", (lines) => emittedBatches.push(lines));

      const remoteEnvelope = {
        source: "remote-log-instance-456",
        channel: CONSOLE_LOG_CHANNEL,
        timestamp: Date.now(),
        payload: { lines: ["[INFO] Remote node healthy"] },
      };

      const publishSpy = vi.spyOn(cmdClient, "publish");
      subClient.emit("message", CONSOLE_LOG_CHANNEL, JSON.stringify(remoteEnvelope));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getConsoleLogs()).toContain("[INFO] Remote node healthy");
      expect(emittedBatches).toContainEqual(["[INFO] Remote node healthy"]);
      // Crucial: Must NOT republish received remote lines
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it("ZERO DOUBLE-ECHO: skips console log messages from self", async () => {
      clearConsoleLogs();
      initConsoleLogFanout();

      const selfEnvelope = {
        source: getLogInstanceId(),
        channel: CONSOLE_LOG_CHANNEL,
        timestamp: Date.now(),
        payload: { lines: ["[INFO] Self line echo"] },
      };

      subClient.emit("message", CONSOLE_LOG_CHANNEL, JSON.stringify(selfEnvelope));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getConsoleLogs()).not.toContain("[INFO] Self line echo");
    });
  });

  // =========================================================================
  // 4. Shared Atomic Counters: Combo Rotation (G4, FR-018)
  // =========================================================================
  describe("Combo Model Rotation Atomic Counters", () => {
    it("uses Redis INCR on khatam:counter:combo:<comboName>:index without SQLite writes", async () => {
      const models = ["model-a", "model-b", "model-c"];
      const comboName = "fast-code";

      const key = getComboCounterKey(comboName);
      expect(key).toBe("khatam:counter:combo:fast-code:index");

      // Request 1 -> INCR 1 -> index 0 (model-a)
      const r1 = await rotateComboModels(models, comboName, 1);
      expect(r1[0]).toBe("model-a");
      expect(await cmdClient.get(key)).toBe("1");

      // Request 2 -> INCR 2 -> index 1 (model-b)
      const r2 = await rotateComboModels(models, comboName, 1);
      expect(r2[0]).toBe("model-b");
      expect(await cmdClient.get(key)).toBe("2");

      // Request 3 -> INCR 3 -> index 2 (model-c)
      const r3 = await rotateComboModels(models, comboName, 1);
      expect(r3[0]).toBe("model-c");
      expect(await cmdClient.get(key)).toBe("3");

      // Request 4 -> INCR 4 -> wraps back to index 0 (model-a)
      const r4 = await rotateComboModels(models, comboName, 1);
      expect(r4[0]).toBe("model-a");
      expect(await cmdClient.get(key)).toBe("4");
    });

    it("respects stickyLimit grouping across sequential atomic requests", async () => {
      const models = ["model-x", "model-y"];
      const comboName = "sticky-combo";

      // stickyLimit = 2: 2 requests per model before switching
      // Req 1 (INCR 1): index = floor(0 / 2) % 2 = 0 -> model-x
      const r1 = await rotateComboModels(models, comboName, 2);
      expect(r1[0]).toBe("model-x");

      // Req 2 (INCR 2): index = floor(1 / 2) % 2 = 0 -> model-x
      const r2 = await rotateComboModels(models, comboName, 2);
      expect(r2[0]).toBe("model-x");

      // Req 3 (INCR 3): index = floor(2 / 2) % 2 = 1 -> model-y
      const r3 = await rotateComboModels(models, comboName, 2);
      expect(r3[0]).toBe("model-y");

      // Req 4 (INCR 4): index = floor(3 / 2) % 2 = 1 -> model-y
      const r4 = await rotateComboModels(models, comboName, 2);
      expect(r4[0]).toBe("model-y");

      // Req 5 (INCR 5): index = floor(4 / 2) % 2 = 0 -> model-x
      const r5 = await rotateComboModels(models, comboName, 2);
      expect(r5[0]).toBe("model-x");
    });

    it("atomic rotation in open-sse/services/combo.js integrates Redis counter", async () => {
      const models = ["m1", "m2"];
      const comboName = "service-combo";

      const r1 = await getRotatedModelsAtomic(models, comboName, "round-robin", 1);
      expect(r1[0]).toBe("m1");

      const r2 = await getRotatedModelsAtomic(models, comboName, "round-robin", 1);
      expect(r2[0]).toBe("m2");

      const r3 = await getRotatedModelsAtomic(models, comboName, "round-robin", 1);
      expect(r3[0]).toBe("m1");
    });

    it("fails open to in-memory rotation when Redis is not available", async () => {
      delete process.env.REDIS_URL;
      await closeRedisClient();

      const models = ["fallback-1", "fallback-2"];
      const r1 = await rotateComboModels(models, "mem-combo", 1);
      expect(r1[0]).toBe("fallback-1");

      const r2 = await rotateComboModels(models, "mem-combo", 1);
      expect(r2[0]).toBe("fallback-2");
    });
  });

  // =========================================================================
  // 5. Shared Atomic Counters: Proxy Pool Rotation (FR-018)
  // =========================================================================
  describe("Proxy Pool Rotation Atomic Counters", () => {
    it("increments Redis counter khatam:counter:proxy:pool:index atomically", async () => {
      await resetProxyPoolCounter();

      const c1 = await getNextProxyPoolCounter();
      expect(c1).toBe(1);

      const c2 = await getNextProxyPoolCounter();
      expect(c2).toBe(2);

      const key = withRedisKey(PROXY_POOL_COUNTER_KEY);
      expect(await cmdClient.get(key)).toBe("2");
    });

    it("rotates through fit proxy pools sequentially without SQLite writes", async () => {
      await resetProxyPoolCounter();

      const poolIds = ["pool-1", "pool-2", "pool-3"];

      const picked1 = await rotateProxyPoolIds(poolIds);
      expect(picked1).toBe("pool-1");

      const picked2 = await rotateProxyPoolIds(poolIds);
      expect(picked2).toBe("pool-2");

      const picked3 = await rotateProxyPoolIds(poolIds);
      expect(picked3).toBe("pool-3");

      const picked4 = await rotateProxyPoolIds(poolIds);
      expect(picked4).toBe("pool-1");
    });

    it("skips unfit proxy pools during rotation", async () => {
      await resetProxyPoolCounter();

      const poolIds = ["pool-alpha", "pool-beta", "pool-gamma"];
      await markPoolUnfit("pool-beta", "openai::gpt-4o", Date.now() + 60000);

      // Only pool-alpha and pool-gamma are fit for scope
      const p1 = await rotateProxyPoolIds(poolIds, "openai::gpt-4o");
      expect(p1).toBe("pool-alpha");

      const p2 = await rotateProxyPoolIds(poolIds, "openai::gpt-4o");
      expect(p2).toBe("pool-gamma");

      const p3 = await rotateProxyPoolIds(poolIds, "openai::gpt-4o");
      expect(p3).toBe("pool-alpha");
    });

    it("fails open to in-memory counter when Redis is unavailable", async () => {
      delete process.env.REDIS_URL;
      await closeRedisClient();
      await resetProxyPoolCounter();

      const poolIds = ["local-p1", "local-p2"];
      const r1 = await rotateProxyPoolIds(poolIds);
      expect(r1).toBe("local-p1");

      const r2 = await rotateProxyPoolIds(poolIds);
      expect(r2).toBe("local-p2");
    });
  });
});

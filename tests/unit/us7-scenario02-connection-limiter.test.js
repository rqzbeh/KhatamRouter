import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkConnectionLimits,
  releaseConnectionSlot,
  resetConnectionLimiter,
  buildConnectionKey,
} from "open-sse/services/rateLimitManager/connectionLimiter.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { FakeRedis } from "./helpers/redisMock.js";
import { setRedisClient, closeRedisClient } from "@/lib/redis/client.js";

// Mock executors
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(async () => {
      return {
        response: new Response(JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hello" } }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }),
  }),
}));

describe("US7 Scenario 2: Connection Limiter Wiring and Enforcement", () => {
  beforeEach(() => {
    resetConnectionLimiter();
    FakeRedis.clearAll();
  });

  afterEach(() => {
    resetConnectionLimiter();
    closeRedisClient();
    delete process.env.REDIS_URL;
  });

  it("enforces minTime spacing between sequential requests on same connection", async () => {
    const connection = {
      provider: "openai",
      account: "acc-1",
      rateLimitOverrides: { minTime: 500 },
    };

    const first = await checkConnectionLimits({ connection, now: 1000 });
    expect(first.allowed).toBe(true);

    // Call 100ms later (less than 500ms minTime)
    const second = await checkConnectionLimits({ connection, now: 1100 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("min_time_not_met");
    expect(second.retryAfterMs).toBe(400);

    // Call 600ms later (exceeds 500ms)
    const third = await checkConnectionLimits({ connection, now: 1700 });
    expect(third.allowed).toBe(true);
  });

  it("enforces maxConcurrent limit and releases slot upon completion", async () => {
    const connection = {
      provider: "anthropic",
      account: "acc-concurrent",
      rateLimitOverrides: { maxConcurrent: 1 },
    };

    const res1 = await checkConnectionLimits({ connection });
    expect(res1.allowed).toBe(true);

    // Second in-flight request on same connection is rejected
    const res2 = await checkConnectionLimits({ connection });
    expect(res2.allowed).toBe(false);
    expect(res2.reason).toBe("concurrency_limit_exceeded");

    // Release first slot
    releaseConnectionSlot({ connection });

    // Now slot can be acquired
    const res3 = await checkConnectionLimits({ connection });
    expect(res3.allowed).toBe(true);
    releaseConnectionSlot({ connection });
  });

  it("triggers connectionLimiter during handleChatCore dispatch", async () => {
    const credentials = {
      provider: "openai",
      connectionId: "conn-dispatch-1",
      apiKey: "sk-test",
      rateLimitOverrides: { minTime: 1000 },
    };

    const body = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };

    // First request passes
    const res1 = await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials,
      connectionId: credentials.connectionId,
    });
    expect(res1.success).toBe(true);
    expect(res1.response.status).toBe(200);

    // Immediate second request within 1000ms is blocked by connectionLimiter
    const res2 = await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials,
      connectionId: credentials.connectionId,
    });
    expect(res2.status).toBe(429);
    expect(res2.error).toContain("Connection rate limit exceeded: min_time_not_met");
  });

  it("routes semaphores through Redis lease path when REDIS_URL is configured", async () => {
    const fakeRedis = new FakeRedis();
    setRedisClient(fakeRedis);
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    const connection = {
      provider: "redis-prov",
      account: "acc-redis",
      rateLimitOverrides: { maxConcurrent: 1 },
    };

    const r1 = await checkConnectionLimits({ connection });
    expect(r1.allowed).toBe(true);
    expect(r1.slotsHeld?.connection).toBe(true);

    const r2 = await checkConnectionLimits({ connection });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("concurrency_limit_exceeded");

    releaseConnectionSlot({ connection, leaseId: r1.slotsHeld?.leaseId });

    const r3 = await checkConnectionLimits({ connection });
    expect(r3.allowed).toBe(true);
    releaseConnectionSlot({ connection, leaseId: r3.slotsHeld?.leaseId });
  });
});

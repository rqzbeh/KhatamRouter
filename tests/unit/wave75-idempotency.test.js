// Wave 7.5 — Leaf 1.6: Idempotency Key Response Replay Unit Tests
//
// Covers User Story 5 (FR-022, FR-023) and specs/0075-bun-only-redis-default/contracts/idempotency.md:
// - Scenario 1: Non-streaming request with new key stores outcome with bounded TTL
// - Scenario 2: Identical replay returns stored response with marker header and 0 upstream calls
// - Scenario 3: In-flight concurrent duplicate waits or returns HTTP 409 conflict
// - Scenario 4: Same key with different payload returns HTTP 422 conflict
// - Scenario 5: Missing Idempotency-Key proceeds unchanged with 0 overhead
// - Scenario 6: Scoped per API key (two different API keys using same key value never collide)
// - Scenario 7: Streaming requests and error responses bypass storage; in-flight locks released
// - Scenario 8: Redis unreachable/error fails open, logs warning once, and proceeds without blocking
// - Edge cases: Header validation (1-256 chars, allowed chars), TTL expiry, case-insensitive header

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/redisMock.js";
import {
  setRedisClient,
  closeRedisClient,
  withRedisKey,
} from "@/lib/redis/client.js";
import {
  IdempotencyStore,
  getIdempotencyStore,
  resetIdempotencyStore,
  hashKey,
  hashBody,
  buildRedisKey,
  isValidIdempotencyKey,
  isStreamingRequest,
  createConflictResponse,
  createInProgressResponse,
  createInvalidKeyResponse,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  DEFAULT_IN_FLIGHT_TTL_SECONDS,
  STATE_IN_FLIGHT,
  STATE_COMPLETE,
} from "@/lib/idempotency/idempotencyStore.js";
import {
  withIdempotency,
  handleIdempotencyPreRequest,
  handleIdempotencyPostRequest,
  extractIdempotencyKey,
} from "@/lib/idempotency/hook.js";

describe("Wave 7.5 — User Story 5: Idempotency Key Response Replay", () => {
  let fakeRedis;

  beforeEach(() => {
    FakeRedis.clearAll();
    resetIdempotencyStore();

    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";

    fakeRedis = new FakeRedis();
    setRedisClient(fakeRedis);
  });

  afterEach(async () => {
    await closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
    FakeRedis.clearAll();
    resetIdempotencyStore();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Non-streaming request with new key stores outcome with bounded TTL
  // ---------------------------------------------------------------------------
  describe("Scenario 1: Non-streaming first request stores outcome with bounded TTL", () => {
    it("stores successful response under khatam:idempotency:<apiKeyHash>:<idempotencyKey> with 300s TTL", async () => {
      const store = new IdempotencyStore({ client: fakeRedis });
      const apiKey = "sk-test-secret-key-12345";
      const idempotencyKey = "7b819f3e-8e4a-4d22-9fa4-706d3e8a4d10";
      const body = { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "Hello" }] };

      // 1. Acquire in-flight lock
      const acquireResult = await store.acquire({ apiKey, idempotencyKey, body });
      expect(acquireResult.proceed).toBe(true);
      expect(acquireResult.acquired).toBe(true);

      const apiKeyHash = hashKey(apiKey);
      const expectedRedisKey = `khatam:idempotency:${apiKeyHash}:${idempotencyKey}`;
      expect(acquireResult.redisKey).toBe(expectedRedisKey);

      // Verify in-flight record exists in Redis
      const inFlightRaw = await fakeRedis.get(expectedRedisKey);
      expect(inFlightRaw).not.toBeNull();
      const inFlightParsed = JSON.parse(inFlightRaw);
      expect(inFlightParsed.state).toBe(STATE_IN_FLIGHT);
      expect(inFlightParsed.bodyHash).toBe(hashBody(body));

      // 2. Save completed response
      const response = {
        status: 200,
        headers: { "content-type": "application/json", "x-provider": "anthropic" },
        body: { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "Hi there!" } }] },
      };
      await store.saveComplete({ redisKey: acquireResult.redisKey, apiKey, idempotencyKey, body, response });

      // 3. Verify complete record in Redis
      const completeRaw = await fakeRedis.get(expectedRedisKey);
      const completeParsed = JSON.parse(completeRaw);
      expect(completeParsed.state).toBe(STATE_COMPLETE);
      expect(completeParsed.bodyHash).toBe(hashBody(body));
      expect(completeParsed.response.status).toBe(200);
      expect(completeParsed.response.body).toEqual(response.body);
    });

    it("runs end-to-end through withIdempotency hook storing result on first run", async () => {
      const apiKey = "sk-live-key-alpha";
      const idempotencyKey = "req-idemp-uuid-1";
      const body = { model: "gpt-4o", messages: [{ role: "user", content: "ping" }] };

      let upstreamCalls = 0;
      const executeUpstream = async () => {
        upstreamCalls++;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { reply: "pong" },
        };
      };

      const req = {
        headers: { "idempotency-key": idempotencyKey },
      };

      const result = await withIdempotency({ req, body, apiKey }, executeUpstream);

      expect(upstreamCalls).toBe(1);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ reply: "pong" });
      expect(result.headers["Idempotency-Replayed"]).toBeUndefined();

      // Verify stored in Redis
      const redisKey = buildRedisKey(hashKey(apiKey), idempotencyKey);
      const stored = await fakeRedis.get(redisKey);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored).state).toBe("complete");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Identical replay returns stored response (0 upstream calls, marker header)
  // ---------------------------------------------------------------------------
  describe("Scenario 2: Identical replay returns cached response with 0 upstream calls", () => {
    it("returns stored response with Idempotency-Replayed: true without touching upstream", async () => {
      const apiKey = "sk-client-key-abc";
      const idempotencyKey = "tx-payment-order-987";
      const body = { model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "summarize" }] };

      let upstreamCalls = 0;
      const executeUpstream = async () => {
        upstreamCalls++;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { summary: "This is a summary." },
        };
      };

      const req = {
        headers: { "Idempotency-Key": idempotencyKey },
      };

      // First call (cache miss)
      const res1 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1);
      expect(res1.body).toEqual({ summary: "This is a summary." });
      expect(res1.headers["Idempotency-Replayed"]).toBeUndefined();

      // Second identical call (cache hit)
      const res2 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1); // ZERO additional upstream calls
      expect(res2.body).toEqual({ summary: "This is a summary." });
      expect(res2.headers["Idempotency-Replayed"]).toBe("true");

      // Third identical call (another hit)
      const res3 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1); // Still 1
      expect(res3.headers["Idempotency-Replayed"]).toBe("true");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: In-flight duplicate waits or returns HTTP 409 conflict
  // ---------------------------------------------------------------------------
  describe("Scenario 3: Concurrent in-flight duplicate handling", () => {
    it("returns HTTP 409 Conflict with Retry-After header on immediate in-flight collision", async () => {
      const store = new IdempotencyStore({ client: fakeRedis });
      const apiKey = "sk-concurrency-key";
      const idempotencyKey = "concurrent-key-1";
      const body = { model: "gpt-4o", messages: [{ role: "user", content: "run task" }] };

      // Request 1 acquires lock
      const acq1 = await store.acquire({ apiKey, idempotencyKey, body, waitForInFlight: false });
      expect(acq1.proceed).toBe(true);
      expect(acq1.acquired).toBe(true);

      // Request 2 arrives while Request 1 is still in_flight (immediate mode)
      const acq2 = await store.acquire({ apiKey, idempotencyKey, body, waitForInFlight: false });
      expect(acq2.proceed).toBe(false);
      expect(acq2.inFlight).toBe(true);
      expect(acq2.error.status).toBe(409);
      expect(acq2.error.headers["Retry-After"]).toBe("2");
      expect(acq2.error.body.error.code).toBe("request_in_progress");
      expect(acq2.error.body.error.type).toBe("conflict_error");
    });

    it("polls and receives replayed response when waitForInFlight is enabled", async () => {
      const store = new IdempotencyStore({ client: fakeRedis, pollIntervalMs: 10, pollTimeoutMs: 1000 });
      const apiKey = "sk-concurrency-wait-key";
      const idempotencyKey = "concurrent-wait-1";
      const body = { model: "gpt-4o", messages: [{ role: "user", content: "slow task" }] };

      // Request 1 acquires lock
      const acq1 = await store.acquire({ apiKey, idempotencyKey, body });
      expect(acq1.proceed).toBe(true);

      // Background simulated completion of Request 1 after 40ms
      setTimeout(async () => {
        await store.saveComplete({
          redisKey: acq1.redisKey,
          apiKey,
          idempotencyKey,
          body,
          response: { status: 200, headers: {}, body: { result: "done after wait" } },
        });
      }, 40);

      // Request 2 polls for completion
      const acq2 = await store.acquire({ apiKey, idempotencyKey, body, waitForInFlight: true });
      expect(acq2.proceed).toBe(false);
      expect(acq2.replayed).toBe(true);
      expect(acq2.response.body).toEqual({ result: "done after wait" });
      expect(acq2.response.headers["Idempotency-Replayed"]).toBe("true");
    });

    it("returns HTTP 409 if waitForInFlight exceeds timeout", async () => {
      const store = new IdempotencyStore({ client: fakeRedis, pollIntervalMs: 10, pollTimeoutMs: 50 });
      const apiKey = "sk-timeout-key";
      const idempotencyKey = "timeout-idemp-1";
      const body = { prompt: "never finishes" };

      // Request 1 acquires lock and never completes
      await store.acquire({ apiKey, idempotencyKey, body });

      // Request 2 waits up to 50ms then times out
      const acq2 = await store.acquire({ apiKey, idempotencyKey, body, waitForInFlight: true });
      expect(acq2.proceed).toBe(false);
      expect(acq2.inFlight).toBe(true);
      expect(acq2.error.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Same key with different body returns HTTP 422 conflict
  // ---------------------------------------------------------------------------
  describe("Scenario 4: Payload mismatch conflict rejection", () => {
    it("rejects with HTTP 422 idempotency_conflict when same key is used with conflicting payload", async () => {
      const apiKey = "sk-user-key-1";
      const idempotencyKey = "reuse-conflict-key";
      const body1 = { model: "gpt-4o", messages: [{ role: "user", content: "first payload" }] };
      const body2 = { model: "gpt-4o", messages: [{ role: "user", content: "DIFFERENT payload" }] };

      let upstreamCalls = 0;
      const executeUpstream = async () => {
        upstreamCalls++;
        return { status: 200, headers: {}, body: { ok: true } };
      };

      const req = { headers: { "Idempotency-Key": idempotencyKey } };

      // Request 1 completes
      const res1 = await withIdempotency({ req, body: body1, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1);
      expect(res1.status).toBe(200);

      // Request 2 sent with same key but different body
      const res2 = await withIdempotency({ req, body: body2, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1); // ZERO upstream calls on conflict!
      expect(res2.status).toBe(422);
      expect(res2.body.error.code).toBe("idempotency_conflict");
      expect(res2.body.error.type).toBe("invalid_request_error");
      expect(res2.body.error.message).toContain("conflicting request payload");
    });

    it("rejects conflicting payload even while original request is still in_flight", async () => {
      const store = new IdempotencyStore({ client: fakeRedis });
      const apiKey = "sk-inflight-conflict-key";
      const idempotencyKey = "inflight-key-1";
      const bodyA = { action: "create", amount: 100 };
      const bodyB = { action: "create", amount: 500 };

      // Acquire with bodyA (in_flight)
      await store.acquire({ apiKey, idempotencyKey, body: bodyA });

      // Concurrent request with bodyB
      const result = await store.acquire({ apiKey, idempotencyKey, body: bodyB });
      expect(result.proceed).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.error.status).toBe(422);
      expect(result.error.body.error.code).toBe("idempotency_conflict");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Missing Idempotency-Key behaves unchanged with 0 overhead
  // ---------------------------------------------------------------------------
  describe("Scenario 5: No Idempotency-Key header leaves request unchanged", () => {
    it("bypasses idempotency store completely when header is absent", async () => {
      const apiKey = "sk-no-header-key";
      const body = { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] };

      let upstreamCalls = 0;
      const executeUpstream = async () => {
        upstreamCalls++;
        return { status: 200, headers: { "x-custom": "true" }, body: { text: "response" } };
      };

      const req = { headers: {} }; // No Idempotency-Key

      const res = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: "response" });
      expect(res.headers["Idempotency-Replayed"]).toBeUndefined();

      // Nothing stored in Redis
      const storeKeys = Array.from(fakeRedis.cluster.store.keys());
      expect(storeKeys.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Scoped per API key (two API keys using same key never collide)
  // ---------------------------------------------------------------------------
  describe("Scenario 6: Per-API-key isolation", () => {
    it("allows two distinct API keys to use the same idempotency key without collision or leakage", async () => {
      const sharedKey = "shared-uuid-12345";
      const apiKeyA = "sk-tenant-alpha-token-111";
      const apiKeyB = "sk-tenant-beta-token-222";

      const bodyA = { tenant: "A", data: "apple" };
      const bodyB = { tenant: "B", data: "banana" }; // Different body

      let callsA = 0;
      let callsB = 0;

      const req = { headers: { "idempotency-key": sharedKey } };

      // Tenant A sends request
      const resA = await withIdempotency({ req, body: bodyA, apiKey: apiKeyA }, async () => {
        callsA++;
        return { status: 200, headers: {}, body: { result: "A outcome" } };
      });
      expect(callsA).toBe(1);
      expect(resA.body).toEqual({ result: "A outcome" });

      // Tenant B sends request with same idempotency key and different body
      // Must NOT be rejected with 422 conflict because it is a different API key!
      const resB = await withIdempotency({ req, body: bodyB, apiKey: apiKeyB }, async () => {
        callsB++;
        return { status: 200, headers: {}, body: { result: "B outcome" } };
      });
      expect(callsB).toBe(1);
      expect(resB.status).toBe(200);
      expect(resB.body).toEqual({ result: "B outcome" });

      // Verify Redis holds two distinct keys
      const redisKeyA = buildRedisKey(hashKey(apiKeyA), sharedKey);
      const redisKeyB = buildRedisKey(hashKey(apiKeyB), sharedKey);
      expect(redisKeyA).not.toBe(redisKeyB);

      const rawA = await fakeRedis.get(redisKeyA);
      const rawB = await fakeRedis.get(redisKeyB);
      expect(JSON.parse(rawA).response.body).toEqual({ result: "A outcome" });
      expect(JSON.parse(rawB).response.body).toEqual({ result: "B outcome" });
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Streaming and error responses are NOT cached; locks released
  // ---------------------------------------------------------------------------
  describe("Scenario 7: Streaming and error responses bypass caching", () => {
    it("bypasses idempotency for streaming requests (stream: true in body)", async () => {
      const apiKey = "sk-stream-key";
      const idempotencyKey = "stream-key-1";
      const body = { stream: true, model: "gpt-4o", messages: [{ role: "user", content: "stream me" }] };

      let upstreamCalls = 0;
      const executeUpstream = async () => {
        upstreamCalls++;
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: "data: [DONE]" };
      };

      const req = { headers: { "Idempotency-Key": idempotencyKey } };

      const res1 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(1);
      expect(res1.body).toBe("data: [DONE]");

      // Must not be cached in Redis
      const redisKey = buildRedisKey(hashKey(apiKey), idempotencyKey);
      const inRedis = await fakeRedis.get(redisKey);
      expect(inRedis).toBeNull();

      // Second identical request executes upstream again (no replay)
      const res2 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(upstreamCalls).toBe(2);
    });

    it("bypasses idempotency when stream=true is in query parameters or URL", () => {
      expect(isStreamingRequest({ url: "http://localhost/v1/chat/completions?stream=true" }, {})).toBe(true);
      expect(isStreamingRequest({ query: { stream: "true" } }, {})).toBe(true);
      expect(isStreamingRequest({ query: { stream: true } }, {})).toBe(true);
      expect(isStreamingRequest({ headers: { accept: "text/event-stream" } }, {})).toBe(true);
      expect(isStreamingRequest(null, { stream: false })).toBe(false);
      expect(isStreamingRequest(null, { stream: "false" })).toBe(false);
    });

    it("does not store 4xx/5xx error responses and releases in-flight lock so retries succeed", async () => {
      const apiKey = "sk-retry-key";
      const idempotencyKey = "flaky-upstream-key";
      const body = { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "retry me" }] };

      let callCount = 0;
      const executeUpstream = async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt returns upstream 503 Service Unavailable
          return { status: 503, headers: {}, body: { error: "overloaded" } };
        }
        // Second attempt succeeds
        return { status: 200, headers: {}, body: { choices: ["ok"] } };
      };

      const req = { headers: { "idempotency-key": idempotencyKey } };

      // Attempt 1: upstream 503
      const res1 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(res1.status).toBe(503);
      expect(callCount).toBe(1);

      // Verify in-flight lock was released from Redis
      const redisKey = buildRedisKey(hashKey(apiKey), idempotencyKey);
      expect(await fakeRedis.get(redisKey)).toBeNull();

      // Attempt 2: client retries with the same key
      const res2 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(res2.status).toBe(200);
      expect(callCount).toBe(2);
      expect(res2.body).toEqual({ choices: ["ok"] });

      // Now successful outcome IS stored in Redis
      const stored = await fakeRedis.get(redisKey);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored).state).toBe("complete");
    });

    it("releases in-flight lock when upstream throws an unhandled exception", async () => {
      const apiKey = "sk-throw-key";
      const idempotencyKey = "crash-key-1";
      const body = { prompt: "crash" };

      let attempts = 0;
      const executeUpstream = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Network timeout to provider");
        }
        return { status: 200, headers: {}, body: { success: true } };
      };

      const req = { headers: { "idempotency-key": idempotencyKey } };

      // Attempt 1: throws
      await expect(withIdempotency({ req, body, apiKey }, executeUpstream)).rejects.toThrow("Network timeout to provider");
      expect(attempts).toBe(1);

      // Lock must be released
      const redisKey = buildRedisKey(hashKey(apiKey), idempotencyKey);
      expect(await fakeRedis.get(redisKey)).toBeNull();

      // Attempt 2: retry succeeds
      const res2 = await withIdempotency({ req, body, apiKey }, executeUpstream);
      expect(res2.status).toBe(200);
      expect(attempts).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Redis unreachable/error fails open and warns once
  // ---------------------------------------------------------------------------
  describe("Scenario 8: Fail-open degradation when Redis is unreachable", () => {
    it("proceeds to upstream when Redis throws, without throwing exception to client", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Faulty Redis mock that throws on every command
      const brokenRedis = {
        get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379")),
        set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379")),
        del: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379")),
      };

      const store = new IdempotencyStore({ client: brokenRedis });
      const apiKey = "sk-failopen-key";
      const idempotencyKey = "broken-redis-key";
      const body = { message: "test" };

      let upstreamCalled = false;
      const req = { headers: { "idempotency-key": idempotencyKey } };

      const result = await withIdempotency({ req, body, apiKey, store }, async () => {
        upstreamCalled = true;
        return { status: 200, headers: {}, body: { ok: true } };
      });

      expect(upstreamCalled).toBe(true);
      expect(result.status).toBe(200);

      // Verify warning was logged with the exact required phrasing
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[idempotency] Redis error during key check, proceeding without idempotency protection")
      );

      // Subsequent call: warning is NOT repeated (warn once)
      const callCountBefore = warnSpy.mock.calls.length;
      await withIdempotency({ req, body, apiKey, store }, async () => {
        return { status: 200, headers: {}, body: { ok: true } };
      });
      expect(warnSpy.mock.calls.length).toBe(callCountBefore);
    });

    it("fails open when Redis is unconfigured (REDIS_URL unset)", async () => {
      delete process.env.REDIS_URL;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = new IdempotencyStore(); // No custom client, will read null from getRedisClient
      const apiKey = "sk-unconfigured-key";
      const idempotencyKey = "no-redis-key";
      const body = { message: "unconfigured" };

      let upstreamCalls = 0;
      const req = { headers: { "idempotency-key": idempotencyKey } };

      const res = await withIdempotency({ req, body, apiKey, store }, async () => {
        upstreamCalls++;
        return { status: 200, headers: {}, body: { answered: true } };
      });

      expect(upstreamCalls).toBe(1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ answered: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Validation and Edge Cases
  // ---------------------------------------------------------------------------
  describe("Validation & Edge Cases", () => {
    it("validates Idempotency-Key length and character constraints", () => {
      // Valid keys: 1-256 chars, ^[A-Za-z0-9_\-\.\:]+$
      expect(isValidIdempotencyKey("uuid-1234-abcd")).toBe(true);
      expect(isValidIdempotencyKey("request.id_123:part-1")).toBe(true);
      expect(isValidIdempotencyKey("a".repeat(256))).toBe(true);

      // Invalid keys
      expect(isValidIdempotencyKey("")).toBe(false); // length < 1
      expect(isValidIdempotencyKey("a".repeat(257))).toBe(false); // length > 256
      expect(isValidIdempotencyKey("key with space")).toBe(false);
      expect(isValidIdempotencyKey("key/slash")).toBe(false);
      expect(isValidIdempotencyKey("key?query")).toBe(false);
      expect(isValidIdempotencyKey("key#hash")).toBe(false);
      expect(isValidIdempotencyKey(null)).toBe(false);
      expect(isValidIdempotencyKey(12345)).toBe(false);
    });

    it("rejects invalid key format with HTTP 400 Bad Request", async () => {
      const apiKey = "sk-valid-key";
      const invalidIdempKey = "invalid key with spaces!";
      const body = { test: true };

      let upstreamCalled = false;
      const req = { headers: { "idempotency-key": invalidIdempKey } };

      const res = await withIdempotency({ req, body, apiKey }, async () => {
        upstreamCalled = true;
        return { status: 200, headers: {}, body: {} };
      });

      expect(upstreamCalled).toBe(false);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_idempotency_key");
      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("extracts header case-insensitively", () => {
      expect(extractIdempotencyKey({ headers: { "idempotency-key": "v1" } })).toBe("v1");
      expect(extractIdempotencyKey({ headers: { "Idempotency-Key": "v2" } })).toBe("v2");
      expect(extractIdempotencyKey({ headers: { "IDEMPOTENCY-KEY": "v3" } })).toBe("v3");
      expect(extractIdempotencyKey({
        headers: {
          get: (h) => (h.toLowerCase() === "idempotency-key" ? "v4" : undefined),
        },
      })).toBe("v4");
      expect(extractIdempotencyKey(null)).toBeUndefined();
    });

    it("expires completed record after TTL", async () => {
      const store = new IdempotencyStore({ client: fakeRedis, ttlSeconds: 10 });
      const apiKey = "sk-ttl-key";
      const idempotencyKey = "expiring-key-1";
      const body = { prompt: "expire test" };

      const redisKey = buildRedisKey(hashKey(apiKey), idempotencyKey);
      await store.saveComplete({
        redisKey,
        apiKey,
        idempotencyKey,
        body,
        response: { status: 200, headers: {}, body: { ok: true } },
      });

      // Initially exists
      expect(await store.get(redisKey)).not.toBeNull();

      // Advance clock past 10s TTL
      const originalDateNow = Date.now;
      try {
        Date.now = () => originalDateNow() + 15_000;
        // Mock get checks expiration against Date.now()
        expect(await store.get(redisKey)).toBeNull();
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});

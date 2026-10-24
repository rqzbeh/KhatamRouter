import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./helpers/redisMock.js";
import {
  setRedisClient,
  closeRedisClient,
} from "@/lib/redis/client.js";
import {
  extractPromptState,
  buildChoiceCriteria,
  parseSystemOneRouteAnswer,
  orderModelsByChoice,
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  resetStickyComboStore,
} from "open-sse/services/systemoneRouter.js";
import {
  handleComboChat,
  resetComboRotation,
} from "open-sse/services/combo.js";

describe("Smart Router / System One Combo Routing & Stickiness", () => {
  let instance1;
  let instance2;

  beforeEach(() => {
    FakeRedis.clearAll();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";

    instance1 = new FakeRedis();
    instance2 = new FakeRedis({ cluster: instance1.cluster });
    setRedisClient(instance1);
  });

  afterEach(async () => {
    await closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
    FakeRedis.clearAll();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Prompt State Extraction & Parsing
  // ---------------------------------------------------------------------------
  describe("extractPromptState", () => {
    it("extracts text from standard OpenAI messages array (latest user turn)", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second question that should be extracted" },
        ],
      };
      expect(extractPromptState(body)).toBe("Second question that should be extracted");
    });

    it("extracts text from multi-part content blocks", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: "World" },
            ],
          },
        ],
      };
      expect(extractPromptState(body)).toBe("Hello World");
    });

    it("extracts text from Codex input array", () => {
      const body = {
        input: [
          { role: "user", text: "Codex input query" },
        ],
      };
      expect(extractPromptState(body)).toBe("Codex input query");
    });

    it("extracts text from body.prompt and body.input strings", () => {
      expect(extractPromptState({ prompt: "  Prompt string  " })).toBe("Prompt string");
      expect(extractPromptState({ input: "  Input string  " })).toBe("Input string");
    });

    it("truncates at maxChars cap to avoid token waste", () => {
      const longText = "a".repeat(3000);
      const extracted = extractPromptState({ prompt: longText }, 500);
      expect(extracted.length).toBe(500);
    });

    it("returns empty string on empty or invalid inputs", () => {
      expect(extractPromptState(null)).toBe("");
      expect(extractPromptState({})).toBe("");
      expect(extractPromptState({ messages: [] })).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Choice Criteria & Answer Parsing
  // ---------------------------------------------------------------------------
  describe("buildChoiceCriteria & parseSystemOneRouteAnswer", () => {
    it("builds criteria map with null values for model strings", () => {
      const criteria = buildChoiceCriteria(["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]);
      expect(criteria).toEqual({
        "openai/gpt-4o": null,
        "anthropic/claude-3-5-sonnet": null,
      });
    });

    it("parses valid route answer from System One response", () => {
      const upstreamJson = {
        answers: {
          route: {
            choice: "anthropic/claude-3-5-sonnet",
            confidence: 0.92,
            probabilities: {
              "anthropic/claude-3-5-sonnet": 0.92,
              "openai/gpt-4o": 0.08,
            },
          },
        },
      };
      const parsed = parseSystemOneRouteAnswer(upstreamJson);
      expect(parsed).toEqual({
        choice: "anthropic/claude-3-5-sonnet",
        confidence: 0.92,
        probabilities: {
          "anthropic/claude-3-5-sonnet": 0.92,
          "openai/gpt-4o": 0.08,
        },
      });
    });

    it("returns null on malformed route response", () => {
      expect(parseSystemOneRouteAnswer(null)).toBeNull();
      expect(parseSystemOneRouteAnswer({})).toBeNull();
      expect(parseSystemOneRouteAnswer({ answers: {} })).toBeNull();
      expect(parseSystemOneRouteAnswer({ answers: { route: { choice: "" } } })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Model Ordering by Probabilities
  // ---------------------------------------------------------------------------
  describe("orderModelsByChoice", () => {
    it("places choice at index 0 and orders remaining models by probability descending", () => {
      const models = ["model-a", "model-b", "model-c", "model-d"];
      const choiceResult = {
        choice: "model-c",
        probabilities: {
          "model-c": 0.7,
          "model-a": 0.1,
          "model-b": 0.2,
        },
      };
      const ordered = orderModelsByChoice(models, choiceResult);
      expect(ordered).toEqual(["model-c", "model-b", "model-a", "model-d"]);
    });

    it("returns original array unchanged if choice is not in candidate models", () => {
      const models = ["model-a", "model-b"];
      const ordered = orderModelsByChoice(models, { choice: "model-unknown" });
      expect(ordered).toEqual(["model-a", "model-b"]);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Two-Instance Redis Stickiness Coordination (Wave 7.5 cluster replication)
  // ---------------------------------------------------------------------------
  describe("Two-Instance Redis Stickiness Coordination", () => {
    it("stores sticky model in Instance 1 and retrieves it seamlessly in Instance 2", async () => {
      const comboName = "smart-coding";
      const sessionId = "session-user-42";
      const models = ["anthropic/claude-3-5-sonnet", "openai/gpt-4o"];

      // Instance 1 writes stickiness
      setRedisClient(instance1);
      await setStickyComboModel(comboName, sessionId, "openai/gpt-4o");

      // Instance 2 reads stickiness across cluster replica
      setRedisClient(instance2);
      const stickyInInstance2 = await getStickyComboModel(comboName, sessionId, models);
      expect(stickyInInstance2).toBe("openai/gpt-4o");

      // Instance 2 clears the session
      await clearStickyComboSession(comboName, sessionId);

      // Instance 1 sees the session is cleared
      setRedisClient(instance1);
      const afterClear = await getStickyComboModel(comboName, sessionId, models);
      expect(afterClear).toBeNull();
    });

    it("resets all combo sessions across cluster replicas", async () => {
      const comboName = "smart-chat";
      const models = ["m1", "m2"];

      setRedisClient(instance1);
      await setStickyComboModel(comboName, "s1", "m1");
      await setStickyComboModel(comboName, "s2", "m2");

      setRedisClient(instance2);
      expect(await getStickyComboModel(comboName, "s1", models)).toBe("m1");
      expect(await getStickyComboModel(comboName, "s2", models)).toBe("m2");

      // Clear all sessions for comboName from Instance 2
      await clearStickyComboSession(comboName);

      // Both sessions cleared for Instance 1
      setRedisClient(instance1);
      expect(await getStickyComboModel(comboName, "s1", models)).toBeNull();
      expect(await getStickyComboModel(comboName, "s2", models)).toBeNull();
    });

    it("forbids in-process Map fallback when Redis is absent (fail-open to null)", async () => {
      setRedisClient(null);
      delete process.env.REDIS_URL;

      // When Redis is not configured, set does not store to any Map
      await setStickyComboModel("comboX", "sessionX", "modelA");
      const result = await getStickyComboModel("comboX", "sessionX", ["modelA"]);
      expect(result).toBeNull();
    });

    it("evicts sticky model if model is removed from combo candidates", async () => {
      setRedisClient(instance1);
      await setStickyComboModel("comboX", "sessY", "removed-model");

      setRedisClient(instance2);
      // Combo candidates currently only have "valid-model"
      const result = await getStickyComboModel("comboX", "sessY", ["valid-model"]);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. handleComboChat Smart Strategy with Two-Instance Simulation
  // ---------------------------------------------------------------------------
  describe("handleComboChat Smart Strategy Integration", () => {
    const dummyLog = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    };

    it("Turn 1 on Instance 1 selects model via System One; Turn 2 on Instance 2 reuses it without re-evaluation (strict lock)", async () => {
      const models = ["model-fast", "model-smart"];
      const comboName = "hybrid-combo";
      const sessionId = "sess-shared-1";

      const mockSingleModel = vi.fn(async (body, modelStr) => {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const mockSmartChoice = vi.fn(async () => {
        return {
          choice: "model-smart",
          confidence: 0.95,
          probabilities: { "model-smart": 0.95, "model-fast": 0.05 },
        };
      });

      // --- Turn 1: Handled by Server Instance 1 ---
      setRedisClient(instance1);
      const res1 = await handleComboChat({
        body: { messages: [{ role: "user", content: "Solve complex theorem" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "strict",
        sessionId,
        resolveSmartChoice: mockSmartChoice,
      });

      expect(res1.status).toBe(200);
      expect(mockSmartChoice).toHaveBeenCalledTimes(1);
      expect(mockSingleModel).toHaveBeenLastCalledWith(expect.anything(), "model-smart");

      // Verify Redis received the stickiness
      const stickyInCluster = await getStickyComboModel(comboName, sessionId, models);
      expect(stickyInCluster).toBe("model-smart");

      // --- Turn 2: Handled by Server Instance 2 (replica) ---
      setRedisClient(instance2);
      const mockSmartChoice2 = vi.fn();

      const res2 = await handleComboChat({
        body: { messages: [{ role: "user", content: "Follow-up question" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "strict",
        sessionId,
        resolveSmartChoice: mockSmartChoice2,
      });

      expect(res2.status).toBe(200);
      // Strict policy: Turn 2 should NOT invoke System One! 0 extra calls, 0ms latency
      expect(mockSmartChoice2).not.toHaveBeenCalled();
      expect(mockSingleModel).toHaveBeenLastCalledWith(expect.anything(), "model-smart");
    });

    it("Smart Switch (adaptive): retains model on low confidence change, switches on high confidence", async () => {
      const models = ["model-fast", "model-smart"];
      const comboName = "adaptive-combo";
      const sessionId = "sess-adaptive";

      const mockSingleModel = vi.fn(async () => {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      // Turn 1: picks model-smart
      setRedisClient(instance1);
      await handleComboChat({
        body: { messages: [{ role: "user", content: "Hard task" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "smart",
        sessionId,
        resolveSmartChoice: async () => ({ choice: "model-smart", confidence: 0.9 }),
      });

      // Turn 2 on Instance 2: task changes slightly, System One suggests model-fast but confidence is 0.65 (< 0.8)
      setRedisClient(instance2);
      await handleComboChat({
        body: { messages: [{ role: "user", content: "Ambiguous task" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "smart",
        sessionId,
        resolveSmartChoice: async () => ({ choice: "model-fast", confidence: 0.65 }),
      });

      // Adaptive hysteresis retained model-smart to preserve warm prompt cache!
      expect(mockSingleModel).toHaveBeenLastCalledWith(expect.anything(), "model-smart");
      expect(await getStickyComboModel(comboName, sessionId, models)).toBe("model-smart");

      // Turn 3 on Instance 2: task completely shifts to fast routine work with confidence 0.95 (>= 0.8)
      await handleComboChat({
        body: { messages: [{ role: "user", content: "Simple hello" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "smart",
        sessionId,
        resolveSmartChoice: async () => ({ choice: "model-fast", confidence: 0.95 }),
      });

      // Model switched to model-fast and updated in Redis
      expect(mockSingleModel).toHaveBeenLastCalledWith(expect.anything(), "model-fast");
      expect(await getStickyComboModel(comboName, sessionId, models)).toBe("model-fast");

      // Turn 4 on Instance 1: reads updated model-fast
      setRedisClient(instance1);
      expect(await getStickyComboModel(comboName, sessionId, models)).toBe("model-fast");
    });

    it("clears sticky model from Redis if that model fails, allowing subsequent turn to re-evaluate", async () => {
      const models = ["model-smart", "model-backup"];
      const comboName = "failover-combo";
      const sessionId = "sess-failover";

      // Initially sticky to model-smart
      setRedisClient(instance1);
      await setStickyComboModel(comboName, sessionId, "model-smart");

      // Model-smart fails (500), model-backup succeeds
      const mockSingleModel = vi.fn(async (body, modelStr) => {
        if (modelStr === "model-smart") {
          return new Response(JSON.stringify({ error: { message: "Internal server error" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "backup ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      setRedisClient(instance2);
      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "Do something" }] },
        models,
        handleSingleModel: mockSingleModel,
        log: dummyLog,
        comboName,
        comboStrategy: "smart",
        smartPolicy: "strict",
        sessionId,
      });

      expect(res.status).toBe(200);
      expect(mockSingleModel).toHaveBeenCalledWith(expect.anything(), "model-smart");
      expect(mockSingleModel).toHaveBeenCalledWith(expect.anything(), "model-backup");

      // Sticky mapping must be cleared from Redis so next turn re-evaluates
      expect(await getStickyComboModel(comboName, sessionId, models)).toBeNull();
    });

    it("resets combo rotation clears Redis sticky sessions", async () => {
      const comboName = "test-reset-combo";
      setRedisClient(instance1);
      await setStickyComboModel(comboName, "s-reset", "m1");

      resetComboRotation(comboName);

      // Wait a microtask for catch/cleanup promise
      await new Promise((r) => setTimeout(r, 10));
      expect(await getStickyComboModel(comboName, "s-reset", ["m1"])).toBeNull();
    });
  });
});

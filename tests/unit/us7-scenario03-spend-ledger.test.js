import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const inMemoryRows = [];
const mockDb = {
  run: vi.fn((sql, args) => {
    if (sql && sql.includes("INSERT INTO request_cost_ledger")) {
      const [id, reqId, keyId, prov, mod, prompt, comp, tot, inCost, outCost, totalUsd, stat, created] = args;
      inMemoryRows.push({
        id,
        request_id: reqId,
        api_key_id: keyId,
        provider: prov,
        model: mod,
        prompt_tokens: prompt,
        completion_tokens: comp,
        total_tokens: tot,
        input_cost_per_million: inCost,
        output_cost_per_million: outCost,
        total_cost_usd: totalUsd,
        status: stat,
        created_at: created,
      });
      return { changes: 1 };
    }
    if (sql && sql.includes("DELETE FROM request_cost_ledger")) {
      inMemoryRows.length = 0;
      return { changes: 1 };
    }
    return { changes: 0 };
  }),
  get: vi.fn((sql, args) => {
    if (sql && sql.includes("SELECT COALESCE(SUM(total_cost_usd)")) {
      const [apiKeyId, sinceIso] = args;
      const matching = inMemoryRows.filter(
        (r) => r.api_key_id === apiKeyId && (!sinceIso || r.created_at >= sinceIso)
      );
      const sumUsd = matching.reduce((acc, r) => acc + (r.total_cost_usd || 0), 0);
      const sumTokens = matching.reduce((acc, r) => acc + (r.total_tokens || 0), 0);
      return { total_usd: sumUsd, total_tokens: sumTokens };
    }
    return null;
  }),
  all: vi.fn(() => []),
  transaction: vi.fn((fn) => (typeof fn === "function" ? fn() : undefined)),
  exec: vi.fn(() => {}),
};

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => mockDb,
  getAdapterSync: () => mockDb,
  verifyDatabaseIntegrity: async () => true,
}));

// Mock executor returning non-streaming response with token usage
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(async () => {
      return {
        response: new Response(
          JSON.stringify({
            id: "chatcmpl-spend-test",
            object: "chat.completion",
            choices: [
              {
                message: { role: "assistant", content: "This is a detailed response from the model." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 2000,
              total_tokens: 3000,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        ),
      };
    }),
  }),
}));

const { handleChatCore } = await import("open-sse/handlers/chatCore.js");
const { checkApiKeyUsageLimits } = await import("@/lib/usage/apiKeyUsageLimits.js");
const { getCumulativeSpendForWindow } = await import("@/lib/db/keyQuota.js");

describe("US7 Scenario 3: Spend Ledger Post-Flight Recording and Limit Enforcement", () => {
  beforeEach(() => {
    inMemoryRows.length = 0;
  });

  afterEach(() => {
    inMemoryRows.length = 0;
  });

  it("populates request_cost_ledger on completed request and triggers USD spend caps", async () => {
    const apiKey = "sk-test-spend-key-1";
    const apiKeyRow = {
      id: "key-spend-1",
      key: apiKey,
      isActive: true,
      usage_limit_enabled: 1,
      daily_usage_limit_usd: 0.0001, // Very low cap: $0.0001
    };

    // Before any requests: spend is 0, limit check passes
    const preCheck = await checkApiKeyUsageLimits({ apiKeyRow });
    expect(preCheck.allowed).toBe(true);

    // Execute request through chatCore
    const result = await handleChatCore({
      body: {
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "test spend" }],
        stream: false,
      },
      modelInfo: { provider: "deepseek", model: "deepseek-chat" },
      credentials: {
        provider: "deepseek",
        connectionId: "conn-spend-1",
        apiKey: "sk-prov",
      },
      connectionId: "conn-spend-1",
      apiKey,
      apiKeyId: apiKeyRow.id,
    });

    expect(result.success).toBe(true);

    // Allow async post-flight cost recording promise microtask to complete
    await new Promise((r) => setTimeout(r, 20));

    // Verify record was written to request_cost_ledger
    const spend = await getCumulativeSpendForWindow({
      apiKeyId: apiKeyRow.id,
      windowType: "daily",
    });

    expect(spend.totalUsd).toBeGreaterThan(0);

    // Subsequent limit check must now trigger budget_exceeded
    const postCheck = await checkApiKeyUsageLimits({ apiKeyRow });
    expect(postCheck.allowed).toBe(false);
    expect(postCheck.reason).toBe("budget_exceeded");
  });
});

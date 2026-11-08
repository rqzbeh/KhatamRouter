import { describe, expect, it, vi } from "vitest";
import { createProviderSyncScheduler, runProviderSyncOnce } from "../../src/lib/models/providerSync.js";
const policy = { globalDefault: "enabled", providers: {}, intervalMs: 3600000 };
describe("independent provider sync safety", () => {
  it("never treats undefined importer output as a successful refresh", async () => {
    const result = await runProviderSyncOnce({ policy, connections: [{ id: "one", provider: "openai", isActive: true }], importConnection: async () => undefined });
    expect(result.results[0].success).toBe(false);
  });
  it("does not return raw importer secrets in sync error summaries", async () => {
    const secret = "sk-fixture-do-not-return";
    const result = await runProviderSyncOnce({ policy, connections: [{ id: "one", provider: "openai", isActive: true }], importConnection: async () => { throw new Error(`Authorization Bearer ${secret}`); } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("settles a hung importer after its timeout", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const running = runProviderSyncOnce({ policy, connections: [{ id: "one", provider: "openai", isActive: true }], perConnectionTimeoutMs: 1000, importConnection: async () => new Promise(() => {}) }).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1100);
      expect(done).toBe(true);
      await running;
    } finally { vi.useRealTimers(); }
  });
  it("reaches connections beyond the first hundred across scheduler cycles", async () => {
    const observed = new Set();
    const connections = Array.from({ length: 101 }, (_, n) => ({ id: `connection-${n}`, provider: "openai", isActive: true }));
    const scheduler = createProviderSyncScheduler({ getPolicy: async () => policy, listConnections: async () => connections, importConnection: async (connection) => { observed.add(connection.id); return { ok: true }; }, role: "leader" });
    await scheduler.runNow();
    await scheduler.runNow();
    expect(observed.has("connection-100")).toBe(true);
    scheduler.stop();
  });
});

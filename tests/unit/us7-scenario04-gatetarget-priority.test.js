import { describe, it, expect, vi, beforeEach } from "vitest";
import { gateTarget } from "@/domain/fallbackResilience.js";
import { CircuitBreaker } from "@/shared/utils/circuitBreaker.js";
import { BREAKER_STATE, GATE, VERDICT } from "open-sse/config/resilienceConfig.js";

// Mock durable circuit breaker store
const mockBreakers = new Map();
vi.mock("@/lib/resilience/circuitBreakerStore.js", () => ({
  getCircuitBreakerForDomain: async (domain) => mockBreakers.get(domain) || null,
  resetDomainCircuitBreakers: () => mockBreakers.clear(),
}));

describe("US7 Scenario 4 & 5: gateTarget Circuit Priority & HALF_OPEN Probe Budget", () => {
  beforeEach(() => {
    mockBreakers.clear();
    process.env.KHATAM_RESILIENCE_CIRCUIT_BREAKER = "1";
  });

  it("yields circuit_open instead of cooldown when breaker is OPEN and cooldown is active", async () => {
    const domain = "test-prov:conn-1";
    const breaker = new CircuitBreaker(domain, { failureThreshold: 1, resetTimeout: 60000 });
    // Trip breaker to OPEN
    breaker.openCircuit("http_503");
    expect(breaker.state).toBe(BREAKER_STATE.OPEN);
    mockBreakers.set(domain, breaker);

    const now = Date.now();
    const target = {
      provider: "test-prov",
      connectionId: "conn-1",
      domain,
      cooldownUntil: now + 30000, // Cooldown is also active
    };

    // Call gateTarget WITHOUT options.getBreaker (the default production path)
    const verdict = await gateTarget(target, { now });

    expect(verdict.kind).toBe(VERDICT.SKIP);
    expect(verdict.reason).toBe(GATE.CIRCUIT); // Must be "circuit", NOT "cooldown"!
  });

  it("consumes probe budget in HALF_OPEN state via canExecute() and bounds probes", async () => {
    const domain = "test-prov:conn-halfopen";
    const breaker = new CircuitBreaker(domain, {
      failureThreshold: 1,
      resetTimeout: 100,
      halfOpenRequests: 1, // Only 1 probe allowed
    });

    breaker.openCircuit("http_503");
    mockBreakers.set(domain, breaker);

    // Fast forward past resetTimeout so state transitions to HALF_OPEN
    breaker.lastFailureTime = Date.now() - 200;
    breaker.refreshOpenState();
    expect(breaker.state).toBe(BREAKER_STATE.HALF_OPEN);

    const now = Date.now();
    const target = {
      provider: "test-prov",
      connectionId: "conn-halfopen",
      domain,
    };

    // First request is admitted as the probe
    const verdict1 = await gateTarget(target, { now });
    expect(verdict1.kind).toBe(VERDICT.PROCEED);

    // Second concurrent request should be rejected because probe budget was consumed
    const verdict2 = await gateTarget(target, { now });
    expect(verdict2.kind).toBe(VERDICT.SKIP);
    expect(verdict2.reason).toBe(GATE.CIRCUIT);
  });
});

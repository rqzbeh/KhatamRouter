import { describe, it, expect } from "vitest";
import {
  createLatestRequestTracker,
  scopeConnectionsToProvider,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("createLatestRequestTracker", () => {
  it("rejects a slow older response after a newer request starts", async () => {
    const tracker = createLatestRequestTracker();
    const request = async (delay, value) => {
      const token = tracker.begin();
      await new Promise((resolve) => setTimeout(resolve, delay));
      return tracker.isLatest(token) ? value : null;
    };

    const slow = request(30, "all");
    const fast = request(5, "antigravity");

    await expect(fast).resolves.toBe("antigravity");
    await expect(slow).resolves.toBeNull();
  });
});

describe("scopeConnectionsToProvider", () => {
  const connections = [
    { id: "c1", provider: "codex" },
    { id: "c2", provider: "antigravity" },
  ];

  it("returns the list unchanged for the all-providers filter", () => {
    expect(scopeConnectionsToProvider(connections, "all")).toBe(connections);
  });

  it("keeps only connections from the selected provider", () => {
    expect(scopeConnectionsToProvider(connections, "antigravity")).toEqual([
      { id: "c2", provider: "antigravity" },
    ]);
  });

  it("returns an empty list when no connection matches", () => {
    expect(scopeConnectionsToProvider(connections, "claude")).toEqual([]);
  });
});

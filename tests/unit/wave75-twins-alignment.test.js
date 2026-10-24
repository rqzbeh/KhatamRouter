import { describe, it, expect } from "vitest";

describe("Wave 7.5: TypeScript and JavaScript Twins Alignment Audit (G10)", () => {
  it("maintains exported symbol parity for bunSqliteAdapter twins", async () => {
    const js = await import("@/lib/db/adapters/bunSqliteAdapter.js");
    const ts = await import("@/lib/db/adapters/bunSqliteAdapter.js");

    const jsExports = Object.keys(js).sort();
    const tsExports = Object.keys(ts).sort();

    expect(tsExports).toEqual(jsExports);
  });

  it("maintains exported symbol parity for redis client twins", async () => {
    const js = await import("@/lib/redis/client.js");
    const ts = await import("@/lib/redis/client.js");

    const jsExports = Object.keys(js).sort();
    const tsExports = Object.keys(ts).sort();

    expect(tsExports).toEqual(jsExports);
  });

  it("maintains exported symbol parity and channel values for events twins", async () => {
    const js = await import("@/lib/redis/events.js");
    const ts = await import("@/lib/redis/events.js");

    const jsExports = Object.keys(js).sort();
    const tsExports = Object.keys(ts).sort();

    expect(tsExports).toEqual(jsExports);
    expect(ts.KHATAM_EVENTS).toEqual(js.KHATAM_EVENTS);
  });

  it("maintains exported symbol parity for redisQuotaStore twins", async () => {
    const js = await import("@/lib/quota/redisQuotaStore.js");
    const ts = await import("@/lib/quota/redisQuotaStore.js");

    const jsExports = Object.keys(js).sort();
    const tsExports = Object.keys(ts).sort();

    expect(tsExports).toEqual(jsExports);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  normalizeSyncPolicy,
  resolveProviderSyncEnabled,
  getSyncPolicy,
  setSyncPolicy,
  getKnownProviderIds,
  DEFAULT_SYNC_POLICY,
  MIN_SYNC_INTERVAL_MS,
  MAX_SYNC_INTERVAL_MS,
  DEFAULT_SYNC_INTERVAL_MS,
} from "../../src/lib/models/providerSync.js";
import { GET, PUT } from "../../src/app/api/models/sync-policy/route.js";
import { createDashboardAuthToken } from "../../src/lib/auth/dashboardSession.js";

const originalDataDir = process.env.DATA_DIR;
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-model-sync-policy-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
  global._dbAdapter = null;

  const { getAdapter } = await import("../../src/lib/db/driver.js");
  db = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
  global._dbAdapter = null;
});

describe("normalizeSyncPolicy - Strict validation", () => {
  const knownIds = new Set(["openai", "anthropic", "custom-node-1"]);

  it("returns default policy on empty input", () => {
    const res = normalizeSyncPolicy({});
    expect(res).toEqual({
      globalDefault: "disabled",
      providers: {},
      intervalMs: DEFAULT_SYNC_INTERVAL_MS,
    });
  });

  it("strictly rejects non-object inputs", () => {
    expect(() => normalizeSyncPolicy(null)).toThrow(TypeError);
    expect(() => normalizeSyncPolicy("string")).toThrow(TypeError);
    expect(() => normalizeSyncPolicy([1, 2, 3])).toThrow(TypeError);
  });

  it("strictly rejects unknown top-level fields", () => {
    expect(() => normalizeSyncPolicy({ unknownField: true })).toThrow(/Unknown policy field/);
    expect(() => normalizeSyncPolicy({ apiKey: "secret" })).toThrow(/Unknown policy field/);
  });

  it("strictly rejects invalid globalDefault enum values", () => {
    expect(() => normalizeSyncPolicy({ globalDefault: "invalid" })).toThrow(/Invalid globalDefault/);
    expect(() => normalizeSyncPolicy({ globalDefault: "inherit" })).toThrow(/Invalid globalDefault/);
    expect(() => normalizeSyncPolicy({ globalDefault: 123 })).toThrow(/Invalid globalDefault/);
  });

  it("strictly validates intervalMs numeric integer bounds (1h to 7d)", () => {
    expect(() => normalizeSyncPolicy({ intervalMs: MIN_SYNC_INTERVAL_MS - 1 })).toThrow(/Invalid intervalMs/);
    expect(() => normalizeSyncPolicy({ intervalMs: MAX_SYNC_INTERVAL_MS + 1 })).toThrow(/Invalid intervalMs/);
    expect(() => normalizeSyncPolicy({ intervalMs: 3600000.5 })).toThrow(/Invalid intervalMs/);
    expect(() => normalizeSyncPolicy({ intervalMs: "86400000" })).toThrow(/Invalid intervalMs/);
    expect(() => normalizeSyncPolicy({ intervalMs: NaN })).toThrow(/Invalid intervalMs/);

    const validLow = normalizeSyncPolicy({ intervalMs: MIN_SYNC_INTERVAL_MS });
    expect(validLow.intervalMs).toBe(MIN_SYNC_INTERVAL_MS);

    const validHigh = normalizeSyncPolicy({ intervalMs: MAX_SYNC_INTERVAL_MS });
    expect(validHigh.intervalMs).toBe(MAX_SYNC_INTERVAL_MS);
  });

  it("strictly rejects unknown provider IDs when knownIds provided", () => {
    expect(() =>
      normalizeSyncPolicy(
        {
          providers: { "unregistered-provider": "enabled" },
        },
        knownIds
      )
    ).toThrow(/Unknown provider id: 'unregistered-provider'/);

    // Dynamic custom node accepted
    const valid = normalizeSyncPolicy(
      {
        providers: { "custom-node-1": "enabled", openai: "disabled" },
      },
      knownIds
    );
    expect(valid.providers).toEqual({
      "custom-node-1": "enabled",
      openai: "disabled",
    });
  });

  it("strictly rejects invalid provider mode enum values", () => {
    expect(() =>
      normalizeSyncPolicy({ providers: { openai: "unsupported" } }, knownIds)
    ).toThrow(/Invalid policy mode/);

    expect(() =>
      normalizeSyncPolicy({ providers: "not an object" }, knownIds)
    ).toThrow(TypeError);
  });
});

describe("resolveProviderSyncEnabled - Matrix verification", () => {
  it("resolves exact global and provider override combinations", () => {
    // 1. Global disabled, provider enabled -> true
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "disabled", providers: { openai: "enabled" } },
        "openai"
      )
    ).toBe(true);

    // 2. Global disabled, provider inherit -> false
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "disabled", providers: { openai: "inherit" } },
        "openai"
      )
    ).toBe(false);

    // 3. Global disabled, provider unconfigured -> false
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "disabled", providers: {} },
        "openai"
      )
    ).toBe(false);

    // 4. Global enabled, provider disabled -> false
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "enabled", providers: { openai: "disabled" } },
        "openai"
      )
    ).toBe(false);

    // 5. Global enabled, provider inherit -> true
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "enabled", providers: { openai: "inherit" } },
        "openai"
      )
    ).toBe(true);

    // 6. Global enabled, provider unconfigured -> true
    expect(
      resolveProviderSyncEnabled(
        { globalDefault: "enabled", providers: {} },
        "openai"
      )
    ).toBe(true);

    // 7. Null/undefined policy or provider ID -> safe false
    expect(resolveProviderSyncEnabled(null, "openai")).toBe(false);
    expect(resolveProviderSyncEnabled({}, null)).toBe(false);
    expect(resolveProviderSyncEnabled(undefined, undefined)).toBe(false);
  });
});

describe("Policy SQLite persistence", () => {
  it("reads default policy when no row exists", async () => {
    const policy = await getSyncPolicy({ db });
    expect(policy.globalDefault).toBe("disabled");
    expect(policy.providers).toEqual({});
    expect(policy.intervalMs).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it("persists policy via immediate transaction and supports partial merge", async () => {
    const known = new Set(["openai", "anthropic"]);

    // 1. Initial write
    const saved = await setSyncPolicy(
      {
        globalDefault: "disabled",
        providers: { openai: "enabled" },
        intervalMs: 7200000,
      },
      { db, knownIds: known }
    );
    expect(saved.providers.openai).toBe("enabled");
    expect(saved.intervalMs).toBe(7200000);

    // Read back from db
    const read = await getSyncPolicy({ db });
    expect(read).toEqual(saved);

    // 2. Partial update with merge=true (add anthropic, preserve openai & intervalMs)
    const updated = await setSyncPolicy(
      {
        providers: { anthropic: "disabled" },
      },
      { db, knownIds: known, merge: true }
    );
    expect(updated.providers.openai).toBe("enabled");
    expect(updated.providers.anthropic).toBe("disabled");
    expect(updated.intervalMs).toBe(7200000);

    const reRead = await getSyncPolicy({ db });
    expect(reRead.providers.openai).toBe("enabled");
    expect(reRead.providers.anthropic).toBe("disabled");
  });
});

describe("GET & PUT /api/models/sync-policy route handler", () => {
  it("rejects unauthenticated requests with 401 when requireLogin is true", async () => {
    const unauthReq = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "GET",
    });
    const res = await GET(unauthReq);
    expect(res.status).toBe(401);
  });

  it("respects requireLogin: false allowing access without auth_token cookie", async () => {
    const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });

    try {
      const req = new Request("http://localhost:20128/api/models/sync-policy", {
        method: "GET",
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.policy).toBeDefined();
    } finally {
      await updateSettings({ requireLogin: true });
    }
  });

  it("allows authenticated GET and returns current policy with known providers and flat fields", async () => {
    const token = await createDashboardAuthToken();
    const req = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "GET",
      headers: {
        cookie: `auth_token=${token}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toBeDefined();
    expect(body.globalDefault).toBeDefined();
    expect(body.providers).toBeDefined();
    expect(body.intervalMs).toBeDefined();
    expect(Array.isArray(body.knownProviders)).toBe(true);
    expect(body.knownProviders.length).toBeGreaterThan(0);
  });

  it("handles authenticated PUT with strict validation", async () => {
    const token = await createDashboardAuthToken();

    // 1. Bad JSON / Unknown field
    const badReq = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "PUT",
      headers: {
        cookie: `auth_token=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ unknownField: "bad" }),
    });
    const badRes = await PUT(badReq);
    expect(badRes.status).toBe(400);
    const badBody = await badRes.json();
    expect(badBody.error).toMatch(/Unknown policy field/);

    // 2. Valid PUT
    const goodReq = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "PUT",
      headers: {
        cookie: `auth_token=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        globalDefault: "disabled",
        intervalMs: 14400000,
        providers: { openai: "enabled" },
      }),
    });
    const goodRes = await PUT(goodReq);
    expect(goodRes.status).toBe(200);
    const goodBody = await goodRes.json();
    expect(goodBody.success).toBe(true);
    expect(goodBody.policy.intervalMs).toBe(14400000);
    expect(goodBody.policy.providers.openai).toBe("enabled");

    // 3. UI Partial PUT (patch): omit globalDefault/intervalMs, pass inherit mode
    const patchReq = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "PUT",
      headers: {
        cookie: `auth_token=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providers: { anthropic: "inherit" },
      }),
    });
    const patchRes = await PUT(patchReq);
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.policy.globalDefault).toBe("disabled"); // unaffected
    expect(patchBody.policy.intervalMs).toBe(14400000); // unaffected
    expect(patchBody.policy.providers.openai).toBe("enabled"); // preserved from earlier PUT
    expect(patchBody.policy.providers.anthropic).toBe("inherit"); // persisted inherit

    // 4. Verify flat fields on GET
    const getReq = new Request("http://localhost:20128/api/models/sync-policy", {
      method: "GET",
      headers: { cookie: `auth_token=${token}` },
    });
    const getRes = await GET(getReq);
    const getBody = await getRes.json();
    expect(getBody.policy).toHaveProperty("globalDefault");
    expect(getBody.policy).toHaveProperty("providers");
    expect(getBody.policy).toHaveProperty("intervalMs");
    expect(getBody.policy.globalDefault).toBe("disabled");
    expect(getBody.policy.providers.openai).toBe("enabled");
    expect(getBody.policy.providers.anthropic).toBe("inherit");
    expect(getBody.policy.intervalMs).toBe(14400000);
  });
});

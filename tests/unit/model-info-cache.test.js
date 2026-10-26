import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  invalidateAliasesCache,
} from "@/lib/db/repos/aliasRepo.js";
import {
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
  invalidateCombosCache,
} from "@/lib/db/repos/combosRepo.js";
import {
  getProviderNodes,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,
  invalidateNodesCache,
} from "@/lib/db/repos/nodesRepo.js";
import {
  validateApiKey,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from "@/lib/db/repos/apiKeysRepo.js";
import {
  publishKhatamEvent,
  KHATAM_EVENTS,
} from "@/lib/redis/events.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let queryCount = 0;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-model-info-cache-test-"));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = null;
  db = await getAdapter();

  // Instrument adapter to count read queries
  const originalGet = db.get.bind(db);
  const originalAll = db.all.bind(db);
  db.get = (sql, ...args) => {
    queryCount++;
    return originalGet(sql, ...args);
  };
  db.all = (sql, ...args) => {
    queryCount++;
    return originalAll(sql, ...args);
  };
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  global._dbAdapter = null;
});

beforeEach(() => {
  queryCount = 0;
  if (typeof invalidateAliasesCache === "function") invalidateAliasesCache();
  if (typeof invalidateCombosCache === "function") invalidateCombosCache();
  if (typeof invalidateNodesCache === "function") invalidateNodesCache();
});

describe("model-info-cache: getModelAliases", () => {
  it("caches getModelAliases across repeated reads within 5s TTL", async () => {
    await setModelAlias("gpt-fast", "openai/gpt-4o-mini");
    queryCount = 0;

    const first = await getModelAliases();
    expect(first["gpt-fast"]).toBe("openai/gpt-4o-mini");
    expect(queryCount).toBeGreaterThan(0);

    const qBefore = queryCount;
    const second = await getModelAliases();
    expect(second["gpt-fast"]).toBe("openai/gpt-4o-mini");
    expect(queryCount - qBefore).toBe(0); // Cache hit: zero queries
  });

  it("returns cloned data so mutations cannot poison cache", async () => {
    await setModelAlias("alias-safe", "target-model");
    const first = await getModelAliases();
    first["alias-safe"] = "poisoned-model";
    first["injected"] = "malicious";

    const second = await getModelAliases();
    expect(second["alias-safe"]).toBe("target-model");
    expect(second["injected"]).toBeUndefined();
  });

  it("invalidates cache on setModelAlias and deleteModelAlias", async () => {
    await setModelAlias("a1", "m1");
    await getModelAliases(); // Warm cache

    // Write: set
    await setModelAlias("a2", "m2");
    queryCount = 0;
    const afterSet = await getModelAliases();
    expect(queryCount).toBeGreaterThan(0); // Must have queried DB
    expect(afterSet["a2"]).toBe("m2");

    // Write: delete
    await deleteModelAlias("a1");
    queryCount = 0;
    const afterDel = await getModelAliases();
    expect(queryCount).toBeGreaterThan(0); // Must have queried DB
    expect(afterDel["a1"]).toBeUndefined();
  });

  it("invalidates cache on config_reload pub/sub event", async () => {
    await setModelAlias("pubsub-alias", "val-1");
    await getModelAliases(); // Warm cache

    // Directly mutate DB row bypassing repo
    db.run(
      "UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?",
      [JSON.stringify("val-updated-by-other-process"), "pubsub-alias"]
    );

    // Without event, cache still returns cached val-1
    queryCount = 0;
    const cached = await getModelAliases();
    expect(queryCount).toBe(0);
    expect(cached["pubsub-alias"]).toBe("val-1");

    // Publish config_reload event
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "aliases",
      timestamp: Date.now(),
    });

    // Next read re-reads from DB
    queryCount = 0;
    const fresh = await getModelAliases();
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh["pubsub-alias"]).toBe("val-updated-by-other-process");
  });

  it("re-reads from DB after 5s hard TTL expires", async () => {
    await setModelAlias("ttl-alias", "ttl-v1");
    await getModelAliases(); // Warm cache

    // Directly mutate DB
    db.run(
      "UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?",
      [JSON.stringify("ttl-v2"), "ttl-alias"]
    );

    // Time travel: forward 5001 ms
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5001;
      queryCount = 0;
      const expired = await getModelAliases();
      expect(queryCount).toBeGreaterThan(0);
      expect(expired["ttl-alias"]).toBe("ttl-v2");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("model-info-cache: getComboByName", () => {
  it("caches getComboByName across repeated reads within 5s TTL", async () => {
    const combo = await createCombo({ name: "combo-perf-1", models: ["openai/m1", "anthropic/m2"] });
    queryCount = 0;

    const first = await getComboByName("combo-perf-1");
    expect(first.id).toBe(combo.id);
    expect(queryCount).toBeGreaterThan(0);

    const qBefore = queryCount;
    const second = await getComboByName("combo-perf-1");
    expect(second.id).toBe(combo.id);
    expect(queryCount - qBefore).toBe(0); // Zero queries on hit
  });

  it("caches negative results (absent combo) and invalidates on create", async () => {
    queryCount = 0;
    const missingFirst = await getComboByName("non-existent-combo-xyz");
    expect(missingFirst).toBeNull();
    expect(queryCount).toBeGreaterThan(0);

    const qBefore = queryCount;
    const missingSecond = await getComboByName("non-existent-combo-xyz");
    expect(missingSecond).toBeNull();
    expect(queryCount - qBefore).toBe(0); // Zero queries on negative cache hit

    // Create the combo now -> negative cache must be invalidated
    const created = await createCombo({ name: "non-existent-combo-xyz", models: ["m1"] });
    queryCount = 0;
    const found = await getComboByName("non-existent-combo-xyz");
    expect(queryCount).toBeGreaterThan(0);
    expect(found).not.toBeNull();
    expect(found.id).toBe(created.id);
  });

  it("returns cloned data so mutations cannot poison cache", async () => {
    await createCombo({ name: "combo-clone-test", models: ["m1", "m2"] });
    const first = await getComboByName("combo-clone-test");
    first.models.push("poison-model");

    const second = await getComboByName("combo-clone-test");
    expect(second.models).toEqual(["m1", "m2"]);
  });

  it("invalidates cache on updateCombo and deleteCombo", async () => {
    const combo = await createCombo({ name: "combo-crud-test", models: ["m1"] });
    await getComboByName("combo-crud-test"); // Warm cache

    // Update
    await updateCombo(combo.id, { models: ["m1", "m2-updated"] });
    queryCount = 0;
    const updated = await getComboByName("combo-crud-test");
    expect(queryCount).toBeGreaterThan(0);
    expect(updated.models).toEqual(["m1", "m2-updated"]);

    // Delete
    await deleteCombo(combo.id);
    queryCount = 0;
    const deleted = await getComboByName("combo-crud-test");
    expect(queryCount).toBeGreaterThan(0);
    expect(deleted).toBeNull();
  });

  it("invalidates cache on config_reload pub/sub event", async () => {
    const combo = await createCombo({ name: "combo-pubsub-test", models: ["original"] });
    await getComboByName("combo-pubsub-test"); // Warm cache

    // Direct DB update
    db.run(
      "UPDATE combos SET models = ? WHERE id = ?",
      [JSON.stringify(["cross-replica-updated"]), combo.id]
    );

    // Cache hit before event
    queryCount = 0;
    const cached = await getComboByName("combo-pubsub-test");
    expect(queryCount).toBe(0);
    expect(cached.models).toEqual(["original"]);

    // Publish config_reload
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "combos",
      timestamp: Date.now(),
    });

    // Re-reads after event
    queryCount = 0;
    const fresh = await getComboByName("combo-pubsub-test");
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh.models).toEqual(["cross-replica-updated"]);
  });

  it("re-reads from DB after 5s hard TTL expires", async () => {
    const combo = await createCombo({ name: "combo-ttl-test", models: ["v1"] });
    await getComboByName("combo-ttl-test"); // Warm cache

    // Direct DB update
    db.run(
      "UPDATE combos SET models = ? WHERE id = ?",
      [JSON.stringify(["v2"]), combo.id]
    );

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5001;
      queryCount = 0;
      const fresh = await getComboByName("combo-ttl-test");
      expect(queryCount).toBeGreaterThan(0);
      expect(fresh.models).toEqual(["v2"]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("model-info-cache: getProviderNodes (keyed by type)", () => {
  it("caches getProviderNodes keyed by type within 5s TTL", async () => {
    await createProviderNode({ type: "openai", name: "Node OpenAI", baseUrl: "https://api.openai.test" });
    await createProviderNode({ type: "claude", name: "Node Claude", baseUrl: "https://api.claude.test" });
    queryCount = 0;

    const first = await getProviderNodes({ type: "openai" });
    expect(first.length).toBe(1);
    expect(first[0].name).toBe("Node OpenAI");
    expect(queryCount).toBeGreaterThan(0);

    const qBefore = queryCount;
    const second = await getProviderNodes({ type: "openai" });
    expect(second.length).toBe(1);
    expect(queryCount - qBefore).toBe(0); // Zero queries on hit
  });

  it("caches getProviderNodes with no filter separately from filtered", async () => {
    queryCount = 0;
    const allFirst = await getProviderNodes({});
    expect(queryCount).toBeGreaterThan(0);

    const qBefore = queryCount;
    const allSecond = await getProviderNodes({});
    expect(queryCount - qBefore).toBe(0); // Zero queries on hit
  });

  it("returns cloned data so mutations cannot poison cache", async () => {
    const first = await getProviderNodes({ type: "openai" });
    first.push({ id: "fake", name: "fake-node" });
    if (first[0]) first[0].name = "poisoned-name";

    const second = await getProviderNodes({ type: "openai" });
    expect(second.find((n) => n.id === "fake")).toBeUndefined();
    if (second[0]) expect(second[0].name).not.toBe("poisoned-name");
  });

  it("invalidates cache on createProviderNode, updateProviderNode, deleteProviderNode", async () => {
    const node = await createProviderNode({ type: "custom-t", name: "Custom 1", baseUrl: "http://test" });
    await getProviderNodes({ type: "custom-t" }); // Warm cache

    // Update
    await updateProviderNode(node.id, { name: "Custom 1 Updated" });
    queryCount = 0;
    const updated = await getProviderNodes({ type: "custom-t" });
    expect(queryCount).toBeGreaterThan(0);
    expect(updated[0].name).toBe("Custom 1 Updated");

    // Delete
    await deleteProviderNode(node.id);
    queryCount = 0;
    const deleted = await getProviderNodes({ type: "custom-t" });
    expect(queryCount).toBeGreaterThan(0);
    expect(deleted.length).toBe(0);
  });

  it("invalidates cache on config_reload pub/sub event", async () => {
    const node = await createProviderNode({ type: "reload-t", name: "Node Original" });
    await getProviderNodes({ type: "reload-t" }); // Warm cache

    // Direct DB update
    db.run("UPDATE providerNodes SET name = ? WHERE id = ?", ["Node Altered", node.id]);

    queryCount = 0;
    const cached = await getProviderNodes({ type: "reload-t" });
    expect(queryCount).toBe(0);
    expect(cached[0].name).toBe("Node Original");

    // Publish event
    publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
      scope: "nodes",
      timestamp: Date.now(),
    });

    queryCount = 0;
    const fresh = await getProviderNodes({ type: "reload-t" });
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh[0].name).toBe("Node Altered");
  });

  it("re-reads from DB after 5s hard TTL expires", async () => {
    const node = await createProviderNode({ type: "ttl-t", name: "TTL Node v1" });
    await getProviderNodes({ type: "ttl-t" }); // Warm cache

    // Direct DB update
    db.run("UPDATE providerNodes SET name = ? WHERE id = ?", ["TTL Node v2", node.id]);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5001;
      queryCount = 0;
      const fresh = await getProviderNodes({ type: "ttl-t" });
      expect(queryCount).toBeGreaterThan(0);
      expect(fresh[0].name).toBe("TTL Node v2");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("security: auth and API keys MUST NOT be cached across requests", () => {
  it("rejects revoked, expired or deleted API keys immediately on the very next check (fail-closed, 0 staleness)", async () => {
    const keyRecord = await createApiKey("key-no-cache-test", "test-machine-id");
    expect(keyRecord?.key).toBeDefined();

    // 1. Initial valid key -> passes, queries DB
    queryCount = 0;
    const validFirst = await validateApiKey(keyRecord.key);
    expect(validFirst).toBe(true);
    expect(queryCount).toBe(1);

    // 2. Second read -> MUST STILL query DB (never cached across requests!)
    queryCount = 0;
    const validSecond = await validateApiKey(keyRecord.key);
    expect(validSecond).toBe(true);
    expect(queryCount).toBe(1); // Crucial security invariant: queries DB every time

    // 3. Deactivate/revoke key
    await updateApiKey(keyRecord.id, { isActive: false });
    queryCount = 0;
    const revoked = await validateApiKey(keyRecord.key);
    expect(revoked).toBe(false); // Rejected immediately on the next request!
    expect(queryCount).toBe(1);

    // 4. Re-activate key
    await updateApiKey(keyRecord.id, { isActive: true });
    queryCount = 0;
    const reactivated = await validateApiKey(keyRecord.key);
    expect(reactivated).toBe(true);
    expect(queryCount).toBe(1);

    // 5. Delete key
    await deleteApiKey(keyRecord.id);
    queryCount = 0;
    const deleted = await validateApiKey(keyRecord.key);
    expect(deleted).toBe(false);
    expect(queryCount).toBe(1);
  });
});

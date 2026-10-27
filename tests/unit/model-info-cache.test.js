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
const originalAllowTemp = process.env.DATA_DIR_ALLOW_TEMP;
let tempDir;
let db;
let queryCount = 0;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-model-info-cache-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.DATA_DIR_ALLOW_TEMP = "1";
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
  if (originalAllowTemp === undefined) delete process.env.DATA_DIR_ALLOW_TEMP;
  else process.env.DATA_DIR_ALLOW_TEMP = originalAllowTemp;
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

  it("clears aliases cache when invalidateAliasesCache is called explicitly", async () => {
    await setModelAlias("exp-alias", "m1");
    await getModelAliases(); // Warm cache
    db.run("UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?", [JSON.stringify("m2"), "exp-alias"]);
    invalidateAliasesCache();
    queryCount = 0;
    const fresh = await getModelAliases();
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh["exp-alias"]).toBe("m2");
  });

  it("invalidates cache on config_reload pub/sub event for aliases, settings, and all scopes", async () => {
    await setModelAlias("pubsub-alias", "val-1");
    await getModelAliases(); // Warm cache

    for (const scope of ["aliases", "settings", "all"]) {
      db.run(
        "UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?",
        [JSON.stringify(`val-${scope}`), "pubsub-alias"]
      );

      // Cache hit before event
      queryCount = 0;
      const cached = await getModelAliases();
      expect(queryCount).toBe(0);

      // Publish config_reload event with scope
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope,
        timestamp: Date.now(),
      });

      // Next read re-reads from DB
      queryCount = 0;
      const fresh = await getModelAliases();
      expect(queryCount).toBeGreaterThan(0);
      expect(fresh["pubsub-alias"]).toBe(`val-${scope}`);
    }
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

  it("clears combos cache when invalidateCombosCache is called explicitly", async () => {
    const combo = await createCombo({ name: "combo-exp-test", models: ["m1"] });
    await getComboByName("combo-exp-test"); // Warm cache
    db.run("UPDATE combos SET models = ? WHERE id = ?", [JSON.stringify(["m2"]), combo.id]);
    invalidateCombosCache();
    queryCount = 0;
    const fresh = await getComboByName("combo-exp-test");
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh.models).toEqual(["m2"]);
  });

  it("invalidates cache on config_reload pub/sub event for combos, settings, and all scopes", async () => {
    const combo = await createCombo({ name: "combo-pubsub-test", models: ["original"] });
    await getComboByName("combo-pubsub-test"); // Warm cache

    for (const scope of ["combos", "settings", "all"]) {
      db.run(
        "UPDATE combos SET models = ? WHERE id = ?",
        [JSON.stringify([`updated-${scope}`]), combo.id]
      );

      // Cache hit before event
      queryCount = 0;
      const cached = await getComboByName("combo-pubsub-test");
      expect(queryCount).toBe(0);

      // Publish config_reload
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope,
        timestamp: Date.now(),
      });

      // Re-reads after event
      queryCount = 0;
      const fresh = await getComboByName("combo-pubsub-test");
      expect(queryCount).toBeGreaterThan(0);
      expect(fresh.models).toEqual([`updated-${scope}`]);
    }
  });

  it("bounds comboByNameCache to 512 entries with oldest-key eviction", async () => {
    // Fill cache with 512 distinct absent combo names
    for (let i = 0; i < 512; i++) {
      await getComboByName(`absent-model-${i}`);
    }

    // Key 'absent-model-0' is currently cached (hit -> 0 queries)
    queryCount = 0;
    const hitOldest = await getComboByName("absent-model-0");
    expect(hitOldest).toBeNull();
    expect(queryCount).toBe(0);

    // Now insert a 513th unique key to trigger eviction of the oldest entry
    queryCount = 0;
    await getComboByName("absent-model-512");
    expect(queryCount).toBe(1);

    // Insert 512 more entries to ensure key 0 is definitely evicted
    for (let i = 513; i < 1025; i++) {
      await getComboByName(`absent-model-${i}`);
    }

    // Now querying absent-model-0 must be a cache miss and query SQLite
    queryCount = 0;
    const evicted = await getComboByName("absent-model-0");
    expect(evicted).toBeNull();
    expect(queryCount).toBe(1); // Evicted! Queried DB again
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

  it("clears nodes cache when invalidateNodesCache is called explicitly", async () => {
    const node = await createProviderNode({ type: "node-exp-t", name: "Node Original" });
    await getProviderNodes({ type: "node-exp-t" }); // Warm cache
    db.run("UPDATE providerNodes SET name = ? WHERE id = ?", ["Node Altered", node.id]);
    invalidateNodesCache();
    queryCount = 0;
    const fresh = await getProviderNodes({ type: "node-exp-t" });
    expect(queryCount).toBeGreaterThan(0);
    expect(fresh[0].name).toBe("Node Altered");
  });

  it("invalidates cache on config_reload pub/sub event for nodes, settings, and all scopes", async () => {
    const node = await createProviderNode({ type: "reload-t", name: "Node Original" });
    await getProviderNodes({ type: "reload-t" }); // Warm cache

    for (const scope of ["nodes", "settings", "all"]) {
      // Direct DB update
      db.run("UPDATE providerNodes SET name = ?", [`Node Altered ${scope}`]);

      queryCount = 0;
      const cached = await getProviderNodes({ type: "reload-t" });
      expect(queryCount).toBe(0);

      // Publish event
      publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, {
        scope,
        timestamp: Date.now(),
      });

      queryCount = 0;
      const fresh = await getProviderNodes({ type: "reload-t" });
      expect(queryCount).toBeGreaterThan(0);
      expect(fresh[0].name).toBe(`Node Altered ${scope}`);
    }
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

// TOCTOU regression: a read whose SELECT ran before a write+invalidation must not
// store its pre-write rows in the cache. DB calls are synchronous, so the write is
// interleaved inside the read: the hook runs the real SELECT (capturing old rows),
// performs the write and invalidation, then returns the old rows. The repo then
// stores (buggy) or skips (fixed) them, and the next read must see the new value.
function interleaveWriteDuringRead(method, sqlFragment, onRead) {
  const orig = db[method];
  let fired = false;
  db[method] = (sql, ...args) => {
    const res = orig(sql, ...args);
    if (!fired && String(sql).includes(sqlFragment)) {
      fired = true;
      onRead();
    }
    return res;
  };
  return () => { db[method] = orig; };
}

describe("TOCTOU: in-flight read must not repopulate cache with pre-write data", () => {
  it("aliasRepo: read interleaved with write+invalidate does not cache stale value", async () => {
    await setModelAlias("toctou-alias", "old-target");
    invalidateAliasesCache();

    const restore = interleaveWriteDuringRead("all", "SELECT key, value FROM kv WHERE scope = ?", () => {
      db.run("UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?", [JSON.stringify("new-target"), "toctou-alias"]);
      invalidateAliasesCache();
    });
    try {
      const inFlight = await getModelAliases();
      expect(inFlight["toctou-alias"]).toBe("old-target"); // interleave proof: read saw pre-write rows
    } finally {
      restore();
    }

    const next = await getModelAliases();
    expect(next["toctou-alias"]).toBe("new-target");
  });

  it("combosRepo: read interleaved with write+invalidate does not cache stale value", async () => {
    const combo = await createCombo({ name: "toctou-combo", models: ["openai/old"] });
    invalidateCombosCache();

    const restore = interleaveWriteDuringRead("get", "FROM combos WHERE name", () => {
      db.run("UPDATE combos SET models = ? WHERE id = ?", [JSON.stringify(["openai/new"]), combo.id]);
      invalidateCombosCache();
    });
    try {
      const inFlight = await getComboByName("toctou-combo");
      expect(inFlight.models).toEqual(["openai/old"]); // interleave proof
    } finally {
      restore();
    }

    const next = await getComboByName("toctou-combo");
    expect(next.models).toEqual(["openai/new"]);
  });

  it("nodesRepo: read interleaved with write+invalidate does not cache stale value", async () => {
    const node = await createProviderNode({ id: "toctou-node", type: "toctou-t", name: "Old" });
    invalidateNodesCache();

    const restore = interleaveWriteDuringRead("all", "FROM providerNodes", () => {
      db.run("UPDATE providerNodes SET name = ? WHERE id = ?", ["New", node.id]);
      invalidateNodesCache();
    });
    try {
      const inFlight = await getProviderNodes({ type: "toctou-t" });
      expect(inFlight[0].name).toBe("Old"); // interleave proof
    } finally {
      restore();
    }

    const next = await getProviderNodes({ type: "toctou-t" });
    expect(next[0].name).toBe("New");
  });
});

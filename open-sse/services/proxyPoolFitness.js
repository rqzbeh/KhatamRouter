// Durable proxy-pool fitness registry.
// Scope format: `provider::model` (for example `freebuff::openai/gpt-5`).
// The map is a read-through cache; fail-open when persistence is unavailable.

const FITNESS_STATE_KEY = "__9routerPoolFitness__";
const fitness = (globalThis[FITNESS_STATE_KEY] ??= new Map());

export const POOL_UNFIT_MS = 5 * 60 * 1000;

function setPoolFitness(poolId, entries) {
  if (entries.length) fitness.set(poolId, new Map(entries.map((entry) => [entry.scope, { until: entry.until, reason: entry.reason || "" }])));
  else fitness.delete(poolId);
}

function entriesFromMap(poolId) {
  const byScope = fitness.get(poolId);
  return byScope ? [...byScope.entries()].map(([scope, entry]) => ({ poolId, scope, ...entry })) : [];
}

function updateCachedFitness(poolId, scope, until, reason = "") {
  const byScope = fitness.get(poolId) || new Map();
  byScope.set(scope, { until, reason });
  fitness.set(poolId, byScope);
}

export async function loadPoolFitness(poolId) {
  if (!poolId) return;
  // In-memory fallback is active
}

export async function markPoolUnfit(poolId, scope, until = Date.now() + POOL_UNFIT_MS, reason = "") {
  if (!poolId || !scope || !Number.isFinite(until)) return false;
  try {
    updateCachedFitness(poolId, scope, until, reason);
    return true;
  } catch {
    return false;
  }
}

export async function clearPoolUnfit(poolId, scope) {
  if (!poolId || !scope) return false;
  try {
    const byScope = fitness.get(poolId);
    if (byScope) {
      byScope.delete(scope);
      if (byScope.size === 0) fitness.delete(poolId);
    }
    return true;
  } catch {
    return false;
  }
}

function providerWildcardScope(scope) {
  const sep = String(scope || "").indexOf("::");
  if (sep < 0) return null;
  return `${scope.slice(0, sep)}::*`;
}

export function isPoolFit(poolId, scope, now = Date.now()) {
  if (!poolId) return true;
  const byScope = fitness.get(poolId);
  if (!byScope) return true;
  for (const key of [scope, providerWildcardScope(scope)]) {
    if (!key) continue;
    const entry = byScope.get(key);
    if (!entry) continue;
    if (entry.until <= now) {
      byScope.delete(key);
      if (byScope.size === 0) fitness.delete(poolId);
      continue;
    }
    return false;
  }
  return true;
}

export function fitPoolIds(poolIds, scope, now = Date.now()) {
  return (poolIds || []).filter((id) => isPoolFit(id, scope, now));
}

export async function clearAllPoolUnfit(provider = null) {
  try {
    if (!provider) fitness.clear();
    else {
      const prefix = `${provider}::`;
      for (const [poolId, byScope] of fitness) {
        for (const scope of [...byScope.keys()]) if (scope.startsWith(prefix)) byScope.delete(scope);
        if (!byScope.size) fitness.delete(poolId);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function resetPoolFitness() {
  try {
    fitness.clear();
    return true;
  } catch {
    return false;
  }
}

export async function pruneExpired(now = Date.now()) {
  let count = 0;
  for (const [poolId, byScope] of fitness) {
    for (const [scope, entry] of byScope) {
      if (entry.until <= now) {
        byScope.delete(scope);
        count++;
      }
    }
    if (!byScope.size) fitness.delete(poolId);
  }
  return count;
}

export async function poolFitnessSnapshot(now = Date.now()) {
  const out = {};
  for (const [poolId, byScope] of fitness) {
    for (const [scope, entry] of byScope) {
      if (entry.until > now) {
        out[poolId] = out[poolId] || {};
        out[poolId][scope] = { until: entry.until, reason: entry.reason || "" };
      }
    }
  }
  return out;
}

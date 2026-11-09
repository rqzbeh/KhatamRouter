// Order is the render order: the two managed daemons first (they are the ones
// a user should reach for), then the free feeds, then everything hand-made.
export const GROUP_LABELS = Object.freeze({
  psiphon: "Psiphon rotating tunnel",
  opencode2api: "WARP rotating egress (opencode2api)",
  oneproxy: "1proxy (free feed)",
  proxifly: "Proxifly (free feed)",
  iplocate: "IPLocate (free feed)",
  manual: "Manual / relay pools",
});

export function poolSourceKey(pool) {
  if (!pool || typeof pool !== "object") {
    return "manual";
  }
  const source = pool.provenance?.source || pool.data?.provenance?.source;
  if (typeof source === "string" && source.startsWith("free:")) {
    const name = source.slice(5).trim();
    if (name) return name;
  }
  const type = pool.type;
  if (type === "psiphon" || type === "opencode2api") {
    return type;
  }
  return "manual";
}

export function groupPools(pools) {
  if (!Array.isArray(pools)) return [];

  const groupsByKey = new Map();
  for (const key of Object.keys(GROUP_LABELS)) {
    groupsByKey.set(key, []);
  }

  for (const pool of pools) {
    let key = poolSourceKey(pool);
    if (!groupsByKey.has(key)) {
      key = "manual";
    }
    groupsByKey.get(key).push(pool);
  }

  const result = [];
  for (const [key, groupPoolsList] of groupsByKey.entries()) {
    if (groupPoolsList.length > 0) {
      const sortedPools = groupPoolsList.slice().sort((a, b) => {
        const nameA = a?.name || "";
        const nameB = b?.name || "";
        return nameA.localeCompare(nameB);
      });
      result.push({
        key,
        label: GROUP_LABELS[key],
        pools: sortedPools,
      });
    }
  }

  return result;
}

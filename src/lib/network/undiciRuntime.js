/**
 * Resolves the real npm `undici` implementation at runtime.
 *
 * Under Bun, `import { fetch } from "undici"` can resolve to Bun's native
 * fetch export (a `[native code]` stub). That stub accepts `dispatcher` but
 * IGNORES it and goes out on the host's own socket, so a proxy-backed request
 * silently succeeds even when the proxy is dead. Anything that must actually
 * use a `ProxyAgent` (pool health tests, latency probes) has to load the
 * package entry point instead.
 *
 * `undici/index.js` is the npm package's own entry (8.x). Fall back to the bare
 * specifier if that file ever disappears.
 */

let cached = null;

function looksNative(fn) {
  try {
    return typeof fn === "function" && fn.toString().includes("[native code]");
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ ProxyAgent: any, fetch: any, Agent: any, request: any }>}
 */
export async function loadRealUndici() {
  if (cached) return cached;

  let mod = null;
  try {
    mod = await import("undici/index.js");
  } catch {
    mod = null;
  }

  // A proxy dispatcher is only meaningful if `fetch` honors it.
  if (!mod || !mod.ProxyAgent || looksNative(mod.fetch)) {
    const pkg = await import("undici");
    if (!mod) mod = pkg;
  }

  cached = mod;
  return cached;
}

/** Test hook: drop the resolved module. */
export function __resetRealUndiciForTests() {
  cached = null;
}

/**
 * True when the resolved `fetch` honors a `dispatcher`. Exposed so tests can
 * pin the Bun-native-stub regression instead of re-deriving it.
 */
export function fetchHonorsDispatcher(fetchFn) {
  return !looksNative(fetchFn);
}
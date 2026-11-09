import { getProxyPoolById } from "@/models";
import {
  isPsiphonPool,
  ensureTunnel,
  PsiphonUnavailableError,
} from "@/lib/network/psiphon/psiphonManager.js";
import {
  isOpencodeSidecarPool,
  ensureSidecar,
} from "@/lib/network/opencode2api/sidecarManager.js";
import {
  MANAGED_SIDECAR_URL,
  MANAGED_SIDECAR_POOL_ID,
} from "@/lib/network/opencode2api/config.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      let proxyPool = await getProxyPoolById(proxyPoolId);

      // The WARP provider (opencode-warp) binds a virtual pool id and no row
      // exists for it. Synthesize the managed pool so the sidecar branch below
      // runs. Without this a deleted/never-created row falls through to
      // source:"none" and the request egresses over the server IP — the one
      // real leak this lane exists to prevent.
      if (!proxyPool && proxyPoolId === MANAGED_SIDECAR_POOL_ID) {
        proxyPool = {
          id: proxyPoolId,
          type: "opencode2api",
          proxyUrl: MANAGED_SIDECAR_URL,
          isActive: true,
          strictProxy: true,
          data: {},
        };
      }

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isPsiphon = isPsiphonPool(proxyPool);
      const isSidecar = isOpencodeSidecarPool(proxyPool);
      poolStrictProxy = isPsiphon || isSidecar || proxyPool?.strictProxy === true;

      if (isSidecar) {
        // Managed loopback daemon, strict by construction: it either serves the
        // request or the request fails closed (never the server's own IP).
        if (proxyPool?.isActive === true) {
          try {
            const sidecar = await ensureSidecar(proxyPool);
            return {
              source: "opencode2api",
              proxyPoolId,
              proxyPool,
              connectionProxyEnabled: false,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              strictProxy: true,
              opencodeSidecarPoolId: proxyPoolId,
              opencodeSidecarUrl: sidecar.proxyUrl,
              opencodeSidecarKey: sidecar.apiKey,
              opencodeSidecarGeneration: sidecar.generation,
            };
          } catch (err) {
            return {
              source: "opencode2api",
              proxyPoolId,
              proxyPool,
              connectionProxyEnabled: false,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              strictProxy: true,
              opencodeSidecarPoolId: proxyPoolId,
              opencodeSidecarUrl: "",
              opencodeSidecarKey: "",
              opencodeSidecarGeneration: -1,
              opencodeSidecarUnavailable: true,
              error: err,
            };
          }
        }

        // Inactive sidecar pool fails closed, exactly like psiphon.
        return {
          source: "opencode2api",
          proxyPoolId,
          proxyPool,
          connectionProxyEnabled: false,
          connectionProxyUrl: "",
          connectionNoProxy: noProxy,
          strictProxy: true,
          opencodeSidecarPoolId: proxyPoolId,
          opencodeSidecarUrl: "",
          opencodeSidecarKey: "",
          opencodeSidecarGeneration: -1,
          opencodeSidecarUnavailable: true,
        };
      }

      if (isPsiphon) {
        if (proxyPool?.isActive === true) {
          try {
            const tunnel = await ensureTunnel(proxyPool);
            return {
              source: "pool",
              proxyPoolId,
              proxyPool,
              connectionProxyEnabled: true,
              connectionProxyUrl: tunnel.proxyUrl,
              connectionNoProxy: noProxy,
              strictProxy: true,
              psiphonPoolId: proxyPoolId,
              psiphonGeneration: tunnel.generation,
            };
          } catch (err) {
            // Fail closed on PsiphonUnavailableError (or any establishment error):
            // return empty connectionProxyUrl with strictProxy: true so proxyAwareFetch throws
            return {
              source: "pool",
              proxyPoolId,
              proxyPool,
              connectionProxyEnabled: true,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              strictProxy: true,
              psiphonPoolId: proxyPoolId,
              psiphonGeneration: -1,
              psiphonUnavailable: true,
              error: err,
            };
          }
        }

        // Inactive psiphon pool fails closed
        return {
          source: "pool",
          proxyPoolId,
          proxyPool,
          connectionProxyEnabled: true,
          connectionProxyUrl: "",
          connectionNoProxy: noProxy,
          strictProxy: true,
          psiphonPoolId: proxyPoolId,
          psiphonGeneration: -1,
          psiphonUnavailable: true,
        };
      }

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

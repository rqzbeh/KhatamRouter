import { NextResponse } from "next/server";
import { isAuthenticated } from "@/dashboardGuard";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderNodes } from "@/models";
import {
  upsertCapabilityOverride,
  getCapabilityOverride,
  deleteCapabilityOverride,
  getResolvedModelMetadata,
} from "@/lib/db/repos/modelMetadataRepo.js";
import {
  initializeOverrideCache,
  getOverrideSourcesSync,
  invalidateOverrideCache,
} from "@/lib/models/overrideCache.js";
import { resolveModelCapabilities } from "@/lib/models/capabilities.js";

export const dynamic = "force-dynamic";

const MAX_STRING_LENGTH = 256;
const MAX_LIMIT_VALUE = 10_000_000;

const ALLOWED_LIMIT_FIELDS = new Set(["contextWindow", "maxOutputTokens"]);
const ALLOWED_BOOLEAN_FIELDS = new Set([
  "supportsVision",
  "supportsTools",
  "supportsReasoning",
  "supportsAudio",
  "supportsVideo",
  "supportsStreaming",
  "supportsImageGeneration",
  "supportsImageEditing",
  "supportsWebSearch",
  "supportsWebFetch",
]);
const ALLOWED_OTHER_FIELDS = new Set(["reasoning", "thinkingFormat", "effortLevels"]);
const ALLOWED_REASONING_KEYS = new Set(["supported", "effortLevels"]);

function ensureRequestWithCookies(request) {
  if (request.cookies && typeof request.cookies.get === "function") {
    return request;
  }
  const cookieHeader = request.headers?.get?.("cookie") || "";
  const cookieMap = new Map();
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const idx = pair.indexOf("=");
      if (idx !== -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        cookieMap.set(key, decodeURIComponent(val));
      }
    }
  }

  return new Proxy(request, {
    get(target, prop, receiver) {
      if (prop === "cookies") {
        return {
          get: (name) => {
            const val = cookieMap.get(name);
            return val !== undefined ? { name, value: val } : undefined;
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const EXTRA_PROVIDER_ALIASES = {
  nv: "nvidia",
};

/**
 * Validates and canonicalizes provider ID.
 * Returns canonical provider string if recognized, null otherwise.
 * Rejects mutable/noncanonical node.name; accepts exact node.id only.
 */
async function resolveAndValidateProvider(rawProvider) {
  if (!rawProvider || typeof rawProvider !== "string") return null;
  const p = rawProvider.trim();

  // 1. Built-in alias resolution: e.g. "nv" -> "nvidia", "ocg" -> "opencode-go"
  const canonical = EXTRA_PROVIDER_ALIASES[p] || resolveProviderAlias(p);
  if (PROVIDERS[canonical] || AI_PROVIDERS[canonical] || PROVIDERS[p] || AI_PROVIDERS[p]) {
    return canonical;
  }

  // 2. Custom provider node matching exact node.id only (rejects mutable node.name)
  try {
    const nodes = await getProviderNodes();
    if (Array.isArray(nodes)) {
      const match = nodes.find((n) => n.id === p);
      if (match) return match.id;
    }
  } catch {}

  return null;
}

function validateModelId(modelId) {
  if (
    typeof modelId !== "string" ||
    !modelId.trim() ||
    modelId.length > MAX_STRING_LENGTH ||
    /[\0\r\n]/.test(modelId)
  ) {
    return "Invalid modelId: must be non-empty string <= 256 characters";
  }
  return null;
}

function validateCapabilities(caps) {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return { error: "capabilities must be a valid JSON object" };
  }

  const clean = {};

  for (const [k, v] of Object.entries(caps)) {
    if (
      !ALLOWED_LIMIT_FIELDS.has(k) &&
      !ALLOWED_BOOLEAN_FIELDS.has(k) &&
      !ALLOWED_OTHER_FIELDS.has(k)
    ) {
      return { error: `Unknown field: ${k}` };
    }

    if (ALLOWED_LIMIT_FIELDS.has(k)) {
      if (v === null) {
        clean[k] = null;
      } else {
        // Strict integer check without coercion (rejects boolean, array, string)
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT_VALUE) {
          return { error: `${k} must be a positive integer <= 10,000,000` };
        }
        clean[k] = v;
      }
    } else if (ALLOWED_BOOLEAN_FIELDS.has(k)) {
      if (v !== null && typeof v !== "boolean") {
        return { error: `${k} must be a boolean or null` };
      }
      clean[k] = v;
    } else if (k === "reasoning") {
      if (v === null || typeof v === "boolean") {
        clean[k] = v;
      } else if (typeof v === "object" && !Array.isArray(v)) {
        // Reject unknown nested keys inside reasoning object
        for (const rk of Object.keys(v)) {
          if (!ALLOWED_REASONING_KEYS.has(rk)) {
            return { error: `Unknown field in reasoning: ${rk}` };
          }
        }
        if (typeof v.supported !== "boolean") {
          return { error: "reasoning.supported must be a boolean" };
        }
        const levels = [];
        if (v.effortLevels !== undefined && v.effortLevels !== null) {
          if (!Array.isArray(v.effortLevels)) {
            return { error: "reasoning.effortLevels must be an array of strings" };
          }
          if (v.effortLevels.length > 20) {
            return { error: "reasoning.effortLevels exceeds maximum of 20 levels" };
          }
          for (const lvl of v.effortLevels) {
            if (typeof lvl !== "string" || lvl.length > 64 || /[\0\r\n]/.test(lvl)) {
              return { error: "reasoning.effortLevels items must be clean strings <= 64 chars" };
            }
            levels.push(lvl.trim());
          }
        }
        clean[k] = { supported: v.supported, effortLevels: levels };
      } else {
        return { error: "reasoning must be boolean, null, or { supported, effortLevels }" };
      }
    } else if (k === "thinkingFormat") {
      if (v === null) {
        clean[k] = null;
      } else if (typeof v === "string") {
        if (v.length > 64 || /[\0\r\n]/.test(v)) {
          return { error: "thinkingFormat must be a string <= 64 characters" };
        }
        clean[k] = v.trim();
      } else {
        return { error: "thinkingFormat must be a string or null" };
      }
    } else if (k === "effortLevels") {
      if (v === null) {
        clean[k] = null;
      } else if (Array.isArray(v)) {
        if (v.length > 20) {
          return { error: "effortLevels exceeds maximum of 20 levels" };
        }
        clean[k] = v.map((lvl) => {
          if (typeof lvl !== "string" || lvl.length > 64) {
            throw new Error("effortLevels items must be strings <= 64 characters");
          }
          return lvl.trim();
        });
      } else {
        return { error: "effortLevels must be an array of strings or null" };
      }
    }
  }

  return { clean };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/models/overrides?provider=x&modelId=y
 */
export async function GET(request) {
  try {
    const authed = await isAuthenticated(ensureRequestWithCookies(request));
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const rawProvider = searchParams.get("provider");
    const rawModelId = searchParams.get("modelId") || searchParams.get("model");

    if (!rawProvider || typeof rawProvider !== "string" || !rawProvider.trim() || rawProvider.length > MAX_STRING_LENGTH) {
      return NextResponse.json({ error: "Invalid provider parameter" }, { status: 400 });
    }

    const modelErr = validateModelId(rawModelId);
    if (modelErr) {
      return NextResponse.json({ error: modelErr }, { status: 400 });
    }

    const canonicalProvider = await resolveAndValidateProvider(rawProvider);
    if (!canonicalProvider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const normModelId = rawModelId.trim();

    await initializeOverrideCache();
    const sources = getOverrideSourcesSync();
    const resolved = resolveModelCapabilities(
      { provider: canonicalProvider, model: normModelId },
      sources
    );

    // Fetch stored metadata for extended fields not in core resolver
    let storedMeta = null;
    try {
      storedMeta = await getResolvedModelMetadata({ provider: canonicalProvider, modelId: normModelId });
    } catch {}

    const capabilities = {
      contextWindow: resolved.contextWindow,
      maxOutputTokens: resolved.maxOutputTokens,
      supportsVision: resolved.supportsVision,
      supportsTools: resolved.supportsTools,
      supportsReasoning: resolved.supportsReasoning,
      supportsAudio: resolved.supportsAudio,
      supportsVideo: resolved.supportsVideo,
      supportsStreaming: resolved.supportsStreaming,
      thinkingFormat: resolved.thinkingFormat || null,
      // Extended fields surfaced from metadata
      supportsImageGeneration: storedMeta?.capabilities?.supportsImageGeneration ?? null,
      supportsImageEditing: storedMeta?.capabilities?.supportsImageEditing ?? null,
      supportsWebSearch: storedMeta?.capabilities?.supportsWebSearch ?? null,
      supportsWebFetch: storedMeta?.capabilities?.supportsWebFetch ?? null,
    };

    if (resolved.effortLevels) {
      capabilities.effortLevels = resolved.effortLevels;
    }

    let manualCaps = null;
    try {
      const manualRow = await getCapabilityOverride({
        provider: canonicalProvider,
        modelId: normModelId,
        source: "manual",
      });
      if (manualRow && manualRow.capabilities) {
        manualCaps = manualRow.capabilities;
      }
    } catch {}

    return NextResponse.json({
      provider: canonicalProvider,
      modelId: normModelId,
      capabilities,
      manual: manualCaps,
      provenance: resolved.provenance,
      source: resolved.source,
    });
  } catch (error) {
    console.error("[api/models/overrides] GET error:", error.message);
    return NextResponse.json({ error: "Failed to retrieve capability overrides" }, { status: 500 });
  }
}

/**
 * POST /api/models/overrides - Patch/merge manual capability overrides
 */
export async function POST(request) {
  try {
    const authed = await isAuthenticated(ensureRequestWithCookies(request));
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { provider: rawProvider, modelId: rawModelId, capabilities } = body;

    if (!rawProvider || typeof rawProvider !== "string" || !rawProvider.trim() || rawProvider.length > MAX_STRING_LENGTH) {
      return NextResponse.json({ error: "Invalid provider parameter" }, { status: 400 });
    }

    const modelErr = validateModelId(rawModelId);
    if (modelErr) {
      return NextResponse.json({ error: modelErr }, { status: 400 });
    }

    const canonicalProvider = await resolveAndValidateProvider(rawProvider);
    if (!canonicalProvider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const normModelId = rawModelId.trim();

    const { clean, error: valErr } = validateCapabilities(capabilities);
    if (valErr) {
      return NextResponse.json({ error: valErr }, { status: 400 });
    }

    const record = await upsertCapabilityOverride({
      provider: canonicalProvider,
      modelId: normModelId,
      capabilities: clean,
      source: "manual",
      replace: false,
    });

    invalidateOverrideCache();

    return NextResponse.json({
      success: true,
      provider: canonicalProvider,
      modelId: normModelId,
      capabilities: record.capabilities,
      source: "manual",
    });
  } catch (error) {
    console.error("[api/models/overrides] POST error:", error.message);
    return NextResponse.json({ error: "Failed to save capability override" }, { status: 500 });
  }
}

/**
 * PUT /api/models/overrides - Atomically replace all manual capability overrides
 */
export async function PUT(request) {
  try {
    const authed = await isAuthenticated(ensureRequestWithCookies(request));
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { provider: rawProvider, modelId: rawModelId, capabilities } = body;

    if (!rawProvider || typeof rawProvider !== "string" || !rawProvider.trim() || rawProvider.length > MAX_STRING_LENGTH) {
      return NextResponse.json({ error: "Invalid provider parameter" }, { status: 400 });
    }

    const modelErr = validateModelId(rawModelId);
    if (modelErr) {
      return NextResponse.json({ error: modelErr }, { status: 400 });
    }

    const canonicalProvider = await resolveAndValidateProvider(rawProvider);
    if (!canonicalProvider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const normModelId = rawModelId.trim();

    const { clean, error: valErr } = validateCapabilities(capabilities);
    if (valErr) {
      return NextResponse.json({ error: valErr }, { status: 400 });
    }

    const record = await upsertCapabilityOverride({
      provider: canonicalProvider,
      modelId: normModelId,
      capabilities: clean,
      source: "manual",
      replace: true,
    });

    invalidateOverrideCache();

    return NextResponse.json({
      success: true,
      provider: canonicalProvider,
      modelId: normModelId,
      capabilities: record.capabilities,
      source: "manual",
    });
  } catch (error) {
    console.error("[api/models/overrides] PUT error:", error.message);
    return NextResponse.json({ error: "Failed to update capability override" }, { status: 500 });
  }
}

/**
 * DELETE /api/models/overrides - Delete manual capability override
 */
export async function DELETE(request) {
  try {
    const authed = await isAuthenticated(ensureRequestWithCookies(request));
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    let rawProvider = searchParams.get("provider");
    let rawModelId = searchParams.get("modelId") || searchParams.get("model");

    if (!rawProvider || !rawModelId) {
      const body = await request.json().catch(() => ({}));
      rawProvider = rawProvider || body.provider;
      rawModelId = rawModelId || body.modelId || body.model;
    }

    if (!rawProvider || typeof rawProvider !== "string" || !rawProvider.trim() || rawProvider.length > MAX_STRING_LENGTH) {
      return NextResponse.json({ error: "Invalid provider parameter" }, { status: 400 });
    }

    const modelErr = validateModelId(rawModelId);
    if (modelErr) {
      return NextResponse.json({ error: modelErr }, { status: 400 });
    }

    const canonicalProvider = await resolveAndValidateProvider(rawProvider);
    if (!canonicalProvider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const normModelId = rawModelId.trim();

    const { deleted } = await deleteCapabilityOverride({
      provider: canonicalProvider,
      modelId: normModelId,
      source: "manual",
    });

    invalidateOverrideCache();

    return NextResponse.json({
      success: true,
      provider: canonicalProvider,
      modelId: normModelId,
      deleted,
    });
  } catch (error) {
    console.error("[api/models/overrides] DELETE error:", error.message);
    return NextResponse.json({ error: "Failed to delete capability override" }, { status: 500 });
  }
}

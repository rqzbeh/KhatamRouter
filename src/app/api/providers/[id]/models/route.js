import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderNodeById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { GEMINI_CONFIG, ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { assertGatewayUrlAllowed, fetchGateway, isGatewaySelfHostedAllowed, sanitizeGatewayError } from "@/lib/network/gatewayTrust.js";
import { refreshGoogleToken, refreshCodexToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveOllamaLocalHost } from "open-sse/config/providers.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { NOUS_MODELS_URL, normalizeNousModels } from "open-sse/services/nous.js";
import { ANTIGRAVITY_OAUTH_CLIENT } from "open-sse/providers/shared.js";
import codexProvider from "open-sse/providers/registry/codex.js";
import clineProvider from "open-sse/providers/registry/cline.js";
import antigravityProvider from "open-sse/providers/registry/antigravity.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  isSignalPresent,
  hasOpenAIPaginationSignal,
  evaluateOpenAIListing,
  validateCloudflareAccountId,
  mapCloudflareModelRow,
  validateAntigravityComplete,
  hasConfiguredProxyEgress,
  validateProxySupport,
  sanitizeNoKeys,
  MAX_PAGINATION_PAGES,
  MAX_PAGINATION_RECORDS,
  MAX_PAGINATION_DEADLINE_MS,
} from "@/lib/models/listingCompleteness.js";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

// Model discovery must identify as the same Codex CLI version as inference.
const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${codexProvider.transport.cliVersion}`;

const parseOpenAIStyleModels = (data) => {
  const list = Array.isArray(data)
    ? data
    : (data?.data || data?.models || data?.results || []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    if (!item || typeof item !== "object") return item;
    const id = item.id || item.name;
    if (!id) return item;
    return {
      ...item,
      id,
      name: item.name || id,
    };
  });
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models.map((item) => {
      if (!item || typeof item !== "object") return item;
      const id = item?.id || item?.model || item?.name;
      if (!id) return item;
      return { ...item, id, name: item?.displayName || item?.name || id, raw: item };
    });
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => {
        if (!id || typeof info !== "object" || info === null) return info;
        return {
          ...info,
          id,
          name: info?.displayName || info?.name || id,
          raw: info,
        };
      });
  }

  return [];
};

// Filter out inline tab-completion slots while keeping all real models
// (including those backed by MODEL_PLACEHOLDER_* upstream slots).
const parseAntigravityModels = (data) =>
  parseGeminiCliModels(data).filter((model) => !model?.id || typeof model.id !== "string" || !model.id.startsWith("tab_"));

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [model];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const normalized = { ...model, id, name };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  listingShape: "openai",
  parseResponse: parseOpenAIStyleModels
});

const normalizeRoutedNousModels = (data) => normalizeNousModels(data).map((model) => ({
  ...model,
  // Live upstream IDs include a vendor namespace (for example,
  // stepfun/step-5-preview:free). Prefix the owning 9router provider so Basic
  // Chat does not parse that namespace as the provider itself.
  id: `nous/${model.id}`,
  upstreamModelId: model.id,
}));

const getStaticProviderModels = (providerId) =>
  getModelsByProviderId(providerId).map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
  }));

// Every fetch a fetchFn performs must go through `timedFetch`: an unresponsive
// provider endpoint would otherwise hold the route handler open indefinitely.
// Same budget as the canonical fetchModelsFetcherIds helper. A timeout surfaces
// as an AbortError and takes the existing fall-to-static path.
const MODELS_FETCH_TIMEOUT_MS = 8000;
const timedFetch = (url, options = {}, proxyOptions = null, callerSignal = null) => {
  const fetchSignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)];
  if (callerSignal) fetchSignals.push(callerSignal);
  const signal = options.signal || AbortSignal.any(fetchSignals);
  return proxyAwareFetch(url, { ...options, signal }, proxyOptions);
};

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, validateComplete, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken, apiKey } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  const scrubKeys = [accessToken, refreshToken, apiKey].filter(Boolean);
  let warning;
  try {
    let response = await fetchFn(accessToken, connection);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection);
      }
    }
    if (response.ok) {
      const data = await response.json();
      const models = parseFn(data);
      const isComplete = typeof validateComplete === "function" ? Boolean(validateComplete(data)) : false;
      if (models.length > 0) return { models, complete: isComplete };
    } else {
      // Never log raw HTTP error body to prevent token reflection; record status only
      warning = `${errorLabel}: HTTP ${response.status}`;
      console.log(`${errorLabel} (falling back to static): HTTP ${response.status}`);
    }
  } catch (error) {
    const sanitizedMsg = sanitizeNoKeys(error.message, scrubKeys);
    warning = `${errorLabel}: ${sanitizedMsg}`;
    console.log(`${errorLabel} (falling back to static):`, sanitizedMsg);
  }
  return { models: [], complete: false, warning };
};

// Qoder shares one resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the connection's provider so qoderModels picks the right
// region's catalog endpoint, and the ids keep the provider prefix.
function buildQoderModelsResolver(providerId) {
  return {
    customResolver: async (connection) => {
      const credentials = {
        provider: providerId,
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData || {},
      };
      let warning;
      try {
        const result = await resolveQoderModels(credentials, { forceRefresh: true });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              // Use the canonical "<providerId>/<key>" id so the dashboard
              // surfaces the same identifier the chat router expects.
              id: `${providerId}/${m.id}`,
              name: m.name,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  };
}

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  muse: {
    url: "https://api.meta.ai/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json", "x-api-version": "1.0.0" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    listingShape: "openai",
    parseResponse: parseOpenAIStyleModels,
  },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    listingShape: "anthropic",
    parseResponse: (data) => data.data || []
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    listingShape: "gemini",
    parseResponse: (data) => data.models || []
  },
  codex: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshCodexToken(conn.refreshToken),
      fetchFn: (token) => timedFetch(CODEX_MODELS_URL, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
          "originator": "codex_cli_rs"
        }
      }),
      parseFn: parseCodexModels,
      errorLabel: "Failed to fetch Codex models"
    })
  },
  antigravity: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(
        conn.refreshToken,
        antigravityProvider.transport.clientId || ANTIGRAVITY_OAUTH_CLIENT.clientId,
        antigravityProvider.transport.clientSecret || ANTIGRAVITY_OAUTH_CLIENT.clientSecret
      ),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        return timedFetch(ANTIGRAVITY_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": antigravityProvider.transport.headers["User-Agent"]
          },
          body: JSON.stringify(projectId ? { project: projectId } : {})
        });
      },
      parseFn: parseAntigravityModels,
      validateComplete: validateAntigravityComplete,
      errorLabel: "Failed to fetch Antigravity models"
    })
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      // Filter out embeddings, non-chat models, and disabled models
      return data.data
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  nous: {
    ...createOpenAIModelsConfig(NOUS_MODELS_URL),
    parseResponse: normalizeRoutedNousModels,
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    listingShape: "anthropic",
    parseResponse: (data) => data.data || []
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    listingShape: "openai",
    parseResponse: (data) => data.data || []
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    listingShape: "openai",
    parseResponse: (data) => data.data || []
  },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    listingShape: "openai",
    parseResponse: (data) => data.data || []
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  "perplexity-agent": createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.com/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  // OpenAI-compatible aggregators.
  tokenharbor: createOpenAIModelsConfig("https://tokenharbor.ai/v1/models"),
  dahl: createOpenAIModelsConfig("https://inference.dahl.global/v1/models"),
  atria: createOpenAIModelsConfig("https://api.atria-asi.ai/v1/models"),
  agnes: createOpenAIModelsConfig("https://apihub.agnes-ai.com/v1/models"),
  bai: createOpenAIModelsConfig("https://api.b.ai/v1/models"),
  kimchi: {
    customResolver: async (connection) => {
      const result = await resolveKimchiModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) {
        return { models: result.models };
      }
      return {
        models: getStaticProviderModels("kimchi"),
        warning: "Kimchi returned no live models; falling back to static catalog.",
      };
    }
  },
  cursor: {
    customResolver: async (connection) => {
      const result = await resolveCursorModels({
        accessToken: connection.accessToken,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("cursor"),
        warning: "Cursor returned no live models; falling back to static catalog.",
      };
    },
  },
  // Zed has no static catalog by design (live /models only) — same cursor
  // direct pattern: resolve with the connection's own credentials (never
  // exposed to the browser), return rich metadata, drop disabled entries.
  // Empty/failure yields an explicit warning, never a silent zero list.
  zed: {
    customResolver: async (connection) => {
      try {
        const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
        const result = await resolveZedModels({
          accessToken: connection.accessToken,
          providerSpecificData: connection.providerSpecificData || {},
        }, {
          config: ZED_HOSTED_CONFIG,
          forceRefresh: true,
          proxyOptions: {
            connectionProxyEnabled: proxy.connectionProxyEnabled === true,
            connectionProxyUrl: proxy.connectionProxyUrl || "",
            connectionNoProxy: proxy.connectionNoProxy || "",
            vercelRelayUrl: proxy.vercelRelayUrl || "",
            strictProxy: proxy.strictProxy === true,
          },
        });
        const models = (result?.models || [])
          .filter((m) => m && !m.isDisabled)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            provider: m.provider,
            contextLength: m.contextLength,
            contextLengthInMaxMode: m.contextLengthInMaxMode,
            maxOutputTokens: m.maxOutputTokens,
            supportsTools: m.supportsTools,
            supportsImages: m.supportsImages,
            supportsThinking: m.supportsThinking,
            supportsDisablingThinking: m.supportsDisablingThinking,
            supportsFastMode: m.supportsFastMode,
            supportsServerSideCompaction: m.supportsServerSideCompaction,
            supportedEffortLevels: m.supportedEffortLevels || [],
            supportsStreamingTools: m.supportsStreamingTools,
            supportsParallelToolCalls: m.supportsParallelToolCalls,
            raw: m,
          }));
        if (models.length > 0) return { models, complete: false };
        return { models: [], complete: false, warning: "Zed returned no live models." };
      } catch (error) {
        console.log("Failed to fetch Zed models dynamically:", error.message);
        return { models: [], complete: false, warning: `Failed to fetch Zed models: ${error.message}` };
      }
    },
  },

  // Cline's catalogue is public, so the resolver never needs a connection
  // token and cannot spend quota. The owner/model ids are served verbatim.
  cline: {
    customResolver: async () => {
      try {
        const response = await timedFetch(clineProvider.modelsFetcher.url, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        if (response.ok) {
          const data = await response.json();
          const models = parseOpenAIStyleModels(data)
            .filter((m) => typeof m?.id === "string" && m.id !== "")
            .map((m) => ({ id: m.id, name: m.name || m.id }));
          if (models.length > 0) return { models };
        }
      } catch (error) {
        console.log("Failed to fetch Cline models dynamically, falling back to static:", error.message);
      }
      return {
        models: getStaticProviderModels(clineProvider.alias),
        warning: "Failed to fetch Cline models; falling back to static catalog.",
      };
    },
  },
  clinepass: {
    customResolver: async (connection) => {
      const result = await resolveClinepassModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
      });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("clinepass"),
        warning: "ClinePass returned no live models; falling back to static catalog.",
      };
    },
  },

  // Custom resolvers (non-OpenAI-shaped APIs / token-refresh flows)
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {}
      };
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          }
        });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description
            }))
          };
        }
        warning = "Kiro returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    }
  },
  qoder: buildQoderModelsResolver("qoder"),
  "qoder-cn": buildQoderModelsResolver("qoder-cn"),
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return timedFetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1"
          },
          body: JSON.stringify(body)
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models"
    })
  },
  "grok-cli": {
    customResolver: async (connection) => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const result = await resolveGrokCliModels({
        ...connection,
        connectionId: connection.id,
      }, {
        log: console,
        proxyOptions: {
          connectionProxyEnabled: proxy.connectionProxyEnabled === true,
          connectionProxyUrl: proxy.connectionProxyUrl || "",
          connectionNoProxy: proxy.connectionNoProxy || "",
          vercelRelayUrl: proxy.vercelRelayUrl || "",
          strictProxy: proxy.strictProxy === true,
        },
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });
      if (result.models.length) return result;
      return {
        models: getStaticProviderModels("grok-cli"),
        warning: result.warning || "Grok CLI returned no live models; using static catalog.",
      };
    },
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await timedFetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from ollama-local:", errorText);
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      const data = await response.json();
      return { models: parseOpenAIStyleModels(data) };
    }
  }
};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */

// Build the { body, status } pair resolveProviderModels returns.
function __respond(body, init) {
  return { body, status: init?.status ?? 200 };
}

async function resolveCloudflareModels(connection, { callerSignal, proxyOptions } = {}) {
  const accountId = connection.providerSpecificData?.accountId;
  if (!accountId || typeof accountId !== "string" || !validateCloudflareAccountId(accountId)) {
    return __respond(
      { error: "Cloudflare discovery requires a valid accountId in providerSpecificData (alphanumeric, dashes, underscores, max 128 characters)" },
      { status: 400 }
    );
  }

  const token = connection.providerSpecificData?.apiToken || connection.apiKey || connection.accessToken;
  if (!token) {
    return __respond({ error: "No valid token found" }, { status: 401 });
  }

  const safeAccountId = encodeURIComponent(accountId.trim());
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${safeAccountId}/ai/models/search`;
  const MAX_PAGES = MAX_PAGINATION_PAGES;
  const totalDeadlineSignal = AbortSignal.timeout(MAX_PAGINATION_DEADLINE_MS);
  let page = 1;
  let pageCount = 0;
  let totalPages = 1;
  let complete = false;
  let warning;
  const allRows = [];
  const seenPages = new Set();

  while (page <= totalPages) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      warning = `Cloudflare pagination reached maximum limit of ${MAX_PAGES} pages`;
      complete = false;
      break;
    }
    if (totalDeadlineSignal.aborted) {
      warning = "Cloudflare pagination exceeded 30s deadline";
      complete = false;
      break;
    }
    if (callerSignal?.aborted) {
      if (pageCount === 1) {
        return __respond({ error: "Cloudflare model discovery canceled by caller" }, { status: 500 });
      }
      warning = "Cloudflare model discovery canceled by caller";
      complete = false;
      break;
    }
    if (seenPages.has(page)) {
      warning = `Cloudflare pagination cycle detected for page ${page}`;
      complete = false;
      break;
    }
    seenPages.add(page);

    const pageUrl = `${baseUrl}?page=${page}&per_page=100`;
    const fetchSignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS), totalDeadlineSignal];
    if (callerSignal) fetchSignals.push(callerSignal);
    const combinedSignal = AbortSignal.any(fetchSignals);

    let response;
    try {
      response = await proxyAwareFetch(pageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: combinedSignal,
      }, proxyOptions);
    } catch (err) {
      if (totalDeadlineSignal.aborted) {
        warning = "Cloudflare pagination exceeded 30s deadline";
        complete = false;
        break;
      }
      if (callerSignal?.aborted) {
        warning = "Cloudflare model discovery canceled by caller";
        complete = false;
        break;
      }
      if (pageCount === 1) {
        return __respond({ error: sanitizeNoKeys(`Failed to fetch models: ${err.message}`, [token]) }, { status: 500 });
      }
      warning = sanitizeNoKeys(`Cloudflare pagination error on page ${page}: ${err.message}`, [token]);
      complete = false;
      break;
    }

    if (!response.ok) {
      if (pageCount === 1) {
        return __respond(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status }
        );
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Cloudflare pagination error on page ${page}: HTTP ${response.status}`;
      complete = false;
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      if (pageCount === 1) {
        return __respond({ error: "Failed to parse models response" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Cloudflare pagination error on page ${page}: invalid JSON`;
      complete = false;
      break;
    }

    if (!Array.isArray(data?.result)) {
      if (pageCount === 1) {
        return __respond({ error: "Cloudflare models response lacked a result array" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Cloudflare pagination error on page ${page}: missing result array`;
      complete = false;
      break;
    }

    allRows.push(...data.result);

    const ri = data.result_info;
    if (ri && typeof ri.total_pages === "number" && Number.isFinite(ri.total_pages)) {
      totalPages = ri.total_pages;
    } else {
      totalPages = page;
    }

    if (page >= totalPages) {
      complete = true;
      break;
    }
    page++;
  }

  const models = allRows.map(mapCloudflareModelRow);

  return __respond({
    provider: connection.provider,
    connectionId: connection.id,
    models,
    complete,
    completenessProvenance: complete ? "exhausted_numeric_pages" : "partial_numeric_pages",
    ...(warning ? { warning } : {}),
  });
}

async function resolveGeminiModels(connection, { callerSignal, proxyOptions } = {}) {
  const token = connection.providerSpecificData?.apiKey || connection.apiKey || connection.accessToken;
  if (!token) {
    return __respond({ error: "No valid token found" }, { status: 401 });
  }

  const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
  const MAX_PAGES = MAX_PAGINATION_PAGES;
  const MAX_RECORDS = MAX_PAGINATION_RECORDS;
  const totalDeadlineSignal = AbortSignal.timeout(MAX_PAGINATION_DEADLINE_MS);
  let pageCount = 0;
  let nextPageToken = null;
  let complete = false;
  let warning;
  const allModels = [];
  const seenTokens = new Set();

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      warning = `Gemini pagination reached maximum limit of ${MAX_PAGES} pages`;
      complete = false;
      break;
    }
    if (totalDeadlineSignal.aborted) {
      warning = "Gemini pagination exceeded 30s deadline";
      complete = false;
      break;
    }
    if (callerSignal?.aborted) {
      if (pageCount === 1) {
        return __respond({ error: "Gemini model discovery canceled by caller" }, { status: 500 });
      }
      warning = "Gemini model discovery canceled by caller";
      complete = false;
      break;
    }

    const params = new URLSearchParams({
      key: token,
      pageSize: "1000",
    });
    if (nextPageToken) {
      params.set("pageToken", nextPageToken);
    }

    const pageUrl = `${baseUrl}?${params.toString()}`;
    const fetchSignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS), totalDeadlineSignal];
    if (callerSignal) fetchSignals.push(callerSignal);
    const combinedSignal = AbortSignal.any(fetchSignals);

    let response;
    try {
      response = await proxyAwareFetch(pageUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: combinedSignal,
      }, proxyOptions);
    } catch (err) {
      if (totalDeadlineSignal.aborted) {
        warning = "Gemini pagination exceeded 30s deadline";
        complete = false;
        break;
      }
      if (callerSignal?.aborted) {
        warning = "Gemini model discovery canceled by caller";
        complete = false;
        break;
      }
      if (pageCount === 1) {
        return __respond({ error: sanitizeNoKeys(`Failed to fetch models: ${err.message}`, [token]) }, { status: 500 });
      }
      warning = sanitizeNoKeys(`Gemini pagination error on page ${pageCount}: ${err.message}`, [token]);
      complete = false;
      break;
    }

    if (!response.ok) {
      if (pageCount === 1) {
        return __respond(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status }
        );
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Gemini pagination error on page ${pageCount}: HTTP ${response.status}`;
      complete = false;
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      if (pageCount === 1) {
        return __respond({ error: "Failed to parse models response" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Gemini pagination error on page ${pageCount}: invalid JSON`;
      complete = false;
      break;
    }

    if (!Array.isArray(data?.models)) {
      if (pageCount === 1) {
        return __respond({ error: "Gemini models response lacked a models array" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Gemini pagination error on page ${pageCount}: missing models array`;
      complete = false;
      break;
    }

    allModels.push(...data.models);

    if (allModels.length >= MAX_RECORDS) {
      warning = `Gemini pagination reached maximum record limit of ${MAX_RECORDS}`;
      complete = false;
      break;
    }

    const tokenFromData = typeof data.nextPageToken === "string" ? data.nextPageToken.trim() : null;
    if (tokenFromData) {
      if (seenTokens.has(tokenFromData)) {
        warning = "Gemini pagination cycle detected: token already seen";
        complete = false;
        break;
      }
      seenTokens.add(tokenFromData);
      nextPageToken = tokenFromData;
    } else {
      complete = true;
      break;
    }
  }

  return __respond({
    provider: connection.provider,
    connectionId: connection.id,
    models: allModels,
    complete,
    completenessProvenance: complete ? "exhausted_token_pages" : "partial_token_pages",
    ...(warning ? { warning } : {}),
  });
}

async function resolveNativeAnthropicModels(connection, { callerSignal, proxyOptions } = {}) {
  const token = connection.providerSpecificData?.apiKey || connection.apiKey || connection.accessToken;
  if (!token) {
    return __respond({ error: "No valid token found" }, { status: 401 });
  }

  const baseUrl = "https://api.anthropic.com/v1/models";
  const MAX_PAGES = MAX_PAGINATION_PAGES;
  const totalDeadlineSignal = AbortSignal.timeout(MAX_PAGINATION_DEADLINE_MS);
  let pageCount = 0;
  let afterId = null;
  let complete = false;
  let warning;
  const allModels = [];
  const seenCursors = new Set();

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      warning = `Anthropic pagination reached maximum limit of ${MAX_PAGES} pages`;
      complete = false;
      break;
    }
    if (totalDeadlineSignal.aborted) {
      warning = "Anthropic pagination exceeded 30s deadline";
      complete = false;
      break;
    }
    if (callerSignal?.aborted) {
      if (pageCount === 1) {
        return __respond({ error: "Anthropic model discovery canceled by caller" }, { status: 500 });
      }
      warning = "Anthropic model discovery canceled by caller";
      complete = false;
      break;
    }

    const params = new URLSearchParams({ limit: "1000" });
    if (afterId) {
      params.set("after_id", afterId);
    }
    const pageUrl = `${baseUrl}?${params.toString()}`;
    const fetchSignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS), totalDeadlineSignal];
    if (callerSignal) fetchSignals.push(callerSignal);
    const combinedSignal = AbortSignal.any(fetchSignals);

    let response;
    try {
      response = await proxyAwareFetch(pageUrl, {
        method: "GET",
        headers: {
          "Anthropic-Version": "2023-06-01",
          "Content-Type": "application/json",
          "x-api-key": token,
        },
        signal: combinedSignal,
      }, proxyOptions);
    } catch (err) {
      if (totalDeadlineSignal.aborted) {
        warning = "Anthropic pagination exceeded 30s deadline";
        complete = false;
        break;
      }
      if (callerSignal?.aborted) {
        warning = "Anthropic model discovery canceled by caller";
        complete = false;
        break;
      }
      if (pageCount === 1) {
        return __respond({ error: sanitizeNoKeys(`Failed to fetch models: ${err.message}`, [token]) }, { status: 500 });
      }
      warning = sanitizeNoKeys(`Anthropic pagination error on page ${pageCount}: ${err.message}`, [token]);
      complete = false;
      break;
    }

    if (!response.ok) {
      if (pageCount === 1) {
        return __respond(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status }
        );
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Anthropic pagination error on page ${pageCount}: HTTP ${response.status}`;
      complete = false;
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      if (pageCount === 1) {
        return __respond({ error: "Failed to parse models response" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Anthropic pagination error on page ${pageCount}: invalid JSON`;
      complete = false;
      break;
    }

    const pageModels = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : null);
    if (!pageModels) {
      if (pageCount === 1) {
        return __respond({ error: "Anthropic models response lacked a models array" }, { status: 502 });
      }
      try { await response.body?.cancel?.(); } catch {}
      warning = `Anthropic pagination error on page ${pageCount}: missing models array`;
      complete = false;
      break;
    }

    allModels.push(...pageModels);

    if (data.has_more !== undefined && typeof data.has_more !== "boolean") {
      warning = `Anthropic pagination error on page ${pageCount}: non-boolean has_more signal`;
      complete = false;
      break;
    }

    const hasAlternatePagination =
      isSignalPresent(data.next) ||
      isSignalPresent(data.next_page) ||
      isSignalPresent(data.next_cursor) ||
      isSignalPresent(data.nextPageToken) ||
      isSignalPresent(data.cursor);

    if (hasAlternatePagination) {
      warning = `Anthropic pagination error on page ${pageCount}: unexpected alternate pagination signal present`;
      complete = false;
      break;
    }

    if (data.has_more === true) {
      const nextLastId = typeof data.last_id === "string" ? data.last_id.trim() : "";
      if (!nextLastId) {
        warning = "Anthropic pagination has_more true but no valid last_id was provided";
        complete = false;
        break;
      }
      if (seenCursors.has(nextLastId)) {
        warning = `Anthropic pagination cycle detected: cursor ${nextLastId} already seen`;
        complete = false;
        break;
      }
      seenCursors.add(nextLastId);
      afterId = nextLastId;
    } else {
      complete = true;
      break;
    }
  }

  return __respond({
    provider: connection.provider,
    connectionId: connection.id,
    models: allModels,
    complete,
    completenessProvenance: complete ? "exhausted_cursor_chain" : "partial_cursor_chain",
    ...(warning ? { warning } : {}),
  });
}

// Shared by GET (list) and the import route: returns { body, status } instead of
// a Response so callers can inspect the listing before deciding what to do.
export async function resolveProviderModels(request, id, { signal } = {}) {
  try {
    const callerSignal = signal || request?.signal || null;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return __respond({ error: "Connection not found" }, { status: 404 });
    }

    if (isOpenAICompatibleProvider(connection.provider)) {
      const node = await getProviderNodeById(connection.provider);
      if (!node?.baseUrl) {
        return __respond({ error: "No base URL configured for OpenAI compatible provider node" }, { status: 400 });
      }

      // Check for origin mismatch between connection-specific URL and immutable node authority
      const connBaseUrl = connection.providerSpecificData?.baseUrl;
      if (connBaseUrl) {
        try {
          const connOrigin = new URL(connBaseUrl).origin;
          const nodeOrigin = new URL(node.baseUrl).origin;
          if (connOrigin !== nodeOrigin) {
            return __respond(
              { error: "Connection URL origin mismatch with trusted node authority" },
              { status: 400 }
            );
          }
        } catch {
          return __respond({ error: "Invalid gateway URL format" }, { status: 400 });
        }
      }

      // Proxy preservation: refuse explicitly if connection requires proxy or relay that cannot be honored
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      if (
        proxy?.strictProxy === true ||
        proxy?.connectionProxyEnabled === true ||
        Boolean(proxy?.vercelRelayUrl) ||
        Boolean(proxy?.connectionProxyUrl) ||
        Boolean(proxy?.proxyPoolId) ||
        Boolean(proxy?.psiphonPoolId)
      ) {
        return __respond(
          { error: "Configured proxy egress cannot be honored for custom gateway model discovery (fail-closed)" },
          { status: 503 }
        );
      }

      const baseUrl = node.baseUrl;
      const isSelfHosted = Boolean(node?.isSelfHosted);
      const allowInsecureTls = Boolean(node?.allowInsecureTls && isSelfHosted);

      if (isSelfHosted) {
        const permitted = isGatewaySelfHostedAllowed({
          request,
          isSelfHosted: true,
          baseUrl,
        });
        if (!permitted) {
          return __respond(
            { error: "Self-hosted gateway discovery not permitted from proxied or non-local requests" },
            { status: 400 }
          );
        }
      }

      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      try {
        await assertGatewayUrlAllowed(url, {
          isSelfHosted,
          authorizedOrigin: new URL(baseUrl).origin,
        });
      } catch (err) {
        return __respond({ error: `Gateway URL not allowed: ${err.message}` }, { status: 400 });
      }

      try {
        const gatewaySignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)];
        if (callerSignal) gatewaySignals.push(callerSignal);
        const response = await fetchGateway(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${connection.apiKey}`,
          },
          signal: AbortSignal.any(gatewaySignals),
        }, {
          isSelfHosted,
          allowInsecureTls,
          authorizedOrigin: new URL(baseUrl).origin,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return __respond(
            { error: `Failed to fetch models: ${response.status}` },
            { status: response.status }
          );
        }

        const data = await response.json();
        const models = Array.isArray(data?.data)
          ? data.data
          : (Array.isArray(data?.models) ? data.models : []);
        const isArray = Array.isArray(data?.data) || Array.isArray(data?.models);
        const hasPagination = hasOpenAIPaginationSignal(data);
        const complete = isArray && !hasPagination;

        return __respond({
          provider: connection.provider,
          connectionId: connection.id,
          models,
          complete,
          completenessProvenance: complete ? "unpaginated_authoritative" : "partial_pagination_signal",
        });
      } catch (err) {
        const sanitized = sanitizeGatewayError(err, [connection.apiKey]);
        return __respond({ error: sanitized.message }, { status: 500 });
      }
    }

    if (isAnthropicCompatibleProvider(connection.provider)) {
      const node = await getProviderNodeById(connection.provider);
      if (!node?.baseUrl) {
        return __respond({ error: "No base URL configured for Anthropic compatible provider node" }, { status: 400 });
      }

      const connBaseUrl = connection.providerSpecificData?.baseUrl;
      if (connBaseUrl) {
        try {
          const connOrigin = new URL(connBaseUrl).origin;
          const nodeOrigin = new URL(node.baseUrl).origin;
          if (connOrigin !== nodeOrigin) {
            return __respond(
              { error: "Connection URL origin mismatch with trusted node authority" },
              { status: 400 }
            );
          }
        } catch {
          return __respond({ error: "Invalid gateway URL format" }, { status: 400 });
        }
      }

      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      if (
        proxy?.strictProxy === true ||
        proxy?.connectionProxyEnabled === true ||
        Boolean(proxy?.vercelRelayUrl) ||
        Boolean(proxy?.connectionProxyUrl) ||
        Boolean(proxy?.proxyPoolId) ||
        Boolean(proxy?.psiphonPoolId)
      ) {
        return __respond(
          { error: "Configured proxy egress cannot be honored for custom gateway model discovery (fail-closed)" },
          { status: 503 }
        );
      }

      let baseUrl = node.baseUrl.replace(/\/$/, "");
      if (baseUrl.endsWith("/messages")) {
        baseUrl = baseUrl.slice(0, -9);
      }

      const isSelfHosted = Boolean(node?.isSelfHosted);
      const allowInsecureTls = Boolean(node?.allowInsecureTls && isSelfHosted);

      if (isSelfHosted) {
        const permitted = isGatewaySelfHostedAllowed({
          request,
          isSelfHosted: true,
          baseUrl,
        });
        if (!permitted) {
          return __respond(
            { error: "Self-hosted gateway discovery not permitted from proxied or non-local requests" },
            { status: 400 }
          );
        }
      }

      const gatewayTrust = {
        isSelfHosted,
        allowInsecureTls,
        authorizedOrigin: new URL(node.baseUrl).origin,
      };

      const gatewayHeaders = {
        "Content-Type": "application/json",
        "x-api-key": connection.apiKey,
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${connection.apiKey}`,
      };

      const MAX_PAGES = 20;
      let pageCount = 0;
      let afterId = null;
      let complete = false;
      let warning = undefined;
      const allModels = [];
      const seenCursors = new Set();

      while (pageCount < MAX_PAGES) {
        pageCount++;
        const params = new URLSearchParams({ limit: "1000" });
        if (afterId) {
          params.set("after_id", afterId);
        }
        const pageUrl = `${baseUrl}/models?${params.toString()}`;

        try {
          await assertGatewayUrlAllowed(pageUrl, gatewayTrust);
        } catch (err) {
          if (pageCount === 1) {
            return __respond({ error: `Gateway URL not allowed: ${err.message}` }, { status: 400 });
          }
          warning = `Anthropic pagination stopped: Gateway URL not allowed: ${err.message}`;
          complete = false;
          break;
        }

        let response;
        try {
          const pageSignals = [AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)];
          if (callerSignal) pageSignals.push(callerSignal);
          response = await fetchGateway(pageUrl, {
            method: "GET",
            headers: gatewayHeaders,
            signal: AbortSignal.any(pageSignals),
          }, gatewayTrust);
        } catch (err) {
          if (pageCount === 1) {
            const sanitized = sanitizeGatewayError(err, [connection.apiKey]);
            return __respond({ error: sanitized.message }, { status: 500 });
          }
          const sanitized = sanitizeGatewayError(err, [connection.apiKey]);
          warning = `Anthropic pagination error on page ${pageCount}: ${sanitized.message}`;
          complete = false;
          break;
        }

        if (!response.ok) {
          if (pageCount === 1) {
            const errorText = await response.text();
            return __respond(
              { error: `Failed to fetch models: ${response.status}` },
              { status: response.status }
            );
          }
          try { await response.body?.cancel?.(); } catch {}
          warning = `Anthropic pagination error on page ${pageCount}: HTTP ${response.status}`;
          complete = false;
          break;
        }

        let data;
        try {
          data = await response.json();
        } catch (jsonErr) {
          if (pageCount === 1) {
            return __respond({ error: "Failed to parse models response" }, { status: 502 });
          }
          try { await response.body?.cancel?.(); } catch {}
          warning = `Anthropic pagination error on page ${pageCount}: invalid JSON`;
          complete = false;
          break;
        }

        // Must require a well-formed model array on EVERY page
        const isArray = Array.isArray(data?.data) || Array.isArray(data?.models);
        if (!isArray) {
          if (pageCount === 1) {
            return __respond({ error: "Anthropic models response lacked a models array" }, { status: 502 });
          }
          warning = `Anthropic pagination error on page ${pageCount}: response lacked a models array`;
          complete = false;
          break;
        }

        const pageModels = Array.isArray(data?.data) ? data.data : data.models;
        allModels.push(...pageModels);

        // Strict boolean check for has_more: reject string "true" or non-boolean values
        if (data.has_more !== undefined && typeof data.has_more !== "boolean") {
          warning = `Anthropic pagination error on page ${pageCount}: non-boolean has_more signal`;
          complete = false;
          break;
        }

        // Check for alternate pagination signals that Anthropic should not ignore
        const hasAlternatePagination =
          isSignalPresent(data.next) ||
          isSignalPresent(data.next_page) ||
          isSignalPresent(data.next_cursor) ||
          isSignalPresent(data.nextPageToken) ||
          isSignalPresent(data.cursor);

        if (hasAlternatePagination) {
          warning = `Anthropic pagination error on page ${pageCount}: unexpected alternate pagination signal present`;
          complete = false;
          break;
        }

        if (data.has_more === true) {
          const nextLastId = typeof data.last_id === "string" ? data.last_id.trim() : "";
          if (!nextLastId) {
            warning = "Anthropic pagination has_more is true but no valid last_id was provided";
            complete = false;
            break;
          }
          // Cursor cycle detection
          if (seenCursors.has(nextLastId)) {
            warning = `Anthropic pagination cycle detected: cursor ${nextLastId} already seen`;
            complete = false;
            break;
          }
          seenCursors.add(nextLastId);
          afterId = nextLastId;

          if (pageCount >= MAX_PAGES) {
            warning = `Anthropic pagination reached maximum limit of ${MAX_PAGES} pages`;
            complete = false;
            break;
          }
        } else {
          // Final page has has_more === false or absent after a fully consumed chain
          complete = true;
          break;
        }
      }

      return __respond({
        provider: connection.provider,
        connectionId: connection.id,
        models: allModels,
        complete,
        completenessProvenance: complete ? "exhausted_cursor_chain" : "partial_cursor_chain",
        ...(warning ? { warning } : {}),
      });
    }

    // Resolve and validate proxy configuration for built-in and native providers.
    // If proxy egress is configured and supported, proxyAwareFetch routes through the proxy.
    // If proxy egress is configured with an unsupported type or failed resolution, fails closed with 503.
    const supportsInternalProxy = connection.provider === "zed" || connection.provider === "grok-cli";
    let proxyOptions = null;
    if (!supportsInternalProxy) {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const proxyValidation = validateProxySupport(proxy, connection.providerSpecificData);
      if (!proxyValidation.ok) {
        return __respond({ error: proxyValidation.error }, { status: proxyValidation.status || 503 });
      }
      proxyOptions = proxyValidation.proxyOptions;
    }

    if (connection.provider === "cloudflare" || connection.provider === "cloudflare-ai") {
      return resolveCloudflareModels(connection, { callerSignal, proxyOptions });
    }

    if (connection.provider === "gemini") {
      return resolveGeminiModels(connection, { callerSignal, proxyOptions });
    }

    if (connection.provider === "anthropic" || connection.provider === "claude") {
      return resolveNativeAnthropicModels(connection, { callerSignal, proxyOptions });
    }

    const config = PROVIDER_MODELS_CONFIG[connection.provider];
    if (!config) {
      const staticModels = getStaticProviderModels(connection.provider);
      if (staticModels.length > 0) {
        return __respond({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels,
          complete: false,
          completenessProvenance: "static_catalog_fallback",
          warning: `Provider ${connection.provider} does not support dynamic model discovery; using static catalog.`,
        });
      }
      return __respond(
        { error: `Provider ${connection.provider} does not support models listing` },
        { status: 400 }
      );
    }

    // Config-driven custom resolver path (OAuth refresh, non-OpenAI shape, etc.)
    if (typeof config.customResolver === "function") {
      const result = await config.customResolver(connection);
      if (result.error) {
        return __respond({ error: result.error }, { status: result.status || 500 });
      }
      const isComplete = result.complete === true;
      return __respond({
        provider: connection.provider,
        connectionId: connection.id,
        models: result.models,
        complete: isComplete,
        completenessProvenance: isComplete ? "proven_custom_resolver" : "unverified_custom_resolver",
        ...(result.warning ? { warning: result.warning } : {})
      });
    }

    // Get auth token
    const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token) {
      return __respond({ error: "No valid token found" }, { status: 401 });
    }

    // Build request URL
    let url = config.url;
    if (config.authQuery) {
      url += `?${config.authQuery}=${encodeURIComponent(token)}`;
    }

    // Build headers
    const headers = { ...config.headers };
    if (config.authHeader && !config.authQuery) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    // Make request
    const fetchOptions = {
      method: config.method,
      headers
    };

    if (config.body && config.method === "POST") {
      fetchOptions.body = JSON.stringify(config.body);
    }

    const response = await timedFetch(url, fetchOptions, proxyOptions, callerSignal);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, errorText);
      return __respond(
        { error: `Failed to fetch models: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    if (config.listingShape === "openai") {
      const evaluation = evaluateOpenAIListing(data);
      let models;
      if (!evaluation.recognized) {
        models = [];
      } else if (config.parseResponse && config.parseResponse !== parseOpenAIStyleModels) {
        models = config.parseResponse(data);
      } else {
        models = evaluation.models;
      }
      return __respond({
        provider: connection.provider,
        connectionId: connection.id,
        models,
        complete: evaluation.complete,
        completenessProvenance: evaluation.complete ? "unpaginated_authoritative" : (evaluation.recognized ? "partial_pagination_signal" : "unrecognized_shape"),
        ...(evaluation.warning ? { warning: evaluation.warning } : {}),
      });
    }

    const models = config.parseResponse ? config.parseResponse(data) : [];

    return __respond({
      provider: connection.provider,
      connectionId: connection.id,
      models,
      complete: false,
      completenessProvenance: "unverified_config_shape",
      warning: `Listing completeness not verified for provider ${connection.provider}`,
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return __respond({ error: "Failed to fetch models" }, { status: 500 });
  }
}

export async function GET(request, { params }) {
  const { id } = await params;
  const { body, status } = await resolveProviderModels(request, id);
  return NextResponse.json(body, { status });
}

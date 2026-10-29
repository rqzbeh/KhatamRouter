import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings, getComboByName } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  getKeyAccessContext,
  keyAccessContextFromRecord,
  enforceKeyAccess,
  filterAdapterModels,
  extractClientApiKey,
} from "../services/keyAccess.js";
import { isTrustedInternalRequest } from "../services/internalTrust.js";
import { enforceUnifiedAcl } from "../services/allowedModels.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { checkApiKeyUsageLimits, formatQuotaErrorResponse } from "@/lib/usage/apiKeyUsageLimits.js";
import { gateTarget, observeFailure, observeSuccess, isResilienceEnabled } from "@/domain/fallbackResilience.js";
import { isStickinessEnabled, computeSessionKey, getStickyConnection, setStickyConnection, clearStickyConnection } from "@/lib/stealth/stickiness.js";
import { handleIdempotencyPreRequest, handleIdempotencyPostRequest } from "@/lib/idempotency/index.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import { rotate, recordUsage, shouldRotateOn } from "@/lib/network/psiphon/psiphonManager.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // 1. Internal Trust Guard: valid x-9r-cli-token bypasses all auth and ACL gates
  const isTrustedInternal = await isTrustedInternalRequest(request);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractClientApiKey(request) || extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Resolve keyRecord ONCE per request (read fresh from SQLite, never cached across requests)
  const keyRecord = (!isTrustedInternal && apiKey) ? await getApiKeyByKey(apiKey) : null;

  // Enforce API key if enabled in settings (bypassed if trusted internal)
  const settings = await getSettings();
  if (!isTrustedInternal && settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = Boolean(keyRecord && keyRecord.isActive);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Idempotency: Pre-request check for non-streaming inference requests
  const idempotency = await handleIdempotencyPreRequest({
    req: request,
    body,
    apiKey,
  });

  if (!idempotency.shouldProceed) {
    if (idempotency.replayed) {
      const resp = idempotency.response;
      return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
        status: resp.status || 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Idempotency-Replayed": "true",
          ...(resp.headers || {}),
        },
      });
    }
    const err = idempotency.response;
    return new Response(typeof err?.body === "string" ? err.body : JSON.stringify(err?.body || {}), {
      status: err?.status || 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...(err?.headers || {}),
      },
    });
  }

  const finishResponse = async (responsePromise) => {
    const response = await responsePromise;
    if (idempotency?.context && !idempotency.bypass) {
      try {
        if (response && response.status < 400) {
          const cloned = await response.clone().json();
          await handleIdempotencyPostRequest({
            context: idempotency.context,
            body,
            response: {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: cloned,
            },
          });
        } else {
          await handleIdempotencyPostRequest({
            context: idempotency.context,
            body,
            response: { status: response?.status || 500 },
          });
        }
      } catch {}
    }
    return response;
  };

  let aclEvaluated = false;
  // 3-5. Unified Tri-State ACL check: kind ("llm") -> combo/provider -> model
  if (!isTrustedInternal) {
    if (keyRecord) {
      const aclDenied = await enforceUnifiedAcl({
        request,
        kind: "llm",
        modelStr,
        keyRecord,
      });
      if (aclDenied) return await finishResponse(aclDenied);
      aclEvaluated = true;

      // 6. Granular API Key Rate/Quota Limits & Spend Caps
      const limitResult = await checkApiKeyUsageLimits({ apiKeyRow: keyRecord });
      if (limitResult && !limitResult.allowed) {
        const formatted = formatQuotaErrorResponse(limitResult);
        return await finishResponse(new Response(JSON.stringify(formatted.body), {
          status: formatted.status,
          headers: {
            ...formatted.headers,
            "Access-Control-Allow-Origin": "*",
          },
        }));
      }
    }
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  // When unified ACL has already evaluated this key, skip the redundant legacy check.
  const keyAccess = isTrustedInternal ? null : (keyRecord ? keyAccessContextFromRecord(keyRecord) : await getKeyAccessContext(request));
  if (!aclEvaluated) {
    const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
    if (keyAccessDenied) return await finishResponse(keyAccessDenied);
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return await finishResponse(bypassResponse.response || bypassResponse);

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  // One combo lookup per request; the resolved combo is threaded to every member call.
  const combo = modelStr.includes("/") ? null : await getComboByName(modelStr);
  const comboModels = combo && combo.models && combo.models.length > 0 ? combo.models : null;

  const requestScope = {
    keyRecord,
    keyAccess,
    isTrustedInternal,
    combo,
  };

  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return await finishResponse(handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, requestScope);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      }));
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[modelStr] || {};
    const rawThresh = typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8;
    const confidenceThreshold = rawThresh > 1 ? rawThresh / 100 : rawThresh;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return await finishResponse(handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, requestScope),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
    }));
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return await finishResponse(handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, requestScope),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    }));
  }

  return await finishResponse(handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null, requestScope));
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, requestScope = null) {
  const keyRecord = requestScope?.keyRecord !== undefined
    ? requestScope.keyRecord
    : (apiKey ? await getApiKeyByKey(apiKey) : null);
  const resolvedCombo = (requestScope?.combo && (!requestScope.combo.name || requestScope.combo.name === modelStr))
    ? requestScope.combo
    : undefined;
  const modelInfo = await getModelInfo(modelStr, resolvedCombo);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr, resolvedCombo);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = requestScope?.keyAccess !== undefined
        ? requestScope.keyAccess
        : await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      const nestedScope = {
        keyRecord,
        keyAccess,
        isTrustedInternal: requestScope?.isTrustedInternal,
        combo: (requestScope?.combo && (!requestScope.combo.name || requestScope.combo.name === modelStr)) ? requestScope.combo : null,
      };

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, nestedScope);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      const rawThresh = typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8;
      const confidenceThreshold = rawThresh > 1 ? rawThresh / 100 : rawThresh;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, nestedScope),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
            })
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Wave 5: Prompt-cache session stickiness (default-off behind STEALTH_STICKINESS=1 / STEALTH_ALL=1)
  const stickinessKey = isStickinessEnabled() ? computeSessionKey(body, provider) : null;
  const preferredConnectionId = stickinessKey ? getStickyConnection(stickinessKey) : null;

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;
  let psiphonRotations = 0;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      requestedModel: requestedModel || model,
      preferredConnectionId: preferredConnectionId && !excludeConnectionIds.has(preferredConnectionId) ? preferredConnectionId : null,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Wave 4 pre-dispatch gate. Inert unless KHATAM_RESILIENCE_CIRCUIT_BREAKER=1:
    // `gateTarget` returns a proceed verdict before touching any breaker state.
    if (isResilienceEnabled()) {
      const verdict = await gateTarget({
        provider,
        connectionId: credentials.connectionId,
        model,
        connection: credentials._connection || null,
      }).catch(() => null);
      if (verdict && verdict.kind === "skip") {
        log.warn("RESILIENCE", `↷ ACC:${credentials.connectionName} skipped pre-dispatch (${verdict.reason}${verdict.retryAfterHuman ? `, ${verdict.retryAfterHuman}` : ""})`);
        excludeConnectionIds.add(credentials.connectionId);
        // Seed the terminal error only while nothing has been recorded: a later
        // real upstream failure keeps overwriting lastError/lastStatus exactly as
        // before, so the final status code never drifts from the pre-Wave-4 path.
        if (!lastError) lastError = verdict.message;
        continue;
      }
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      apiKeyId: keyRecord?.id,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      loopGuardEnabled: !!chatSettings.loopGuardEnabled,
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
        // Wave 4: closes a HALF_OPEN probe and decays CLOSED failure counts.
        // No-op when the flag is off.
        if (isResilienceEnabled()) {
          await observeSuccess({ provider, connectionId: credentials.connectionId });
        }
        // Wave 5: record session pin on success
        if (stickinessKey && credentials.connectionId) {
          setStickyConnection(stickinessKey, credentials.connectionId);
        }
      }
    });

    if (result.success) {
      const psiphonPoolId = credentials?.providerSpecificData?.psiphonPoolId;
      if (psiphonPoolId) {
        let tokens = 0;
        if (result.usage) {
          tokens = (result.usage.prompt_tokens || result.usage.input_tokens || 0) +
                   (result.usage.completion_tokens || result.usage.output_tokens || 0) ||
                   result.usage.total_tokens || 0;
        }
        recordUsage(psiphonPoolId, { requests: 1, tokens });
      }
      return result.response;
    }

    // Psiphon burn-signal rotation (FR-014-07):
    // If request used a Psiphon pool and upstream emitted a burn signal (429, 403 FreeTier, 502/503 transport),
    // rotate the tunnel (up to 2 times per request) and retry. Applies to noauth as well.
    const psiphonPoolId = credentials?.providerSpecificData?.psiphonPoolId;
    const isPsiphonUnavailable = credentials?.providerSpecificData?.psiphonUnavailable === true;
    if (psiphonPoolId && !isPsiphonUnavailable && shouldRotateOn(result) && psiphonRotations < 2) {
      psiphonRotations++;
      const seenGeneration = credentials?.providerSpecificData?.psiphonGeneration;
      log.warn("PSIPHON", `Burn signal detected (${result.status}) on pool ${psiphonPoolId} (rotation ${psiphonRotations}/2) → rotating tunnel`);
      try {
        await rotate(psiphonPoolId, { reason: `burn_${result.status}`, seenGeneration });
      } catch (rotateErr) {
        log.warn("PSIPHON", `Tunnel rotation failed: ${rotateErr.message}`);
      }
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    // Wave 4: record failure against the breaker when enabled.
    // Client-error statuses (400, 406, 408, 409, 410, 422) and POLICY refusals
    // are exempt inside `observeFailure` and never move health.
    if (isResilienceEnabled()) {
      await observeFailure({
        provider,
        connectionId: credentials.connectionId,
        model,
        status: result.status,
        error: result.error,
        headers: result.response?.headers,
      }).catch(() => null);
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      if (stickinessKey && credentials.connectionId === preferredConnectionId) {
        clearStickyConnection(stickinessKey);
      }
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}

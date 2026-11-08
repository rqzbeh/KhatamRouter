import crypto from "node:crypto";
import {
  looksLikeQuotaExhausted,
  looksLikeTerminalQuotaExhaustion,
  parseRetryAfter,
  upstreamRetryDelaySeconds,
} from "../resilience/failureClassification.js";
import { POLICY_FAILURE_PATTERN } from "open-sse/config/resilienceConfig.js";

export const MODEL_TEST_CLASSIFICATION = Object.freeze({
  SUCCESS: "success",
  QUOTA_COST: "quota_cost",
  RATE_LIMITED: "rate_limited",
  ACCESS_RESTRICTION: "access_restriction",
  TRANSPORT_INDETERMINATE: "transport_indeterminate",
  HARD_MODEL_FAILURE: "hard_model_failure",
});

export const MODEL_TEST_REASON = Object.freeze({
  SUCCESS: "success",
  QUOTA_EXHAUSTED: "quota_exhausted",
  TERMINAL_QUOTA_EXHAUSTED: "terminal_quota_exhausted",
  PAYMENT_REQUIRED: "payment_required",
  RATE_LIMITED: "rate_limited",
  ACCESS_RESTRICTION: "access_restricted",
  REGION_UNSUPPORTED: "region_unsupported",
  PERMISSION_DENIED: "permission_denied",
  MODEL_NOT_FOUND: "model_not_found",
  UNSUPPORTED_MODEL: "unsupported_model",
  AUTH_FAILURE: "auth_failure",
  FORBIDDEN: "forbidden",
  CONTENT_REFUSAL: "content_refusal",
  BAD_REQUEST: "bad_request",
  SERVER_ERROR: "server_error",
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  TRANSPORT_INDETERMINATE: "transport_indeterminate",
  INVALID_RESULT: "invalid_result",
  FAILED_TO_DISABLE: "failed_to_disable",
  ABORTED: "aborted",
  CONSECUTIVE_RATE_LIMITS: "consecutive_rate_limits",
  CONSECUTIVE_BOT_BLOCKS: "consecutive_bot_blocks",
  BATCH_TIMEOUT: "batch_timeout",
});

const MAX_SCAN_CHARS = 2048;
const MAX_MODEL_ID_LENGTH = 256;
const HARD_MAX_MODELS = 100;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_RATE_LIMIT_THRESHOLD = 3;
const DEFAULT_BOT_BLOCK_THRESHOLD = 2;
const DEFAULT_MAX_BATCH_DURATION_MS = 5 * 60 * 1000;

const HARD_MODEL_CODES = new Set([
  "model_not_found",
  "unknown_model",
  "unsupported_model",
  "modelnotfound",
  "unknownmodel",
  "unsupportedmodel",
  "model_does_not_exist",
]);

const HARD_MODEL_PATTERNS = [
  /\bmodel_not_found\b/i,
  /\bunknown_model\b/i,
  /\bunsupported_model\b/i,
  /\bmodel\s+['"`]?[^'"`\s]+['"`]?\s+(?:is\s+not\s+found|not\s+found|does\s+not\s+exist|is\s+unsupported|is\s+not\s+supported)\b/i,
  /\b(?:the\s+)?model\s+[`'"]?[^`'"]+[`'"]?\s+does\s+not\s+exist\b/i,
  /\b(?:unknown|unsupported)\s+model(?:\s+['"`]?[^'"`\s]+['"`]?)?\b/i,
  /\bdoes\s+not\s+support\s+model\b/i,
  /\bno\s+such\s+model\b/i,
];

const AMBIGUOUS_ACCESS_PATTERN =
  /\b(?:or\s+(?:you\s+)?(?:do\s+not|don't)\s+have\s+access|or\s+access\s+denied|or\s+permission\s+denied|may\s+not\s+have\s+access)\b/i;

const SCHEMA_VALIDATION_PATTERN =
  /\b(?:schema|parameter|validation|expected|property|argument|body\s+format)\b/i;

const REGIONAL_PATTERNS = [
  /\b(?:user\s+)?location\s+is\s+not\s+supported\b/i,
  /\b(?:region|country|territory|jurisdiction|location)\s+(?:is\s+)?(?:not\s+supported|unsupported|blocked|restricted)\b/i,
  /\bnot\s+available\s+in\s+your\s+(?:country|region|location|territory)\b/i,
  /\bgeoblock(?:ed)?\b/i,
  /\bcountry_blocked\b/i,
  /\blocation_not_supported\b/i,
  /\bunsupported_country_region_territory\b/i,
];

const PERMISSION_PATTERNS = [
  /\bpermission[_\s-]+denied\b/i,
  /\baccess[_\s-]+denied\b/i,
  /\bnot\s+(?:authorized|permitted)\s+to\s+access\b/i,
  /\baccount[_\s-]+restricted\b/i,
];

const PERMISSION_CODES = new Set(["permission_denied", "access_denied", "account_restricted"]);

const CONTENT_POLICY_PATTERNS = [
  POLICY_FAILURE_PATTERN,
  /\bcontent[_\s-]?policy\b/i,
  /\bsafety[_\s-]?(?:filter|system|violation|blocked)\b/i,
  /\bmoderation(?:[_\s-]?blocked)?\b/i,
  /\bharmful\s+content\b/i,
  /\bprohibited\s+content\b/i,
];

function extractStatusCode(result) {
  if (!result || typeof result !== "object") return null;
  const raw =
    result.status ??
    result.statusCode ??
    result.response?.status ??
    result.response?.statusCode ??
    result.error?.status ??
    result.error?.statusCode;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d{3}$/.test(trimmed)) return null;
    const num = Number.parseInt(trimmed, 10);
    return num >= 100 && num <= 599 ? num : null;
  }
  return null;
}

function extractSafeTextAndCodes(result) {
  const parts = [];
  const codes = [];
  let totalLen = 0;
  let visited = 0;

  function addStr(s) {
    if (typeof s !== "string" || !s || visited >= 16 || totalLen >= MAX_SCAN_CHARS) return;
    visited++;
    const slice = s.slice(0, Math.min(512, MAX_SCAN_CHARS - totalLen));
    parts.push(slice);
    totalLen += slice.length;
  }

  function addCode(c) {
    if (typeof c === "string" && c.trim()) {
      codes.push(c.trim().toLowerCase().slice(0, 256));
    }
  }

  function walk(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 2 || visited >= 16) return;
    if (typeof obj.message === "string") addStr(obj.message);
    if (typeof obj.code === "string") { addStr(obj.code); addCode(obj.code); }
    if (typeof obj.type === "string") { addStr(obj.type); addCode(obj.type); }
    if (typeof obj.param === "string") addStr(obj.param);
    if (typeof obj.statusText === "string") addStr(obj.statusText);
    if (typeof obj.reason === "string") addStr(obj.reason);

    if (depth < 2) {
      if (typeof obj.error === "string") addStr(obj.error);
      else if (obj.error && typeof obj.error === "object") walk(obj.error, depth + 1);
      if (typeof obj.body === "string") addStr(obj.body);
      else if (obj.body && typeof obj.body === "object") walk(obj.body, depth + 1);
      if (typeof obj.data === "string") addStr(obj.data);
      else if (obj.data && typeof obj.data === "object") walk(obj.data, depth + 1);
    }
  }

  if (typeof result === "string") {
    addStr(result);
  } else if (result && typeof result === "object") {
    walk(result, 0);
  }

  return { text: parts.join(" ").slice(0, MAX_SCAN_CHARS), codes };
}

function isContentPolicyRefusal(text, codes) {
  if (codes.some((c) => c === "content_policy_violation" || c === "moderation" || c === "refusal" || c === "safety")) {
    return true;
  }
  return CONTENT_POLICY_PATTERNS.some((pat) => pat.test(text));
}

function isHardModelFailure(statusCode, text, codes) {
  if (statusCode !== 404 && statusCode !== 400 && statusCode !== 410) return false;
  if (AMBIGUOUS_ACCESS_PATTERN.test(text)) return false;
  if (isContentPolicyRefusal(text, codes)) return false;
  if (statusCode === 400 && SCHEMA_VALIDATION_PATTERN.test(text)) return false;

  for (const c of codes) {
    if (HARD_MODEL_CODES.has(c)) return true;
  }
  return HARD_MODEL_PATTERNS.some((pat) => pat.test(text));
}

function extractRetryAfterHeader(result) {
  if (!result || typeof result !== "object") return null;
  const headers = result.headers || result.response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("retry-after");
  if (typeof headers === "object") return headers["retry-after"] ?? headers["Retry-After"] ?? null;
  return null;
}

export function classifyModelTestResult(result) {
  if (!result || typeof result !== "object") {
    return {
      classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
      disableEligible: false,
      statusCode: null,
      reason: MODEL_TEST_REASON.INVALID_RESULT,
    };
  }

  const statusCode = extractStatusCode(result);

  // Success strictly requires ok === true AND no 4xx/5xx status
  if (result.ok === true && (statusCode === null || statusCode < 400)) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.SUCCESS,
      disableEligible: false,
      statusCode: statusCode ?? 200,
      reason: MODEL_TEST_REASON.SUCCESS,
    };
  }

  const { text, codes } = extractSafeTextAndCodes(result);

  if (statusCode === 402) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.QUOTA_COST,
      disableEligible: false,
      statusCode: 402,
      reason: MODEL_TEST_REASON.PAYMENT_REQUIRED,
    };
  }

  if (looksLikeTerminalQuotaExhaustion(text)) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.QUOTA_COST,
      disableEligible: false,
      statusCode,
      reason: MODEL_TEST_REASON.TERMINAL_QUOTA_EXHAUSTED,
    };
  }

  if (looksLikeQuotaExhausted(text)) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.QUOTA_COST,
      disableEligible: false,
      statusCode,
      reason: MODEL_TEST_REASON.QUOTA_EXHAUSTED,
    };
  }

  if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
    if (/\[429\]|HTTP\s+429|upstream(?:\s+status)?\s*:?\s*429/i.test(text)) {
      if (looksLikeQuotaExhausted(text) || looksLikeTerminalQuotaExhaustion(text)) {
        return {
          classification: MODEL_TEST_CLASSIFICATION.QUOTA_COST,
          disableEligible: false,
          statusCode,
          reason: MODEL_TEST_REASON.QUOTA_EXHAUSTED,
        };
      }
      return {
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode,
        reason: MODEL_TEST_REASON.TRANSPORT_INDETERMINATE,
      };
    }
  }

  if (AMBIGUOUS_ACCESS_PATTERN.test(text)) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION,
      disableEligible: false,
      statusCode: statusCode ?? 403,
      reason: MODEL_TEST_REASON.ACCESS_RESTRICTED,
    };
  }

  if (isHardModelFailure(statusCode, text, codes)) {
    const isUnsupported =
      codes.includes("unsupported_model") ||
      codes.includes("unsupportedmodel") ||
      /\bunsupported\s+model\b/i.test(text);
    return {
      classification: MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE,
      disableEligible: true,
      statusCode,
      reason: isUnsupported ? MODEL_TEST_REASON.UNSUPPORTED_MODEL : MODEL_TEST_REASON.MODEL_NOT_FOUND,
    };
  }

  if (statusCode === 429 || codes.includes("rate_limit_exceeded") || codes.includes("too_many_requests")) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.RATE_LIMITED,
      disableEligible: false,
      statusCode: 429,
      reason: MODEL_TEST_REASON.RATE_LIMITED,
    };
  }

  if (REGIONAL_PATTERNS.some((pat) => pat.test(text))) {
    return {
      classification: MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION,
      disableEligible: false,
      statusCode: statusCode ?? 403,
      reason: MODEL_TEST_REASON.REGION_UNSUPPORTED,
    };
  }

  if (statusCode === 403) {
    const isPermission = codes.some((c) => PERMISSION_CODES.has(c)) || PERMISSION_PATTERNS.some((p) => p.test(text));
    if (isPermission) {
      return {
        classification: MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION,
        disableEligible: false,
        statusCode: 403,
        reason: MODEL_TEST_REASON.PERMISSION_DENIED,
      };
    }
  }

  let reason = MODEL_TEST_REASON.TRANSPORT_INDETERMINATE;
  if (isContentPolicyRefusal(text, codes)) reason = MODEL_TEST_REASON.CONTENT_REFUSAL;
  else if (statusCode === 401) reason = MODEL_TEST_REASON.AUTH_FAILURE;
  else if (statusCode === 403) reason = MODEL_TEST_REASON.FORBIDDEN;
  else if (statusCode && statusCode >= 500 && statusCode <= 599) reason = MODEL_TEST_REASON.SERVER_ERROR;
  else if (/\btimeout\b|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) reason = MODEL_TEST_REASON.TIMEOUT;
  else if (/\bnetwork\b|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch\s+failed|socket\s+hang\s+up/i.test(text)) reason = MODEL_TEST_REASON.NETWORK_ERROR;
  else if (statusCode === 400) reason = MODEL_TEST_REASON.BAD_REQUEST;

  return {
    classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
    disableEligible: false,
    statusCode,
    reason,
  };
}

function defaultSleep(ms, { signal } = {}) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { signal.removeEventListener("abort", onAbort); onAbort = null; }
    };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal) {
      onAbort = () => { cleanup(); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function validateModelIds(modelIds, maxModels) {
  if (!Array.isArray(modelIds)) throw new TypeError("runModelTestBatch: modelIds must be an array");
  if (modelIds.length < 1 || modelIds.length > maxModels) {
    throw new RangeError(`runModelTestBatch: modelIds count must be between 1 and ${maxModels}`);
  }

  const seen = new Set();
  const sanitized = [];

  for (let i = 0; i < modelIds.length; i++) {
    const raw = modelIds[i];
    if (typeof raw !== "string") throw new TypeError(`runModelTestBatch: modelId at index ${i} must be a string`);
    const trimmed = raw.trim();
    if (!trimmed) throw new Error(`runModelTestBatch: modelId at index ${i} must not be empty`);
    if (trimmed.length > MAX_MODEL_ID_LENGTH) {
      throw new RangeError(`runModelTestBatch: modelId at index ${i} exceeds maximum length of ${MAX_MODEL_ID_LENGTH} characters`);
    }
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
      throw new Error(`runModelTestBatch: modelId at index ${i} contains forbidden control characters`);
    }
    if (seen.has(trimmed)) throw new Error(`runModelTestBatch: duplicate modelId detected: ${trimmed}`);
    seen.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
}

export async function runModelTestBatch({
  modelIds,
  probe,
  autoDisable = false,
  disableModel,
  signal,
  maxModels = HARD_MAX_MODELS,
  intervalMs = DEFAULT_INTERVAL_MS,
  rateLimitThreshold = DEFAULT_RATE_LIMIT_THRESHOLD,
  botBlockThreshold = DEFAULT_BOT_BLOCK_THRESHOLD,
  maxBatchDurationMs = DEFAULT_MAX_BATCH_DURATION_MS,
  sleep = defaultSleep,
} = {}) {
  if (maxModels !== undefined) {
    if (!Number.isInteger(maxModels) || maxModels < 1 || maxModels > HARD_MAX_MODELS) {
      throw new RangeError(`runModelTestBatch: maxModels must be an integer between 1 and ${HARD_MAX_MODELS}`);
    }
  }
  const effectiveMaxModels = Math.min(HARD_MAX_MODELS, maxModels ?? HARD_MAX_MODELS);
  const sanitizedIds = validateModelIds(modelIds, effectiveMaxModels);

  if (typeof probe !== "function") throw new TypeError("runModelTestBatch: probe must be a function");
  if (autoDisable === true && typeof disableModel !== "function") {
    throw new TypeError("runModelTestBatch: disableModel must be a function when autoDisable is true");
  }
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("runModelTestBatch: intervalMs must be a finite non-negative number");
  }
  if (typeof maxBatchDurationMs !== "number" || !Number.isFinite(maxBatchDurationMs) || maxBatchDurationMs <= 0) {
    throw new RangeError("runModelTestBatch: maxBatchDurationMs must be a finite positive number");
  }
  if (!Number.isInteger(rateLimitThreshold) || rateLimitThreshold < 1) {
    throw new RangeError("runModelTestBatch: rateLimitThreshold must be a positive integer");
  }
  if (!Number.isInteger(botBlockThreshold) || botBlockThreshold < 1) {
    throw new RangeError("runModelTestBatch: botBlockThreshold must be a positive integer");
  }

  const sleepFn = typeof sleep === "function" ? sleep : defaultSleep;
  const batchId = crypto.randomUUID();
  const startTime = Date.now();
  const results = Object.create(null);
  const summary = { tested: 0, total: sanitizedIds.length, disabled: 0, skipped: 0 };

  let stoppedEarly = false;
  let stopReason = null;
  let consecutiveRateLimits = 0;
  let consecutiveBotBlocks = 0;

  const setRow = (id, row) => {
    Object.defineProperty(results, id, {
      value: row,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };

  const skipRemaining = (startIndex, reason) => {
    for (let j = startIndex; j < sanitizedIds.length; j++) {
      setRow(sanitizedIds[j], {
        tested: false,
        status: "skipped",
        reason: reason || "batch_stopped",
        disabled: false,
      });
      summary.skipped++;
    }
  };

  for (let i = 0; i < sanitizedIds.length; i++) {
    const modelId = sanitizedIds[i];

    if (signal?.aborted) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.ABORTED;
      skipRemaining(i, stopReason);
      break;
    }

    const remainingBudgetMs = Math.max(0, startTime + maxBatchDurationMs - Date.now());
    if (remainingBudgetMs <= 0) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.BATCH_TIMEOUT;
      skipRemaining(i, stopReason);
      break;
    }

    const probeController = new AbortController();
    let timeoutTimer = null;
    let callerAbortHandler = null;

    if (signal) {
      if (signal.aborted) {
        probeController.abort();
      } else {
        callerAbortHandler = () => probeController.abort();
        signal.addEventListener("abort", callerAbortHandler, { once: true });
      }
    }

    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        probeController.abort();
        resolve({ timedOut: true });
      }, remainingBudgetMs);
    });

    const probeStart = Date.now();
    let probePromise;
    try {
      probePromise = Promise.resolve(probe(modelId, { signal: probeController.signal }))
        .then((res) => ({ timedOut: false, result: res }))
        .catch((err) => ({ timedOut: false, result: err }));
    } catch (syncErr) {
      probePromise = Promise.resolve({ timedOut: false, result: syncErr });
    }

    probePromise.catch(() => {});

    const outcome = await Promise.race([probePromise, timeoutPromise]);

    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (signal && callerAbortHandler) {
      signal.removeEventListener("abort", callerAbortHandler);
      callerAbortHandler = null;
    }

    if (outcome.timedOut) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.BATCH_TIMEOUT;
      skipRemaining(i, stopReason);
      break;
    }

    const elapsedProbeMs = Math.max(0, Date.now() - probeStart);
    const probeResult = outcome.result;

    if (signal?.aborted) {
      const classification = classifyModelTestResult(probeResult);
      summary.tested++;
      setRow(modelId, {
        tested: true,
        classification: classification.classification,
        disableEligible: classification.disableEligible,
        statusCode: classification.statusCode,
        reason: classification.reason,
        disabled: false,
        latencyMs: elapsedProbeMs,
      });
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.ABORTED;
      skipRemaining(i + 1, stopReason);
      break;
    }

    const classification = classifyModelTestResult(probeResult);
    summary.tested++;

    let modelDisabled = false;
    let disabledAt = null;
    let persistenceError = null;

    // Disabling is only executed if batch is not aborted and deadline has not expired
    if (
      classification.disableEligible &&
      autoDisable === true &&
      !signal?.aborted &&
      Date.now() < startTime + maxBatchDurationMs
    ) {
      const remainingForDisableMs = Math.max(0, startTime + maxBatchDurationMs - Date.now());
      if (remainingForDisableMs > 0) {
        disabledAt = new Date().toISOString();
        try {
          const disableTimeout = Math.min(5000, remainingForDisableMs);
          let disableTimer = null;
          const disableTimeoutPromise = new Promise((_, reject) => {
            disableTimer = setTimeout(() => reject(new Error("disable_timeout")), disableTimeout);
          });
          await Promise.race([
            Promise.resolve(disableModel({ id: modelId, reason: classification.reason, disabledAt, batchId })),
            disableTimeoutPromise,
          ]);
          clearTimeout(disableTimer);
          modelDisabled = true;
          summary.disabled++;
        } catch {
          modelDisabled = false;
          disabledAt = null;
          persistenceError = MODEL_TEST_REASON.FAILED_TO_DISABLE;
        }
      }
    }

    let reportedLatency = elapsedProbeMs;
    if (typeof probeResult?.latencyMs === "number" && Number.isFinite(probeResult.latencyMs) && probeResult.latencyMs >= 0) {
      reportedLatency = Math.round(probeResult.latencyMs);
    } else if (typeof probeResult?.latency === "number" && Number.isFinite(probeResult.latency) && probeResult.latency >= 0) {
      reportedLatency = Math.round(probeResult.latency);
    }

    const modelRecord = {
      tested: true,
      classification: classification.classification,
      disableEligible: classification.disableEligible,
      statusCode: classification.statusCode,
      reason: classification.reason,
      disabled: modelDisabled,
      latencyMs: reportedLatency,
    };
    if (disabledAt) modelRecord.disabledAt = disabledAt;
    if (persistenceError) modelRecord.persistenceError = persistenceError;
    setRow(modelId, modelRecord);

    if (classification.classification === MODEL_TEST_CLASSIFICATION.QUOTA_COST) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.QUOTA_EXHAUSTED;
      skipRemaining(i + 1, stopReason);
      break;
    }

    if (classification.classification === MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.ACCESS_RESTRICTED;
      skipRemaining(i + 1, stopReason);
      break;
    }

    if (classification.statusCode === 401 || classification.reason === MODEL_TEST_REASON.AUTH_FAILURE) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.AUTH_FAILURE;
      skipRemaining(i + 1, stopReason);
      break;
    }

    if (classification.classification === MODEL_TEST_CLASSIFICATION.RATE_LIMITED) {
      consecutiveRateLimits++;
      consecutiveBotBlocks = 0;
      if (consecutiveRateLimits >= rateLimitThreshold) {
        stoppedEarly = true;
        stopReason = MODEL_TEST_REASON.CONSECUTIVE_RATE_LIMITS;
        skipRemaining(i + 1, stopReason);
        break;
      }
    } else if (
      classification.statusCode === 403 &&
      classification.classification === MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE
    ) {
      consecutiveBotBlocks++;
      consecutiveRateLimits = 0;
      if (consecutiveBotBlocks >= botBlockThreshold) {
        stoppedEarly = true;
        stopReason = MODEL_TEST_REASON.CONSECUTIVE_BOT_BLOCKS;
        skipRemaining(i + 1, stopReason);
        break;
      }
    } else {
      consecutiveRateLimits = 0;
      consecutiveBotBlocks = 0;
    }

    if (signal?.aborted) {
      stoppedEarly = true;
      stopReason = MODEL_TEST_REASON.ABORTED;
      skipRemaining(i + 1, stopReason);
      break;
    }

    if (i < sanitizedIds.length - 1) {
      let retrySeconds = null;
      const headerVal = extractRetryAfterHeader(probeResult);
      if (headerVal != null) retrySeconds = parseRetryAfter(headerVal);
      if (retrySeconds == null) retrySeconds = upstreamRetryDelaySeconds(probeResult?.body || probeResult);

      const retryAfterMs =
        retrySeconds != null && Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.round(retrySeconds * 1000)
          : 0;

      const delayMs = Math.max(intervalMs, retryAfterMs);

      if (Date.now() + delayMs > startTime + maxBatchDurationMs) {
        stoppedEarly = true;
        stopReason = MODEL_TEST_REASON.BATCH_TIMEOUT;
        skipRemaining(i + 1, stopReason);
        break;
      }

      await sleepFn(delayMs, { signal });

      if (signal?.aborted) {
        stoppedEarly = true;
        stopReason = MODEL_TEST_REASON.ABORTED;
        skipRemaining(i + 1, stopReason);
        break;
      }
    }
  }

  return {
    batchId,
    results,
    summary,
    stoppedEarly,
    stopReason,
  };
}

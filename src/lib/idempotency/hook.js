/**
 * Request-path hook and middleware for Idempotency-Key support in KhatamRouter.
 *
 * Implements:
 * - specs/0075-bun-only-redis-default/contracts/idempotency.md
 * - Opt-in Idempotency-Key on non-streaming inference requests.
 * - Same key + identical payload -> replay cached response (0 upstream calls)
 * - Same key + conflicting payload -> 422 error
 * - In-flight concurrent duplicate -> wait or 409 error
 * - Streaming or error responses -> not cached, locks released
 */

import {
  getIdempotencyStore,
  isStreamingRequest,
} from "./idempotencyStore.js";

/**
 * Extract Idempotency-Key header value case-insensitively from a request.
 */
export function extractIdempotencyKey(req) {
  if (!req?.headers) return undefined;
  if (typeof req.headers.get === "function") {
    return req.headers.get("idempotency-key") || req.headers.get("Idempotency-Key") || undefined;
  }
  return req.headers["idempotency-key"] ||
    req.headers["Idempotency-Key"] ||
    req.headers["IDEMPOTENCY-KEY"] ||
    undefined;
}

/**
 * Pre-request hook checking idempotency cache and locking in-flight.
 *
 * @param {Object} options
 * @param {Object} options.req - Incoming HTTP request (NextRequest or Node req)
 * @param {Object|string} options.body - Parsed or raw request body
 * @param {string} options.apiKey - Authenticated API key or token
 * @param {IdempotencyStore} [options.store] - Optional store instance
 * @param {boolean} [options.waitForInFlight] - If true, polls for concurrent request completion
 * @returns {Promise<Object>}
 */
export async function handleIdempotencyPreRequest({
  req,
  body,
  apiKey,
  store = getIdempotencyStore(),
  waitForInFlight = false,
}) {
  const idempotencyKey = extractIdempotencyKey(req);

  // If no header or request is streaming, proceed without protection
  if (!idempotencyKey || isStreamingRequest(req, body)) {
    return { shouldProceed: true, bypass: true };
  }

  const result = await store.acquire({
    apiKey,
    idempotencyKey,
    body,
    req,
    waitForInFlight,
  });

  if (!result.proceed) {
    return {
      shouldProceed: false,
      replayed: Boolean(result.replayed),
      conflict: Boolean(result.conflict),
      inFlight: Boolean(result.inFlight),
      response: result.response || result.error,
    };
  }

  return {
    shouldProceed: true,
    bypass: Boolean(result.bypass),
    context: result,
  };
}

/**
 * Post-request hook saving completed outcome or releasing in-flight lock on failure.
 *
 * @param {Object} options
 * @param {IdempotencyStore} [options.store] - Store instance
 * @param {Object} options.context - Context returned from handleIdempotencyPreRequest
 * @param {Object|string} options.body - Request body
 * @param {Object} [options.response] - Upstream response object { status, headers, body }
 * @param {Error} [options.error] - Upstream error if thrown
 */
export async function handleIdempotencyPostRequest({
  store = getIdempotencyStore(),
  context,
  body,
  response,
  error,
}) {
  if (!context || context.bypass) return;

  const status = response?.status !== undefined ? response.status : 200;
  if (error || status >= 400) {
    await store.release({ redisKey: context.redisKey });
  } else if (response) {
    await store.saveComplete({
      redisKey: context.redisKey,
      apiKeyHash: context.apiKeyHash,
      idempotencyKey: context.idempotencyKey,
      body,
      response,
    });
  }
}

/**
 * Higher-order function wrapping request execution with full idempotency lifecycle.
 *
 * @param {Object} options
 * @param {Object} options.req - Incoming request
 * @param {Object|string} options.body - Request body
 * @param {string} options.apiKey - Authenticated API key
 * @param {IdempotencyStore} [options.store] - Optional store
 * @param {boolean} [options.waitForInFlight] - Whether to poll for in-flight completion
 * @param {Function} executeFn - Function executing upstream request
 * @returns {Promise<Object>} Response object
 */
export async function withIdempotency(options, executeFn) {
  const { req, body, apiKey, store = getIdempotencyStore(), waitForInFlight = false } = options;

  const pre = await handleIdempotencyPreRequest({
    req,
    body,
    apiKey,
    store,
    waitForInFlight,
  });

  if (!pre.shouldProceed) {
    return pre.response;
  }

  if (pre.bypass) {
    return await executeFn();
  }

  try {
    const response = await executeFn();
    await handleIdempotencyPostRequest({
      store,
      context: pre.context,
      body,
      response,
    });
    return response;
  } catch (err) {
    await handleIdempotencyPostRequest({
      store,
      context: pre.context,
      body,
      error: err,
    });
    throw err;
  }
}

/**
 * Redis-backed Idempotency Key response caching and replay store for KhatamRouter.
 *
 * Implements:
 * - Contract: specs/0075-bun-only-redis-default/contracts/idempotency.md
 * - User Story: specs/0075-bun-only-redis-default/spec.md (US5, Scenarios 1-8)
 * - FR-022, FR-023: Opt-in Idempotency-Key on non-streaming chat requests,
 *   stored keyed by (apiKeyHash, idempotencyKey) with bodyHash + state(in_flight|complete) + result + TTL.
 *
 * Rules:
 * - Streaming requests (stream: true / isStreaming: true) bypass storage and replay.
 * - Same key + identical payload returns stored response with `Idempotency-Replayed: true` (0 upstream calls).
 * - Same key + different payload returns HTTP 422 conflict.
 * - In-flight concurrent duplicate waits for resolution or returns HTTP 409 conflict.
 * - Scoped per API key: two keys using the same value never collide.
 * - Error responses (4xx/5xx) and streaming responses are NOT cached; in-flight locks are cleared.
 * - Redis unreachable/error fails open, logs warning once, and proceeds without blocking.
 */

import { createHash } from "node:crypto";
import {
  getRedisClient,
  isRedisConfigured,
  withRedisKey,
} from "../redis/client.js";

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes
export const DEFAULT_IN_FLIGHT_TTL_SECONDS = 60; // 1 minute in-flight lock
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-\.\:]+$/;

export const STATE_IN_FLIGHT = "in_flight";
export const STATE_COMPLETE = "complete";

/**
 * Hash an API key / token into a 64-char hex SHA-256 digest.
 */
export function hashKey(rawKey) {
  const trimmed = String(rawKey || "").trim();
  if (!trimmed) return "anonymous";
  return createHash("sha256").update(trimmed).digest("hex");
}

/**
 * Hash request body payload into a 64-char hex SHA-256 digest.
 */
export function hashBody(body) {
  if (body == null) return createHash("sha256").update("").digest("hex");
  if (typeof body === "string") return createHash("sha256").update(body).digest("hex");
  if (Buffer.isBuffer(body)) return createHash("sha256").update(body).digest("hex");
  try {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
  } catch {
    return createHash("sha256").update(String(body)).digest("hex");
  }
}

/**
 * Build Redis key for idempotency record:
 * `khatam:idempotency:<apiKeyHash>:<idempotencyKey>`
 */
export function buildRedisKey(apiKeyHash, idempotencyKey) {
  return withRedisKey(`idempotency:${apiKeyHash}:${idempotencyKey}`);
}

/**
 * Validate Idempotency-Key header value format (1-256 chars, ^[A-Za-z0-9_\-\.\:]+$).
 */
export function isValidIdempotencyKey(key) {
  if (typeof key !== "string") return false;
  if (key.length < 1 || key.length > 256) return false;
  return IDEMPOTENCY_KEY_REGEX.test(key);
}

/**
 * Detect whether a request is streaming (must bypass idempotency storage).
 */
export function isStreamingRequest(req, body) {
  if (body && (body.stream === true || body.stream === "true" || body.isStreaming === true)) {
    return true;
  }
  if (req) {
    if (req.query && (req.query.stream === true || req.query.stream === "true")) {
      return true;
    }
    if (req.url) {
      try {
        const url = new URL(req.url, "http://localhost");
        if (url.searchParams.get("stream") === "true") return true;
      } catch {
        if (typeof req.url === "string" && req.url.includes("stream=true")) return true;
      }
    }
    const accept = typeof req.headers?.get === "function"
      ? req.headers.get("accept")
      : req.headers?.accept;
    if (accept && String(accept).includes("text/event-stream")) {
      return true;
    }
  }
  return false;
}

/**
 * Standard HTTP 422 Conflict error response for payload mismatch.
 */
export function createConflictResponse() {
  return {
    status: 422,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      error: {
        message: "Idempotency-Key reuse with conflicting request payload",
        type: "invalid_request_error",
        code: "idempotency_conflict",
      },
    },
  };
}

/**
 * Standard HTTP 409 Conflict error response for in-flight concurrent execution.
 */
export function createInProgressResponse() {
  return {
    status: 409,
    headers: {
      "Retry-After": "2",
      "Content-Type": "application/json",
    },
    body: {
      error: {
        message: "A request with this Idempotency-Key is currently in progress",
        type: "conflict_error",
        code: "request_in_progress",
      },
    },
  };
}

/**
 * Standard HTTP 400 Bad Request error response for malformed Idempotency-Key header.
 */
export function createInvalidKeyResponse() {
  return {
    status: 400,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      error: {
        message: "Invalid Idempotency-Key header: must be 1-256 characters matching ^[A-Za-z0-9_\\-\\.\\:]+$",
        type: "invalid_request_error",
        code: "invalid_idempotency_key",
      },
    },
  };
}

export class IdempotencyStore {
  constructor(options = {}) {
    this.customClient = options.client !== undefined ? options.client : undefined;
    this.ttlSeconds = Number(options.ttlSeconds) || DEFAULT_IDEMPOTENCY_TTL_SECONDS;
    this.inFlightTtlSeconds = Number(options.inFlightTtlSeconds) || DEFAULT_IN_FLIGHT_TTL_SECONDS;
    this.pollTimeoutMs = Number(options.pollTimeoutMs) || 10000;
    this.pollIntervalMs = Number(options.pollIntervalMs) || 50;
    this.warned = false;
  }

  getClient() {
    if (this.customClient !== undefined) return this.customClient;
    if (!isRedisConfigured()) return null;
    return getRedisClient();
  }

  _warnRedisError(err, context = "") {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[idempotency] Redis error during key check, proceeding without idempotency protection`);
  }

  resetWarned() {
    this.warned = false;
  }

  /**
   * Raw get of stored record.
   */
  async get(key) {
    try {
      const client = this.getClient();
      if (!client) return null;
      const raw = await client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      this._warnRedisError(err, "get");
      return null;
    }
  }

  /**
   * Raw set of stored record with TTL.
   */
  async set(key, record, ttlSeconds = this.ttlSeconds) {
    try {
      const client = this.getClient();
      if (!client) return false;
      const serialized = typeof record === "string" ? record : JSON.stringify(record);
      await client.set(key, serialized, "EX", ttlSeconds);
      return true;
    } catch (err) {
      this._warnRedisError(err, "set");
      return false;
    }
  }

  /**
   * Raw deletion of record (e.g. on upstream failure / timeout).
   */
  async delete(key) {
    try {
      const client = this.getClient();
      if (!client) return false;
      await client.del(key);
      return true;
    } catch (err) {
      this._warnRedisError(err, "delete");
      return false;
    }
  }

  /**
   * Acquire idempotency lock or inspect existing outcome.
   *
   * Returns:
   * - `{ proceed: true, acquired: true, redisKey, apiKeyHash, idempotencyKey, bodyHash }`
   *     -> Caller executes upstream.
   * - `{ proceed: true, bypass: true }`
   *     -> No header, streaming request, or Redis unreachable: proceed without caching.
   * - `{ proceed: false, replayed: true, response }`
   *     -> Identical request found in cache: replay response immediately.
   * - `{ proceed: false, conflict: true, error }`
   *     -> Same key with conflicting payload: return HTTP 422.
   * - `{ proceed: false, inFlight: true, error }`
   *     -> Another request with this key is running: return HTTP 409.
   * - `{ proceed: false, error }`
   *     -> Invalid key format: return HTTP 400.
   */
  async acquire({ apiKey, idempotencyKey, body, req, waitForInFlight = false }) {
    if (!idempotencyKey) {
      return { proceed: true, bypass: true };
    }

    if (isStreamingRequest(req, body)) {
      return { proceed: true, bypass: true };
    }

    if (!isValidIdempotencyKey(idempotencyKey)) {
      return {
        proceed: false,
        error: createInvalidKeyResponse(),
      };
    }

    const client = this.getClient();
    if (!client) {
      this._warnRedisError("Redis client unavailable");
      return { proceed: true, bypass: true };
    }

    const apiKeyHash = hashKey(apiKey);
    const bodyHash = hashBody(body);
    const redisKey = buildRedisKey(apiKeyHash, idempotencyKey);

    try {
      const inFlightPayload = JSON.stringify({
        state: STATE_IN_FLIGHT,
        bodyHash,
        createdAt: Date.now(),
      });

      // Atomic acquire with SET NX EX
      const lockResult = await client.set(redisKey, inFlightPayload, "EX", this.inFlightTtlSeconds, "NX");
      if (lockResult === "OK") {
        return {
          proceed: true,
          acquired: true,
          redisKey,
          apiKeyHash,
          idempotencyKey,
          bodyHash,
        };
      }

      // Key already exists. Read existing record.
      let raw = await client.get(redisKey);
      if (!raw) {
        // Transient race: key might have expired immediately, attempt re-acquire
        const retry = await client.set(redisKey, inFlightPayload, "EX", this.inFlightTtlSeconds, "NX");
        if (retry === "OK") {
          return {
            proceed: true,
            acquired: true,
            redisKey,
            apiKeyHash,
            idempotencyKey,
            bodyHash,
          };
        }
        raw = await client.get(redisKey);
      }

      if (!raw) {
        return { proceed: true, bypass: true };
      }

      let existing;
      try {
        existing = JSON.parse(raw);
      } catch {
        return { proceed: true, bypass: true };
      }

      // Check payload conflict
      if (existing.bodyHash !== bodyHash) {
        return {
          proceed: false,
          conflict: true,
          error: createConflictResponse(),
        };
      }

      // Identical payload: check state
      if (existing.state === STATE_COMPLETE) {
        return {
          proceed: false,
          replayed: true,
          record: existing,
          response: {
            status: existing.response?.status || 200,
            headers: {
              ...(existing.response?.headers || {}),
              "Idempotency-Replayed": "true",
            },
            body: existing.response?.body,
          },
        };
      }

      if (existing.state === STATE_IN_FLIGHT) {
        if (waitForInFlight) {
          const deadline = Date.now() + this.pollTimeoutMs;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
            let pollRaw;
            try {
              pollRaw = await client.get(redisKey);
            } catch {
              break;
            }

            if (!pollRaw) {
              // Lock released or expired, try re-acquiring
              try {
                const retryAcquire = await client.set(redisKey, inFlightPayload, "EX", this.inFlightTtlSeconds, "NX");
                if (retryAcquire === "OK") {
                  return {
                    proceed: true,
                    acquired: true,
                    redisKey,
                    apiKeyHash,
                    idempotencyKey,
                    bodyHash,
                  };
                }
              } catch {}
              continue;
            }

            try {
              const pollRecord = JSON.parse(pollRaw);
              if (pollRecord.bodyHash !== bodyHash) {
                return {
                  proceed: false,
                  conflict: true,
                  error: createConflictResponse(),
                };
              }
              if (pollRecord.state === STATE_COMPLETE) {
                return {
                  proceed: false,
                  replayed: true,
                  record: pollRecord,
                  response: {
                    status: pollRecord.response?.status || 200,
                    headers: {
                      ...(pollRecord.response?.headers || {}),
                      "Idempotency-Replayed": "true",
                    },
                    body: pollRecord.response?.body,
                  },
                };
              }
            } catch {}
          }
          // Polling timed out: return in-flight conflict error
          return {
            proceed: false,
            inFlight: true,
            error: createInProgressResponse(),
          };
        } else {
          // Immediate in-flight conflict error
          return {
            proceed: false,
            inFlight: true,
            error: createInProgressResponse(),
          };
        }
      }

      return { proceed: true, bypass: true };
    } catch (err) {
      this._warnRedisError(err, "acquire");
      return { proceed: true, bypass: true };
    }
  }

  /**
   * Save completed response outcome to Redis with TTL.
   * If response was an error (status >= 400), deletes the in-flight lock instead.
   */
  async saveComplete({ redisKey, apiKey, idempotencyKey, body, response, ttlSeconds = this.ttlSeconds }) {
    if (!response) return;
    const status = response.status !== undefined ? response.status : 200;

    // Error responses (4xx/5xx) are NOT stored for replay: release in-flight lock immediately
    if (status >= 400) {
      await this.release({ redisKey, apiKey, idempotencyKey });
      return;
    }

    // Streaming responses are NOT stored
    const headers = response.headers || {};
    const contentType = typeof headers.get === "function"
      ? headers.get("content-type")
      : (headers["content-type"] || headers["Content-Type"]);
    if (contentType && String(contentType).includes("text/event-stream")) {
      await this.release({ redisKey, apiKey, idempotencyKey });
      return;
    }

    try {
      const client = this.getClient();
      if (!client) return;

      const targetKey = redisKey || (apiKey && idempotencyKey ? buildRedisKey(hashKey(apiKey), idempotencyKey) : null);
      if (!targetKey) return;

      let serializedHeaders = {};
      if (typeof headers.forEach === "function") {
        headers.forEach((val, key) => {
          serializedHeaders[key] = val;
        });
      } else if (typeof headers === "object") {
        serializedHeaders = { ...headers };
      }

      const completeRecord = {
        state: STATE_COMPLETE,
        bodyHash: hashBody(body),
        response: {
          status,
          headers: serializedHeaders,
          body: response.body !== undefined ? response.body : null,
        },
        createdAt: Date.now(),
        completedAt: Date.now(),
      };

      await client.set(targetKey, JSON.stringify(completeRecord), "EX", ttlSeconds);
    } catch (err) {
      this._warnRedisError(err, "saveComplete");
    }
  }

  /**
   * Release in-flight lock on failure or exception so client retries are not blocked.
   */
  async release({ redisKey, apiKey, idempotencyKey }) {
    try {
      const client = this.getClient();
      if (!client) return;
      const targetKey = redisKey || (apiKey && idempotencyKey ? buildRedisKey(hashKey(apiKey), idempotencyKey) : null);
      if (!targetKey) return;
      await client.del(targetKey);
    } catch (err) {
      this._warnRedisError(err, "release");
    }
  }
}

let defaultStore = null;

export function getIdempotencyStore(options) {
  if (options || !defaultStore) {
    const store = new IdempotencyStore(options);
    if (!options) defaultStore = store;
    return store;
  }
  return defaultStore;
}

export function resetIdempotencyStore() {
  defaultStore = null;
}

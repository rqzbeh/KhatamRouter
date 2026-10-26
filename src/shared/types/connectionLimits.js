/**
 * Connection Limits and Overrides matching contracts/connection-limits.json
 *
 * Stored as a JSON string in SQLite table providerConnections.rate_limit_overrides_json
 */

/**
 * @typedef {Object} ConnectionLimitOverrides
 * @property {number} [rpm] - Maximum requests admitted per minute (integer >= 1)
 * @property {number} [rpd] - Maximum requests admitted per day (UTC calendar day) (integer >= 1)
 * @property {number} [tpm] - Maximum tokens admitted per minute (integer >= 1)
 * @property {number} [tpd] - Maximum tokens admitted per day (integer >= 1)
 * @property {number} [minTime] - Minimum delay in milliseconds required between consecutive request dispatches (> 0)
 * @property {number} [maxConcurrent] - Maximum in-flight concurrent requests allowed to this connection (integer >= 1)
 * @property {number} [maxWaitMs] - Queue wait timeout in milliseconds before failing (> 0)
 * @property {number} [executionMaxWaitMs] - Upstream response timeout in milliseconds (> 0)
 * @property {Record<string, number>} [modelConcurrency] - Per-model in-flight concurrency caps (modelId -> integer >= 1)
 * @property {number} [maxBudgetUsd] - Lifetime or billing cycle budget ceiling in USD (>= 0). Stored and displayed.
 */

/**
 * @typedef {Object} ModelConcurrencyRow
 * @property {string} model
 * @property {string} concurrency
 */

/**
 * @typedef {Object} ConnectionLimitsFormState
 * @property {string} rpm
 * @property {string} rpd
 * @property {string} tpm
 * @property {string} tpd
 * @property {string} minTime
 * @property {string} maxConcurrent
 * @property {string} maxWaitMs
 * @property {string} executionMaxWaitMs
 * @property {string} maxBudgetUsd
 * @property {ModelConcurrencyRow[]} modelConcurrency
 */

/**
 * @typedef {Object} ConnectionLimitsValidationErrors
 * @property {string} [rpm]
 * @property {string} [rpd]
 * @property {string} [tpm]
 * @property {string} [tpd]
 * @property {string} [minTime]
 * @property {string} [maxConcurrent]
 * @property {string} [maxWaitMs]
 * @property {string} [executionMaxWaitMs]
 * @property {string} [maxBudgetUsd]
 * @property {Record<string, string>} [modelConcurrency]
 * @property {string} [general]
 */

/**
 * @typedef {Object} ConnectionLimitsFormValidationResult
 * @property {boolean} isValid
 * @property {ConnectionLimitsValidationErrors} errors
 * @property {ConnectionLimitOverrides} sanitized
 */

/**
 * @typedef {Object} ConnectionLimitsApiResponse
 * @property {string} [connectionId]
 * @property {ConnectionLimitOverrides} limits
 * @property {string} [error]
 * @property {string[]} [errors]
 */

export const CONNECTION_LIMIT_FIELDS = [
  "rpm",
  "rpd",
  "tpm",
  "tpd",
  "minTime",
  "maxConcurrent",
  "maxWaitMs",
  "executionMaxWaitMs",
  "maxBudgetUsd",
  "modelConcurrency",
];

/**
 * TypeScript interfaces for Connection Limits and Overrides matching
 * contracts/connection-limits.json
 *
 * Stored as a JSON string in SQLite table providerConnections.rate_limit_overrides_json
 */

export interface ConnectionLimitOverrides {
  /** Maximum requests admitted per minute (integer >= 1) */
  rpm?: number;
  /** Maximum requests admitted per day (UTC calendar day) (integer >= 1) */
  rpd?: number;
  /** Maximum tokens admitted per minute (integer >= 1) */
  tpm?: number;
  /** Maximum tokens admitted per day (integer >= 1) */
  tpd?: number;
  /** Minimum delay in milliseconds required between consecutive request dispatches (> 0) */
  minTime?: number;
  /** Maximum in-flight concurrent requests allowed to this connection (integer >= 1) */
  maxConcurrent?: number;
  /** Queue wait timeout in milliseconds before failing (> 0) */
  maxWaitMs?: number;
  /** Upstream response timeout in milliseconds (> 0) */
  executionMaxWaitMs?: number;
  /** Per-model in-flight concurrency caps (modelId -> integer >= 1) */
  modelConcurrency?: Record<string, number>;
  /**
   * Lifetime or billing cycle budget ceiling in USD (>= 0).
   * Stored and displayed; request-time budget enforcement is an explicit out-of-scope follow-up.
   */
  maxBudgetUsd?: number;
}

export interface ModelConcurrencyRow {
  model: string;
  concurrency: string;
}

export interface ConnectionLimitsFormState {
  rpm: string;
  rpd: string;
  tpm: string;
  tpd: string;
  minTime: string;
  maxConcurrent: string;
  maxWaitMs: string;
  executionMaxWaitMs: string;
  maxBudgetUsd: string;
  modelConcurrency: ModelConcurrencyRow[];
}

export interface ConnectionLimitsValidationErrors {
  rpm?: string;
  rpd?: string;
  tpm?: string;
  tpd?: string;
  minTime?: string;
  maxConcurrent?: string;
  maxWaitMs?: string;
  executionMaxWaitMs?: string;
  maxBudgetUsd?: string;
  modelConcurrency?: Record<string, string>;
  general?: string;
}

export interface ConnectionLimitsFormValidationResult {
  isValid: boolean;
  errors: ConnectionLimitsValidationErrors;
  sanitized: ConnectionLimitOverrides;
}

export interface ConnectionLimitsApiResponse {
  connectionId?: string;
  limits: ConnectionLimitOverrides;
  error?: string;
  errors?: string[];
}

# Data Model: Dashboard and Tooling

**Branch**: `spec/010-wave8-dashboard-tooling`  
**Date**: 2026-10-26  
**Status**: Completed  

---

## 1. Connection Limits Data Model (`ConnectionLimitOverrides`)

Stored as JSON string in SQLite table `providerConnections.rate_limit_overrides_json`:

```typescript
export interface ConnectionLimitOverrides {
  /** Maximum requests admitted per minute */
  rpm?: number;
  /** Maximum requests admitted per day (UTC calendar day) */
  rpd?: number;
  /** Maximum tokens admitted per minute */
  tpm?: number;
  /** Maximum tokens admitted per day */
  tpd?: number;
  /** Minimum spacing in milliseconds required between consecutive request dispatches */
  minTime?: number;
  /** Maximum in-flight concurrent requests allowed to this connection */
  maxConcurrent?: number;
  /** Maximum time in milliseconds a request may wait in queue for an available slot before failing */
  maxWaitMs?: number;
  /** Maximum execution timeout in milliseconds for upstream HTTP response */
  executionMaxWaitMs?: number;
  /** Per-model in-flight concurrency caps (modelId -> max concurrent requests) */
  modelConcurrency?: Record<string, number>;
  /** Optional lifetime or billing cycle USD budget cap */
  maxBudgetUsd?: number;
}
```

### Validation Rules
- All rate, spacing, and timeout numeric values must be positive, finite numbers (`> 0`).
- `rpm`, `rpd`, `tpm`, `tpd`, and `maxConcurrent` must be floored to positive integers.
- `modelConcurrency` keys must be non-empty strings, values positive integers.
- `maxBudgetUsd` must be a non-negative finite number (`>= 0`).
- Unknown keys are stripped during sanitization via `sanitizeConnectionLimitOverrides()`.

### Enforcement Invariant & Scope
- In-flight gateway enforcement (`connectionLimiter.js`) checks `minTime`, `maxConcurrent`, `modelConcurrency`, `rpm`, `rpd`, `tpm`, and `tpd`.
- Connection-level budget enforcement does NOT exist at runtime today because `request_cost_ledger` currently aggregates costs by `api_key_id` and does not record connection IDs. Dashboard tooling scopes `maxBudgetUsd` strictly to STORING and DISPLAYING in the dashboard and backend validator (`overrides.js`). Request-time budget blocking is an explicit out-of-scope follow-up.

---

## 2. API Key Quota & Utilization Data Model

Backed by existing database tables `api_key_quota_limits`, `api_key_quota_counters`, and `request_cost_ledger`:

```typescript
export type QuotaWindowType =
  | "rpm"
  | "rph"
  | "rpd"
  | "tpm"
  | "tpd"
  | "daily_usd"
  | "weekly_usd"
  | "monthly_usd";

export interface ApiKeyQuotaLimit {
  id: string;
  apiKey: string; // Plaintext or hashed key
  windowType: QuotaWindowType;
  limitValue: number;
  action: "reject" | "warn" | "throttle";
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyQuotaUtilization {
  keyId: string;
  keyName: string;
  limits: Array<{
    windowType: QuotaWindowType;
    limit: number;
    used: number;
    remaining: number;
    utilizationPercent: number;
    resetMs: number;
    resetsAtIso: string;
  }>;
  spendSummary: {
    todayUsd: number;
    thisWeekUsd: number;
    thisMonthUsd: number;
    totalTokensToday: number;
  };
  status: "healthy" | "warning" | "exceeded";
}

export interface SpendTrendPoint {
  timestamp: string; // ISO timestamp or bucket label (e.g. "2026-10-26 14:00")
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}
```

---

## 3. Capability Modality Data Model

```typescript
export interface ModelCapabilities {
  // Input modalities
  vision: boolean;
  pdf: boolean;
  audioInput: boolean;
  videoInput: boolean;
  // Output modalities
  imageOutput: boolean;
  audioOutput: boolean;
  // Features
  search: boolean;
  tools: boolean;
  reasoning: boolean;
  // Thinking details
  thinkingFormat: string | null;
  thinkingCanDisable: boolean;
  thinkingRange: { min: number; max: number } | null;
  thinkingEffortSupported?: boolean;
  // Token limits
  contextWindow: number;
  maxOutput: number;
}

export interface CapacityBadgeMeta {
  key: keyof ModelCapabilities;
  icon: string;         // Google Material Symbols Outlined icon name
  label: string;        // Short human-readable label
  desc: string;         // Descriptive tooltip explanation
  color: string;        // Tailwind text color class
  bgClass: string;      // Tailwind background color class
}
```

---

## 4. CLI Types (DROPPED)

DROPPED: The consolidated TypeScript CLI was superseded by the plain-JavaScript-only rule (PR #64); no TypeScript CLI ships. The published CLI remains unchanged in `cli/cli.js`.

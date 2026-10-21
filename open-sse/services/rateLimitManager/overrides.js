/**
 * Connection Limit Overrides Parser and Sanitizer.
 *
 * Strictly parses and sanitizes provider_connections.rate_limit_overrides_json:
 *  - Supported keys: rpm, rpd, tpm, tpd, minTime, maxConcurrent, maxWaitMs, executionMaxWaitMs, modelConcurrency
 *  - Unknown keys are dropped
 *  - Non-positive or non-finite numbers are rejected
 *  - modelConcurrency is strictly validated as a map of modelId -> positive integer
 */

export const ALLOWED_NUM_FIELDS = Object.freeze([
  "rpm",
  "rpd",
  "tpm",
  "tpd",
  "minTime",
  "maxConcurrent",
  "maxWaitMs",
  "executionMaxWaitMs",
]);

const INTEGER_FIELDS = new Set(["rpm", "rpd", "tpm", "tpd", "maxConcurrent"]);

/**
 * Safely parse raw JSON or return object. Returns null if invalid JSON or not an object.
 */
export function parseConnectionLimitOverrides(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return null;
}

/**
 * Strictly sanitise connection limit overrides.
 * Returns null if raw is not a valid object/string.
 * Unknown keys are dropped, non-positive or non-finite values are omitted.
 */
export function sanitizeConnectionLimitOverrides(raw) {
  const parsed = parseConnectionLimitOverrides(raw);
  if (!parsed) return null;

  const result = {};

  for (const field of ALLOWED_NUM_FIELDS) {
    if (Object.hasOwn(parsed, field)) {
      const val = parsed[field];
      if (typeof val === "number" && Number.isFinite(val) && val > 0) {
        if (INTEGER_FIELDS.has(field)) {
          const floored = Math.floor(val);
          if (floored > 0) result[field] = floored;
        } else {
          result[field] = val;
        }
      }
    }
  }

  if (
    Object.hasOwn(parsed, "modelConcurrency") &&
    typeof parsed.modelConcurrency === "object" &&
    parsed.modelConcurrency !== null &&
    !Array.isArray(parsed.modelConcurrency)
  ) {
    const sanitizedModelMap = {};
    for (const [modelKey, limitVal] of Object.entries(parsed.modelConcurrency)) {
      if (
        typeof modelKey === "string" &&
        modelKey.trim().length > 0 &&
        typeof limitVal === "number" &&
        Number.isFinite(limitVal) &&
        limitVal > 0
      ) {
        const floored = Math.floor(limitVal);
        if (floored > 0) {
          sanitizedModelMap[modelKey.trim()] = floored;
        }
      }
    }
    if (Object.keys(sanitizedModelMap).length > 0) {
      result.modelConcurrency = sanitizedModelMap;
    }
  }

  return result;
}

/**
 * Validate overrides and return detailed error diagnostics.
 */
export function validateConnectionLimitOverrides(raw) {
  const errors = [];
  const parsed = parseConnectionLimitOverrides(raw);

  if (!parsed) {
    return {
      ok: false,
      errors: ["Invalid JSON or not an object"],
      value: null,
    };
  }

  const allowedSet = new Set([...ALLOWED_NUM_FIELDS, "modelConcurrency"]);

  for (const key of Object.keys(parsed)) {
    if (!allowedSet.has(key)) {
      errors.push(`Unknown key "${key}"`);
      continue;
    }

    if (key === "modelConcurrency") {
      const val = parsed[key];
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        errors.push(`"modelConcurrency" must be an object map of model -> positive integer`);
      } else {
        for (const [m, count] of Object.entries(val)) {
          if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
            errors.push(`modelConcurrency["${m}"] must be a positive integer`);
          }
        }
      }
      continue;
    }

    const numVal = parsed[key];
    if (typeof numVal !== "number" || !Number.isFinite(numVal) || numVal <= 0) {
      errors.push(`Field "${key}" must be a positive finite number`);
    }
  }

  const sanitized = sanitizeConnectionLimitOverrides(parsed);

  return {
    ok: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    value: sanitized,
  };
}

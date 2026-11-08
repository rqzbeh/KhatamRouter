import { describe, it, expect } from "vitest";
import {
  classifyModelTestResult,
  MODEL_TEST_CLASSIFICATION,
  MODEL_TEST_REASON,
} from "@/lib/models/modelTestBatch.js";

describe("classifyModelTestResult (Spec 017 Core)", () => {
  describe("Input Defensiveness & Bounded Scanning", () => {
    it("handles null, undefined, primitives, and empty objects safely", () => {
      expect(classifyModelTestResult(null)).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: null,
        reason: MODEL_TEST_REASON.INVALID_RESULT,
      });

      expect(classifyModelTestResult(undefined)).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: null,
        reason: MODEL_TEST_REASON.INVALID_RESULT,
      });

      expect(classifyModelTestResult("plain string error")).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: null,
        reason: MODEL_TEST_REASON.INVALID_RESULT,
      });

      expect(classifyModelTestResult({})).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: null,
        reason: MODEL_TEST_REASON.TRANSPORT_INDETERMINATE,
      });
    });

    it("handles circular references without throwing", () => {
      const circular = { error: { message: "Circular probe error" } };
      circular.error.self = circular;

      const res = classifyModelTestResult(circular);
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
    });

    it("bounds scan to 2048 characters and never returns raw server text or secrets", () => {
      const secret = "sk-live-supersecretapikey123456789";
      const hugePadding = "A".repeat(4000);
      const res = classifyModelTestResult({
        status: 500,
        error: { message: `Internal server failure ${secret} ${hugePadding}` },
      });

      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.reason).toBe(MODEL_TEST_REASON.SERVER_ERROR);
      expect(JSON.stringify(res)).not.toContain(secret);
      expect(JSON.stringify(res)).not.toContain(hugePadding);
    });
  });

  describe("Success Category", () => {
    it("classifies result.ok === true as success with 200 default status", () => {
      const res = classifyModelTestResult({ ok: true });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.SUCCESS,
        disableEligible: false,
        statusCode: 200,
        reason: MODEL_TEST_REASON.SUCCESS,
      });
    });

    it("preserves explicit 200/204 status on ok === true", () => {
      const res = classifyModelTestResult({ ok: true, status: 204 });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.SUCCESS,
        disableEligible: false,
        statusCode: 204,
        reason: MODEL_TEST_REASON.SUCCESS,
      });
    });
  });

  describe("Quota Cost Category", () => {
    it("classifies HTTP 402 Payment Required as quota_cost", () => {
      const res = classifyModelTestResult({ status: 402, error: "Payment Required" });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.QUOTA_COST,
        disableEligible: false,
        statusCode: 402,
        reason: MODEL_TEST_REASON.PAYMENT_REQUIRED,
      });
    });

    it("classifies terminal billing and credit exhaustion as quota_cost", () => {
      const res = classifyModelTestResult({
        status: 429,
        body: { error: { message: "You have exceeded your billing cap or credits balance is exhausted" } },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.QUOTA_COST);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.TERMINAL_QUOTA_EXHAUSTED);
    });

    it("classifies long-period quota exhaustion patterns as quota_cost", () => {
      const res = classifyModelTestResult({
        status: 429,
        error: { message: "Daily request limit exceeded. Resets over a rolling 24-hour period." },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.QUOTA_COST);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.QUOTA_EXHAUSTED);
    });

    it("classifies CJK quota exhaustion wording as quota_cost", () => {
      const res = classifyModelTestResult({
        status: 429,
        body: "配额已耗尽，请稍后再试",
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.QUOTA_COST);
      expect(res.disableEligible).toBe(false);
    });

    it("classifies outer 503 wrapping embedded 429 quota failure as quota_cost and preserves outer 503 status", () => {
      const res = classifyModelTestResult({
        status: 503,
        body: {
          error: {
            message: "[429]: You have reached the daily limit of 60 free-model requests for your account. Retry after 11114 seconds.",
          },
        },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.QUOTA_COST);
      expect(res.disableEligible).toBe(false);
      expect(res.statusCode).toBe(503);
      expect(res.reason).toBe(MODEL_TEST_REASON.QUOTA_EXHAUSTED);
    });

    it("classifies outer 503 with embedded 429 without explicit quota conservatively as transport_indeterminate", () => {
      const res = classifyModelTestResult({
        status: 503,
        error: { message: "upstream returned [429]: Service temporarily throttled" },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.statusCode).toBe(503);
    });
  });

  describe("Rate Limited Category", () => {
    it("classifies 429 without explicit long-period quota as rate_limited", () => {
      const res = classifyModelTestResult({
        status: 429,
        error: { message: "Rate limit reached for requests per minute (RPM). Please slow down." },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.RATE_LIMITED,
        disableEligible: false,
        statusCode: 429,
        reason: MODEL_TEST_REASON.RATE_LIMITED,
      });
    });

    it("classifies structured rate_limit_exceeded code as rate_limited", () => {
      const res = classifyModelTestResult({
        status: 429,
        error: { code: "rate_limit_exceeded", message: "Too many requests" },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.RATE_LIMITED);
      expect(res.disableEligible).toBe(false);
    });
  });

  describe("Access Restriction Category", () => {
    it("classifies regional restrictions as access_restriction", () => {
      const res = classifyModelTestResult({
        status: 400,
        body: { error: { message: "User location is not supported for this API" } },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION,
        disableEligible: false,
        statusCode: 400,
        reason: MODEL_TEST_REASON.REGION_UNSUPPORTED,
      });
    });

    it("classifies unsupported country/territory signals as access_restriction", () => {
      const res = classifyModelTestResult({
        status: 403,
        error: "Country or territory not supported",
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.REGION_UNSUPPORTED);
    });

    it("classifies 403 with explicit permission denied signals as access_restriction", () => {
      const res = classifyModelTestResult({
        status: 403,
        error: { code: "permission_denied", message: "Permission denied for project resource" },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION,
        disableEligible: false,
        statusCode: 403,
        reason: MODEL_TEST_REASON.PERMISSION_DENIED,
      });
    });

    it("classifies generic 403 Cloudflare/WAF bot block as transport_indeterminate", () => {
      const res = classifyModelTestResult({
        status: 403,
        error: "Forbidden",
        body: "<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies</body></html>",
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: 403,
        reason: MODEL_TEST_REASON.FORBIDDEN,
      });
    });

    it("classifies ambiguous 'does not exist or you do not have access' as access_restriction, NOT hard failure", () => {
      const res = classifyModelTestResult({
        status: 404,
        error: {
          code: "model_not_found",
          message: "The model 'gpt-4o' does not exist or you do not have access to it.",
        },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.ACCESS_RESTRICTION);
      expect(res.disableEligible).toBe(false);
      expect(res.statusCode).toBe(404);
      expect(res.reason).toBe(MODEL_TEST_REASON.ACCESS_RESTRICTED);
    });
  });

  describe("Hard Model Failure Category (Disable Eligible)", () => {
    it("classifies explicit model_not_found code with 404 as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 404,
        error: { code: "model_not_found", message: "The model `claude-nonexistent` does not exist" },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE,
        disableEligible: true,
        statusCode: 404,
        reason: MODEL_TEST_REASON.MODEL_NOT_FOUND,
      });
    });

    it("classifies explicit unsupported_model code with 400 as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 400,
        error: { code: "unsupported_model", message: "This provider does not support model xyz" },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE,
        disableEligible: true,
        statusCode: 400,
        reason: MODEL_TEST_REASON.UNSUPPORTED_MODEL,
      });
    });

    it("classifies 410 with explicit model does not exist wording as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 410,
        body: { error: { message: "The model 'gpt-3.5-old' does not exist on this endpoint" } },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.HARD_MODEL_FAILURE);
      expect(res.disableEligible).toBe(true);
      expect(res.statusCode).toBe(410);
    });

    it("does NOT classify arbitrary 404 path/route errors as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 404,
        body: "<html>404 Not Found: Cannot POST /v1/invalid-route</html>",
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
    });

    it("does NOT classify malformed JSON / syntax error on 400 as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 400,
        error: { message: "Invalid JSON body: Unexpected token '}' at line 1" },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.BAD_REQUEST);
    });

    it("does NOT classify request schema parameter validation error on 400 as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 400,
        error: {
          code: "invalid_request_error",
          message: "Invalid request parameter: schema validation failed for model options",
        },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.BAD_REQUEST);
    });

    it("does NOT classify content-policy or safety refusal as hard_model_failure", () => {
      const res = classifyModelTestResult({
        status: 400,
        error: {
          code: "content_policy_violation",
          message: "The prompt violated the safety policy: moderation blocked response",
        },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.CONTENT_REFUSAL);
    });
  });

  describe("Transport Indeterminate Category", () => {
    it("classifies 401 unauthorized as transport_indeterminate auth_failure", () => {
      const res = classifyModelTestResult({
        status: 401,
        error: { message: "Invalid API key provided" },
      });
      expect(res).toEqual({
        classification: MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE,
        disableEligible: false,
        statusCode: 401,
        reason: MODEL_TEST_REASON.AUTH_FAILURE,
      });
    });

    it("classifies 500 / 502 / 504 server errors as transport_indeterminate", () => {
      const res500 = classifyModelTestResult({ status: 500, error: "Internal Server Error" });
      expect(res500.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res500.reason).toBe(MODEL_TEST_REASON.SERVER_ERROR);

      const res502 = classifyModelTestResult({ status: 502, error: "Bad Gateway" });
      expect(res502.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res502.reason).toBe(MODEL_TEST_REASON.SERVER_ERROR);
    });

    it("classifies network errors (ECONNREFUSED, fetch failed) as transport_indeterminate network_error", () => {
      const res = classifyModelTestResult({
        error: { message: "fetch failed: connect ECONNREFUSED 127.0.0.1:8000" },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.NETWORK_ERROR);
    });

    it("classifies timeouts as transport_indeterminate timeout", () => {
      const res = classifyModelTestResult({
        error: { message: "The operation timed out: ETIMEDOUT" },
      });
      expect(res.classification).toBe(MODEL_TEST_CLASSIFICATION.TRANSPORT_INDETERMINATE);
      expect(res.disableEligible).toBe(false);
      expect(res.reason).toBe(MODEL_TEST_REASON.TIMEOUT);
    });
  });
});

"use client";

import React, { useState, useEffect } from "react";
import { cn } from "@/shared/utils/cn";

const INTEGER_KEYS = [
  "rpm",
  "rpd",
  "tpm",
  "tpd",
  "maxConcurrent",
];

const FLOAT_TIMING_KEYS = [
  "minTime",
  "maxWaitMs",
  "executionMaxWaitMs",
];

/**
 * Pure client-side validation helper for Connection Limits Form.
 *
 * @param {Object} form
 * @returns {{ isValid: boolean, errors: Object, sanitized: Object }}
 */
export function validateLimitsForm(form) {
  const errors = {};
  const sanitized = {};

  // Integer positive fields (> 0, floored)
  for (const key of INTEGER_KEYS) {
    const rawVal = form[key]?.trim();
    if (rawVal) {
      const num = Number(rawVal);
      if (!Number.isFinite(num) || num <= 0) {
        errors[key] = `${key.toUpperCase()} must be a positive integer`;
      } else {
        const floored = Math.floor(num);
        if (floored <= 0) {
          errors[key] = `${key.toUpperCase()} must be a positive integer`;
        } else {
          sanitized[key] = floored;
        }
      }
    }
  }

  // Float timing fields (> 0)
  for (const key of FLOAT_TIMING_KEYS) {
    const rawVal = form[key]?.trim();
    if (rawVal) {
      const num = Number(rawVal);
      if (!Number.isFinite(num) || num <= 0) {
        errors[key] = `${key} must be a positive number`;
      } else {
        sanitized[key] = num;
      }
    }
  }

  // maxBudgetUsd (non-negative number >= 0)
  const budgetRaw = form.maxBudgetUsd?.trim();
  if (budgetRaw) {
    const num = Number(budgetRaw);
    if (!Number.isFinite(num) || num < 0) {
      errors.maxBudgetUsd = "Budget ceiling must be a non-negative number";
    } else {
      sanitized.maxBudgetUsd = num;
    }
  }

  // modelConcurrency
  if (Array.isArray(form.modelConcurrency) && form.modelConcurrency.length > 0) {
    const modelErrors = {};
    const sanitizedModels = {};

    for (let i = 0; i < form.modelConcurrency.length; i++) {
      const row = form.modelConcurrency[i];
      const modelId = row.model?.trim();
      const concRaw = row.concurrency?.trim();

      // If both fields are empty, skip row
      if (!modelId && !concRaw) continue;

      if (!modelId) {
        modelErrors[`model_${i}`] = "Model ID is required";
      }

      if (!concRaw) {
        modelErrors[`concurrency_${i}`] = "Concurrency cap is required";
      } else {
        const concNum = Number(concRaw);
        if (!Number.isFinite(concNum) || concNum <= 0) {
          modelErrors[`concurrency_${i}`] = "Concurrency must be a positive integer";
        } else if (modelId) {
          sanitizedModels[modelId] = Math.floor(concNum);
        }
      }
    }

    if (Object.keys(modelErrors).length > 0) {
      errors.modelConcurrency = modelErrors;
    } else if (Object.keys(sanitizedModels).length > 0) {
      sanitized.modelConcurrency = sanitizedModels;
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    sanitized,
  };
}

function getInitialFormState(connection, initialLimits) {
  let limitsObj = null;
  if (initialLimits) {
    limitsObj = initialLimits;
  } else if (connection?.rate_limit_overrides_json) {
    if (typeof connection.rate_limit_overrides_json === "string") {
      try {
        limitsObj = JSON.parse(connection.rate_limit_overrides_json);
      } catch {
        limitsObj = null;
      }
    } else {
      limitsObj = connection.rate_limit_overrides_json;
    }
  }

  const modelRows = [];
  if (limitsObj?.modelConcurrency && typeof limitsObj.modelConcurrency === "object") {
    for (const [model, count] of Object.entries(limitsObj.modelConcurrency)) {
      modelRows.push({ model, concurrency: String(count) });
    }
  }

  return {
    rpm: limitsObj?.rpm !== undefined ? String(limitsObj.rpm) : "",
    rpd: limitsObj?.rpd !== undefined ? String(limitsObj.rpd) : "",
    tpm: limitsObj?.tpm !== undefined ? String(limitsObj.tpm) : "",
    tpd: limitsObj?.tpd !== undefined ? String(limitsObj.tpd) : "",
    minTime: limitsObj?.minTime !== undefined ? String(limitsObj.minTime) : "",
    maxConcurrent: limitsObj?.maxConcurrent !== undefined ? String(limitsObj.maxConcurrent) : "",
    maxWaitMs: limitsObj?.maxWaitMs !== undefined ? String(limitsObj.maxWaitMs) : "",
    executionMaxWaitMs: limitsObj?.executionMaxWaitMs !== undefined ? String(limitsObj.executionMaxWaitMs) : "",
    maxBudgetUsd: limitsObj?.maxBudgetUsd !== undefined ? String(limitsObj.maxBudgetUsd) : "",
    modelConcurrency: modelRows,
  };
}

function ModalField({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  min,
  step,
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-text-main">{label}</label>
      <input
        type={type}
        min={min}
        step={step}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className={cn(
          "w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
          "border border-border-subtle placeholder-text-muted/60",
          "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
          "transition-all duration-150 ease-out",
          error && "ring-1 ring-red-500 border-red-500/40"
        )}
      />
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[13px]">error</span>
          <span>{error}</span>
        </p>
      )}
      {hint && !error && <p className="text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

function ConnectionLimitsDialogContent({
  onClose,
  connection,
  initialLimits,
  onSave,
}) {
  const [form, setForm] = useState(() =>
    getInitialFormState(connection, initialLimits)
  );
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [onClose]);

  const handleFieldChange = (field) => (e) => {
    const value = e.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const handleAddModelRow = () => {
    setForm((prev) => ({
      ...prev,
      modelConcurrency: [...prev.modelConcurrency, { model: "", concurrency: "" }],
    }));
  };

  const handleRemoveModelRow = (index) => {
    setForm((prev) => {
      const nextModels = [...prev.modelConcurrency];
      nextModels.splice(index, 1);
      return { ...prev, modelConcurrency: nextModels };
    });
  };

  const handleModelChange = (index, key, val) => {
    setForm((prev) => {
      const nextModels = [...prev.modelConcurrency];
      nextModels[index] = { ...nextModels[index], [key]: val };
      return { ...prev, modelConcurrency: nextModels };
    });
  };

  const handleReset = () => {
    setForm({
      rpm: "",
      rpd: "",
      tpm: "",
      tpd: "",
      minTime: "",
      maxConcurrent: "",
      maxWaitMs: "",
      executionMaxWaitMs: "",
      maxBudgetUsd: "",
      modelConcurrency: [],
    });
    setErrors({});
    setSubmitError(null);
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    setSubmitError(null);

    const validation = validateLimitsForm(form);
    if (!validation.isValid) {
      setErrors(validation.errors);
      return;
    }

    setLoading(true);
    try {
      if (connection?.id && typeof fetch === "function") {
        const res = await fetch(`/api/providers/${connection.id}/limits`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limits: validation.sanitized }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to update connection limits");
        }
      }

      if (onSave) {
        await onSave(validation.sanitized);
      }

      onClose();
    } catch (err) {
      setSubmitError(err.message || "Failed to save connection limits");
    } finally {
      setLoading(false);
    }
  };

  const title = connection?.name
    ? `Connection Limits: ${connection.name}`
    : "Connection Limits & Overrides";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in"
        onClick={onClose}
      />

      {/* Dialog window */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          "relative z-10 w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-xl",
          "flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-surface-2/40">
          <div>
            <h2 id="modal-title" className="text-base font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-brand-500 text-[20px]">tune</span>
              {title}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              Enforce per-connection dispatch rates, wait timeouts, concurrency caps, and budget ceilings.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
            title="Close dialog"
            aria-label="Close dialog"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          {submitError && (
            <div className="p-3 text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] shrink-0">error</span>
              <span>{submitError}</span>
            </div>
          )}

          {/* Section: Rate Limits */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-1 border-b border-border-subtle">
              <span className="material-symbols-outlined text-text-muted text-[16px]">speed</span>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Request &amp; Token Rates
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModalField
                label="Requests per Minute (RPM)"
                placeholder="e.g. 60"
                value={form.rpm}
                onChange={handleFieldChange("rpm")}
                error={errors.rpm}
                hint="Maximum requests dispatched per minute"
                type="number"
                min="1"
              />
              <ModalField
                label="Requests per Day (RPD)"
                placeholder="e.g. 5000"
                value={form.rpd}
                onChange={handleFieldChange("rpd")}
                error={errors.rpd}
                hint="Maximum requests admitted per calendar day"
                type="number"
                min="1"
              />
              <ModalField
                label="Tokens per Minute (TPM)"
                placeholder="e.g. 100000"
                value={form.tpm}
                onChange={handleFieldChange("tpm")}
                error={errors.tpm}
                hint="Maximum tokens processed per minute"
                type="number"
                min="1"
              />
              <ModalField
                label="Tokens per Day (TPD)"
                placeholder="e.g. 2000000"
                value={form.tpd}
                onChange={handleFieldChange("tpd")}
                error={errors.tpd}
                hint="Maximum tokens processed per calendar day"
                type="number"
                min="1"
              />
            </div>
          </div>

          {/* Section: Timing & Spacing */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-1 border-b border-border-subtle">
              <span className="material-symbols-outlined text-text-muted text-[16px]">timer</span>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Pacing &amp; Timeouts
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <ModalField
                label="Min Inter-request Time (ms)"
                placeholder="e.g. 250"
                value={form.minTime}
                onChange={handleFieldChange("minTime")}
                error={errors.minTime}
                hint="Minimum delay between dispatches"
                type="number"
                min="1"
              />
              <ModalField
                label="Max Queue Wait (ms)"
                placeholder="e.g. 15000"
                value={form.maxWaitMs}
                onChange={handleFieldChange("maxWaitMs")}
                error={errors.maxWaitMs}
                hint="Queue wait timeout before abort"
                type="number"
                min="1"
              />
              <ModalField
                label="Execution Timeout (ms)"
                placeholder="e.g. 60000"
                value={form.executionMaxWaitMs}
                onChange={handleFieldChange("executionMaxWaitMs")}
                error={errors.executionMaxWaitMs}
                hint="Upstream socket/response timeout"
                type="number"
                min="1"
              />
            </div>
          </div>

          {/* Section: Concurrency & Budget */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-1 border-b border-border-subtle">
              <span className="material-symbols-outlined text-text-muted text-[16px]">stacked_line_chart</span>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Concurrency &amp; Budget
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModalField
                label="Max In-Flight Concurrency"
                placeholder="e.g. 5"
                value={form.maxConcurrent}
                onChange={handleFieldChange("maxConcurrent")}
                error={errors.maxConcurrent}
                hint="Global in-flight request limit for connection"
                type="number"
                min="1"
              />
              <ModalField
                label="Budget Ceiling ($ USD)"
                placeholder="e.g. 50.00"
                value={form.maxBudgetUsd}
                onChange={handleFieldChange("maxBudgetUsd")}
                error={errors.maxBudgetUsd}
                hint="Stored and displayed connection budget cap"
                type="number"
                min="0"
                step="0.01"
              />
            </div>
          </div>

          {/* Section: Per-Model Concurrency Map */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-text-muted text-[16px]">account_tree</span>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Per-Model Concurrency Overrides
                </h3>
              </div>
              <button
                type="button"
                onClick={handleAddModelRow}
                className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium transition-colors"
              >
                <span className="material-symbols-outlined text-[15px]">add</span>
                Add Model Cap
              </button>
            </div>

            {form.modelConcurrency.length === 0 ? (
              <p className="text-xs text-text-muted italic py-1">
                No per-model concurrency caps configured. All models share the global connection limit.
              </p>
            ) : (
              <div className="space-y-2">
                {form.modelConcurrency.map((row, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <div className="flex-1">
                      <input
                        type="text"
                        placeholder="Model ID (e.g. gpt-4o, claude-3-5-sonnet)"
                        value={row.model}
                        onChange={(e) => handleModelChange(idx, "model", e.target.value)}
                        className={cn(
                          "w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
                          "border border-border-subtle placeholder-text-muted/60",
                          "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
                          errors.modelConcurrency?.[`model_${idx}`] && "ring-1 ring-red-500 border-red-500/40"
                        )}
                      />
                      {errors.modelConcurrency?.[`model_${idx}`] && (
                        <p className="text-[11px] text-red-500 mt-1">
                          {errors.modelConcurrency[`model_${idx}`]}
                        </p>
                      )}
                    </div>

                    <div className="w-32">
                      <input
                        type="number"
                        min="1"
                        placeholder="Max concurrent"
                        value={row.concurrency}
                        onChange={(e) => handleModelChange(idx, "concurrency", e.target.value)}
                        className={cn(
                          "w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
                          "border border-border-subtle placeholder-text-muted/60",
                          "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
                          errors.modelConcurrency?.[`concurrency_${idx}`] && "ring-1 ring-red-500 border-red-500/40"
                        )}
                      />
                      {errors.modelConcurrency?.[`concurrency_${idx}`] && (
                        <p className="text-[11px] text-red-500 mt-1">
                          {errors.modelConcurrency[`concurrency_${idx}`]}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveModelRow(idx)}
                      className="p-2 text-text-muted hover:text-red-500 transition-colors mt-0.5 rounded-lg hover:bg-surface-2"
                      title="Remove model cap"
                      aria-label="Remove model cap"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-border-subtle bg-surface-2/30">
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-text-muted hover:text-red-500 transition-colors flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-surface-2"
          >
            <span className="material-symbols-outlined text-[15px]">restart_alt</span>
            Reset to Defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-3.5 py-1.5 text-xs font-medium text-text-main bg-surface-2 hover:bg-surface-3 rounded-lg border border-border-subtle transition-all duration-150"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className={cn(
                "px-4 py-1.5 text-xs font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg",
                "shadow-sm transition-all duration-150 flex items-center gap-1.5",
                loading && "opacity-70 cursor-not-allowed"
              )}
            >
              {loading && <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>}
              Save Limits
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Dedicated React dialog for configuring per-connection rate limits,
 * concurrency caps, inter-request pacing, and budget ceilings.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {Object} [props.connection]
 * @param {Object} [props.initialLimits]
 * @param {(limits: Object) => Promise<void> | void} [props.onSave]
 */
export default function ConnectionLimitsModal({
  isOpen,
  onClose,
  connection,
  initialLimits,
  onSave,
}) {
  if (!isOpen) return null;

  return (
    <ConnectionLimitsDialogContent
      key={connection?.id || "default"}
      onClose={onClose}
      connection={connection}
      initialLimits={initialLimits}
      onSave={onSave}
    />
  );
}

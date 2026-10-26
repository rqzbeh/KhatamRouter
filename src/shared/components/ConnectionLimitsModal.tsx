"use client";

import React, { useState, useEffect } from "react";
import { cn } from "@/shared/utils/cn";
import type {
  ConnectionLimitOverrides,
  ConnectionLimitsFormState,
  ConnectionLimitsValidationErrors,
  ConnectionLimitsFormValidationResult,
  ModelConcurrencyRow,
} from "@/shared/types/connectionLimits";

const INTEGER_KEYS: Array<keyof Pick<ConnectionLimitsFormState, "rpm" | "rpd" | "tpm" | "tpd" | "maxConcurrent">> = [
  "rpm",
  "rpd",
  "tpm",
  "tpd",
  "maxConcurrent",
];

const FLOAT_TIMING_KEYS: Array<keyof Pick<ConnectionLimitsFormState, "minTime" | "maxWaitMs" | "executionMaxWaitMs">> = [
  "minTime",
  "maxWaitMs",
  "executionMaxWaitMs",
];

/**
 * Pure client-side validation helper for Connection Limits Form.
 */
export function validateLimitsForm(form: ConnectionLimitsFormState): ConnectionLimitsFormValidationResult {
  const errors: ConnectionLimitsValidationErrors = {};
  const sanitized: ConnectionLimitOverrides = {};

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
    const modelErrors: Record<string, string> = {};
    const sanitizedModels: Record<string, number> = {};

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

function getInitialFormState(
  connection?: ConnectionLimitsModalProps["connection"],
  initialLimits?: ConnectionLimitOverrides | null
): ConnectionLimitsFormState {
  let limitsObj: ConnectionLimitOverrides | null = null;
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

  const modelRows: ModelConcurrencyRow[] = [];
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

export interface ConnectionLimitsModalProps {
  isOpen: boolean;
  onClose: () => void;
  connection?: {
    id: string;
    name?: string | null;
    provider?: string | null;
    rate_limit_overrides_json?: ConnectionLimitOverrides | string | null;
  } | null;
  initialLimits?: ConnectionLimitOverrides | null;
  onSave?: (limits: ConnectionLimitOverrides) => Promise<void> | void;
}

interface ModalFieldProps {
  label: string;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  hint?: string;
  min?: string;
  step?: string;
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
}: ModalFieldProps) {
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
}: Omit<ConnectionLimitsModalProps, "isOpen">) {
  const [form, setForm] = useState<ConnectionLimitsFormState>(() =>
    getInitialFormState(connection, initialLimits)
  );
  const [errors, setErrors] = useState<ConnectionLimitsValidationErrors>({});
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [onClose]);

  const handleFieldChange = (field: keyof Omit<ConnectionLimitsFormState, "modelConcurrency">) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
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

  const handleRemoveModelRow = (index: number) => {
    setForm((prev) => {
      const nextModels = [...prev.modelConcurrency];
      nextModels.splice(index, 1);
      return { ...prev, modelConcurrency: nextModels };
    });
  };

  const handleModelChange = (index: number, key: "model" | "concurrency", val: string) => {
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

  const handleSubmit = async (e?: React.FormEvent) => {
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
    } catch (err: any) {
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
        className={cn(
          "relative w-full max-w-xl bg-surface",
          "border border-border-subtle",
          "rounded-[14px] shadow-[var(--shadow-elev)]",
          "fade-in flex flex-col max-h-[90vh]"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-brand-500 text-[20px]">tune</span>
            <h2 className="text-base font-semibold text-text-main">{title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-[8px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 custom-scrollbar">
          {submitError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-[10px] text-red-500 text-xs flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">error</span>
              <span>{submitError}</span>
            </div>
          )}

          {/* Section 1: Rate & Token Limits */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Rate & Token Limits
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModalField
                label="Requests / Minute (RPM)"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 60"
                value={form.rpm}
                onChange={handleFieldChange("rpm")}
                error={errors.rpm}
                hint="Max requests admitted per minute"
              />
              <ModalField
                label="Requests / Day (RPD)"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 5000"
                value={form.rpd}
                onChange={handleFieldChange("rpd")}
                error={errors.rpd}
                hint="Max requests per UTC calendar day"
              />
              <ModalField
                label="Tokens / Minute (TPM)"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 100000"
                value={form.tpm}
                onChange={handleFieldChange("tpm")}
                error={errors.tpm}
                hint="Max tokens admitted per minute"
              />
              <ModalField
                label="Tokens / Day (TPD)"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 2000000"
                value={form.tpd}
                onChange={handleFieldChange("tpd")}
                error={errors.tpd}
                hint="Max tokens per UTC calendar day"
              />
            </div>
          </div>

          {/* Section 2: Pacing & Timeouts */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Pacing & Queue Timeouts
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <ModalField
                label="Min Delay (ms)"
                type="number"
                min="1"
                placeholder="e.g. 250"
                value={form.minTime}
                onChange={handleFieldChange("minTime")}
                error={errors.minTime}
                hint="Inter-request spacing"
              />
              <ModalField
                label="Queue Timeout (ms)"
                type="number"
                min="1"
                placeholder="e.g. 15000"
                value={form.maxWaitMs}
                onChange={handleFieldChange("maxWaitMs")}
                error={errors.maxWaitMs}
                hint="Queue wait ceiling"
              />
              <ModalField
                label="Execution Timeout (ms)"
                type="number"
                min="1"
                placeholder="e.g. 60000"
                value={form.executionMaxWaitMs}
                onChange={handleFieldChange("executionMaxWaitMs")}
                error={errors.executionMaxWaitMs}
                hint="Upstream response timeout"
              />
            </div>
          </div>

          {/* Section 3: Concurrency & Budget Ceiling */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Concurrency & Budget Ceiling
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModalField
                label="Max In-Flight Concurrency"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 5"
                value={form.maxConcurrent}
                onChange={handleFieldChange("maxConcurrent")}
                error={errors.maxConcurrent}
                hint="Global concurrent request cap"
              />
              <ModalField
                label="Budget Ceiling (USD) — Stored & Displayed"
                type="number"
                min="0"
                step="any"
                placeholder="e.g. 100.00"
                value={form.maxBudgetUsd}
                onChange={handleFieldChange("maxBudgetUsd")}
                error={errors.maxBudgetUsd}
                hint="Cost threshold displayed in connection views"
              />
            </div>
          </div>

          {/* Section 4: Per-Model Concurrency */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Per-Model Concurrency Overrides
              </h3>
              <button
                type="button"
                onClick={handleAddModelRow}
                className="px-2 py-1 text-xs font-medium text-brand-500 hover:text-brand-600 bg-brand-500/10 hover:bg-brand-500/20 rounded-[6px] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">add</span>
                <span>Add Model Limit</span>
              </button>
            </div>

            {form.modelConcurrency.length === 0 ? (
              <p className="text-xs text-text-muted italic py-1">
                No per-model concurrency limits configured. Requests share connection-level max concurrency.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {form.modelConcurrency.map((row, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <div className="flex-1 flex flex-col gap-1">
                      <input
                        placeholder="Model ID (e.g. gpt-5.6-sol)"
                        value={row.model}
                        onChange={(e) => handleModelChange(idx, "model", e.target.value)}
                        className={cn(
                          "w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
                          "border border-border-subtle placeholder-text-muted/60",
                          "focus:outline-none focus:ring-2 focus:ring-brand-500/30",
                          errors.modelConcurrency?.[`model_${idx}`] && "ring-1 ring-red-500"
                        )}
                      />
                      {errors.modelConcurrency?.[`model_${idx}`] && (
                        <p className="text-[11px] text-red-500">{errors.modelConcurrency[`model_${idx}`]}</p>
                      )}
                    </div>
                    <div className="w-28 flex flex-col gap-1">
                      <input
                        placeholder="Cap (e.g. 2)"
                        type="number"
                        min="1"
                        step="1"
                        value={row.concurrency}
                        onChange={(e) => handleModelChange(idx, "concurrency", e.target.value)}
                        className={cn(
                          "w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
                          "border border-border-subtle placeholder-text-muted/60",
                          "focus:outline-none focus:ring-2 focus:ring-brand-500/30",
                          errors.modelConcurrency?.[`concurrency_${idx}`] && "ring-1 ring-red-500"
                        )}
                      />
                      {errors.modelConcurrency?.[`concurrency_${idx}`] && (
                        <p className="text-[11px] text-red-500">{errors.modelConcurrency[`concurrency_${idx}`]}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveModelRow(idx)}
                      className="p-2 text-text-muted hover:text-red-500 rounded-[8px] hover:bg-surface-2 transition-colors cursor-pointer"
                      title="Remove model limit"
                      aria-label="Remove model limit"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-border-subtle bg-surface-2/40">
          <button
            type="button"
            onClick={handleReset}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text-main rounded-[8px] hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50"
          >
            Clear All
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium text-text-main bg-surface-2 hover:bg-surface-3 border border-border-subtle rounded-[8px] transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[8px] shadow-sm transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            {loading && (
              <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>
            )}
            <span>Save Limits</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Dedicated TypeScript/React dialog for configuring per-connection rate limits,
 * concurrency caps, inter-request pacing, and budget ceilings.
 */
export default function ConnectionLimitsModal({
  isOpen,
  onClose,
  connection,
  initialLimits,
  onSave,
}: ConnectionLimitsModalProps) {
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

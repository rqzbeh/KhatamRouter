"use client";

import { useState, useEffect } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import {
  VALID_QUOTA_WINDOW_TYPES,
  VALID_QUOTA_ACTIONS,
  type QuotaWindowType,
  type QuotaAction,
  type ApiKeyQuotaLimit,
} from "@/shared/types/keyQuota.ts";

const ModalComponent: any = Modal;
const ButtonComponent: any = Button;
const InputComponent: any = Input;
const SelectComponent: any = Select;

export interface QuotaLimitsModalProps {
  isOpen: boolean;
  onClose: () => void;
  keyId: string;
  keyName: string;
  existingLimits?: ApiKeyQuotaLimit[];
  onSaved?: () => void;
}

const WINDOW_LABELS: Record<QuotaWindowType, string> = {
  rpm: "Requests / Minute (RPM)",
  rph: "Requests / Hour (RPH)",
  rpd: "Requests / Day (RPD)",
  tpm: "Tokens / Minute (TPM)",
  tpd: "Tokens / Day (TPD)",
  daily_usd: "Daily Budget ($ USD)",
  weekly_usd: "Weekly Budget ($ USD)",
  monthly_usd: "Monthly Budget ($ USD)",
};

interface FormLimitRow {
  windowType: QuotaWindowType;
  limitValue: string;
  action: QuotaAction;
}

export default function QuotaLimitsModal({
  isOpen,
  onClose,
  keyId,
  keyName,
  existingLimits = [],
  onSaved,
}: QuotaLimitsModalProps) {
  const [rows, setRows] = useState<FormLimitRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(null);
      if (existingLimits && existingLimits.length > 0) {
        setRows(
          existingLimits.map((lim) => ({
            windowType: lim.windowType,
            limitValue: String(lim.limitValue),
            action: lim.action || "reject",
          }))
        );
      } else {
        setRows([
          { windowType: "rpm", limitValue: "60", action: "reject" },
          { windowType: "daily_usd", limitValue: "10", action: "warn" },
        ]);
      }
    }
  }, [isOpen, existingLimits]);

  const handleAddRow = () => {
    // Pick the first unused window type if available
    const usedTypes = new Set(rows.map((r) => r.windowType));
    const nextType =
      VALID_QUOTA_WINDOW_TYPES.find((t) => !usedTypes.has(t)) || "rpm";
    setRows([...rows, { windowType: nextType, limitValue: "100", action: "reject" }]);
  };

  const handleRemoveRow = (idx: number) => {
    setRows(rows.filter((_, i) => i !== idx));
  };

  const handleRowChange = (
    idx: number,
    field: keyof FormLimitRow,
    value: string
  ) => {
    const updated = [...rows];
    updated[idx] = { ...updated[idx], [field]: value };
    setRows(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate rows
    const limitsToSave = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const num = Number(r.limitValue);
      if (!Number.isFinite(num) || num <= 0) {
        setError(`Limit for ${WINDOW_LABELS[r.windowType]} must be a positive number (> 0)`);
        return;
      }
      limitsToSave.push({
        windowType: r.windowType,
        limitValue: num,
        action: r.action,
      });
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/keys/${keyId}/quota`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limits: limitsToSave }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Server responded with ${res.status}`);
      }

      onSaved?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to update quota limits");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalComponent
      isOpen={isOpen}
      onClose={onClose}
      title={`Configure Quota: ${keyName}`}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Configure sliding-window request, token, and USD spend limits for this API key.
          Enforcement actions define how requests exceeding quotas are handled.
        </p>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-500">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2.5 max-h-[340px] overflow-y-auto pr-1">
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-subtle p-6 text-center text-xs text-text-muted">
              No quota limits configured. This API key currently has unlimited access.
            </div>
          ) : (
            rows.map((row, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg p-2.5"
              >
                <div className="flex-1 min-w-[160px]">
                  <label className="text-[10px] text-text-muted block mb-1">
                    Window Type
                  </label>
                  <SelectComponent
                    value={row.windowType}
                    onChange={(val: any) => handleRowChange(idx, "windowType", val)}
                    options={VALID_QUOTA_WINDOW_TYPES.map((t) => ({
                      value: t,
                      label: WINDOW_LABELS[t],
                    }))}
                  />
                </div>

                <div className="w-28">
                  <label className="text-[10px] text-text-muted block mb-1">
                    Limit Value
                  </label>
                  <InputComponent
                    type="number"
                    min="0.001"
                    step="any"
                    value={row.limitValue}
                    onChange={(e: any) => handleRowChange(idx, "limitValue", e.target.value)}
                    required
                  />
                </div>

                <div className="w-28">
                  <label className="text-[10px] text-text-muted block mb-1">
                    Action
                  </label>
                  <SelectComponent
                    value={row.action}
                    onChange={(val: any) => handleRowChange(idx, "action", val)}
                    options={VALID_QUOTA_ACTIONS.map((a) => ({
                      value: a,
                      label: a.charAt(0).toUpperCase() + a.slice(1),
                    }))}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => handleRemoveRow(idx)}
                  className="mt-4 p-1.5 text-text-muted hover:text-red-500 rounded-md transition-colors"
                  title="Remove limit"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle pt-3">
          <ButtonComponent
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAddRow}
          >
            <span className="material-symbols-outlined text-[16px] mr-1">add</span>
            Add Limit
          </ButtonComponent>

          <div className="flex items-center gap-2">
            <ButtonComponent type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </ButtonComponent>
            <ButtonComponent type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? "Saving..." : "Save Quota"}
            </ButtonComponent>
          </div>
        </div>
      </form>
    </ModalComponent>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { cn } from "@/shared/utils/cn";
import SpendTrendsChart from "./SpendTrendsChart";
import QuotaLimitsModal from "./QuotaLimitsModal";
import {
  formatResetTimer,
  type KeyQuotaApiResponse,
  type QuotaWindowType,
} from "@/shared/types/keyQuota.ts";

const CardComponent: any = Card;
const ButtonComponent: any = Button;
const BadgeComponent: any = Badge;

interface ApiKeySummary {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
}

const WINDOW_LABELS: Record<QuotaWindowType, string> = {
  rpm: "Requests / Minute",
  rph: "Requests / Hour",
  rpd: "Requests / Day",
  tpm: "Tokens / Minute",
  tpd: "Tokens / Day",
  daily_usd: "Daily Budget",
  weekly_usd: "Weekly Budget",
  monthly_usd: "Monthly Budget",
};

export default function KeyQuotaView() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [quotaData, setQuotaData] = useState<KeyQuotaApiResponse | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [loadingQuota, setLoadingQuota] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [period, setPeriod] = useState<"today" | "24h" | "7d" | "30d">("24h");

  // Load all API keys on mount
  const loadKeys = useCallback(async () => {
    setLoadingKeys(true);
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const json = await res.json();
        const list = json.keys || [];
        setKeys(list);
        if (list.length > 0 && !selectedKeyId) {
          setSelectedKeyId(list[0].id);
        }
      }
    } catch (err) {
      console.warn("Failed to load API keys for quota view:", err);
    } finally {
      setLoadingKeys(false);
    }
  }, [selectedKeyId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadKeys();
  }, [loadKeys]);

  // Load quota data for selected key
  const loadQuota = useCallback(async (keyId: string, currentPeriod: string) => {
    if (!keyId) return;
    setLoadingQuota(true);
    try {
      const res = await fetch(`/api/keys/${keyId}/quota?period=${currentPeriod}`);
      if (res.ok) {
        const json = await res.json();
        setQuotaData(json);
      }
    } catch (err) {
      console.warn("Failed to load key quota details:", err);
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    if (selectedKeyId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadQuota(selectedKeyId, period);
    }
  }, [selectedKeyId, period, loadQuota]);

  const selectedKey = keys.find((k) => k.id === selectedKeyId);

  const filteredKeys = keys.filter(
    (k) =>
      k.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      k.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusBadge = (status?: "healthy" | "warning" | "exceeded") => {
    if (status === "exceeded") {
      return (
        <BadgeComponent variant="error" size="sm" dot>
          Exceeded
        </BadgeComponent>
      );
    }
    if (status === "warning") {
      return (
        <BadgeComponent variant="warning" size="sm" dot>
          Warning (&gt;70%)
        </BadgeComponent>
      );
    }
    return (
      <BadgeComponent variant="success" size="sm" dot>
        Healthy
      </BadgeComponent>
    );
  };

  const getProgressBarColor = (pct: number) => {
    if (pct > 90) return "bg-red-500";
    if (pct >= 70) return "bg-amber-500";
    return "bg-emerald-500";
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Degraded mode warning if storage disconnected */}
      {quotaData?.degraded && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
          <span className="material-symbols-outlined text-[18px]">warning</span>
          <span>
            Operating in degraded mode: live quota counters or spend ledger are temporarily unavailable.
            Gateway continues routing requests without blocking.
          </span>
        </div>
      )}

      {/* Top Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CardComponent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-text-muted">Total API Keys</p>
              <h3 className="text-2xl font-bold text-text-main mt-1">
                {loadingKeys ? "..." : keys.length}
              </h3>
            </div>
            <div className="rounded-xl bg-brand-500/10 p-2.5 text-brand-500">
              <span className="material-symbols-outlined text-[24px]">key</span>
            </div>
          </div>
        </CardComponent>

        <CardComponent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-text-muted">Active Keys</p>
              <h3 className="text-2xl font-bold text-text-main mt-1">
                {loadingKeys ? "..." : keys.filter((k) => k.isActive).length}
              </h3>
            </div>
            <div className="rounded-xl bg-emerald-500/10 p-2.5 text-emerald-500">
              <span className="material-symbols-outlined text-[24px]">check_circle</span>
            </div>
          </div>
        </CardComponent>

        <CardComponent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-text-muted">Selected Key Spend Today</p>
              <h3 className="text-2xl font-bold text-text-main mt-1">
                ${(quotaData?.utilization?.spendSummary?.todayUsd || 0).toFixed(4)}
              </h3>
            </div>
            <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-500">
              <span className="material-symbols-outlined text-[24px]">payments</span>
            </div>
          </div>
        </CardComponent>

        <CardComponent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-text-muted">Selected Key Spend 30D</p>
              <h3 className="text-2xl font-bold text-text-main mt-1">
                ${(quotaData?.utilization?.spendSummary?.thisMonthUsd || 0).toFixed(4)}
              </h3>
            </div>
            <div className="rounded-xl bg-indigo-500/10 p-2.5 text-indigo-500">
              <span className="material-symbols-outlined text-[24px]">calendar_month</span>
            </div>
          </div>
        </CardComponent>
      </div>

      {/* Main Content Layout: Key Selector + Quota Inspection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: API Key Picker (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-text-main">Select API Key</h4>
            <span className="text-xs text-text-muted">{keys.length} keys</span>
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Search keys..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-brand-500"
            />
          </div>

          <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-1">
            {loadingKeys ? (
              <div className="p-8 text-center text-xs text-text-muted">Loading keys...</div>
            ) : filteredKeys.length === 0 ? (
              <div className="p-8 text-center text-xs text-text-muted">No API keys found</div>
            ) : (
              filteredKeys.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setSelectedKeyId(k.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-xl border p-3 text-left transition-all",
                    selectedKeyId === k.id
                      ? "border-brand-500 bg-brand-500/5 shadow-sm"
                      : "border-border-subtle bg-surface hover:border-brand-500/30"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-text-main truncate">
                      {k.name}
                    </span>
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        k.isActive ? "bg-emerald-500" : "bg-gray-400"
                      )}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-text-muted truncate">
                    {k.id}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right Column: Key Quota Details & Spend Trends (8 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          {selectedKey ? (
            <>
              {/* Key Detail Card */}
              <CardComponent className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-text-main">
                        {selectedKey.name}
                      </h3>
                      {getStatusBadge(quotaData?.utilization?.status)}
                    </div>
                    <p className="font-mono text-xs text-text-muted mt-1">
                      Key: <code className="bg-surface-2 px-1.5 py-0.5 rounded text-[11px]">{quotaData?.keyMasked || "••••••••"}</code>
                    </p>
                  </div>

                  <ButtonComponent
                    variant="secondary"
                    size="sm"
                    onClick={() => setModalOpen(true)}
                  >
                    <span className="material-symbols-outlined text-[16px] mr-1">tune</span>
                    Configure Quotas
                  </ButtonComponent>
                </div>

                {/* Quotas Section */}
                <div className="mt-4 flex flex-col gap-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Active Quotas &amp; Sliding Windows
                  </h4>

                  {loadingQuota ? (
                    <div className="p-6 text-center text-xs text-text-muted">
                      Loading quota counters...
                    </div>
                  ) : !quotaData?.limits || quotaData.limits.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-subtle p-6 text-center">
                      <span className="material-symbols-outlined text-[32px] text-text-muted/60 mb-2">
                        all_inclusive
                      </span>
                      <p className="text-sm font-medium text-text-main">
                        Unlimited (no quotas enforced)
                      </p>
                      <p className="text-xs text-text-muted mt-1 mb-3">
                        This key can send unlimited requests without rate, token, or budget ceilings.
                      </p>
                      <ButtonComponent
                        variant="secondary"
                        size="sm"
                        onClick={() => setModalOpen(true)}
                      >
                        Set Quota Limits
                      </ButtonComponent>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {quotaData.utilization?.limits.map((item) => {
                        const isUsd = item.windowType.includes("usd");
                        const isTokens = item.windowType.startsWith("tp");
                        const unit = isUsd ? "$" : isTokens ? "tok" : "req";

                        const formatVal = (v: number) => {
                          if (isUsd) return `$${v.toFixed(2)}`;
                          if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
                          return String(Math.round(v));
                        };

                        return (
                          <div
                            key={item.windowType}
                            className="rounded-xl border border-border-subtle bg-bg p-3.5 flex flex-col gap-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-text-main">
                                {WINDOW_LABELS[item.windowType] || item.windowType}
                              </span>
                              <BadgeComponent
                                variant={
                                  item.action === "warn"
                                    ? "warning"
                                    : item.action === "throttle"
                                    ? "info"
                                    : "error"
                                }
                                size="sm"
                              >
                                {item.action || "reject"}
                              </BadgeComponent>
                            </div>

                            {/* Progress bar */}
                            <div className="flex flex-col gap-1">
                              <div className="flex justify-between text-[11px] text-text-muted">
                                <span>
                                  {formatVal(item.used)} / {formatVal(item.limit)} {unit}
                                </span>
                                <span className="font-semibold text-text-main">
                                  {item.utilizationPercent.toFixed(1)}%
                                </span>
                              </div>
                              <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all duration-300",
                                    getProgressBarColor(item.utilizationPercent)
                                  )}
                                  style={{
                                    width: `${Math.min(100, Math.max(0, item.utilizationPercent))}%`,
                                  }}
                                />
                              </div>
                            </div>

                            {/* Reset countdown */}
                            <div className="flex items-center justify-between text-[10px] text-text-muted border-t border-border-subtle/50 pt-2">
                              <span>Window Reset:</span>
                              <span className="font-medium text-text-main flex items-center gap-1">
                                <span className="material-symbols-outlined text-[12px]">schedule</span>
                                {formatResetTimer(item.resetMs)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </CardComponent>

              {/* Spend Trends Chart */}
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold text-text-main">
                  Spend &amp; Consumption Trends
                </h4>
                <SpendTrendsChart
                  apiKeyId={selectedKey.id}
                  period={period}
                  onPeriodChange={(p) => setPeriod(p)}
                />
              </div>

              {/* Modal for editing limits */}
              <QuotaLimitsModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                keyId={selectedKey.id}
                keyName={selectedKey.name}
                existingLimits={quotaData?.limits || []}
                onSaved={() => loadQuota(selectedKey.id, period)}
              />
            </>
          ) : (
            <CardComponent className="p-12 text-center text-sm text-text-muted">
              Select an API key to inspect quota utilization and spend trends.
            </CardComponent>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import Card from "@/shared/components/Card";
import { cn } from "@/shared/utils/cn";

const CardComponent = Card;

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
];

const METRIC_MODES = [
  { value: "cost", label: "Cost ($ USD)", icon: "payments" },
  { value: "tokens", label: "Tokens", icon: "data_usage" },
  { value: "requests", label: "Requests", icon: "swap_horiz" },
];

const fmtTokens = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const fmtRequests = (n) => String(Number(n) || 0);

/**
 * SpendTrendsChart component plotting cost, token, and request trends.
 *
 * @param {Object} props
 * @param {string} [props.apiKeyId]
 * @param {Array<Object>} [props.data]
 * @param {"today" | "24h" | "7d" | "30d"} [props.period]
 * @param {(period: "today" | "24h" | "7d" | "30d") => void} [props.onPeriodChange]
 * @param {string} [props.className]
 */
export default function SpendTrendsChart({
  apiKeyId,
  data: externalData,
  period: externalPeriod,
  onPeriodChange,
  className,
}) {
  const [internalPeriod, setInternalPeriod] = useState("24h");
  const [fetchedData, setFetchedData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [metricMode, setMetricMode] = useState("cost");

  const activePeriod = externalPeriod || internalPeriod;

  const handlePeriodSelect = (p) => {
    if (onPeriodChange) {
      onPeriodChange(p);
    } else {
      setInternalPeriod(p);
    }
  };

  const fetchTrends = useCallback(async () => {
    if (!apiKeyId || externalData !== undefined) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/keys/${apiKeyId}/quota?period=${activePeriod}`);
      if (res.ok) {
        const json = await res.json();
        setFetchedData(json.spendTrends || []);
      }
    } catch (err) {
      console.warn("Failed to fetch key spend trends:", err);
    } finally {
      setLoading(false);
    }
  }, [apiKeyId, activePeriod, externalData]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTrends();
  }, [fetchTrends]);

  const displayData = externalData !== undefined ? externalData : fetchedData;

  const chartData = useMemo(() => {
    if (!displayData || displayData.length === 0) return [];
    return displayData.map((d) => ({
      ...d,
      totalTokens: d.totalTokens ?? (d.promptTokens + d.completionTokens),
    }));
  }, [displayData]);

  const hasData = chartData.some(
    (d) => (d.totalCostUsd || 0) > 0 || (d.promptTokens || 0) > 0 || (d.requestCount || 0) > 0
  );

  return (
    <CardComponent className={cn("flex flex-col gap-4 p-4", className)}>
      {/* Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
        {/* Metric Selector */}
        <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-1">
          {METRIC_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMetricMode(m.value)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                metricMode === m.value
                  ? "bg-surface text-text-main shadow-sm"
                  : "text-text-muted hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[15px]">{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>

        {/* Period Selector */}
        <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handlePeriodSelect(opt.value)}
              className={cn(
                "px-2.5 py-1 text-xs font-medium rounded-md transition-all",
                activePeriod === opt.value
                  ? "bg-surface text-text-main shadow-sm"
                  : "text-text-muted hover:text-text-main"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Body */}
      <div className="min-h-[260px] w-full">
        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-text-muted">
            <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">
              sync
            </span>
            Loading spend trends...
          </div>
        ) : !hasData ? (
          <div className="flex h-64 flex-col items-center justify-center text-center text-sm text-text-muted">
            <span className="material-symbols-outlined mb-2 text-[32px] text-text-muted/60">
              analytics
            </span>
            <p className="font-medium text-text-main">No recorded requests</p>
            <p className="text-xs text-text-muted">
              Zero requests or spend recorded for the {activePeriod} window.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradPrompt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradCompletion" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis
                dataKey="timestamp"
                tick={{ fontSize: 11 }}
                tickLine={false}
                stroke="#888888"
                tickFormatter={(val) => {
                  if (!val) return "";
                  if (val.length > 11) return val.slice(11); // HH:00
                  return val.slice(5); // MM-DD
                }}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                stroke="#888888"
                tickFormatter={(val) => {
                  if (metricMode === "cost") return `$${val.toFixed(2)}`;
                  if (metricMode === "tokens") return fmtTokens(val);
                  return fmtRequests(val);
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(23, 23, 23, 0.9)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "#ffffff",
                }}
                formatter={(val, name) => {
                  const num = Number(val) || 0;
                  if (name === "Cost") return [fmtCost(num), "Cost"];
                  if (name === "Prompt Tokens") return [fmtTokens(num), "Prompt Tokens"];
                  if (name === "Completion Tokens") return [fmtTokens(num), "Completion Tokens"];
                  if (name === "Total Tokens") return [fmtTokens(num), "Total Tokens"];
                  if (name === "Requests") return [fmtRequests(num), "Requests"];
                  return [val, name];
                }}
              />

              {metricMode === "cost" && (
                <Area
                  type="monotone"
                  dataKey="totalCostUsd"
                  name="Cost"
                  stroke="#f59e0b"
                  fillOpacity={1}
                  fill="url(#gradCost)"
                  strokeWidth={2}
                />
              )}

              {metricMode === "tokens" && (
                <>
                  <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                  <Area
                    type="monotone"
                    dataKey="promptTokens"
                    name="Prompt Tokens"
                    stackId="1"
                    stroke="#6366f1"
                    fillOpacity={1}
                    fill="url(#gradPrompt)"
                    strokeWidth={1.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="completionTokens"
                    name="Completion Tokens"
                    stackId="1"
                    stroke="#10b981"
                    fillOpacity={1}
                    fill="url(#gradCompletion)"
                    strokeWidth={1.5}
                  />
                </>
              )}

              {metricMode === "requests" && (
                <Area
                  type="monotone"
                  dataKey="requestCount"
                  name="Requests"
                  stroke="#06b6d4"
                  fillOpacity={1}
                  fill="url(#gradRequests)"
                  strokeWidth={2}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </CardComponent>
  );
}

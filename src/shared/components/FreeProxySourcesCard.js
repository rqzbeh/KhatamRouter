// Based on OmniRoute (MIT License): https://github.com/cheaper-inference/OmniRoute/tree/2a8dc2741f7c2b5ecb328e151545fbf6bc3e80ac
"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Toggle from "./Toggle";
import Badge from "./Badge";

const SOURCE_METADATA = {
  oneproxy: {
    label: "1proxy (Public API)",
    description: "Curated JSON endpoint with quality metrics and latency scoring.",
  },
  proxifly: {
    label: "Proxifly (Public Tier)",
    description: "Multi-protocol free pool with periodic upstream rotation.",
  },
  iplocate: {
    label: "IPLocate (GitHub Lists)",
    description: "Community plain-text HTTP/HTTPS proxy feeds.",
  },
};

export default function FreeProxySourcesCard({ onSynced }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [syncResult, setSyncResult] = useState(null);

  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);
  const [enabledSources, setEnabledSources] = useState({
    oneproxy: false,
    proxifly: false,
    iplocate: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/free-proxies", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const policy = data.policy || {};
        const lastSyncStats = data.lastSyncStats || policy.lastSyncStats;
        const lastSyncAt = data.lastSyncAt || policy.lastSyncAt;
        setAcknowledgedRisk(Boolean(policy.acknowledgedRisk));
        setEnabledSources({
          oneproxy: Boolean(policy.enabled?.oneproxy),
          proxifly: Boolean(policy.enabled?.proxifly),
          iplocate: Boolean(policy.enabled?.iplocate),
        });
        if (lastSyncStats) {
          setSyncResult({
            added: lastSyncStats.added,
            updated: lastSyncStats.updated,
            skipped: lastSyncStats.skipped,
            total: lastSyncStats.total,
            timestamp: lastSyncAt,
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load free proxy policy");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updatePolicy = async (nextRisk, nextSources) => {
    try {
      setSaving(true);
      setError(null);
      const res = await fetch("/api/settings/free-proxies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acknowledgedRisk: nextRisk,
          enabled: nextSources,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save settings");
      }

      setAcknowledgedRisk(Boolean(data.policy.acknowledgedRisk));
      setEnabledSources({
        oneproxy: Boolean(data.policy.enabled?.oneproxy),
        proxifly: Boolean(data.policy.enabled?.proxifly),
        iplocate: Boolean(data.policy.enabled?.iplocate),
      });
    } catch (err) {
      setError(err?.message || "Failed to update policy");
    } finally {
      setSaving(false);
    }
  };

  const handleRiskChange = (checked) => {
    const nextRisk = checked;
    // If disabling risk acknowledgment, all sources must be toggled off
    const nextSources = nextRisk ? enabledSources : { oneproxy: false, proxifly: false, iplocate: false };
    setAcknowledgedRisk(nextRisk);
    if (!nextRisk) {
      setEnabledSources(nextSources);
    }
    updatePolicy(nextRisk, nextSources);
  };

  const handleSourceToggle = (sourceKey, checked) => {
    if (!acknowledgedRisk && checked) {
      setError("Please acknowledge the public proxy risks before enabling any feed.");
      return;
    }
    const nextSources = { ...enabledSources, [sourceKey]: checked };
    setEnabledSources(nextSources);
    updatePolicy(acknowledgedRisk, nextSources);
  };

  const handleManualSync = async () => {
    try {
      setSyncing(true);
      setError(null);
      setSyncResult(null);

      const res = await fetch("/api/settings/free-proxies/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Sync failed");
      }

      setSyncResult({
        added: data.added || 0,
        updated: data.updated || 0,
        skipped: data.skipped || 0,
        pruned: data.pruned || 0,
        total: data.total || 0,
        message: data.message,
        timestamp: new Date().toISOString(),
      });
      // A sync creates and prunes pools behind the page's back; without this the
      // list on screen is stale until a manual reload.
      onSynced?.();
    } catch (err) {
      setError(err?.message || "Sync encountered an error");
    } finally {
      setSyncing(false);
    }
  };

  const hasAnyEnabled = Object.values(enabledSources).some(Boolean);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Free Proxy Feed Ingestion
          </h3>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Import public proxy candidates from open-source feeds into your proxy pools.
          </p>
        </div>
        <Badge variant={hasAnyEnabled ? "success" : "neutral"}>
          {hasAnyEnabled ? "Feeds Active" : "All Off"}
        </Badge>
      </div>

      {/* Security Warning Notice */}
      <div className="mb-6 p-4 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-sm">
        <p className="font-semibold mb-1">Security & Operational Notice:</p>
        <p className="mb-2">
          Public proxies are operated by unverified third parties. While upstream HTTPS
          connections remain TLS-encrypted, proxy operators can observe packet metadata,
          timing, and target domains. Feeds may be unstable or short-lived.
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-300">
          A sync only imports candidates that already answered the upstream through the proxy,
          and adds them to Proxy Pools as <strong>Active</strong> straight away. Each pool can
          still be switched off in the Proxy Pools view.
        </p>
      </div>

      {/* Explicit Risk Acknowledgment Checkbox */}
      <div className="mb-6 flex items-start space-x-3">
        <input
          type="checkbox"
          id="ack-risk"
          checked={acknowledgedRisk}
          disabled={loading || saving}
          onChange={(e) => handleRiskChange(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
        />
        <label htmlFor="ack-risk" className="text-sm font-medium text-neutral-800 dark:text-neutral-200 cursor-pointer">
          I acknowledge that public proxies are untrusted external nodes and accept the operational
          and privacy risks of importing them.
        </label>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Feed Sources Toggle List */}
      <div className="space-y-4 mb-6">
        {Object.entries(SOURCE_METADATA).map(([key, meta]) => {
          const isEnabled = enabledSources[key] === true;
          return (
            <div
              key={key}
              className="flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-800"
            >
              <div>
                <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {meta.label}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {meta.description}
                </div>
              </div>
              <Toggle
                checked={isEnabled}
                disabled={!acknowledgedRisk || loading || saving}
                onChange={(checked) => handleSourceToggle(key, checked)}
              />
            </div>
          );
        })}
      </div>

      {/* Manual Sync Control */}
      <div className="flex items-center justify-between pt-4 border-t border-neutral-200 dark:border-neutral-800">
        <div className="text-xs text-neutral-500">
          {syncResult?.timestamp && (
            <span>
              Last sync: {new Date(syncResult.timestamp).toLocaleTimeString()} &mdash;{" "}
              {syncResult.added} added, {syncResult.updated} updated, {syncResult.skipped} skipped
              {syncResult.pruned > 0 ? `, ${syncResult.pruned} pruned` : ""}
            </span>
          )}
        </div>
        <Button
          variant="primary"
          disabled={!hasAnyEnabled || syncing || loading}
          onClick={handleManualSync}
        >
          {syncing ? "Syncing..." : "Sync Feeds Now"}
        </Button>
      </div>
    </Card>
  );
}

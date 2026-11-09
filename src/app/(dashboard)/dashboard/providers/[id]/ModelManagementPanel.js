"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import ModelOverrideModal from "./ModelOverrideModal";

const TAB_KEYS = {
  IMPORT: "import",
  TEST: "test",
  SYNC: "sync",
  OVERRIDES: "overrides",
};

export function summarizeModelTestResults(results) {
  let passed = 0;
  let broken = 0;
  let quotaErrors = 0;
  let accessErrors = 0;
  let transportErrors = 0;
  let skipped = 0;

  if (results && typeof results === "object") {
    for (const resItem of Object.values(results)) {
      if (!resItem || typeof resItem !== "object") {
        transportErrors++;
        continue;
      }

      if (resItem.tested === false || resItem.status === "skipped") {
        skipped++;
        continue;
      }

      const cls = String(resItem.classification || "").toLowerCase().trim();
      const statusCode = Number(resItem.statusCode ?? resItem.status) || null;
      const reason = String(resItem.reason || "").toLowerCase().trim();

      if (cls === "success" || cls === "ok" || cls === "passed") {
        passed++;
      } else if (
        cls === "quota_cost" ||
        cls === "rate_limited" ||
        cls === "quota" ||
        cls === "rate_limit"
      ) {
        quotaErrors++;
      } else if (
        cls === "access_restriction" ||
        cls === "access" ||
        cls === "auth" ||
        cls === "forbidden"
      ) {
        accessErrors++;
      } else if (cls === "hard_model_failure") {
        broken++;
      } else if (
        cls === "transport_indeterminate" ||
        cls === "transport" ||
        cls === "network" ||
        cls === "timeout"
      ) {
        if (
          statusCode === 401 ||
          statusCode === 403 ||
          reason === "auth_failure" ||
          reason === "forbidden" ||
          reason === "access_restricted" ||
          reason === "permission_denied" ||
          /auth|access|forbidden|permission/.test(reason)
        ) {
          accessErrors++;
        } else {
          transportErrors++;
        }
      } else {
        if (
          statusCode === 401 ||
          statusCode === 403 ||
          reason === "auth_failure" ||
          reason === "forbidden" ||
          reason === "access_restricted" ||
          reason === "permission_denied" ||
          /auth|access|forbidden|permission/.test(reason)
        ) {
          accessErrors++;
        } else {
          transportErrors++;
        }
      }
    }
  }

  return {
    passed,
    broken,
    quotaErrors,
    accessErrors,
    transportErrors,
    skipped,
  };
}

export default function ModelManagementPanel({
  providerId,
  connections = [],
  visibleModelIds = [],
  visiblemodelIDs, // Support alias prop
  onChanged,
}) {
  const allVisibleModels = useMemo(() => {
    const list = Array.isArray(visibleModelIds) && visibleModelIds.length > 0
      ? visibleModelIds
      : (Array.isArray(visiblemodelIDs) ? visiblemodelIDs : []);
    return list;
  }, [visibleModelIds, visiblemodelIDs]);

  const [activeTab, setActiveTab] = useState(TAB_KEYS.IMPORT);

  // -------------------------------------------------------------
  // Feature 1: Model Import
  // -------------------------------------------------------------
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [importError, setImportError] = useState("");

  const effectiveConnectionId = (
    selectedConnectionId && connections.some((c) => c.id === selectedConnectionId)
  )
    ? selectedConnectionId
    : (connections[0]?.id || "");

  const handleImport = async () => {
    if (importing || !effectiveConnectionId) return;
    setImporting(true);
    setImportError("");
    setImportSummary(null);

    try {
      const res = await fetch(`/api/providers/${effectiveConnectionId}/import-models`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `Import failed (HTTP ${res.status})`);
      }

      setImportSummary({
        added: Array.isArray(data.added) ? data.added.length : (data.add?.length ?? 0),
        updated: Array.isArray(data.updated) ? data.updated.length : (data.update?.length ?? 0),
        removed: Array.isArray(data.removed) ? data.removed.length : (data.remove?.length ?? 0),
        stale: Array.isArray(data.stale) ? data.stale.length : 0,
        unchanged: typeof data.unchanged === "number" ? data.unchanged : 0,
        authoritative: data.authoritative !== false,
        warning: data.warning || null,
      });

      onChanged?.();
    } catch (err) {
      setImportError(err.message || "Failed to import provider models");
    } finally {
      setImporting(false);
    }
  };

  // -------------------------------------------------------------
  // Feature 2: Batch Testing
  // -------------------------------------------------------------
  const [autoDisable, setAutoDisable] = useState(false);
  const [testingBatch, setTestingBatch] = useState(false);
  const [testSummary, setTestSummary] = useState(null);
  const [testError, setTestError] = useState("");
  const [batchIndex, setBatchIndex] = useState(0);
  const [auditList, setAuditList] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const abortControllerRef = useRef(null);

  const BATCH_SIZE = 100;
  const totalModels = allVisibleModels.length;
  const totalBatches = Math.max(1, Math.ceil(totalModels / BATCH_SIZE));
  const currentBatchStart = batchIndex * BATCH_SIZE;
  const currentBatchEnd = Math.min(totalModels, (batchIndex + 1) * BATCH_SIZE);
  const currentBatchModels = allVisibleModels.slice(currentBatchStart, currentBatchEnd);
  const remainingAfterBatch = Math.max(0, totalModels - currentBatchEnd);

  const handleTestBatch = async () => {
    if (testingBatch || currentBatchModels.length === 0) return;
    setTestingBatch(true);
    setTestError("");
    setTestSummary(null);

    // Snapshot IDs stably for this batch execution to prevent race conditions
    // Send raw provider-scoped model IDs (strip provider alias prefix if present; server qualifies)
    const rawModelIds = currentBatchModels.map((id) => {
      if (typeof id === "string" && id.startsWith(`${providerId}/`)) {
        return id.slice(providerId.length + 1);
      }
      return id;
    });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/models/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          providerId,
          connectionId: effectiveConnectionId || undefined,
          modelIds: rawModelIds,
          autoDisable,
          respectRateLimit: true,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(data.error || "Provider is currently busy with another test batch");
        }
        if (res.status === 429) {
          throw new Error(data.error || "Host concurrency limit reached. Please wait before retrying");
        }
        throw new Error(data.error || `Batch testing failed (HTTP ${res.status})`);
      }

      const summary = data.summary || {};
      const results = data.results || {};

      const hasResults = results && typeof results === "object" && Object.keys(results).length > 0;
      const counts = summarizeModelTestResults(results);
      const effectiveBroken = hasResults ? counts.broken : (data.broken ?? data.failingCount ?? 0);

      setTestSummary({
        batchId: data.batchId,
        executionScope: data.executionScope || "provider",
        executionNote: data.executionNote || null,
        totalTested: summary.tested ?? rawModelIds.length,
        total: summary.total ?? rawModelIds.length,
        passed: hasResults ? counts.passed : (data.passed ?? data.okCount ?? 0),
        broken: effectiveBroken,
        quotaErrors: hasResults ? counts.quotaErrors : (data.quota ?? data.quotaCount ?? 0),
        accessErrors: hasResults ? counts.accessErrors : (data.access ?? data.accessCount ?? 0),
        transportErrors: hasResults ? counts.transportErrors : (data.transport ?? data.transportCount ?? 0),
        disabledCount: summary.disabled ?? (data.disabledCount ?? (autoDisable ? effectiveBroken : 0)),
        skippedCount: summary.skipped ?? (hasResults ? counts.skipped : (data.skippedCount ?? 0)),
        stoppedEarly: data.stoppedEarly === true,
        stopReason: data.stopReason || null,
        results,
        batchNumber: batchIndex + 1,
        totalBatches,
      });

      if ((summary.disabled ?? 0) > 0 || (data.disabledCount ?? 0) > 0 || (autoDisable && effectiveBroken > 0)) {
        onChanged?.();
      }
    } catch (err) {
      if (err.name === "AbortError") {
        setTestError("Batch testing was cancelled by the user.");
      } else {
        setTestError(err.message || "Error running batch model test");
      }
    } finally {
      setTestingBatch(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelTest = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleNextBatch = () => {
    if (batchIndex + 1 < totalBatches) {
      setBatchIndex((prev) => prev + 1);
      setTestSummary(null);
      setTestError("");
    }
  };

  const handleFetchAudit = async () => {
    if (loadingAudit) return;
    setLoadingAudit(true);
    try {
      const res = await fetch(`/api/models/test-batch?providerId=${encodeURIComponent(providerId)}`);
      if (res.ok) {
        const data = await res.json();
        setAuditList(Array.isArray(data.audit) ? data.audit : (Array.isArray(data) ? data : []));
      } else {
        setAuditList([]);
      }
    } catch {
      setAuditList([]);
    } finally {
      setLoadingAudit(false);
    }
  };

  // -------------------------------------------------------------
  // Feature 3: Automatic Catalog Sync Policy
  // -------------------------------------------------------------
  const [syncPolicyLoading, setSyncPolicyLoading] = useState(true);
  const [syncPolicySaving, setSyncPolicySaving] = useState(false);
  const [syncPolicyError, setSyncPolicyError] = useState("");
  const [syncPolicySuccess, setSyncPolicySuccess] = useState("");
  const [rawServerPolicy, setRawServerPolicy] = useState(null);

  // Global settings
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [globalIntervalHours, setGlobalIntervalHours] = useState(24);

  // Provider-specific settings
  const [providerSyncMode, setProviderSyncMode] = useState("inherit"); // "inherit" | "enabled" | "disabled"
  const [providerIntervalHours, setProviderIntervalHours] = useState(24);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetch("/api/models/sync-policy", { signal: controller.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`Failed to load sync policy (HTTP ${res.status})`);
        }
        const data = await res.json();
        if (cancelled) return;
        setRawServerPolicy(data);

        if (data.globalDefault) {
          setGlobalEnabled(data.globalDefault.enabled !== false);
          setGlobalIntervalHours(Number(data.globalDefault.intervalHours) || 24);
        }

        const pConfig = data.providers?.[providerId];
        if (pConfig) {
          if (pConfig.enabled === "inherit" || pConfig.enabled == null) {
            setProviderSyncMode("inherit");
          } else if (pConfig.enabled === true) {
            setProviderSyncMode("enabled");
          } else {
            setProviderSyncMode("disabled");
          }
          if (pConfig.intervalHours != null) {
            setProviderIntervalHours(Number(pConfig.intervalHours) || 24);
          }
        } else {
          setProviderSyncMode("inherit");
        }
        setSyncPolicyLoading(false);
      })
      .catch((err) => {
        if (!cancelled && err.name !== "AbortError") {
          setSyncPolicyError(err.message || "Failed to load sync policy");
          setSyncPolicyLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [providerId]);

  const handleSaveSyncPolicy = async () => {
    if (syncPolicySaving) return;
    setSyncPolicySaving(true);
    setSyncPolicyError("");
    setSyncPolicySuccess("");

    try {
      const boundedGlobalInterval = Math.max(1, Math.min(168, Number(globalIntervalHours) || 24));
      const boundedProviderInterval = Math.max(1, Math.min(168, Number(providerIntervalHours) || 24));

      // Partial patch merging: merge this provider's configuration without clobbering other providers
      const updatedProviders = {
        ...(rawServerPolicy?.providers || {}),
        [providerId]:
          providerSyncMode === "inherit"
            ? { enabled: "inherit" }
            : {
                enabled: providerSyncMode === "enabled",
                intervalHours: boundedProviderInterval,
              },
      };

      const payload = {
        globalDefault: {
          enabled: globalEnabled,
          intervalHours: boundedGlobalInterval,
        },
        providers: updatedProviders,
      };

      const res = await fetch("/api/models/sync-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to update sync policy (HTTP ${res.status})`);
      }

      const savedData = await res.json().catch(() => payload);
      setRawServerPolicy(savedData);
      setSyncPolicySuccess("Sync policy updated successfully.");
      onChanged?.();
    } catch (err) {
      setSyncPolicyError(err.message || "Error saving sync policy");
    } finally {
      setSyncPolicySaving(false);
    }
  };

  // -------------------------------------------------------------
  // Feature 4: Model Capability Overrides
  // -------------------------------------------------------------
  const [selectedOverrideModel, setSelectedOverrideModel] = useState("");
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  const effectiveOverrideModel = (
    selectedOverrideModel && allVisibleModels.includes(selectedOverrideModel)
  )
    ? selectedOverrideModel
    : (allVisibleModels[0] || "");

  const hasConnections = connections.length > 0;

  return (
    <div className="w-full rounded-xl border border-border bg-surface p-3 sm:p-4 mb-4">
      {/* Header and Tab Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border-subtle pb-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-xl">tune</span>
          <h3 className="text-sm font-semibold text-text-main">Model Management</h3>
        </div>

        {/* Compact Navigation Tabs */}
        <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg self-start sm:self-auto overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setActiveTab(TAB_KEYS.IMPORT)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === TAB_KEYS.IMPORT
                ? "bg-surface text-primary shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => setActiveTab(TAB_KEYS.TEST)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === TAB_KEYS.TEST
                ? "bg-surface text-primary shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Test All ({totalModels})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab(TAB_KEYS.SYNC)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === TAB_KEYS.SYNC
                ? "bg-surface text-primary shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Auto-Sync
          </button>
          <button
            type="button"
            onClick={() => setActiveTab(TAB_KEYS.OVERRIDES)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === TAB_KEYS.OVERRIDES
                ? "bg-surface text-primary shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Capabilities
          </button>
        </div>
      </div>

      {/* Tab 1: Import Models */}
      {activeTab === TAB_KEYS.IMPORT && (
        <div className="pt-3 flex flex-col gap-3">
          <p className="text-xs text-text-muted">
            Fetch and reconcile live models from the upstream provider. New models are added and capabilities refreshed.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {hasConnections ? (
              connections.length === 1 ? (
                <div className="flex items-center gap-1.5 text-xs text-text-muted bg-sidebar px-2.5 py-1.5 rounded-lg border border-border">
                  <span className="material-symbols-outlined text-[15px]">key</span>
                  <span>
                    Connection:{" "}
                    <strong className="text-text-main">
                      {connections[0].name || connections[0].id}
                    </strong>
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <label htmlFor="import-connection-select" className="text-xs text-text-muted font-medium">
                    Connection:
                  </label>
                  <select
                    id="import-connection-select"
                    value={effectiveConnectionId}
                    onChange={(e) => setSelectedConnectionId(e.target.value)}
                    className="text-xs px-2.5 py-1.5 border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name ? `${c.name} (${c.id.slice(0, 8)})` : c.id}
                      </option>
                    ))}
                  </select>
                </div>
              )
            ) : (
              <div className="text-xs text-text-muted bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                <span className="material-symbols-outlined text-amber-500 text-sm">info</span>
                <span>
                  Importing models requires an active connection (not supported without a connection until synthetic listings are available).
                </span>
              </div>
            )}

            <Button
              size="sm"
              icon="download"
              onClick={handleImport}
              disabled={!hasConnections || importing}
              className="text-xs"
            >
              {importing ? "Importing..." : "Import Models"}
            </Button>
          </div>

          {importError && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              <span>{importError}</span>
            </div>
          )}

          {importSummary && (
            <div className="p-3 rounded-lg bg-sidebar border border-border text-xs flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium text-text-main">
                <span className="material-symbols-outlined text-green-500 text-base">check_circle</span>
                <span>Import Completed Successfully</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
                <span>Added: <strong className="text-text-main">{importSummary.added}</strong></span>
                <span>Updated: <strong className="text-text-main">{importSummary.updated}</strong></span>
                <span>Removed: <strong className="text-text-main">{importSummary.removed}</strong></span>
                {importSummary.stale > 0 && (
                  <span>Preserved (manual): <strong className="text-text-main">{importSummary.stale}</strong></span>
                )}
                {importSummary.unchanged > 0 && (
                  <span>Unchanged: <strong className="text-text-main">{importSummary.unchanged}</strong></span>
                )}
              </div>
              {!importSummary.authoritative && (
                <p className="text-[11px] text-amber-500 mt-1">
                  Note: The provider did not return a live authoritative listing; no models were pruned.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Batch Testing */}
      {activeTab === TAB_KEYS.TEST && (
        <div className="pt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-text-main">
              Tests use this provider’s configured account routing
            </p>
            <p className="text-xs text-amber-500 flex items-center gap-1 font-medium">
              <span className="material-symbols-outlined text-[15px]">warning</span>
              Tests send real requests and may consume quota/credits
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-2/60 p-2.5 rounded-lg border border-border">
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-text-main">
              <input
                type="checkbox"
                checked={autoDisable}
                onChange={(e) => setAutoDisable(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary w-4 h-4"
              />
              <span>Disable confirmed failing models</span>
            </label>

            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span>
                {`Batch ${batchIndex + 1} of ${totalBatches} (${currentBatchModels.length} models${remainingAfterBatch > 0 ? `, ${remainingAfterBatch} remaining` : ""})`}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!testingBatch ? (
              <Button
                size="sm"
                icon="play_arrow"
                onClick={handleTestBatch}
                disabled={currentBatchModels.length === 0}
                className="text-xs"
              >
                {totalBatches > 1
                  ? `Start Batch ${batchIndex + 1} (${currentBatchModels.length} models)`
                  : `Start Batch Test (${currentBatchModels.length} models)`}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon="cancel"
                onClick={handleCancelTest}
                className="text-xs text-red-500 hover:text-red-600"
              >
                Cancel Test
              </Button>
            )}

            {remainingAfterBatch > 0 && !testingBatch && (
              <Button
                size="sm"
                variant="secondary"
                icon="arrow_forward"
                onClick={handleNextBatch}
                className="text-xs"
              >
                {`Next Batch (${Math.min(BATCH_SIZE, remainingAfterBatch)} models)`}
              </Button>
            )}

            <button
              type="button"
              onClick={() => {
                setShowAudit((prev) => !prev);
                if (!auditList && !loadingAudit) handleFetchAudit();
              }}
              className="text-xs text-text-muted hover:text-primary transition-colors ml-auto flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[15px]">history</span>
              {showAudit ? "Hide Audit" : "View Audit History"}
            </button>
          </div>

          {testError && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              <span>{testError}</span>
            </div>
          )}

          {testSummary && (
            <div className="p-3 rounded-lg bg-sidebar border border-border text-xs flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-text-main">
                  Batch {testSummary.batchNumber} Results ({testSummary.totalTested} models tested)
                </span>
                {testSummary.disabledCount > 0 && (
                  <span className="text-red-500 font-medium">
                    {testSummary.disabledCount} models disabled
                  </span>
                )}
              </div>

              {/* Explicit classifications: quota/access/transport are NEVER mislabeled as broken */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 pt-1 border-t border-border-subtle">
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Passed</span>
                  <span className="text-sm font-semibold text-green-500">{testSummary.passed}</span>
                </div>
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Broken</span>
                  <span className="text-sm font-semibold text-red-500">{testSummary.broken}</span>
                </div>
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Quota Exceeded</span>
                  <span className="text-sm font-semibold text-amber-500">{testSummary.quotaErrors}</span>
                </div>
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Access Error</span>
                  <span className="text-sm font-semibold text-amber-500">{testSummary.accessErrors}</span>
                </div>
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Transport</span>
                  <span className="text-sm font-semibold text-amber-500">{testSummary.transportErrors}</span>
                </div>
                <div className="flex flex-col p-1.5 rounded bg-surface">
                  <span className="text-[10px] text-text-muted">Skipped</span>
                  <span className="text-sm font-semibold text-text-muted">{testSummary.skippedCount}</span>
                </div>
              </div>
            </div>
          )}

          {showAudit && (
            <div className="p-3 rounded-lg border border-border bg-surface-2/40 text-xs">
              <h4 className="font-semibold text-text-main mb-1.5">Reversible Test Audit</h4>
              {loadingAudit ? (
                <p className="text-text-muted">Loading audit entries...</p>
              ) : Array.isArray(auditList) && auditList.length > 0 ? (
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {auditList.map((entry, idx) => (
                    <div key={idx} className="flex items-center justify-between p-1.5 rounded bg-surface border border-border-subtle text-[11px]">
                      <span>{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : `Audit #${idx + 1}`}</span>
                      <span>Tested: {entry.testedCount ?? 0}</span>
                      <span>Disabled: {entry.disabledCount ?? 0}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-text-muted">No audit entries recorded for this provider.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Automatic Sync Policy */}
      {activeTab === TAB_KEYS.SYNC && (
        <div className="pt-3 flex flex-col gap-3">
          <p className="text-xs text-text-muted">
            Configure background model discovery and catalog synchronization intervals.
          </p>

          {syncPolicyLoading ? (
            <div className="flex items-center gap-2 text-xs text-text-muted py-3">
              <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
              <span>Loading sync policies...</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Global Setting Controls (clearly global) */}
              <div className="p-3 rounded-lg bg-surface-2/60 border border-border flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-text-main block">
                      Global Default Sync Policy
                    </span>
                    <span className="text-[11px] text-text-muted">
                      Applies to all providers that inherit the default setting
                    </span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
                    <input
                      type="checkbox"
                      checked={globalEnabled}
                      onChange={(e) => setGlobalEnabled(e.target.checked)}
                      className="rounded border-border text-primary focus:ring-primary w-4 h-4"
                    />
                    <span className="text-xs text-text-main">{globalEnabled ? "Enabled" : "Disabled"}</span>
                  </label>
                </div>

                <div className="flex items-center gap-2 pt-1 border-t border-border-subtle">
                  <label htmlFor="global-sync-interval" className="text-xs text-text-muted">
                    Global Interval (hours, 1-168):
                  </label>
                  <input
                    id="global-sync-interval"
                    type="number"
                    min="1"
                    max="168"
                    value={globalIntervalHours}
                    onChange={(e) => setGlobalIntervalHours(e.target.value)}
                    className="w-20 px-2 py-1 text-xs border border-border rounded bg-background text-text-main focus:outline-none focus:border-primary"
                  />
                  <span className="text-[11px] text-text-muted">hours (max 7 days)</span>
                </div>
              </div>

              {/* Per-Provider Override */}
              <div className="p-3 rounded-lg bg-surface border border-border flex flex-col gap-2">
                <span className="text-xs font-semibold text-text-main">
                  Provider Policy ({providerId})
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="provider-sync-select" className="text-xs text-text-muted font-medium">
                      Provider Sync Mode:
                    </label>
                    <select
                      id="provider-sync-select"
                      value={providerSyncMode}
                      onChange={(e) => setProviderSyncMode(e.target.value)}
                      className="text-xs px-2.5 py-1.5 border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                    >
                      <option value="inherit">Inherit Global Policy</option>
                      <option value="enabled">Enabled (Custom Interval)</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </div>

                  {providerSyncMode === "enabled" && (
                    <div className="flex flex-col gap-1">
                      <label htmlFor="provider-sync-interval" className="text-xs text-text-muted font-medium">
                        Provider Interval (hours, 1-168):
                      </label>
                      <input
                        id="provider-sync-interval"
                        type="number"
                        min="1"
                        max="168"
                        value={providerIntervalHours}
                        onChange={(e) => setProviderIntervalHours(e.target.value)}
                        className="px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                      />
                    </div>
                  )}
                </div>
              </div>

              {syncPolicyError && (
                <div role="alert" className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">error</span>
                  <span>{syncPolicyError}</span>
                </div>
              )}

              {syncPolicySuccess && (
                <div className="p-2.5 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-500 flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">check_circle</span>
                  <span>{syncPolicySuccess}</span>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleSaveSyncPolicy}
                  disabled={syncPolicySaving}
                  className="text-xs"
                >
                  {syncPolicySaving ? "Saving..." : "Save Sync Policy"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Capabilities & Overrides Entry */}
      {activeTab === TAB_KEYS.OVERRIDES && (
        <div className="pt-3 flex flex-col gap-3">
          <p className="text-xs text-text-muted">
            Configure custom capability flags, token limits, and reasoning options for any model.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <label htmlFor="override-model-select" className="text-xs text-text-muted font-medium">
                Model:
              </label>
              <select
                id="override-model-select"
                value={effectiveOverrideModel}
                onChange={(e) => setSelectedOverrideModel(e.target.value)}
                disabled={allVisibleModels.length === 0}
                className="text-xs px-2.5 py-1.5 border border-border rounded-lg bg-background text-text-main flex-1 focus:outline-none focus:border-primary font-mono"
              >
                {allVisibleModels.length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  allVisibleModels.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))
                )}
              </select>
            </div>

            <Button
              size="sm"
              icon="tune"
              onClick={() => setShowOverrideModal(true)}
              disabled={!effectiveOverrideModel}
              className="text-xs"
            >
              Edit Capabilities
            </Button>
          </div>
        </div>
      )}

      {/* Reusable Override Modal */}
      {showOverrideModal && effectiveOverrideModel && (
        <ModelOverrideModal
          isOpen={showOverrideModal}
          onClose={() => setShowOverrideModal(false)}
          providerId={providerId}
          modelId={effectiveOverrideModel}
          onSaved={() => {
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

ModelManagementPanel.propTypes = {
  providerId: PropTypes.string.isRequired,
  connections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      isActive: PropTypes.bool,
    })
  ),
  visibleModelIds: PropTypes.arrayOf(PropTypes.string),
  visiblemodelIDs: PropTypes.arrayOf(PropTypes.string),
  onChanged: PropTypes.func,
};

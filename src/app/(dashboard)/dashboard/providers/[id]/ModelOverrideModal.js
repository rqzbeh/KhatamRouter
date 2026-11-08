"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";

export const CAPABILITY_BOOLEAN_FIELDS = [
  { key: "supportsVision", label: "Vision", description: "Image and visual input support" },
  { key: "supportsTools", label: "Tools / Function Calling", description: "Structured tool call and function definition support" },
  { key: "supportsReasoning", label: "Reasoning / Thinking", description: "Reasoning tokens and chain-of-thought support" },
  { key: "supportsAudio", label: "Audio", description: "Audio input and/or speech processing" },
  { key: "supportsVideo", label: "Video", description: "Video frames and stream processing" },
  { key: "supportsStreaming", label: "Streaming", description: "Real-time token streaming / SSE delivery" },
  { key: "supportsImageGeneration", label: "Image Generation", description: "Image synthesis from prompt instructions" },
  { key: "supportsImageEditing", label: "Image Editing", description: "Masking, inpainting, or image transform support" },
  { key: "supportsWebSearch", label: "Web Search", description: "Live web search query integration" },
  { key: "supportsWebFetch", label: "Web Fetch", description: "Direct web document retrieval capability" },
];

function buildInitialForm(manual = {}) {
  const form = {
    contextWindow: manual?.contextWindow != null ? String(manual.contextWindow) : "",
    maxOutputTokens: manual?.maxOutputTokens != null ? String(manual.maxOutputTokens) : "",
    reasoningSupported:
      manual?.reasoning?.supported === true
        ? "true"
        : manual?.reasoning?.supported === false
        ? "false"
        : "auto",
    effortLevels: Array.isArray(manual?.reasoning?.effortLevels)
      ? manual.reasoning.effortLevels.join(", ")
      : "",
  };

  for (const { key } of CAPABILITY_BOOLEAN_FIELDS) {
    if (manual?.[key] === true) {
      form[key] = "true";
    } else if (manual?.[key] === false) {
      form[key] = "false";
    } else {
      form[key] = "auto";
    }
  }

  return form;
}

export default function ModelOverrideModal({
  isOpen,
  onClose,
  providerId,
  modelId,
  onSaved,
}) {
  const rawModelId = typeof modelId === "string" && modelId.startsWith(`${providerId}/`)
    ? modelId.slice(providerId.length + 1)
    : modelId;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(() => buildInitialForm());
  const [resolved, setResolved] = useState(null);
  const [provenance, setProvenance] = useState(null);
  const [showProvenance, setShowProvenance] = useState(false);

  useEffect(() => {
    if (!isOpen || !providerId || !rawModelId) return;
    let cancelled = false;
    const controller = new AbortController();

    fetch(
      `/api/models/overrides?provider=${encodeURIComponent(providerId)}&modelId=${encodeURIComponent(rawModelId)}`,
      { signal: controller.signal }
    )
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setForm(buildInitialForm({}));
            setResolved(null);
            setProvenance(null);
            setLoading(false);
            return;
          }
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed to fetch overrides (HTTP ${res.status})`);
        }
        const data = await res.json();
        if (cancelled) return;
        // Read initial manual fields strictly from GET manual (never infer from resolved source)
        const manualData = data?.manual || {};
        setForm(buildInitialForm(manualData));
        setResolved(data?.resolved || null);
        setProvenance(data?.provenance || null);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled && err.name !== "AbortError") {
          setError(err.message || "Failed to load model capability overrides");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isOpen, providerId, rawModelId]);

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Build manual draft containing only explicitly configured manual fields
  // Omitted/Automatic fields are not sent in capabilities draft so they resolve automatically
  const buildManualDraft = () => {
    const draft = {};

    for (const { key } of CAPABILITY_BOOLEAN_FIELDS) {
      if (form[key] === "true") draft[key] = true;
      if (form[key] === "false") draft[key] = false;
    }

    if (form.contextWindow.trim() !== "") {
      const val = parseInt(form.contextWindow.trim(), 10);
      if (!Number.isNaN(val) && val > 0) {
        draft.contextWindow = val;
      }
    }

    if (form.maxOutputTokens.trim() !== "") {
      const val = parseInt(form.maxOutputTokens.trim(), 10);
      if (!Number.isNaN(val) && val > 0) {
        draft.maxOutputTokens = val;
      }
    }

    const hasReasoningSupported = form.reasoningSupported !== "auto";
    const effortLevelsArr = form.effortLevels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (hasReasoningSupported || effortLevelsArr.length > 0) {
      draft.reasoning = {};
      if (hasReasoningSupported) {
        draft.reasoning.supported = form.reasoningSupported === "true";
      }
      if (effortLevelsArr.length > 0) {
        draft.reasoning.effortLevels = effortLevelsArr;
      }
    }

    return draft;
  };

  // PUT: atomic replace of manual fields for this model
  const handleSave = async () => {
    if (saving || resetting) return;
    setSaving(true);
    setError("");

    try {
      const manualDraft = buildManualDraft();
      const res = await fetch("/api/models/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          modelId: rawModelId,
          capabilities: manualDraft,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to save capabilities (HTTP ${res.status})`);
      }

      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Error saving overrides");
    } finally {
      setSaving(false);
    }
  };

  // DELETE: reset entire manual override for this model back to automatic
  const handleResetAll = async () => {
    if (resetting || saving) return;
    setResetting(true);
    setError("");

    try {
      const res = await fetch(
        `/api/models/overrides?provider=${encodeURIComponent(providerId)}&modelId=${encodeURIComponent(rawModelId)}`,
        { method: "DELETE" }
      );

      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to reset overrides (HTTP ${res.status})`);
      }

      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Error resetting overrides");
    } finally {
      setResetting(false);
    }
  };

  const footer = (
    <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-2 w-full">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleResetAll}
        disabled={loading || saving || resetting}
        className="w-full sm:w-auto text-red-500 hover:text-red-600 hover:bg-red-500/10"
      >
        {resetting ? "Resetting..." : "Reset to Automatic"}
      </Button>

      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onClose}
          disabled={saving || resetting}
          className="w-full sm:w-auto"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={loading || saving || resetting}
          className="w-full sm:w-auto"
        >
          {saving ? "Saving..." : "Save Overrides"}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Model Capabilities"
      size="lg"
      footer={footer}
    >
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto px-1 py-1">
        <div className="flex flex-col gap-1 border-b border-border-subtle pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-muted font-medium">Provider:</span>
            <code className="text-xs bg-sidebar px-2 py-0.5 rounded font-mono text-text-main">
              {providerId}
            </code>
            <span className="text-xs text-text-muted font-medium ml-2">Model:</span>
            <code className="text-xs bg-sidebar px-2 py-0.5 rounded font-mono text-primary font-semibold break-all">
              {modelId}
            </code>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Configure manual capability overrides. Fields set to <em>Automatic</em> inherit live provider
            and catalog discovery metadata.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500 flex items-start gap-2"
          >
            <span className="material-symbols-outlined text-sm shrink-0 mt-0.5">error</span>
            <span className="break-words flex-1">{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-muted text-sm">
            <span className="material-symbols-outlined animate-spin text-2xl">progress_activity</span>
            <span>Loading capability overrides...</span>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* Context & Token Limits */}
            <div>
              <h3 className="text-xs font-semibold text-text-main uppercase tracking-wider mb-2">
                Context & Output Limits
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="override-context-window"
                    className="text-xs font-medium text-text-muted"
                  >
                    Context Window (Tokens)
                  </label>
                  <input
                    id="override-context-window"
                    type="number"
                    min="1"
                    placeholder={
                      resolved?.contextWindow ? `Auto (${resolved.contextWindow.toLocaleString()})` : "Automatic"
                    }
                    value={form.contextWindow}
                    onChange={(e) => handleChange("contextWindow", e.target.value)}
                    className="px-3 py-1.5 text-sm border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                  />
                  <span className="text-[10px] text-text-muted">
                    Leave blank to inherit automatic limits
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="override-max-output"
                    className="text-xs font-medium text-text-muted"
                  >
                    Max Output Tokens
                  </label>
                  <input
                    id="override-max-output"
                    type="number"
                    min="1"
                    placeholder={
                      resolved?.maxOutputTokens ? `Auto (${resolved.maxOutputTokens.toLocaleString()})` : "Automatic"
                    }
                    value={form.maxOutputTokens}
                    onChange={(e) => handleChange("maxOutputTokens", e.target.value)}
                    className="px-3 py-1.5 text-sm border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                  />
                  <span className="text-[10px] text-text-muted">
                    Leave blank to inherit automatic limits
                  </span>
                </div>
              </div>
            </div>

            {/* Tri-state Capabilities */}
            <div>
              <h3 className="text-xs font-semibold text-text-main uppercase tracking-wider mb-2">
                Modalities & Features (Tri-State)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {CAPABILITY_BOOLEAN_FIELDS.map(({ key, label, description }) => {
                  const resolvedVal = resolved?.[key];
                  const autoLabel = resolvedVal === true ? "Auto (True)" : resolvedVal === false ? "Auto (False)" : "Automatic";

                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-1 p-2.5 rounded-lg border border-border bg-surface-2/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <label
                          htmlFor={`override-${key}`}
                          className="text-xs font-medium text-text-main"
                          title={description}
                        >
                          {label}
                        </label>
                        <select
                          id={`override-${key}`}
                          value={form[key]}
                          onChange={(e) => handleChange(key, e.target.value)}
                          className="text-xs px-2 py-1 border border-border rounded bg-background text-text-main focus:outline-none focus:border-primary"
                        >
                          <option value="auto">{autoLabel}</option>
                          <option value="true">True (Enabled)</option>
                          <option value="false">False (Disabled)</option>
                        </select>
                      </div>
                      <span className="text-[10px] text-text-muted truncate" title={description}>
                        {description}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Reasoning Specifics */}
            <div>
              <h3 className="text-xs font-semibold text-text-main uppercase tracking-wider mb-2">
                Reasoning Configuration
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="override-reasoning-supported"
                    className="text-xs font-medium text-text-muted"
                  >
                    Reasoning Support
                  </label>
                  <select
                    id="override-reasoning-supported"
                    value={form.reasoningSupported}
                    onChange={(e) => handleChange("reasoningSupported", e.target.value)}
                    className="text-xs px-2 py-1.5 border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                  >
                    <option value="auto">Automatic</option>
                    <option value="true">True (Enabled)</option>
                    <option value="false">False (Disabled)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="override-effort-levels"
                    className="text-xs font-medium text-text-muted"
                  >
                    Effort Levels (Comma-separated)
                  </label>
                  <input
                    id="override-effort-levels"
                    type="text"
                    placeholder="e.g. low, medium, high, max"
                    value={form.effortLevels}
                    onChange={(e) => handleChange("effortLevels", e.target.value)}
                    className="px-3 py-1.5 text-xs border border-border rounded-lg bg-background text-text-main focus:outline-none focus:border-primary"
                  />
                  <span className="text-[10px] text-text-muted">
                    Levels supported by model reasoning parameter
                  </span>
                </div>
              </div>
            </div>

            {/* Provenance Readout */}
            {(resolved || provenance) && (
              <div className="rounded-lg border border-border/80 bg-surface/50 p-3">
                <button
                  type="button"
                  onClick={() => setShowProvenance((prev) => !prev)}
                  className="flex items-center justify-between w-full text-left text-xs font-medium text-text-muted hover:text-text-main"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[15px]">info</span>
                    Active Provenance & Resolved Defaults
                  </span>
                  <span className="material-symbols-outlined text-[15px]">
                    {showProvenance ? "expand_less" : "expand_more"}
                  </span>
                </button>

                {showProvenance && (
                  <div className="mt-2 pt-2 border-t border-border-subtle text-xs text-text-muted space-y-1">
                    {provenance?.source && (
                      <p>
                        <strong>Source:</strong> {provenance.source}
                      </p>
                    )}
                    {resolved?.contextWindow && (
                      <p>
                        <strong>Resolved Context Window:</strong>{" "}
                        {resolved.contextWindow.toLocaleString()} tokens
                      </p>
                    )}
                    {resolved?.maxOutputTokens && (
                      <p>
                        <strong>Resolved Max Output:</strong>{" "}
                        {resolved.maxOutputTokens.toLocaleString()} tokens
                      </p>
                    )}
                    <p className="text-[11px] text-text-muted/80 mt-1">
                      Manual overrides take precedence over catalog defaults without clearing other known
                      provider capabilities.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

ModelOverrideModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  providerId: PropTypes.string.isRequired,
  modelId: PropTypes.string.isRequired,
  onSaved: PropTypes.func,
};

"use client";

import { useState, useEffect } from "react";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import Select from "./Select";
import ModelSelectModal from "./ModelSelectModal";
import CapacityBadges from "./CapacityBadges";
import { COOLDOWN_PRESET_OPTIONS, isComboCooldownDisabled } from "open-sse/config/comboCooldown.js";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Inline editable model item
function ModelItem({ index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };
  return (
    <div className="group flex min-w-0 items-center gap-1.5 rounded-md bg-black/[0.02] px-2 py-1 transition-colors hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20" />
      ) : (
        <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
          <div className="min-w-0 truncate cursor-text rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => setEditing(true)} title="Click to edit">{model}</div>
          <CapacityBadges comboModels={[model]} size={12} className="shrink-0" />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button onClick={onMoveUp} disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move up">
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button onClick={onMoveDown} disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move down">
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button onClick={onRemove} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all" title="Remove">
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

// Reusable Combo create/edit modal. forcePrefix auto-prepends to name.
export default function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, forcePrefix = "", title, strategy = {}, memberCooldownMs = null }) {
  // Strip prefix when editing existing combo so user only edits suffix
  const initialName = combo?.name
    ? (forcePrefix && combo.name.startsWith(forcePrefix) ? combo.name.slice(forcePrefix.length) : combo.name)
    : "";
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const initialCooldown = memberCooldownMs ?? strategy?.memberCooldownMs ?? null;
  const isInitiallyDisabled = isComboCooldownDisabled(strategy, initialCooldown);
  const initialMode = isInitiallyDisabled
    ? "disabled"
    : initialCooldown === 60_000 || initialCooldown === "1m"
      ? "1m"
      : initialCooldown === 300_000 || initialCooldown === "5m"
        ? "5m"
        : initialCooldown === 3_600_000 || initialCooldown === "1h"
          ? "1h"
          : (typeof initialCooldown === "number" || (typeof initialCooldown === "string" && /^\d+$/.test(initialCooldown)))
            ? "custom"
            : "default";

  const [cooldownMode, setCooldownMode] = useState(initialMode);
  const [customCooldownSec, setCustomCooldownSec] = useState(
    initialMode === "custom" ? String(Math.round(Number(initialCooldown) / 1000)) : ""
  );
  const [cooldownError, setCooldownError] = useState("");

  const validateCooldown = (mode, secStr) => {
    if (mode !== "custom") {
      setCooldownError("");
      return true;
    }
    const trimmed = String(secStr || "").trim();
    if (!trimmed) {
      setCooldownError("Cooldown duration required when custom is selected");
      return false;
    }
    if (!/^\d+$/.test(trimmed)) {
      setCooldownError("Must be a whole number of seconds");
      return false;
    }
    const sec = parseInt(trimmed, 10);
    if (!Number.isSafeInteger(sec) || sec < 10 || sec > 86400) {
      setCooldownError("Cooldown must be between 10s and 86400s (24h)");
      return false;
    }
    setCooldownError("");
    return true;
  };

  const handleCooldownModeChange = (mode) => {
    setCooldownMode(mode);
    if (mode === "custom") {
      validateCooldown(mode, customCooldownSec);
    } else {
      setCooldownError("");
    }
  };

  const handleCustomCooldownChange = (e) => {
    const val = e.target.value;
    setCustomCooldownSec(val);
    validateCooldown(cooldownMode, val);
  };

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    async function loadAliases() {
      try {
        const res = await fetch("/api/models/alias", { signal: controller.signal });
        if (!res.ok) return;
        const d = await res.json();
        if (!controller.signal.aborted && d?.aliases) {
          setModelAliases(d.aliases || {});
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching modal data:", err);
        }
      }
    }
    loadAliases();
    return () => {
      controller.abort();
    };
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) { setNameError("Name is required"); return false; }
    const full = forcePrefix + value;
    if (!VALID_NAME_REGEX.test(full)) { setNameError("Only letters, numbers, -, _ and . allowed"); return false; }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    let value = e.target.value;
    // If user types prefix manually, strip it (we always prepend)
    if (forcePrefix && value.startsWith(forcePrefix)) value = value.slice(forcePrefix.length);
    setName(value);
    if (value) validateName(value); else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) setModels([...models, model.value]);
  };
  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };
  const handleRemoveModel = (i) => setModels(models.filter((_, idx) => idx !== i));
  const handleMoveUp = (i) => {
    if (i === 0) return;
    const a = [...models]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setModels(a);
  };
  const handleMoveDown = (i) => {
    if (i === models.length - 1) return;
    const a = [...models]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; setModels(a);
  };

  const handleSave = async () => {
    if (!validateName(name) || !validateCooldown(cooldownMode, customCooldownSec)) return;
    let savedCooldown = null;
    let isCooldownDisabled = false;
    if (cooldownMode === "disabled") {
      isCooldownDisabled = true;
      savedCooldown = null;
    } else if (cooldownMode === "1m" || cooldownMode === "5m" || cooldownMode === "1h") {
      savedCooldown = cooldownMode;
    } else if (cooldownMode === "custom") {
      const sec = parseInt(customCooldownSec.trim(), 10);
      if (Number.isSafeInteger(sec) && sec >= 10 && sec <= 86400) {
        savedCooldown = sec * 1000;
      }
    }
    setSaving(true);
    await onSave({ name: forcePrefix + name.trim(), models, memberCooldownMs: savedCooldown, disableCooldown: isCooldownDisabled });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title || (isEdit ? "Edit Combo" : "Create Combo")}>
        <div className="flex flex-col gap-3">
          <div>
            {forcePrefix ? (
              <>
                <label className="text-sm font-medium mb-1 block">Combo Name</label>
                <div className="flex items-stretch">
                  <span className="inline-flex items-center px-2 rounded-l border border-r-0 border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.04] text-text-muted font-mono text-sm">{forcePrefix}</span>
                  <input value={name} onChange={handleNameChange} placeholder="my-combo"
                    className="flex-1 min-w-0 rounded-r border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 font-mono text-sm outline-none focus:border-primary" />
                </div>
                {nameError && <p className="text-[11px] text-red-500 mt-0.5">{nameError}</p>}
              </>
            ) : (
              <Input label="Combo Name" value={name} onChange={handleNameChange} placeholder="my-combo" error={nameError} />
            )}
            <p className="text-[10px] text-text-muted mt-0.5">
              {forcePrefix ? `Auto-prefixed with "${forcePrefix}". ` : ""}Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium block">Models</label>
                {models.length > 0 && (
                  <span data-testid="combo-aggregated-badges" className="inline-flex">
                    <CapacityBadges
                      comboModels={models}
                      size={14}
                    />
                  </span>
                )}
              </div>
              {models.length > 0 && (
                <span className="text-[11px] text-text-muted">({models.length} models)</span>
              )}
            </div>
            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
              <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                {models.map((model, index) => (
                  <ModelItem key={index} index={index} model={model}
                    isFirst={index === 0} isLast={index === models.length - 1}
                    onEdit={(v) => { const a = [...models]; a[index] = v; setModels(a); }}
                    onMoveUp={() => handleMoveUp(index)}
                    onMoveDown={() => handleMoveDown(index)}
                    onRemove={() => handleRemoveModel(index)} />
                ))}
              </div>
            )}
            <button onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1">
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Member Failure Cooldown</label>
            <Select
              options={COOLDOWN_PRESET_OPTIONS}
              value={cooldownMode}
              onChange={(e) => handleCooldownModeChange(e.target.value)}
              selectClassName="py-1.5 text-xs"
            />
            {cooldownMode === "custom" && (
              <div className="mt-1.5 flex items-center gap-2">
                <Input
                  type="number"
                  min="10"
                  max="86400"
                  value={customCooldownSec}
                  onChange={handleCustomCooldownChange}
                  placeholder="e.g. 60"
                  className="w-32"
                />
                <span className="text-xs text-text-muted">seconds (10s – 24h)</span>
              </div>
            )}
            {cooldownError && (
              <p className="text-[11px] text-red-500 mt-0.5">{cooldownError}</p>
            )}
            <p className="text-[10px] text-text-muted mt-0.5">
              Remove failing members (401/402/403/429/5xx) from rotation across requests for this combo.
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
            <Button onClick={handleSave} fullWidth size="sm" disabled={!name.trim() || !!nameError || !!cooldownError || saving}>
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {showModelSelect && (
        <ModelSelectModal isOpen={showModelSelect} onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel} onDeselect={handleDeselectModel}
          onSelectBatch={(items) => {
            const vals = items.map((m) => m?.value || m?.name || m).filter(Boolean);
            setModels((prev) => [...new Set([...prev, ...vals])]);
          }}
          onDeselectBatch={(items) => {
            const vals = new Set(items.map((m) => m?.value || m?.name || m).filter(Boolean));
            setModels((prev) => prev.filter((m) => !vals.has(m)));
          }}
          activeProviders={activeProviders} modelAliases={modelAliases}
          title="Add Model to Combo" kindFilter={kindFilter}
          addedModelValues={models} closeOnSelect={false} />
      )}
    </>
  );
}
